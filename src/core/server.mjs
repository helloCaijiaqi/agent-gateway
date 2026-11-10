/**
 * agent-gateway HTTP 服务（core）：鉴权、契约校验、幂等、路由。
 *
 * 边界（必须读）：
 *   - `/v1/inbound` 只做「鉴权 → 契约校验 → 幂等 → 落盘」，**不碰 DSH**。
 *     `mode=shadow` 时记录 `status:'shadow'`，`mode=on` 时交给注入的 runtime。
 *   - 本文件**不 import 上层模块**（turn 编排、executor、上下文组装）：工具调用、
 *     状态读写、turn 投递都以「注入的 handler」形式出现（见 createGatewayServer
 *     的 runtime 形参）。装配在 `src/main.mjs`，边界由 `scripts/test-layering.mjs` 钉住。
 *   - 未匹配路由一律 404 JSON，不做静默 200。
 *
 * 与项目其他服务保持一致的三个约定：
 *   1. 只监听回环（config 层已放宽时打印显式警告）；
 *   2. `/v1/health` 免鉴权、不含业务内容（部署探测要用）；
 *   3. 错误响应一律 `{ok:false, error:{code,message}}`，code 取自 contracts。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { isLoopbackAddress } from './net.mjs';
import {
  AuthError, createNonceCache, verifyRequest,
  safeEqualString, issueOperatorSession, verifyOperatorSession,
  operatorCookieHeader, OPERATOR_COOKIE, OPERATOR_TOKEN_PATTERN,
} from './auth.mjs';
import { ContractError, parseInbound, parseToolCall, parseToolResult, parseStateUpdate, parseServiceRegistration, newRegistrationId, inboundIdempotencyKey, sessionKeyOf } from './contracts.mjs';
import { assertLoopbackUrl } from './service-registry.mjs';
import { createIdempotency } from './idempotency.mjs';
import { createTurnStore } from './turn-store.mjs';
import { createMetrics } from './metrics.mjs';
import { configSummary, isConversationAllowed } from './config.mjs';
import { createWsHub } from './ws-hub.mjs';

export function createGatewayServer({
  config, logger = () => {}, now = Date.now, runtime = null, services = null,
  // P4 编排 UI：管线引擎（步骤名三级解析校验用；null = 管线 off，编排只存不校）。
  pipeline = null,
  // §6 记忆落库调度器（runtime 注入，core 不 import）：入站观察点。null = 不落库。
  memoryIngest = null,
} = {}) {
  const adaptersById = new Map(config.adapters.map((adapter) => [adapter.id, adapter]));
  // V2 P2：装饰器/过滤器服务与消费者同构连入 WS（同一握手鉴权）。合并登记表
  // 交给 ws-hub；HTTP 侧的 authenticate 不合并——服务不走 /v1/inbound（它们
  // 是被调用方，回执走 service.call/result 帧）。
  // V2 P3：登记是活的（服务可随时通过登记目录注册/卸载），握手身份表必须
  // 同样是活视图——启动时快照 Map 会让热注册的 WS 服务永远握不上手。
  // ws-hub 只用 clientsById.get(id)（握手取 secret），一个 get 视图即可。
  const wsClientsById = services
    ? {
      get(id) {
        if (adaptersById.has(id)) return adaptersById.get(id);
        const service = services.resolveService(id);
        return service && service.enabled !== false
          ? { id: service.id, kind: service.kind, platform: null, secret: service.secret }
          : undefined;
      },
    }
    : adaptersById;
  const nonceCache = createNonceCache({ windowMs: config.replayWindowMs });
  // P3：MCP 薄壳（mcp-bus）的独立 nonce 缓存——与适配器共用会互相挤占容量，
  // 分开还能在 metrics 里区分两类调用方的重放行为。
  const toolNonceCache = createNonceCache({ windowMs: config.replayWindowMs });
  const metrics = createMetrics();
  const idempotency = createIdempotency({ file: config.idempotencyFile, logger });
  const turns = createTurnStore({ file: config.turnsFile, logger });
  const startedAt = Date.now();

  /**
   * 入站处理。独立成函数是为了：
   *  (a) 测试可以不经 HTTP 直接驱动；
   *  (b) runtime 是装配点注入的（core 不 import runtime，依赖方向不变）：
   *      mode=on 且 runtime 就位时，命中灰度白名单的会话交给 runtime，
   *      未命中返回 routed:false，适配器继续走自己的旧路径。
   *
   * @param {object} envelope 已通过 parseInbound 的信封
   * @param {{adapterId?: string}} [meta] 上报方身份（HTTP 来自签名头，WS 来自握手）
   * @returns {{turnId: string, deduped: boolean, status: string, routed?: boolean}}
   */
  function handleInbound(envelope, { adapterId } = {}) {
    const key = inboundIdempotencyKey(envelope, adapterId);
    // 兼容读取：灰度升级前落盘的旧键（不含 adapterId）仍要命中，否则重启后
    // 最近一条消息会被当新消息重复处理。
    const legacyKey = adapterId ? inboundIdempotencyKey(envelope) : null;
    const existing = idempotency.get(key) ?? (legacyKey ? idempotency.get(legacyKey) : null);
    if (existing) {
      metrics.inc('gateway_inbound_total', { platform: envelope.platform, result: 'deduped' });
      return { turnId: existing.turnId, deduped: true, status: existing.status };
    }

    const turnId = `turn_${randomUUID()}`;
    const sessionKey = sessionKeyOf(envelope);
    // 路由决策在落盘前做出：status 是这条入站的最终归属，改口比改记录贵。
    let status;
    let note;
    if (config.mode === 'shadow') {
      status = 'shadow';
    } else if (!runtime) {
      status = 'queued';
      note = 'dsh pipeline pending (P1)';
    } else if (!isConversationAllowed(config, sessionKey)) {
      status = 'unrouted';
      note = 'conversation not whitelisted; adapter keeps local path';
    } else {
      status = 'accepted';
    }
    const record = {
      v: 1,
      turnId,
      sessionKey,
      status,
      // 信封整体保留：P1 管线需要 message 之外的字段（traceId、sender.roles）。
      // 在这里挑字段然后发现漏了，代价远高于存全量。
      envelope,
      degraded: [],
      note,
      at: now(),
    };
    // 先落盘再返回：先写 turn + 幂等（崩溃后适配器重发能命中，不会重复起 turn）。
    // 但 submit 是同步调用，若它抛错（队列满/编程错误），幂等记录必须回滚——
    // 否则适配器重试被判 deduped，这一轮永远丢失。
    turns.put(turnId, record);
    idempotency.put(key, { turnId, status });
    metrics.inc('gateway_inbound_total', { platform: envelope.platform, result: 'ok' });
    // §6 记忆落库（双向拦截的入站侧）：所有入站都观察（含 shadow/unrouted/queued
    // ——纯消息不一定触发 turn）；调度器内部缓冲聚合，投递失败只重试不阻塞。
    memoryIngest?.observeInbound({ sessionKey, envelope });
    if (status === 'accepted') {
      try {
        runtime.submit({ turnId, sessionKey, envelope, degraded: [] });
      } catch (error) {
        idempotency.delete(key);
        if (legacyKey) idempotency.delete(legacyKey);
        turns.put(turnId, { ...record, status: 'error', note: `submit failed: ${error?.message ?? error}` });
        throw error;
      }
    }
    return { turnId, deduped: false, status, routed: status === 'accepted' };
  }

  function authenticate(req, body, declaredPlatform) {
    const adapterId = req.headers['x-adapter-id'];
    const adapter = typeof adapterId === 'string' ? adaptersById.get(adapterId) : undefined;
    // 不存在与签名错误返回同一个 code，避免枚举适配器。
    if (!adapter) throw new AuthError('E_AUTH', 'unknown adapter');
    return verifyRequest({
      secret: adapter.secret,
      expectedAdapterId: adapter.id,
      expectedPlatform: adapter.platform,
      headers: req.headers,
      body,
      declaredPlatform,
      now: now(),
      windowMs: config.replayWindowMs,
      nonceCache,
    });
  }

  /**
   * P3：工具调用方的鉴权。mcp-bus 不是适配器（不占 adapters.json 名额），
   * 但走同一套 HMAC 签名格式——共享密钥来自 config.tools.busSecret，
   * adapterId 固定 'mcp-bus'。签名格式一致意味着将来用别的语言实现薄壳时
   * 不需要新的鉴权实现。
   */
  function verifyToolAuth(req, body) {
    return verifyRequest({
      secret: config.tools.busSecret,
      expectedAdapterId: 'mcp-bus',
      headers: req.headers,
      body,
      now: now(),
      windowMs: config.replayWindowMs,
      nonceCache: toolNonceCache,
    });
  }

  // ── operator（控制台）认证通道（docs/console/auth/PLAN.md）────────────────
  // 与适配器 HMAC 并存：operator token（x-operator-token 头，给 CLI/脚本）或
  // 登录换发的签名 Cookie（给浏览器）。控制面端点一律走这条通道，数据面端点
  // （inbound / tools / actions 回投）只认适配器 HMAC。
  const revokedSessions = new Set(); // 登出吊销集合（容量受限，防内存膨胀）

  function parseCookieHeader(header) {
    const out = {};
    for (const part of String(header ?? '').split(';')) {
      const idx = part.indexOf('=');
      if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    return out;
  }

  function verifyOperator(req) {
    const header = req.headers['x-operator-token'];
    if (typeof header === 'string' && safeEqualString(header, config.console.operatorToken)) {
      metrics.inc('console_auth_total', { result: 'ok' });
      return { via: 'token' };
    }
    const cookie = parseCookieHeader(req.headers.cookie)[OPERATOR_COOKIE];
    if (typeof cookie === 'string' && cookie.length > 0) {
      const verdict = verifyOperatorSession({ secret: config.console.operatorToken, value: cookie, now });
      if (verdict.ok && !revokedSessions.has(cookie)) {
        metrics.inc('console_auth_total', { result: 'ok' });
        return { via: 'cookie', cookie, expiresAt: verdict.expiresAt };
      }
      metrics.inc('console_auth_total', { result: verdict.ok ? 'invalid' : 'expired' });
    } else {
      metrics.inc('console_auth_total', { result: 'invalid' });
    }
    throw new AuthError('E_AUTH', 'operator credential missing or invalid');
  }

  /** 控制面写操作 CSRF：写必须 JSON，带 Origin 时必须同源（SameSite=Strict 兜底）。 */
  function assertConsoleCsrf(req) {
    if (req.headers.origin) {
      try {
        const origin = new URL(String(req.headers.origin));
        if (origin.host !== String(req.headers.host ?? '')) {
          throw new ContractError('E_FORBIDDEN', 'cross-origin console request rejected');
        }
      } catch (error) {
        if (error instanceof ContractError) throw error;
        throw new ContractError('E_FORBIDDEN', 'malformed Origin header');
      }
    }
    const contentType = String(req.headers['content-type'] ?? '');
    if (!contentType.includes('application/json')) {
      throw new ContractError('E_FORBIDDEN', 'console writes require content-type application/json');
    }
  }

  /** 控制面开关守卫：off 时直接回 503（返回 true = 已处理）。 */
  function consoleDisabled(res) {
    if (config.console.mode === 'on') return false;
    sendError(res, 503, 'E_DISABLED', 'console is off (GATEWAY_CONSOLE=off)');
    return true;
  }

  /** 预设备份目录：state/gateway/preset-backups（不在 DSH 子树内）。 */
  function presetBackupDir() {
    return path.join(config.stateDir, 'preset-backups');
  }

  /** 预设文件层错误 → HTTP：找不到 404；防呆拒绝 400 E_POLICY；其余 500。 */
  function classifyPresetError(res, error) {
    const message = String(error?.message ?? error);
    if (/找不到预设文件|找不到 persona/.test(message)) {
      sendError(res, 404, 'E_SCHEMA', message);
      return;
    }
    if (/缺少安全不变量|过短|不能为空|过长|不一致，已放弃写入|没有可用的备份|拒绝还原|无法定位/.test(message)) {
      sendError(res, 400, 'E_POLICY', message);
      return;
    }
    sendError(res, 500, 'E_INTERNAL', message);
  }

  /** 双通道鉴权（/v1/turns、/v1/usage 等控制台读端点）：适配器 HMAC 或 operator 二选一。 */
  function authenticateDual(req, rawBody, declaredPlatform) {
    try {
      return { channel: 'adapter', ...authenticate(req, rawBody, declaredPlatform) };
    } catch (error) {
      if (error instanceof AuthError) {
        verifyOperator(req);
        return { channel: 'operator' };
      }
      throw error;
    }
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > config.maxBodyBytes) {
          // 不 destroy：把连接读完才能把 413 送回去；超限后的内容直接丢弃。
          tooLarge = true;
          return;
        }
        if (!tooLarge) chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooLarge) {
          reject(new ContractError('E_SCHEMA', `body exceeds ${config.maxBodyBytes} bytes`));
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      req.on('error', reject);
    });
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  function sendError(res, status, code, message) {
    sendJson(res, status, { ok: false, error: { code, message } });
  }

  // ── P4 控制台静态资源（public/console/）────────────────────────────────────
  // GET-only、扩展名白名单、normalize 后必须仍落在目录内（防路径穿越）；
  // GATEWAY_CONSOLE=off 时整组 404（控制面整体不暴露，与 API 的 503 语义独立：
  // 静态页没有存在感比「存在但拒绝」更不泄露信息）。页面本身不设鉴权——登录态
  // 由前端调 /v1/console/session 自检后切视图，数据面一律走 verifyOperator。
  const consolePublicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'console');
  const CONSOLE_STATIC_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
  };

  /** 处理控制台静态请求；返回 true = 已接管响应，false = 落回常规路由。 */
  function tryServeConsoleStatic(req, res, pathname) {
    if (req.method !== 'GET') return false;
    let rel = null;
    if (pathname === '/' || pathname === '/console' || pathname === '/console/') rel = 'index.html';
    else if (pathname.startsWith('/console/')) rel = decodeURIComponent(pathname.slice('/console/'.length));
    else return false;
    if (config.console.mode !== 'on') {
      sendError(res, 404, 'E_SCHEMA', 'not found');
      return true;
    }
    const target = path.normalize(path.join(consolePublicDir, rel));
    if (target !== consolePublicDir && !target.startsWith(consolePublicDir + path.sep)) {
      sendError(res, 404, 'E_SCHEMA', 'not found');
      return true;
    }
    const type = CONSOLE_STATIC_TYPES[path.extname(target).toLowerCase()];
    if (!type) {
      sendError(res, 404, 'E_SCHEMA', 'not found');
      return true;
    }
    let content;
    try {
      content = fs.readFileSync(target);
    } catch {
      sendError(res, 404, 'E_SCHEMA', 'not found');
      return true;
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(content);
    return true;
  }

  /**
   * 指标用的路由标签：**只允许已知路由前缀**，未知路径一律 `/other`。
   *
   * 旧实现直接把 pathname 当标签（`route=/v1/turns/<任意 id>`），任何对本机的
   * 扫描流量都会给每个 URL 生成一条时间线；id 唯一时上限无穷。
   */
  const ROUTE_ROOTS = [
    '/v1/health', '/v1/metrics', '/v1/tools', '/v1/state', '/v1/inbound',
    '/v1/console', '/v1/turns', '/v1/usage', '/v1/actions', '/v1/ws',
  ];
  function routeLabel(pathname) {
    if (pathname === '/') return '/';
    for (const root of ROUTE_ROOTS) {
      if (pathname === root) return root;
      if (pathname.startsWith(`${root}/`)) return `${root}/*`;
    }
    return '/other';
  }

  async function route(req, res) {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    try {
      if (!isLoopbackAddress(req.socket?.remoteAddress)) {
        sendError(res, 403, 'E_AUTH', 'loopback only');
        return;
      }

      // P4 控制台静态资源（/ 与 /console/*）；返回 false 落回常规路由。
      if (tryServeConsoleStatic(req, res, pathname)) return;

      if (req.method === 'GET' && pathname === '/v1/health') {
        // 公开面只回「活着、什么模式、WS 开没开」：探测脚本不需要 pid/uptime/
        // 适配器回调地址/工具与管线统计这些排障细节，而本地任意进程都能读它。
        // 要细节请带 ?detail=1 并出示 operator/adapter 凭据（走 dual 鉴权）。
        if (url.searchParams.get('detail') !== '1') {
          sendJson(res, 200, {
            ok: true,
            service: 'agent-gateway',
            version: 1,
            mode: config.mode,
            turns: turns.size,
            ws: wsHub ? { mode: 'on', path: config.ws.path, clients: wsHub.status().clients } : { mode: 'off' },
            // 只回开关状态：部署探针要能区分「管线没开」和「服务没连上」，
            // 具体 per-consumer 编排与连接明细属于排障细节（detail=1）。
            pipeline: { mode: config.pipeline.mode },
            tools: { mode: config.tools.mode },

          });
          return;
        }
        authenticateDual(req, '');
        sendJson(res, 200, {
          ok: true,
          service: 'agent-gateway',
          version: 1,
          pid: process.pid,
          uptimeMs: Date.now() - startedAt,
          mode: config.mode,
          dsh: runtime
            ? { connected: runtime.connected === true, managed: true, runtime: runtime.status() }
            : { connected: false, managed: false },
          turns: turns.size,
          whitelistedConversations: config.conversations.length,
          tools: config.tools.mode === 'on'
            ? { mode: 'on', ...(runtime?.toolStatus?.() ?? {}) }
            : { mode: 'off' },
          state: config.state.mode === 'on'
            ? { mode: 'on', ...(runtime?.stateStats?.() ?? {}) }
            : { mode: 'off' },
          // V2 客户端通道：部署探测要能看出 WS 端点开没开、谁连着。
          ws: wsHub ? { mode: 'on', ...wsHub.status() } : { mode: 'off' },
          // V2 P2 管线：模式、per-consumer 编排键与外部服务连接状态（灰度期排障要能
          // 回答「这条消息为什么没被装饰」——多半是服务没连上或管线没编排）。
          pipeline: config.pipeline.mode === 'on'
            ? { mode: 'on', ...(runtime?.pipelineStatus?.() ?? {}) }
            : { mode: 'off' },
          // 与 /v1/metrics 的 configSummary 同源：健康检查要能看出「谁登记了、
          // 声明了哪些能力、动作回投到哪」，否则灰度期只能靠猜。
          adapters: configSummary(config).adapters,
        });
        return;
      }

      const rawBody = req.method === 'POST' || req.method === 'PUT'
        ? await readBody(req)
        : '';

      if (req.method === 'GET' && pathname === '/v1/metrics') {
        authenticate(req, rawBody);
        sendJson(res, 200, { ok: true, metrics: metrics.snapshot(), config: configSummary(config) });
        return;
      }

      // ── P3 统一工具面 ──────────────────────────────────────────────────────
      if (req.method === 'GET' && pathname === '/v1/tools') {
        if (config.tools.mode !== 'on') {
          sendError(res, 503, 'E_DISABLED', 'gateway tools are off');
          return;
        }
        verifyToolAuth(req, rawBody);
        const tools = runtime?.toolList?.() ?? [];
        sendJson(res, 200, { ok: true, tools });
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/tools/call') {
        if (config.tools.mode !== 'on') {
          sendError(res, 503, 'E_DISABLED', 'gateway tools are off');
          return;
        }
        if (!runtime?.toolCall) {
          sendError(res, 503, 'E_DISABLED', 'tool runtime not assembled');
          return;
        }
        const callStarted = Date.now();
        try {
          verifyToolAuth(req, rawBody);
          let body;
          try {
            body = JSON.parse(rawBody || '{}');
          } catch {
            throw new ContractError('E_SCHEMA', 'body is not valid JSON');
          }
          const parsed = parseToolCall(body);
          const result = await runtime.toolCall(parsed);
          const payload = { v: 1, callId: parsed.callId, ok: result?.ok === true };
          if (payload.ok) payload.data = result.data ?? null;
          else payload.error = result?.error ?? { code: 'E_INTERNAL', message: 'unknown tool failure' };
          // 出站前按自家 schema 自检：工具结果形状漂移立刻暴露，而不是等薄壳解析炸掉。
          sendJson(res, 200, parseToolResult(payload));
          metrics.observe('gateway_tool_call_ms', Date.now() - callStarted, { route: 'tools/call' });
        } catch (error) {
          metrics.inc('gateway_tool_http_total', { result: 'error' });
          throw error;
        }
        return;
      }

      // ── P4 会话状态（适配器镜像写 + 控制台只读查询）────────────────────────
      // 鉴权走适配器 HMAC（bridge 就是登记在案的适配器；控制台没有网关密钥，
      // 只能经 bridge 的 /api/socialV2/* 代理进来——这正是「网关不直接暴露
      // 给浏览器」的边界）。handler 仍由 runtime 注入，core 不知道 mailbox。
      if (req.method === 'GET' && pathname === '/v1/state') {
        if (config.state.mode !== 'on') {
          sendError(res, 503, 'E_DISABLED', 'gateway state is off');
          return;
        }
        authenticate(req, rawBody);
        sendJson(res, 200, { ok: true, sessions: runtime?.stateList?.() ?? [] });
        return;
      }

      if (req.method === 'GET' && pathname.startsWith('/v1/state/')) {
        if (config.state.mode !== 'on') {
          sendError(res, 503, 'E_DISABLED', 'gateway state is off');
          return;
        }
        authenticate(req, rawBody);
        const sessionKey = decodeURIComponent(pathname.slice('/v1/state/'.length));
        if (!sessionKey) {
          sendError(res, 400, 'E_SCHEMA', 'sessionKey is required');
          return;
        }
        sendJson(res, 200, { ok: true, state: runtime?.stateGet?.(sessionKey) ?? { sessionKey, exists: false, unreadCount: 0, readThroughSeq: 0, lastUnreadSeq: 0 } });
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/state/update') {
        if (config.state.mode !== 'on') {
          sendError(res, 503, 'E_DISABLED', 'gateway state is off');
          return;
        }
        if (!runtime?.stateUpdate) {
          sendError(res, 503, 'E_DISABLED', 'state runtime not assembled');
          return;
        }
        const updateStarted = Date.now();
        try {
          authenticate(req, rawBody);
          let body;
          try {
            body = JSON.parse(rawBody || '{}');
          } catch {
            throw new ContractError('E_SCHEMA', 'body is not valid JSON');
          }
          const parsed = parseStateUpdate(body);
          const result = await runtime.stateUpdate(parsed);
          if (result?.ok !== true) {
            sendError(res, 422, result?.error?.code ?? 'E_INTERNAL', result?.error?.message ?? 'state update rejected');
            metrics.inc('gateway_state_total', { action: parsed.action, result: 'rejected' });
            return;
          }
          sendJson(res, 200, { ok: true, state: result.data });
          metrics.inc('gateway_state_total', { action: parsed.action, result: 'ok' });
          metrics.observe('gateway_state_ms', Date.now() - updateStarted, { route: 'state/update' });
        } catch (error) {
          metrics.inc('gateway_state_total', { action: 'unknown', result: 'error' });
          throw error;
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/inbound') {
        if (config.mode === 'off') {
          sendError(res, 503, 'E_DISABLED', 'gateway mode is off');
          return;
        }
        const inboundStarted = Date.now();
        try {
          let envelope;
          try {
            envelope = JSON.parse(rawBody || '{}');
          } catch {
            throw new ContractError('E_SCHEMA', 'body is not valid JSON');
          }
          const parsed = parseInbound(envelope);
          const auth = authenticate(req, rawBody, parsed.platform);
          const result = handleInbound(parsed, { adapterId: auth?.adapterId });
          metrics.observe('gateway_inbound_ms', Date.now() - inboundStarted, { route: 'inbound' });
          sendJson(res, 202, { ok: true, ...result, mode: config.mode });
        } catch (error) {
          metrics.inc('gateway_inbound_total', { platform: 'unknown', result: 'error' });
          throw error;
        }
        return;
      }

      // ── operator 会话（登录/自检/登出/换 token）────────────────────────────
      // 凭据来源与 fail-closed 语义见 config.mjs console 块；写操作强制 JSON +
      // 同源 Origin（CSRF），Cookie 带 HttpOnly/SameSite=Strict。
      if (pathname.startsWith('/v1/console/session')) {
        if (consoleDisabled(res)) return;
        if (req.method === 'POST' && pathname === '/v1/console/session') {
          assertConsoleCsrf(req);
          let body;
          try {
            body = JSON.parse(rawBody || '{}');
          } catch {
            throw new ContractError('E_SCHEMA', 'body is not valid JSON');
          }
          if (!safeEqualString(String(body?.token ?? ''), config.console.operatorToken)) {
            metrics.inc('console_auth_total', { result: 'invalid' });
            throw new AuthError('E_AUTH', 'invalid operator token');
          }
          const session = issueOperatorSession({
            secret: config.console.operatorToken,
            ttlMs: config.console.sessionTtlMs,
            now,
          });
          res.setHeader('set-cookie', operatorCookieHeader(session.value, session.expiresAt));
          sendJson(res, 200, { ok: true, expiresAt: session.expiresAt });
          return;
        }
        if (req.method === 'GET' && pathname === '/v1/console/session') {
          const auth = verifyOperator(req);
          sendJson(res, 200, { ok: true, via: auth.via, expiresAt: auth.expiresAt ?? null });
          return;
        }
        if (req.method === 'DELETE' && pathname === '/v1/console/session') {
          const auth = verifyOperator(req);
          if (auth.cookie) {
            revokedSessions.add(auth.cookie);
            // 吊销集合只增不减会变成内存漏洞：清掉已过期自然失效的条目。
            if (revokedSessions.size > 1024) {
              for (const value of revokedSessions) {
                if (!verifyOperatorSession({ secret: config.console.operatorToken, value, now }).ok) {
                  revokedSessions.delete(value);
                }
              }
            }
          }
          res.setHeader('set-cookie', operatorCookieHeader('', 0));
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method === 'POST' && pathname === '/v1/console/session/rotate') {
          assertConsoleCsrf(req);
          verifyOperator(req);
          let body;
          try {
            body = JSON.parse(rawBody || '{}');
          } catch {
            throw new ContractError('E_SCHEMA', 'body is not valid JSON');
          }
          const nextToken = typeof body?.token === 'string' && body.token.length > 0
            ? body.token.trim()
            : randomBytes(24).toString('base64url');
          if (!OPERATOR_TOKEN_PATTERN.test(nextToken)) {
            throw new ContractError('E_SCHEMA', `token must match ${OPERATOR_TOKEN_PATTERN.source}`);
          }
          // 写回凭据源：rotate 必须重启后仍然生效——优先写 state 文件
          // （内联 env 的部署由运维自行改环境变量，这里只覆盖文件源）。
          try {
            fs.mkdirSync(config.stateDir, { recursive: true });
            fs.writeFileSync(config.console.tokenFile, `${nextToken}\n`, { encoding: 'utf8', mode: 0o600 });
          } catch (error) {
            throw new ContractError('E_INTERNAL', `cannot persist operator token: ${error?.message ?? error}`);
          }
          // Cookie 用旧 token 签名：token 一换，全部旧会话自然失效（无状态签名的代价）。
          config.console.operatorToken = nextToken;
          logger('operator token rotated; all console sessions invalidated');
          sendJson(res, 200, { ok: true, generated: typeof body?.token !== 'string' || body.token.length === 0 });
          return;
        }
      }

      // ── DSH 控制面：预设清单 + 仿真提示词（docs/console/dsh-presets/PLAN.md）──
      // 数据源：清单 = DSH agentPresets.list（活 DSH）；文件 = DSH home 的
      // agent-presets 子树（preset-files.mjs，防呆在文件层）。白名单与
      // session-registry 的 ensurePresetAllowed 同源（同一个活 DSH 清单）。
      if (pathname === '/v1/console/dsh/presets' || pathname.startsWith('/v1/console/dsh/presets/')) {
        if (consoleDisabled(res)) return;
        verifyOperator(req);
        const presetFiles = runtime?.presetFiles;
        const listLive = runtime?.consoleDsh?.presetsList;
        const presetMatch = /^\/v1\/console\/dsh\/presets\/([A-Za-z0-9_-]{1,64})(\/sim-prompt)?(\/backups|\/restore)?$/.exec(pathname);
        if (req.method === 'GET' && pathname === '/v1/console/dsh/presets') {
          let ids = null;
          let dshError = null;
          try {
            ids = await listLive();
          } catch (error) {
            dshError = String(error?.message ?? error);
          }
          if (ids === null) {
            sendError(res, 503, 'E_DSH_DOWN', `DSH 预设清单不可用：${dshError ?? '未知原因'}`);
            return;
          }
          sendJson(res, 200, {
            ok: true,
            source: 'dsh',
            presets: ids.map((id) => ({
              id,
              editable: presetFiles ? Boolean(presetFiles.describePreset(id).installed) : false,
              ...(presetFiles ? presetFiles.describePreset(id) : {}),
            })),
          });
          return;
        }
        if (presetMatch) {
          const presetId = presetMatch[1];
          const sub = presetMatch[2] ?? '';
          const tail = presetMatch[3] ?? '';
          if (!presetFiles) {
            sendError(res, 503, 'E_DISABLED', 'preset file layer not wired (runtime.presetFiles missing)');
            return;
          }
          if (req.method === 'GET' && !sub) {
            sendJson(res, 200, { ok: true, ...presetFiles.describePreset(presetId) });
            return;
          }
          if (req.method === 'GET' && sub === '/sim-prompt' && !tail) {
            try {
              sendJson(res, 200, { ok: true, ...presetFiles.readSimPrompt(presetId) });
            } catch (error) {
              classifyPresetError(res, error);
            }
            return;
          }
          if (req.method === 'PUT' && sub === '/sim-prompt' && !tail) {
            assertConsoleCsrf(req);
            let body;
            try {
              body = JSON.parse(rawBody || '{}');
            } catch {
              throw new ContractError('E_SCHEMA', 'body is not valid JSON');
            }
            if (typeof body?.content !== 'string') {
              throw new ContractError('E_SCHEMA', 'content must be a string');
            }
            try {
              const result = presetFiles.writeSimPrompt(presetId, body.content, {
                backupDir: presetBackupDir(),
                now,
              });
              logger(`sim-prompt saved: preset=${presetId} changed=${result.changed}${result.backup ? ` backup=${path.basename(result.backup)}` : ''}`);
              sendJson(res, 200, { ok: true, ...result });
            } catch (error) {
              classifyPresetError(res, error);
            }
            return;
          }
          if (req.method === 'GET' && sub === '/sim-prompt' && tail === '/backups') {
            sendJson(res, 200, { ok: true, backups: presetFiles.listPresetBackups(presetId, presetBackupDir()) });
            return;
          }
          if (req.method === 'POST' && sub === '/sim-prompt' && tail === '/restore') {
            assertConsoleCsrf(req);
            let body;
            try {
              body = JSON.parse(rawBody || '{}');
            } catch {
              throw new ContractError('E_SCHEMA', 'body is not valid JSON');
            }
            try {
              const result = presetFiles.restorePresetBackup(presetId, body?.file, {
                backupDir: presetBackupDir(),
                now,
              });
              logger(`sim-prompt restored: preset=${presetId} from=${result.restoredFrom}`);
              sendJson(res, 200, { ok: true, ...result });
            } catch (error) {
              classifyPresetError(res, error);
            }
            return;
          }
        }
      }

      // ── DSH 控制面：模型目录 / 思考强度 / 会话列表（docs/console/dsh-sessions/PLAN.md）──
      if (pathname === '/v1/console/dsh/model' || pathname === '/v1/console/dsh/sessions') {
        if (consoleDisabled(res)) return;
        verifyOperator(req);
        const consoleDsh = runtime?.consoleDsh;
        if (!consoleDsh) {
          sendError(res, 503, 'E_DISABLED', 'DSH console handlers not wired (runtime.consoleDsh missing)');
          return;
        }
        if (req.method === 'GET' && pathname === '/v1/console/dsh/model') {
          let catalog = null;
          let source = 'fallback';
          try {
            catalog = await consoleDsh.modelCatalog();
            source = 'dsh';
          } catch (error) {
            logger(`model catalog unavailable, using fallback: ${error?.message ?? error}`);
          }
          sendJson(res, 200, {
            ok: true,
            source,
            chat: {
              provider: consoleDsh.chat.provider,
              model: consoleDsh.chat.model,
              reasoningEffort: consoleDsh.chat.reasoningEffort,
              preset: consoleDsh.chat.preset,
            },
            catalog: catalog ?? {
              efforts: consoleDsh.fallbackEfforts,
              defaultEffort: consoleDsh.fallbackEfforts.at(-1),
            },
            sideEffects: 'session.selectModel 会同时改写 ~/.dsh/settings.yaml 的 agent-default-model（全局副作用，影响所有新会话的默认模型）',
            epoch: consoleDsh.epoch,
          });
          return;
        }
        if (req.method === 'PUT' && pathname === '/v1/console/dsh/model') {
          assertConsoleCsrf(req);
          let body;
          try {
            body = JSON.parse(rawBody || '{}');
          } catch {
            throw new ContractError('E_SCHEMA', 'body is not valid JSON');
          }
          const chat = consoleDsh.chat;
          const model = typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : chat.model;
          if (!model) throw new ContractError('E_SCHEMA', 'model must be a non-empty string');
          const nextEffort = body?.reasoningEffort === undefined ? chat.reasoningEffort : String(body.reasoningEffort);
          // 白名单：活 DSH 的 modelCatalog 优先；不可用时退回内置（与桥接一致）。
          let allowed = consoleDsh.fallbackEfforts;
          let effortSource = 'fallback';
          try {
            const value = await consoleDsh.modelCatalog();
            const current = (value?.groups ?? []).flatMap((g) => g?.models ?? [])
              .find((m) => m?.id === model || m?.model === model);
            const efforts = (current?.reasoning?.efforts ?? []).map((e) => e?.id ?? e?.name).filter(Boolean);
            if (efforts.length > 0) {
              allowed = efforts;
              effortSource = 'dsh';
            }
          } catch { /* 目录不可用：用内置白名单 */ }
          if (!allowed.includes(nextEffort)) {
            throw new ContractError('E_SCHEMA', `思考强度只能是 ${allowed.join(' / ')}（来源：${effortSource}）`);
          }
          chat.model = model;
          chat.reasoningEffort = nextEffort;
          consoleDsh.persistModelOverlay({ model, reasoningEffort: nextEffort });
          logger(`console model updated: ${chat.provider}/${chat.model} effort=${chat.reasoningEffort}（对所有会话在下一轮生效）`);
          sendJson(res, 200, {
            ok: true,
            chat: { provider: chat.provider, model: chat.model, reasoningEffort: chat.reasoningEffort },
            effortSource,
            sideEffects: '对所有会话在下一轮 inbound 时重新 selectModel 生效；DSH agent-default-model 同步变更',
          });
          return;
        }
        if (req.method === 'GET' && pathname === '/v1/console/dsh/sessions') {
          const sessions = consoleDsh.registry.list();
          // 活跃度：turn store 内存里按 sessionKey 取最后一条记录时间。
          const lastTurnAt = new Map();
          for (const { record } of turns.recent(Math.min(turns.size, 1000))) {
            if (record?.sessionKey && !lastTurnAt.has(record.sessionKey)) lastTurnAt.set(record.sessionKey, record.at);
          }
          sendJson(res, 200, {
            ok: true,
            sessions: sessions.map((s) => ({ ...s, lastTurnAt: lastTurnAt.get(s.sessionKey) ?? null })),
          });
          return;
        }
      }

      // ── DSH pending 应答（docs/console/dsh-pending/PLAN.md 应答阶段）─────────
      // POST /v1/console/pending/{eventId}/respond：审批 { decision } / 提问
      // { answers }。红线：只有 operator 显式处置才调 $events/result（无任何
      // 自动应答路径）；outcome 形状与桥接回滚形态同源实测（快照仓
      // dsh-client.js respond / bridge.js handlePendingAnswer）。成功后条目出列，
      // 失败保留以便重试；未知/已淘汰 eventId → 404 E_SCHEMA。
      const pendingRespondMatch = /^\/v1\/console\/pending\/([A-Za-z0-9_-]{1,128})\/respond$/.exec(pathname);
      if (pendingRespondMatch) {
        if (consoleDisabled(res)) return;
        verifyOperator(req);
        const pendingView = runtime?.pending;
        if (!pendingView?.respond || !pendingView?.entry) {
          sendError(res, 503, 'E_DISABLED', 'runtime not assembled (mode=off?)');
          return;
        }
        if (req.method !== 'POST') {
          sendError(res, 404, 'E_SCHEMA', `unknown console path: ${pathname}`);
          return;
        }
        assertConsoleCsrf(req);
        let body;
        try {
          body = JSON.parse(rawBody || '{}');
        } catch {
          throw new ContractError('E_SCHEMA', 'body is not valid JSON');
        }
        const eventId = pendingRespondMatch[1];
        const entry = pendingView.entry(eventId);
        if (!entry) {
          sendError(res, 404, 'E_SCHEMA', 'unknown or evicted pending event');
          return;
        }
        let outcome;
        if (entry.kind === 'approval') {
          if (body?.decision !== 'approve' && body?.decision !== 'deny') {
            sendError(res, 400, 'E_SCHEMA', 'approval respond requires { decision: "approve" | "deny" }');
            return;
          }
          outcome = { kind: 'result', value: body.decision === 'approve' ? 'allowed-once' : 'rejected' };
        } else {
          const answers = body?.answers;
          const valid = Array.isArray(answers) && answers.length > 0 && answers.length <= 20
            && answers.every((a) => a && typeof a.id === 'string'
              && (a.selected === undefined || (Array.isArray(a.selected)
                && a.selected.every((s) => typeof s === 'string')))
              && (a.custom === undefined || typeof a.custom === 'string'));
          if (!valid) {
            sendError(res, 400, 'E_SCHEMA', 'question respond requires { answers: [{ id, selected?, custom? }] }');
            return;
          }
          outcome = { kind: 'result', value: { answers } };
        }
        try {
          await pendingView.respond(eventId, outcome);
        } catch (error) {
          logger(`pending respond failed (${eventId}): ${error?.message ?? error}`);
          sendError(res, 502, 'E_DSH_DOWN', `respond rejected by DSH: ${error?.message ?? 'unknown error'}`);
          return;
        }
        sendJson(res, 200, { ok: true, eventId, kind: entry.kind });
        return;
      }

      // ── DSH pending 查看（docs/console/dsh-pending/PLAN.md）────────────────
      // 数据源 = dsh-gateway 暂存 Map（进程内，重启即清空）；sessionKey 经
      // registry 反查，无映射标 unmapped。应答走上方 /respond（operator 显式处置）。
      if (pathname === '/v1/console/pending') {
        if (consoleDisabled(res)) return;
        verifyOperator(req);
        const pendingView = runtime?.pending;
        if (!pendingView?.list) {
          sendError(res, 503, 'E_DISABLED', 'runtime not assembled (mode=off?)');
          return;
        }
        if (req.method !== 'GET') {
          sendError(res, 404, 'E_SCHEMA', `unknown console path: ${pathname}`);
          return;
        }
        const kindParam = url.searchParams.get('kind');
        if (kindParam && !['question', 'approval'].includes(kindParam)) {
          sendError(res, 400, 'E_SCHEMA', 'kind must be question|approval');
          return;
        }
        const registry = runtime.consoleDsh?.registry ?? null;
        const limitRaw = Number(url.searchParams.get('limit'));
        const limit = Number.isSafeInteger(limitRaw) && limitRaw > 0
          ? Math.min(limitRaw, pendingView.capacity) : pendingView.capacity;
        const sessionKeyParam = url.searchParams.get('sessionKey');
        const rows = [];
        for (const entry of pendingView.list(kindParam ? { kind: kindParam } : {})) {
          const sessionKey = registry?.sessionKeyOf?.(entry.sessionId) ?? null;
          const row = {
            eventId: entry.eventId,
            kind: entry.kind,
            sessionId: entry.sessionId,
            sessionKey,
            mapped: Boolean(sessionKey),
            at: entry.at,
            ageMs: Math.max(0, now() - entry.at),
          };
          if (entry.kind === 'approval') {
            row.toolName = entry.toolName ?? null;
            row.callId = entry.callId ?? null;
            row.reason = entry.reason ?? null;
          } else {
            row.questions = entry.questions ?? [];
          }
          rows.push(row);
        }
        const filtered = sessionKeyParam ? rows.filter((row) => row.sessionKey === sessionKeyParam) : rows;
        sendJson(res, 200, {
          ok: true,
          pending: filtered.slice(0, limit),
          total: filtered.length,
          capacity: pendingView.capacity,
          forward: pendingView.forward,
        });
        return;
      }

      // ── 用量与计费（usage-billing）：纯 operator 通道；显式拒绝 agent 凭据
      //（跨群花费是管理信息，不能让群里的 AI 读到——语义对标桥接旧端点双保险）。
      if (pathname === '/v1/console/usage' || pathname.startsWith('/v1/console/usage/')) {
        if (consoleDisabled(res)) return;
        if (typeof req.headers['x-agent-token'] === 'string') {
          sendError(res, 403, 'E_FORBIDDEN', 'agent token is not allowed on billing endpoints');
          return;
        }
        verifyOperator(req);
        const ledger = runtime?.usageLedger;
        if (!ledger) {
          sendError(res, 503, 'E_DISABLED', 'usage ledger not assembled (runtime.usageLedger missing)');
          return;
        }
        const usageMatch = /^\/v1\/console\/usage\/(summary|series|recent|prices|reset)$/.exec(pathname);
        const convMatch = /^\/v1\/console\/usage\/conversations\/(.+)$/.exec(pathname);
        if (req.method === 'GET' && usageMatch?.[1] === 'summary') {
          sendJson(res, 200, ledger.summary({ limit: Number(url.searchParams.get('limit')) || 200 }));
          return;
        }
        if (req.method === 'GET' && usageMatch?.[1] === 'series') {
          sendJson(res, 200, ledger.series({
            hours: Number(url.searchParams.get('hours')) || 24,
            maxBuckets: Number(url.searchParams.get('buckets')) || 48,
          }));
          return;
        }
        if (req.method === 'GET' && usageMatch?.[1] === 'recent') {
          sendJson(res, 200, { ok: true, samples: ledger.recent(Number(url.searchParams.get('limit')) || 50) });
          return;
        }
        if (req.method === 'GET' && usageMatch?.[1] === 'prices') {
          const snapshot = ledger.summary({ limit: 1 });
          sendJson(res, 200, {
            ok: true,
            version: snapshot.priceTable.version,
            symbol: snapshot.priceTable.symbol,
            currency: snapshot.priceTable.currency,
            models: snapshot.priceTable.models,
            peakWindows: snapshot.priceTable.peakWindows,
            holidayCount: snapshot.priceTable.holidayCount,
          });
          return;
        }
        if (req.method === 'POST' && usageMatch?.[1] === 'reset') {
          assertConsoleCsrf(req);
          let body;
          try {
            body = JSON.parse(rawBody || '{}');
          } catch {
            throw new ContractError('E_SCHEMA', 'body is not valid JSON');
          }
          if (body?.confirm !== 'reset') {
            throw new ContractError('E_SCHEMA', 'reset requires { confirm: "reset" }');
          }
          const before = ledger.stats();
          ledger.reset();
          logger(`usage ledger reset by operator (before: ${JSON.stringify(before)})`);
          sendJson(res, 200, { ok: true, resetAt: now(), before });
          return;
        }
        if (req.method === 'GET' && convMatch) {
          const view = ledger.conversation(decodeURIComponent(convMatch[1]), {
            turnLimit: Number(url.searchParams.get('limit')) || 200,
          });
          if (!view) {
            sendError(res, 404, 'E_SCHEMA', 'unknown conversation');
            return;
          }
          sendJson(res, 200, view);
          return;
        }
      }

      // ── 适配器总览（adapters-overview）：流量（turn store 扫描）+ 消费
      //（ledger.byAdapter 同源聚合，总花费与 usage/summary 口径一致）。
      if (pathname === '/v1/console/adapters' || pathname.startsWith('/v1/console/adapters/')) {
        if (consoleDisabled(res)) return;
        if (typeof req.headers['x-agent-token'] === 'string') {
          sendError(res, 403, 'E_FORBIDDEN', 'agent token is not allowed on billing endpoints');
          return;
        }
        verifyOperator(req);
        const ledger = runtime?.usageLedger;
        if (!ledger) {
          sendError(res, 503, 'E_DISABLED', 'usage ledger not assembled (runtime.usageLedger missing)');
          return;
        }
        const adapterUsageMatch = /^\/v1\/console\/adapters\/([A-Za-z0-9_-]+)\/usage$/.exec(pathname);
        if (req.method === 'GET' && adapterUsageMatch) {
          sendJson(res, 200, ledger.series({
            hours: Number(url.searchParams.get('hours')) || 24,
            maxBuckets: Number(url.searchParams.get('buckets')) || 48,
            adapterId: adapterUsageMatch[1],
          }));
          return;
        }
        if (req.method !== 'GET' || pathname !== '/v1/console/adapters') {
          sendError(res, 404, 'E_SCHEMA', `unknown console path: ${pathname}`);
          return;
        }
        const windowHours = Number(String(url.searchParams.get('window') ?? '24h').replace(/h$/, '')) || 24;
        const since = now() - windowHours * 60 * 60 * 1000;
        const byId = new Map();
        for (const { record } of turns.recent(Math.min(turns.size, 5000))) {
          const at = record?.finishedAt ?? record?.at ?? 0;
          if (at < since) continue;
          const aid = record?.envelope?.adapterId ?? '(unknown)';
          let entry = byId.get(aid);
          if (!entry) {
            entry = { lastTurnAt: 0, turns: 0, errors: 0, errorCodes: {}, wakes: {} };
            byId.set(aid, entry);
          }
          entry.turns += 1;
          entry.lastTurnAt = Math.max(entry.lastTurnAt, at);
          const errorCode = record?.result?.error?.code;
          if (errorCode) {
            entry.errors += 1;
            entry.errorCodes[errorCode] = (entry.errorCodes[errorCode] ?? 0) + 1;
          }
          const wake = record?.envelope?.wake?.kind;
          if (wake) entry.wakes[wake] = (entry.wakes[wake] ?? 0) + 1;
        }
        const registered = new Map(config.adapters.map((a) => [a.id, a]));
        // P4.x 统一消费端总览：登记目录 kind=consumer 服务并入视图（多平台统筹
        // 语义——「消费端」= adapters.json 适配器 ∪ 登记消费端，前者承载入站
        // 认证，后者承载编排/工具 roles；同 id 双来源标注 both，认证语义不动）。
        const registryConsumers = (services?.registrations?.() ?? [])
          .filter((registration) => registration.kind === 'consumer')
          .map((registration) => ({
            id: registration.id,
            name: registration.name,
            enabled: registration.enabled !== false,
            // roles 从该服务的登记工具声明聚合（编排能力面）。
            roles: [...new Set((services.registeredTools?.() ?? [])
              .filter((tool) => tool.serviceId === registration.id)
              .flatMap((tool) => tool.roles))],
          }));
        const registryById = new Map(registryConsumers.map((consumer) => [consumer.id, consumer]));
        const consumption = new Map(ledger.byAdapter().map((row) => [row.adapterId, row]));
        const ids = new Set([...registered.keys(), ...registryById.keys(), ...byId.keys(), ...consumption.keys()]);
        const adapters = [...ids].map((id) => {
          const flow = byId.get(id) ?? null;
          const cost = consumption.get(id) ?? null;
          const inAdapters = registered.has(id);
          const inRegistry = registryById.has(id);
          const source = inAdapters && inRegistry ? 'both' : (inRegistry ? 'registry' : 'adapters.json');
          return {
            id,
            // 展示名：登记消费端用登记 name，adapters.json 适配器无展示名（id 即名）。
            name: registryById.get(id)?.name ?? null,
            platform: registered.get(id)?.platform ?? null,
            // 来源标注（P4.x 只增字段）：adapters.json | registry | both。
            source,
            registered: inAdapters,
            unregistered: !inAdapters && !inRegistry,
            enabled: inRegistry ? registryById.get(id).enabled : (inAdapters ? true : null),
            roles: registryById.get(id)?.roles ?? [],
            lastTurnAt: flow?.lastTurnAt ?? cost?.lastAt ?? null,
            turns: flow?.turns ?? 0,
            errors: flow?.errors ?? 0,
            errorCodes: flow?.errorCodes ?? {},
            wakes: flow?.wakes ?? {},
            tokens: cost?.totalTokens ?? 0,
            cost: cost?.cost ?? 0,
          };
        });
        // 平台维度汇总（P4.x 多平台统筹）：同窗口内按 platform 的用量/花费。
        const platforms = typeof ledger.byPlatform === 'function' ? ledger.byPlatform() : [];
        sendJson(res, 200, { ok: true, windowHours, adapters, platforms });
        return;
      }

      // ── P4 控制台：服务注册/卸载/台账（docs/console/registry-ui/PLAN.md）──────
      // 「文件系统就是登记 API 的磁盘形态」：注册 = 写 <id>.json（文件名即身份），
      // 卸载 = 删文件；写后 scanRegistrations('operator') 即时生效并落 append-only
      // 台账。secret 永不回显、不进登记文件——单独落 stateDir/secrets/<id>.secret
      // （0600），登记只存 secretFile 引用（resolveSecret 相对 stateDir 解析）。
      if (pathname === '/v1/console/services' || pathname.startsWith('/v1/console/services/')) {
        if (consoleDisabled(res)) return;
        if (!services) {
          sendError(res, 503, 'E_DISABLED', 'service registry not assembled (GATEWAY_PIPELINE and GATEWAY_TOOLS both off)');
          return;
        }
        if (req.method !== 'GET') assertConsoleCsrf(req);
        verifyOperator(req);
        if (req.method === 'GET' && pathname === '/v1/console/services') {
          sendJson(res, 200, {
            ok: true,
            registrationsEnabled: Boolean(config.registrations),
            services: services.services(),
            registrations: services.registrations(),
            tools: services.registeredTools(),
          });
          return;
        }
        if (req.method === 'GET' && pathname === '/v1/console/services/ledger') {
          const view = services.registrationLedger({
            limit: Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 1000),
          });
          if (!view) {
            sendError(res, 503, 'E_DISABLED', 'registration ledger not enabled');
            return;
          }
          sendJson(res, 200, { ok: true, ...view });
          return;
        }
        if (req.method === 'POST' && pathname === '/v1/console/services') {
          if (!config.registrations) {
            sendError(res, 503, 'E_DISABLED', 'registration directory not configured');
            return;
          }
          let body;
          try {
            body = JSON.parse(String(rawBody || '{}'));
          } catch {
            throw new ContractError('E_SCHEMA', 'body is not valid JSON');
          }
          const { name, kind, transport, url, timeoutMs, tools, secret, secretEnv } = body ?? {};
          // secret 必填（二选一）：登记服务与网关之间是 HMAC（service.call 出站
          // 签名 + WS 握手鉴权），没有凭据的服务装载必被 resolveSecret 拒载——
          // 挡在落盘前（fail-closed），不让 UI 产出注定 reject 的登记文件。
          if (secret !== undefined && secretEnv !== undefined) {
            sendError(res, 400, 'E_SCHEMA', 'provide exactly one of secret | secretEnv');
            return;
          }
          if (secret === undefined && secretEnv === undefined) {
            sendError(res, 400, 'E_SCHEMA', 'registration requires a credential: provide secret or secretEnv (service HMAC)');
            return;
          }
          const id = newRegistrationId();
          // url 回环前置校验：与装载同口径（assertLoopbackUrl），错误先于落盘给出。
          if (typeof url === 'string' && url) {
            try {
              assertLoopbackUrl(url, String(name ?? '(pending)'));
            } catch (error) {
              sendError(res, 400, 'E_SCHEMA', error?.message ?? String(error));
              return;
            }
          }
          const reg = { v: 1, id, name, kind, transport, enabled: true };
          if (url !== undefined) reg.url = url;
          if (timeoutMs !== undefined) reg.timeoutMs = timeoutMs;
          if (tools !== undefined) reg.tools = tools;
          if (secretEnv !== undefined) reg.secretEnv = secretEnv;
          try {
            parseServiceRegistration(reg);
          } catch (error) {
            sendError(res, 400, 'E_SCHEMA', error?.message ?? String(error));
            return;
          }
          if (secret !== undefined) {
            if (typeof secret !== 'string' || secret.length < 16) {
              sendError(res, 400, 'E_SCHEMA', 'secret must be a string of at least 16 characters');
              return;
            }
            // 密钥独立落盘（0600），登记文件只存相对 stateDir 的 secretFile 引用。
            const secretsDir = path.join(config.stateDir, 'secrets');
            fs.mkdirSync(secretsDir, { recursive: true });
            fs.writeFileSync(path.join(secretsDir, `${id}.secret`), `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
            reg.secretFile = `secrets/${id}.secret`;
            try {
              parseServiceRegistration(reg); // 带上 secretFile 后终校验
            } catch (error) {
              try { fs.rmSync(path.join(secretsDir, `${id}.secret`), { force: true }); } catch { /* 尽力清理 */ }
              sendError(res, 400, 'E_SCHEMA', error?.message ?? String(error));
              return;
            }
          }
          fs.mkdirSync(config.registrations.dir, { recursive: true });
          fs.writeFileSync(
            path.join(config.registrations.dir, `${id}.json`),
            `${JSON.stringify(reg, null, 2)}\n`,
            { encoding: 'utf8', mode: 0o600 },
          );
          const changed = services.scanRegistrations('operator');
          metrics.inc('console_service_total', { action: 'register' });
          // active=false 意味着装载被拒（如 secretEnv 未在环境里）——文件与台账
          // 留痕，UI 据此提示修复（登记按份 fail-safe：坏文件不拖垮网关）。
          const active = services.registrations().some((entry) => entry.id === id);
          logger(`console: service registered via UI: ${id} (kind=${reg.kind} active=${active})`);
          sendJson(res, 201, { ok: true, id, name: reg.name, kind: reg.kind, active });
          return;
        }
        const unregisterMatch = /^\/v1\/console\/services\/([0-9a-f]{32})$/.exec(pathname);
        if (req.method === 'DELETE' && unregisterMatch) {
          if (!config.registrations) {
            sendError(res, 503, 'E_DISABLED', 'registration directory not configured');
            return;
          }
          const id = unregisterMatch[1];
          const entry = services.registrations().find((candidate) => candidate.id === id);
          if (!entry) {
            sendError(res, 404, 'E_SCHEMA', `unknown registration: ${id}`);
            return;
          }
          fs.rmSync(path.join(config.registrations.dir, entry.file), { force: true });
          // 配套密钥文件一并撤销（登记已删，密钥无主）。
          try { fs.rmSync(path.join(config.stateDir, 'secrets', `${id}.secret`), { force: true }); } catch { /* 尽力清理 */ }
          const changed = services.scanRegistrations('operator');
          metrics.inc('console_service_total', { action: 'unregister' });
          logger(`console: service unregistered via UI: ${id} (applied=${changed})`);
          sendJson(res, 200, { ok: true, id });
          return;
        }
        sendError(res, 404, 'E_SCHEMA', `unknown console path: ${pathname}`);
        return;
      }

      // ── P4/P5 控制台：通路/回路编排（per-consumer 管线读写）───────────────────
      // 双向完整闭环（保存即生效：updateConsumerPipeline 原子落盘 + 热加载）。
      // P5：回路引擎已接通（发送动作外发文本过 returnPipelines，deliverAction
      // 拦截点）——returnEffective 取引擎真实开关（off 回滚 = false，标注回
      // 「已配置未生效」）。
      if (pathname === '/v1/console/pipelines' || pathname.startsWith('/v1/console/pipelines/')) {
        if (consoleDisabled(res)) return;
        if (!services) {
          sendError(res, 503, 'E_DISABLED', 'service registry not assembled (GATEWAY_PIPELINE and GATEWAY_TOOLS both off)');
          return;
        }
        if (req.method !== 'GET') assertConsoleCsrf(req);
        verifyOperator(req);
        // 步骤名三级解析的候选集：内置（pipeline 注入）→ 登记服务 id →
        // 装饰器/过滤器角色的登记工具名。管线 off 时 builtin 为空表。
        const builtinSteps = new Set(pipeline ? pipeline.status().builtinSteps : []);
        const returnEffective = pipeline?.status?.().returnEffective === true;
        if (req.method === 'GET' && pathname === '/v1/console/pipelines') {
          const forwardBy = new Map(services.pipelinesView().map((entry) => [entry.key, entry.steps]));
          const returnBy = new Map(services.returnPipelinesView().map((entry) => [entry.key, entry.steps]));
          const consumers = [
            ...config.adapters.map((adapter) => ({ id: adapter.id, kind: 'adapter', platform: adapter.platform })),
            ...services.registrations()
              .filter((registration) => registration.kind === 'consumer' && registration.enabled !== false)
              .map((registration) => ({ id: registration.id, kind: 'registered-consumer', platform: null })),
          ];
          sendJson(res, 200, {
            ok: true,
            pipelineMode: config.pipeline.mode,
            consumers: consumers.map((consumer) => ({
              ...consumer,
              forward: forwardBy.get(consumer.id) ?? [],
              return: returnBy.get(consumer.id) ?? [],
              returnEffective,
            })),
            default: {
              forward: forwardBy.get('default') ?? [],
              return: returnBy.get('default') ?? [],
            },
            available: {
              builtin: [...builtinSteps],
              services: services.services().map(({ id, kind }) => ({ id, kind })),
              tools: services.registeredTools()
                .filter((tool) => tool.roles.includes('decorator') || tool.roles.includes('filter'))
                .map(({ serviceId, name, roles }) => ({ serviceId, name, roles })),
            },
          });
          return;
        }
        const pipelineMatch = /^\/v1\/console\/pipelines\/([A-Za-z0-9:_-]{1,64})$/.exec(pathname);
        if (req.method === 'PUT' && pipelineMatch) {
          let body;
          try {
            body = JSON.parse(String(rawBody || '{}'));
          } catch {
            throw new ContractError('E_SCHEMA', 'body is not valid JSON');
          }
          // 两个方向都必须显式给出（数组，可为空 = 删除该方向编排 → 透传）。
          // 条目双形态（P4.x）：字符串步骤名或规则对象（once/join/text/fn…）——
          // 形状与 regex/fn 规则 fail-closed 校验复用 registry 的条目校验器
          //（与启动/热加载同口径），归一清单供未知步骤检查（static 不解析）。
          const { forward, return: returnSteps } = body ?? {};
          for (const [label, steps] of [['forward', forward], ['return', returnSteps]]) {
            if (!Array.isArray(steps)) {
              sendError(res, 400, 'E_SCHEMA', `body.${label} must be an array of step entries (name string or rule object)`);
              return;
            }
            if (steps.length > 16) {
              sendError(res, 400, 'E_SCHEMA', `body.${label} exceeds 16 steps`);
              return;
            }
          }
          let forwardInspected;
          let returnInspected;
          try {
            forwardInspected = forward.length > 0 ? services.inspectPipelineSteps(forward) : [];
            returnInspected = returnSteps.length > 0 ? services.inspectPipelineSteps(returnSteps) : [];
          } catch (error) {
            sendError(res, 400, 'E_SCHEMA', error?.message ?? String(error));
            return;
          }
          // 步骤名三级解析前置校验（fail-closed，写盘前给出明细）：本地静态
          // 供料条目（text）不解析，其余必须命中内置/登记服务/装饰器工具。
          const unknown = [...forwardInspected, ...returnInspected]
            .filter((entry) => !entry.static)
            .map((entry) => entry.name)
            .filter((name) => !builtinSteps.has(name) && !services.resolveService(name) && !services.resolveToolStep(name));
          if (unknown.length > 0) {
            sendError(res, 400, 'E_SCHEMA', `unknown pipeline step(s): ${unknown.join(', ')}`);
            return;
          }
          try {
            services.updateConsumerPipeline(
              pipelineMatch[1],
              forward.length > 0 ? forward : null,
              returnSteps.length > 0 ? returnSteps : null,
            );
          } catch (error) {
            // 消费端身份门禁 / 形状校验失败：写盘发生在校验之后，失败即未生效。
            sendError(res, 400, 'E_SCHEMA', error?.message ?? String(error));
            return;
          }
          metrics.inc('console_pipeline_total', { action: 'update' });
          const stepNames = (steps) => steps.map((step) => (typeof step === 'string' ? step : step?.step)).join(', ');
          logger(`console: pipeline updated via UI: ${pipelineMatch[1]} forward=[${stepNames(forward)}] return=[${stepNames(returnSteps)}]`);
          sendJson(res, 200, {
            ok: true,
            consumerId: pipelineMatch[1],
            forward,
            return: returnSteps,
            returnEffective,
          });
          return;
        }
        sendError(res, 404, 'E_SCHEMA', `unknown console path: ${pathname}`);
        return;
      }

      // 控制台用：turn 列表（不带正文，正文从不落盘）与 token 用量。
      // 双通道鉴权：适配器 HMAC 或 operator 凭据二选一——浏览器/CLI 直连网关
      // 成为可能，「经桥接代理读取」的临时形态就此终结（docs/console/auth/PLAN.md）。
      if (req.method === 'GET' && pathname === '/v1/turns') {
        authenticateDual(req, rawBody);
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
        const sessionKey = url.searchParams.get('sessionKey');
        const list = turns.recent(limit)
          .filter(({ record }) => !sessionKey || record?.sessionKey === sessionKey)
          .map(({ turnId, record }) => ({
            turnId,
            sessionKey: record?.sessionKey ?? null,
            platform: record?.envelope?.platform ?? null,
            status: record?.status ?? null,
            at: record?.at ?? null,
            finishedAt: record?.finishedAt ?? null,
            messageId: record?.envelope?.message?.id ?? null,
            wake: record?.envelope?.wake ?? null,
            result: record?.result ?? null,
          }));
        sendJson(res, 200, { ok: true, turns: list, total: turns.size });
        return;
      }

      if (req.method === 'GET' && pathname === '/v1/usage') {
        authenticateDual(req, rawBody);
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 1000);
        const sinceRaw = Number(url.searchParams.get('since'));
        const since = Number.isFinite(sinceRaw) ? sinceRaw : 0;
        const sessionKey = url.searchParams.get('sessionKey');
        const rows = turns.recent(limit)
          .filter(({ record }) => record?.result?.usage
            && (record.finishedAt ?? record.at ?? 0) >= since
            && (!sessionKey || record?.sessionKey === sessionKey))
          .map(({ turnId, record }) => ({
            turnId,
            sessionKey: record.sessionKey,
            platform: record?.envelope?.platform ?? null,
            at: record.finishedAt ?? record.at ?? null,
            wake: record?.result?.wake ?? null,
            // adapters-overview 的对账字段：行投影补齐 envelope.adapterId。
            adapterId: record?.envelope?.adapterId ?? null,
            usage: record.result.usage,
          }));
        sendJson(res, 200, { ok: true, usage: rows });
        return;
      }

      const turnMatch = /^\/v1\/turns\/([A-Za-z0-9_-]+)$/.exec(pathname);
      if (req.method === 'GET' && turnMatch) {
        authenticateDual(req, rawBody);
        const record = turns.get(turnMatch[1]);
        if (!record) {
          sendError(res, 404, 'E_SCHEMA', `unknown turn: ${turnMatch[1]}`);
          return;
        }
        sendJson(res, 200, { ok: true, record });
        return;
      }

      sendError(res, 404, 'E_SCHEMA', `unknown route: ${req.method} ${pathname}`);
    } catch (error) {
      if (error instanceof AuthError) {
        sendError(res, 401, error.code, error.message);
        return;
      }
      if (error instanceof ContractError) {
        const status = /exceeds .* bytes/.test(error.message) ? 413
          : error.code === 'E_FORBIDDEN' ? 403
            : 400;
        sendError(res, status, error.code, error.message);
        return;
      }
      logger(`gateway: internal error on ${req.method} ${pathname}: ${error?.stack ?? error}`);
      sendError(res, 500, 'E_INTERNAL', 'internal error');
    } finally {
      metrics.observe('gateway_request_ms', Date.now() - started, { route: routeLabel(pathname), method: req.method ?? '' });
    }
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      logger(`gateway: unhandled route error: ${error?.stack ?? error}`);
      try { sendError(res, 500, 'E_INTERNAL', 'internal error'); } catch { /* headers already sent */ }
    });
  });

  // V2 客户端通道（GATEWAY_WS=on 时）：与 HTTP 同一端口、同一消费者登记表、
  // 同一 nonce 缓存语义。off 时不挂 upgrade 监听，行为与旧版完全一致。
  // off 模式下 WS 入站直接回 E_DISABLED（对齐 /v1/inbound 的 503 语义）。
  const wsHub = config.ws?.mode === 'on'
    ? createWsHub({
      server,
      path: config.ws.path,
      clientsById: wsClientsById,
      nonceCache,
      heartbeatMs: config.ws.heartbeatMs,
      replayWindowMs: config.replayWindowMs,
      onInbound: (parsed, entry) => {
        if (config.mode === 'off') {
          // 帧级回 E_DISABLED（对齐 /v1/inbound 的 503 语义）；连接保持，
          // 客户端切模式后无需重连。
          throw new ContractError('E_DISABLED', 'gateway mode is off');
        }
        // entry.id = 握手身份：幂等键按消费者隔离，同一平台多适配器不互相吞消息。
        return handleInbound(parsed, { adapterId: entry?.id });
      },
      logger,
      metrics,
    })
    : null;

  return {
    server,
    metrics,
    idempotency,
    turns,
    handleInbound,
    ws: wsHub,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          logger(`gateway listening on ${config.host}:${config.port} (mode=${config.mode}`
            + `${wsHub ? `, ws=${wsHub.path}` : ', ws=off'})`);
          resolve();
        });
      });
    },
    close() {
      return new Promise(async (resolve) => {
        wsHub?.close();
        idempotency.close();
        if (runtime) {
          try { await runtime.stop?.(); } catch { /* stop 失败不阻塞进程退出 */ }
        }
        server.close(() => resolve());
        // Node 的 server 'close' 事件要等全部连接断开才触发；测试/重启场景下
        // 客户端（如 undici fetch 的 keep-alive 池）的连接会一直挂着，让 close()
        // 的 Promise 永不 resolve。关停语义下直接清掉残余连接。
        server.closeAllConnections?.();
      });
    },
  };
}

/*
 * 进程入口与装配在 `src/main.mjs`：core 只认 HTTP 契约与注入的 runtime 视图，
 * 不知道有哪些 executor、section 或上游服务。
 */
