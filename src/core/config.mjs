/**
 * 网关配置的加载与校验。
 *
 * 设计原则：**fail-closed 且可解释**。
 *  - 没有任何适配器配置时拒绝启动（而不是回退到无鉴权）——一个能被任意
 *    本机进程调用的网关，等于把「给任意群发消息」的能力暴露出去。
 *  - 每个错误都告诉操作者该改哪个文件、跑哪个命令，不允许「配置了但没生效」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ACTION_TYPES } from './contracts.mjs';
import { OPERATOR_TOKEN_PATTERN } from './auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 本文件位于 src/core/，包根是上两级。
export const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

export const GATEWAY_MODES = Object.freeze(['off', 'shadow', 'on']);
export const DEFAULT_PORT = 7190;
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * 适配器能「真的执行」的动作子集。
 *
 * `wait / set_wake / noop` 是模型侧语义，网关自己消费，永远不该出现在适配器的
 * capabilities 里——允许它们会让适配器声称支持一个根本不存在的投递动作。
 */
export const DELIVERABLE_ACTIONS = Object.freeze(
  ACTION_TYPES.filter((action) => !['wait', 'set_wake', 'noop'].includes(action)),
);

/**
 * 密钥来源，按优先级：内联（仅测试）→ 文件 → 环境变量。
 * 环境变量放最后，因为 Windows 的进程环境会被同用户的任何进程读到。
 * 服务登记（V2 P2 起，现为登记目录）复用同一口径，label 用于区分错误信息。
 */
export function resolveSecret(entry, env, stateDir, label = 'adapter') {
  if (typeof entry.secret === 'string' && entry.secret.length > 0) {
    if (entry.secret.length < 16) {
      throw new Error(`${label} "${entry.id}": inline secret must be at least 16 characters`);
    }
    return entry.secret;
  }
  if (typeof entry.secretFile === 'string' && entry.secretFile.length > 0) {
    const file = path.isAbsolute(entry.secretFile) ? entry.secretFile : path.join(stateDir, entry.secretFile);
    if (!fs.existsSync(file)) {
      throw new Error(`${label} "${entry.id}": secret file not found: ${file}`);
    }
    const secret = fs.readFileSync(file, 'utf8').trim();
    if (secret.length < 16) {
      throw new Error(`${label} "${entry.id}": secret in ${file} must be at least 16 characters`);
    }
    return secret;
  }
  if (typeof entry.secretEnv === 'string' && entry.secretEnv.length > 0) {
    const secret = env[entry.secretEnv];
    if (!secret || secret.length < 16) {
      throw new Error(`${label} "${entry.id}": env ${entry.secretEnv} is missing or too short (>=16)`);
    }
    return secret;
  }
  throw new Error(`${label} "${entry.id}": needs one of secretFile / secretEnv / secret`);
}

/**
 * @param {object} options
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string}   [options.stateDir]  默认 `<package>/state/gateway`
 * @param {string}   [options.adaptersFile] 默认 `<stateDir>/adapters.json`
 * @param {object[]} [options.adapters]  直接注入（测试用），跳过文件
 */
/**
 * 数值型环境变量校验（fail-closed）。
 *
 * 直接 `Number(env.X ?? default)` 的问题是：写成 "30s" / "abc" 会得到 NaN，
 * 而 NaN 在比较里恒 false —— 重放时间窗、超时、TTL 会静默失效，比启动失败
 * 难排查得多。空串按缺省处理；其余非法值直接抛。
 */
function intInRange(name, raw, { min, max, fallback }) {
  const value = raw === undefined || raw === null || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}], got "${raw}"`);
  }
  return value;
}

export function loadConfig({ env = process.env, stateDir, adaptersFile, adapters: injectedAdapters } = {}) {
  const dir = stateDir ?? path.join(PACKAGE_ROOT, 'state', 'gateway');
  const modeRaw = String(env.GATEWAY_MODE ?? 'off').trim().toLowerCase();
  if (!GATEWAY_MODES.includes(modeRaw)) {
    throw new Error(`GATEWAY_MODE must be one of ${GATEWAY_MODES.join(' | ')}, got "${env.GATEWAY_MODE}"`);
  }
  const mode = modeRaw;

  const host = String(env.GATEWAY_HOST ?? '127.0.0.1');
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    // 允许显式放宽，但要看见这个决定：默认 listen 全地址是历史事故的常见来源。
    console.warn(`[gateway] GATEWAY_HOST=${host} 非回环地址：请确认已部署 TLS 与网络层访问控制`);
  }

  const port = Number(env.GATEWAY_PORT ?? DEFAULT_PORT);
  // 0 = 临时端口，仅供测试使用；生产配置写 0 会在日志里看到随机端口，不算错误。
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`GATEWAY_PORT must be an integer in [0, 65535], got "${env.GATEWAY_PORT}"`);
  }

  let adapterList = injectedAdapters;
  const file = adaptersFile ?? path.join(dir, 'adapters.json');
  if (!adapterList) {
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        adapterList = Array.isArray(parsed?.adapters) ? parsed.adapters : null;
        if (!adapterList) {
          throw new Error(`${file} must be {"adapters": [{ id, platform, secretFile | secretEnv }]}`);
        }
      } catch (error) {
        throw new Error(`failed to read ${file}: ${error?.message ?? error}`);
      }
    } else if (env.GATEWAY_SECRET) {
      // 单适配器的最简路径：GATEWAY_ADAPTER_ID 默认 qq-main。
      adapterList = [{
        id: String(env.GATEWAY_ADAPTER_ID ?? 'qq-main'),
        platform: String(env.GATEWAY_ADAPTER_PLATFORM ?? 'qq'),
        secret: String(env.GATEWAY_SECRET),
      }];
    }
  }

  // P5：每个适配器一个独立开关，两种写法等价：
  //   adapters.json 里 `"enabled": false`（长期） / `GATEWAY_DISABLED_ADAPTERS=wx-main`（临时）。
  // 过滤发生在密钥解析之前：关掉的适配器不该因为「密钥文件忘了放」把网关拖住。
  const disabledAdapters = new Set(String(env.GATEWAY_DISABLED_ADAPTERS ?? '')
    .split(',').map((value) => value.trim()).filter(Boolean));

  function resolveAdapter(entry) {
    if (!entry || typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.id)) {
      throw new Error(`adapter id must match ^[a-z0-9][a-z0-9-]{0,63}$, got ${JSON.stringify(entry?.id)}`);
    }
    // V2 消费者抽象：kind='route' 的消费者不绑定平台（它可以是一条路由、一个桥），
    // 网关不关心谁在消费；kind 缺省 = 'platform'，既有 adapters.json 行为不变。
    const kind = entry.kind ?? 'platform';
    if (!['platform', 'route'].includes(kind)) {
      throw new Error(`adapter "${entry.id}": kind must be "platform" or "route"`);
    }
    if (kind === 'platform' && !['qq', 'wx'].includes(entry.platform)) {
      throw new Error(`adapter "${entry.id}": platform must be "qq" or "wx"`);
    }
    if (kind === 'route' && entry.platform !== undefined) {
      throw new Error(`adapter "${entry.id}": route consumers must not declare a platform`);
    }
    // V2 客户端通道：auto = 能连 WS 就走 WS、HTTP 备用（缺省，兼容既有部署）；
    // 显式 http/ws 可钉死。真正的降级逻辑在客户端，网关两侧通道常开。
    const transport = entry.transport ?? 'auto';
    if (!['auto', 'http', 'ws'].includes(transport)) {
      throw new Error(`adapter "${entry.id}": transport must be "auto", "http" or "ws"`);
    }
    // capabilities 缺省 = 不限制（既有适配器没有声明，行为保持不变）。
    // 一旦声明就必须是「可投递动作」的子集：写错一个动作名等于让模型以为能戳一戳。
    let capabilities = null;
    if (entry.capabilities !== undefined) {
      if (!Array.isArray(entry.capabilities) || entry.capabilities.length === 0) {
        throw new Error(`adapter "${entry.id}": capabilities must be a non-empty array when provided`);
      }
      const unknown = entry.capabilities.filter((action) => !DELIVERABLE_ACTIONS.includes(action));
      if (unknown.length > 0) {
        throw new Error(
          `adapter "${entry.id}": unknown capabilities ${unknown.join(', ')} `
          + `(allowed: ${DELIVERABLE_ACTIONS.join(', ')})`,
        );
      }
      capabilities = [...new Set(entry.capabilities)];
    }
    return {
      id: entry.id,
      kind,
      transport,
      platform: kind === 'platform' ? entry.platform : null,
      secret: resolveSecret(entry, env, dir),
      // P1：网关出站动作的回投地址（适配器 /v1/actions）。缺省表示「暂不回投」，
      // 文本投递仍由适配器经自己的 mux 处理（P1 灰度语义，见设计文档）。
      callbackBase: typeof entry.callbackBase === 'string' && entry.callbackBase
        ? entry.callbackBase.replace(/\/+$/, '') : null,
      capabilities,
    };
  }

  // `enabled` 只接受布尔：`"enabled": "false"` 会被 `!== false` 判成「开」，
  // 一个引号就让本该关掉的适配器继续跑，这种事故不值得靠人眼发现。
  for (const entry of adapterList ?? []) {
    if (entry?.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      throw new Error(`adapter "${entry?.id}": enabled must be a boolean, got ${JSON.stringify(entry.enabled)}`);
    }
  }

  const resolved = (adapterList ?? [])
    .filter((entry) => entry?.enabled !== false)
    .filter((entry) => !disabledAdapters.has(entry?.id))
    .map(resolveAdapter);

  if (mode !== 'off' && resolved.length === 0) {
    throw new Error(
      `GATEWAY_MODE=${mode} requires at least one adapter. `
      + `Create ${file} as {"adapters":[{"id":"qq-main","platform":"qq","secretFile":"qq-main.secret"}]} `
      + `and put a >=16 char random string into that file, or set GATEWAY_SECRET.`,
    );
  }

  const ids = new Set();
  const platformOwner = new Map();
  for (const adapter of resolved) {
    if (ids.has(adapter.id)) throw new Error(`duplicate adapter id: ${adapter.id}`);
    ids.add(adapter.id);
    // 出站动作按 platform 路由（adapter-tools 每个平台一个工具命名空间）。同平台两个适配器
    // 会静默「后登记者覆盖」，模型发到 wx 的动作可能落在另一个进程上。
    // 真要并行接入，得先给路由加 adapterId，而不是让配置自己撞车。
    // V2：route 消费者不绑定平台，不参与平台独占检查。
    if (adapter.kind === 'route') continue;
    const owner = platformOwner.get(adapter.platform);
    if (owner) {
      throw new Error(
        `adapters "${owner}" and "${adapter.id}" share platform "${adapter.platform}": `
        + 'only one adapter per platform can receive actions',
      );
    }
    platformOwner.set(adapter.platform, adapter.id);
  }

  // ── V2 客户端通道（WebSocket）────────────────────────────────────────────
  // off：不起 WS 端点（默认，P1 灰度期）；on：在 /v1/ws 挂 RFC6455 服务，
  // 消费者与装饰器/过滤器服务以客户端身份连入（HTTP 端点全部保留为备用）。
  const wsModeRaw = String(env.GATEWAY_WS ?? 'off').trim().toLowerCase();
  if (!['off', 'on'].includes(wsModeRaw)) {
    throw new Error(`GATEWAY_WS must be off|on, got "${env.GATEWAY_WS}"`);
  }
  const wsPathRaw = String(env.GATEWAY_WS_PATH ?? '/v1/ws');
  if (!wsPathRaw.startsWith('/')) {
    throw new Error(`GATEWAY_WS_PATH must start with "/", got "${env.GATEWAY_WS_PATH}"`);
  }
  const ws = {
    mode: wsModeRaw,
    path: wsPathRaw.replace(/\/+$/, '') || '/v1/ws',
    // 服务端心跳间隔：每周期发一次 ping；连续两个周期没有任何入站帧（含 pong）
    // 视为半开连接，ws-hub 会 terminate 掉（见 ws-hub.mjs armHeartbeat）。
    heartbeatMs: Number(env.GATEWAY_WS_HEARTBEAT_MS ?? 30000),
  };
  if (!Number.isSafeInteger(ws.heartbeatMs) || ws.heartbeatMs < 5000 || ws.heartbeatMs > 300000) {
    throw new Error(`GATEWAY_WS_HEARTBEAT_MS must be an integer in [5000, 300000], got "${env.GATEWAY_WS_HEARTBEAT_MS}"`);
  }

  // ── P1 runtime 配置 ────────────────────────────────────────────────────────
  // 灰度白名单：命中 `qq:group:123456` 这类 sessionKey 才走网关管线；未命中的
  // 入站返回 routed:false，适配器继续走自己的旧路径。支持尾缀通配 `qq:group:*`。
  const conversations = String(env.GATEWAY_CONVERSATIONS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  const dsh = {
    baseUrl: String(env.GATEWAY_DSH_BASE_URL ?? 'http://127.0.0.1:3080').replace(/\/+$/, ''),
    authToken: String(env.GATEWAY_DSH_TOKEN ?? ''),
    allowRemote: env.GATEWAY_DSH_ALLOW_REMOTE === 'true',
    timeoutMs: intInRange('GATEWAY_DSH_TIMEOUT_MS', env.GATEWAY_DSH_TIMEOUT_MS, {
      min: 1000, max: 600_000, fallback: 30_000,
    }),
  };

  const chat = {
    // fail-closed：preset 缺失或不在 DSH 可用清单时拒绝建会话（绝不回退 DSH 默认
    // preset——那会把本地工具暴露给群聊，沿用 bridge 的教训）。
    preset: String(env.GATEWAY_PRESET ?? 'qq-chat-v2'),
    provider: String(env.GATEWAY_PROVIDER ?? 'deepseek-official'),
    model: String(env.GATEWAY_MODEL ?? 'deepseek-flash'),
    reasoningEffort: String(env.GATEWAY_REASONING_EFFORT ?? 'max'),
    workspaceDir: env.GATEWAY_WORKSPACE_DIR ?? path.join(dir, 'agents'),
    turnTimeoutMs: intInRange('GATEWAY_TURN_TIMEOUT_MS', env.GATEWAY_TURN_TIMEOUT_MS, {
      min: 5000, max: 3_600_000, fallback: 300_000,
    }),
  };

  // ── V2 P3 管线引擎（docs/design/GATEWAY_V2_REFACTOR.md §3/§4）──────────────
  // 拼装唯一路径（P3 转正）：per-consumer 通路步骤序列（pipelines.json 的
  // pipelines 块）执行 过滤器→装饰器 链，装饰能力由登记的装饰器服务承载；
  // 空管线 = prompt 透传；off = 回滚通道（prompt 原样透传，装饰全停）。
  // GATEWAY_CONTEXT 开关已退役：读到它 = 配置过期，直接挡在启动（fail-closed，
  // 避免操作者以为旧回滚语义还在而实际已透传）。
  if (env.GATEWAY_CONTEXT !== undefined) {
    throw new Error('GATEWAY_CONTEXT is retired (P3 cutover): orchestration now lives in pipelines.json; use GATEWAY_PIPELINE=off for prompt passthrough');
  }
  // 旧编排文件路径 env 已随内联服务装载一起退役：静默忽略会让运维以为配置仍生效。
  if (env.GATEWAY_SERVICES_FILE) {
    throw new Error([
      'GATEWAY_SERVICES_FILE is retired: orchestration moved to <stateDir>/pipelines.json.',
      'Migration: (1) move any inline "services" entries from the old services.json into per-service',
      'files under the registration dir (GATEWAY_SERVICES_DIR); (2) copy "pipelines"/"returnPipelines"',
      'into pipelines.json; (3) delete the old services.json and this env var.',
    ].join(' '));
  }
  const pipelineModeRaw = String(env.GATEWAY_PIPELINE ?? 'on').trim().toLowerCase();
  if (!['off', 'on'].includes(pipelineModeRaw)) {
    throw new Error(`GATEWAY_PIPELINE must be off|on, got "${env.GATEWAY_PIPELINE}"`);
  }
  const pipeline = {
    mode: pipelineModeRaw,
    // 编排配置文件：只有 pipelines（通路）与 returnPipelines（回路）两块，键是消费端。
    // 服务登记在登记目录（GATEWAY_SERVICES_DIR），与本文件彻底分离。
    file: env.GATEWAY_PIPELINES_FILE
      ? path.resolve(String(env.GATEWAY_PIPELINES_FILE))
      : path.join(dir, 'pipelines.json'),
    // 单个外部步骤的调用超时：超时记 degraded 继续后续步骤，不拖垮 turn 超时链。
    stepTimeoutMs: Number(env.GATEWAY_PIPELINE_STEP_TIMEOUT_MS ?? 8000),
    // prompt 预算（字符）：超限整段丢弃最低优先级 section，语义与旧 assembler 一致。
    budgetChars: Number(env.GATEWAY_PIPELINE_BUDGET ?? 6000),
  };
  if (!Number.isSafeInteger(pipeline.stepTimeoutMs)
    || pipeline.stepTimeoutMs < 1000 || pipeline.stepTimeoutMs > 60_000) {
    throw new Error(`GATEWAY_PIPELINE_STEP_TIMEOUT_MS must be an integer in [1000, 60000], got "${env.GATEWAY_PIPELINE_STEP_TIMEOUT_MS}"`);
  }
  if (!Number.isSafeInteger(pipeline.budgetChars)
    || pipeline.budgetChars < 0 || pipeline.budgetChars > 100_000) {
    throw new Error(`GATEWAY_PIPELINE_BUDGET must be an integer in [0, 100000], got "${env.GATEWAY_PIPELINE_BUDGET}"`);
  }

  // ── V2 P3 服务自主登记（docs/design/GATEWAY_V2_REFACTOR.md §3/§4 P3）───────
  // 登记目录：每个服务一份登记文件（<id>.json），声明类型（decorator/filter/
  // consumer）、transport、密钥引用与自有工具。注册=放入文件，卸载=移除文件；
  // 网关启动/热加载校验装载，注册/卸载事件落 append-only 台账（满足「保存注册
  // 内容 + 记录」，P4 UI 复用同一套校验/装载逻辑，UI 只是目录的前端）。
  // 目录不存在不算错误：没有登记服务 = 纯内置工具面（GATEWAY_TOOLS 的内置
  // executors 照常装配）。编排（pipelines/returnPipelines）在 pipelines.json，
  // 不在登记文件，也不再有内联 services 块。
  const registrations = {
    dir: env.GATEWAY_SERVICES_DIR
      ? path.resolve(String(env.GATEWAY_SERVICES_DIR))
      : path.join(dir, 'services'),
    ledgerFile: path.join(dir, 'registration-ledger.jsonl'),
    // 热加载轮询间隔（ms）；0 = 关闭热加载（只启动时装载一次）。
    reloadMs: Number(env.GATEWAY_SERVICES_RELOAD_MS ?? 4000),
  };
  if (!Number.isSafeInteger(registrations.reloadMs)
    || registrations.reloadMs < 0 || registrations.reloadMs > 600_000) {
    throw new Error(`GATEWAY_SERVICES_RELOAD_MS must be an integer in [0, 600000], got "${env.GATEWAY_SERVICES_RELOAD_MS}"`);
  }

  // ── P3 统一工具面 ──────────────────────────────────────────────────────────
  // off：不装 ToolHost / 工具 executor（MCP 薄壳的 tools/list 会拿到空清单）；
  // on：装配 tool-host + memory-tools/rolecard-tools executor，开放
  // POST /v1/tools/call 与 GET /v1/tools。
  // busSecret 是 MCP 薄壳（mcp-bus）与网关之间的 HMAC 共享密钥——薄壳跑在
  // DSH 沙箱可及的本机上，「来自回环」不是信任凭据，与适配器同一口径。
  const toolsModeRaw = String(env.GATEWAY_TOOLS ?? 'off').trim().toLowerCase();
  if (!['off', 'on'].includes(toolsModeRaw)) {
    throw new Error(`GATEWAY_TOOLS must be off|on, got "${env.GATEWAY_TOOLS}"`);
  }
  const busSecret = String(env.GATEWAY_MCP_TOKEN ?? '');
  if (toolsModeRaw === 'on' && busSecret.length < 16) {
    throw new Error('GATEWAY_TOOLS=on requires GATEWAY_MCP_TOKEN (a >=16 char random string shared with mcp-bus)');
  }
  // 清单驱动工具面（P2）：网关启动时从每个配了 callbackBase 的适配器拉取
  // GET /v1/actions/manifest，把清单翻译成 chat_<platform>_* 工具。
  // sensitive 门：清单里 kind:sensitive 的动作（如 set_wake）默认**不暴露**给
  // 模型，必须显式 GATEWAY_TOOL_SENSITIVE=on——「默认关闭、显式允许」与
  // preset fail-closed 同一口径：敏感能力的默认状态必须是关。
  const sensitiveRaw = String(env.GATEWAY_TOOL_SENSITIVE ?? 'off').trim().toLowerCase();
  if (!['off', 'on'].includes(sensitiveRaw)) {
    throw new Error(`GATEWAY_TOOL_SENSITIVE must be off|on, got "${env.GATEWAY_TOOL_SENSITIVE}"`);
  }
  const tools = {
    mode: toolsModeRaw,
    busSecret,
    maxCallsPerTurn: intInRange('GATEWAY_TOOL_MAX_CALLS_PER_TURN', env.GATEWAY_TOOL_MAX_CALLS_PER_TURN, {
      min: 1, max: 500, fallback: 30,
    }),
    callTimeoutMs: intInRange('GATEWAY_TOOL_CALL_TIMEOUT_MS', env.GATEWAY_TOOL_CALL_TIMEOUT_MS, {
      min: 1000, max: 600_000, fallback: 20_000,
    }),
    sensitive: sensitiveRaw,
    // 清单拉取超时：适配器起得比网关慢是常态，超时只影响「本次装配有没有工具面」，
    // 不应把网关启动拖死，所以默认给一个短窗口。
    manifestTimeoutMs: Number(env.GATEWAY_TOOL_MANIFEST_TIMEOUT_MS ?? 5000),
  };
  if (!Number.isSafeInteger(tools.manifestTimeoutMs)
    || tools.manifestTimeoutMs < 100 || tools.manifestTimeoutMs > 60_000) {
    throw new Error(`GATEWAY_TOOL_MANIFEST_TIMEOUT_MS must be an integer in [100, 60000], got "${env.GATEWAY_TOOL_MANIFEST_TIMEOUT_MS}"`);
  }

  // ── 阶段 3 联网搜索收编（chat_web_search，内置清单、非适配器来源）─────────
  // off（默认）：不装 web-search executor，模型工具面没有 chat_web_search；
  // on：装配。API key 在 executor 内解析（GATEWAY_WEB_SEARCH_KEY → key 文件 →
  // DEEPSEEK_API_KEY → DSH .credentials.yaml），解析不到 = 装配跳过并记日志
  // （宁可缺工具，不放一个必然失败的占位工具）。
  const webSearchModeRaw = String(env.GATEWAY_WEB_SEARCH ?? 'off').trim().toLowerCase();
  if (!['off', 'on'].includes(webSearchModeRaw)) {
    throw new Error(`GATEWAY_WEB_SEARCH must be off|on, got "${env.GATEWAY_WEB_SEARCH}"`);
  }
  const webSearch = {
    mode: webSearchModeRaw,
    // 单次上游请求的缺省超时上限；实际取它与 tool-host 预算的较小者。
    timeoutMs: Number(env.GATEWAY_WEB_SEARCH_TIMEOUT_MS ?? 35000),
  };
  if (!Number.isSafeInteger(webSearch.timeoutMs)
    || webSearch.timeoutMs < 5000 || webSearch.timeoutMs > 120_000) {
    throw new Error(`GATEWAY_WEB_SEARCH_TIMEOUT_MS must be an integer in [5000, 120000], got "${env.GATEWAY_WEB_SEARCH_TIMEOUT_MS}"`);
  }

  // ── DSH pending 平台转发（docs/console/dsh-pending/PLAN.md 第二阶段）────────
  // off（默认）：pending 只在网关暂存，控制台 /v1/console/pending 只读可见；
  // on：question/approval 事件到达时作为出站动作（ask/approve）转发到该会话
  // 对应的平台会话——通知性质，不做任何自动应答（应答 RPC 未列入 dsh-client）。
  const pendingForwardModeRaw = String(env.GATEWAY_PENDING_FORWARD ?? 'off').trim().toLowerCase();
  if (!['off', 'on'].includes(pendingForwardModeRaw)) {
    throw new Error(`GATEWAY_PENDING_FORWARD must be off|on, got "${env.GATEWAY_PENDING_FORWARD}"`);
  }
  const pendingForward = {
    mode: pendingForwardModeRaw,
    timeoutMs: Number(env.GATEWAY_PENDING_FORWARD_TIMEOUT_MS ?? 8000),
  };
  if (!Number.isSafeInteger(pendingForward.timeoutMs)
    || pendingForward.timeoutMs < 2000 || pendingForward.timeoutMs > 60_000) {
    throw new Error(`GATEWAY_PENDING_FORWARD_TIMEOUT_MS must be an integer in [2000, 60000], got "${env.GATEWAY_PENDING_FORWARD_TIMEOUT_MS}"`);
  }

  // ── P4 会话状态（邮箱游标 + 唤醒状态 + agentToken）─────────────────────────
  // off：不装 mailbox（/v1/state* 返回 503，适配器各自持有状态——P3 及之前的行为）；
  // on：装配 mailbox，适配器把「丢了无法重建」的状态（已读水位/未读游标/唤醒
  // 配置/agentToken）镜像过来，控制台经适配器代理做只读查询。
  // P4 是镜像期：适配器本地的 social-v2.json 继续写，回滚 = 关掉本开关。
  const stateModeRaw = String(env.GATEWAY_STATE ?? 'off').trim().toLowerCase();
  if (!['off', 'on'].includes(stateModeRaw)) {
    throw new Error(`GATEWAY_STATE must be off|on, got "${env.GATEWAY_STATE}"`);
  }
  const state = {
    mode: stateModeRaw,
    file: path.join(dir, 'session-state.json'),
  };

  // ── §6 记忆落库调度器（P3：入站+出站双向自动沉淀）───────────────────────────
  // off（默认）：不装配调度器（observe 点空转，行为与 P3 前一致）；
  // on：入站消息与发送成功的出站文本按会话/时间窗聚合后，经网关出站通道逐条
  // POST 记忆服务的 /api/memory/record（与 chat_memory_record 同一写入口径，
  // 幂等/去重由服务端裁决）。token 三态复用 resolveSecret 口径（>=16 字符）：
  //   GATEWAY_MEMORY_INGEST_TOKEN（内联）| GATEWAY_MEMORY_INGEST_TOKEN_FILE
  //   （相对 stateDir）| GATEWAY_MEMORY_INGEST_TOKEN_ENV（环境变量名）。
  const memoryIngestModeRaw = String(env.GATEWAY_MEMORY_INGEST ?? 'off').trim().toLowerCase();
  if (!['off', 'on'].includes(memoryIngestModeRaw)) {
    throw new Error(`GATEWAY_MEMORY_INGEST must be off|on, got "${env.GATEWAY_MEMORY_INGEST}"`);
  }
  const memoryIngest = {
    mode: memoryIngestModeRaw,
    // 记忆服务的 /api/* 通道（x-mcp-token 鉴权，非登记 HMAC 通道）。
    url: String(env.GATEWAY_MEMORY_INGEST_URL ?? 'http://127.0.0.1:7181'),
    token: memoryIngestModeRaw === 'on'
      ? resolveSecret({
        id: 'memory-ingest',
        secret: env.GATEWAY_MEMORY_INGEST_TOKEN,
        secretFile: env.GATEWAY_MEMORY_INGEST_TOKEN_FILE,
        secretEnv: env.GATEWAY_MEMORY_INGEST_TOKEN_ENV,
      }, env, dir, 'memory-ingest')
      : '',
    // 聚合时间窗（会话缓冲冲刷周期）与单会话批量阈值（攒满提前冲刷）。
    windowMs: Number(env.GATEWAY_MEMORY_INGEST_WINDOW_MS ?? 30_000),
    maxBatch: Number(env.GATEWAY_MEMORY_INGEST_BATCH ?? 50),
  };
  if (!Number.isSafeInteger(memoryIngest.windowMs) || memoryIngest.windowMs < 1000 || memoryIngest.windowMs > 600_000) {
    throw new Error(`GATEWAY_MEMORY_INGEST_WINDOW_MS must be an integer in [1000, 600000], got "${env.GATEWAY_MEMORY_INGEST_WINDOW_MS}"`);
  }
  if (!Number.isSafeInteger(memoryIngest.maxBatch) || memoryIngest.maxBatch < 1 || memoryIngest.maxBatch > 500) {
    throw new Error(`GATEWAY_MEMORY_INGEST_BATCH must be an integer in [1, 500], got "${env.GATEWAY_MEMORY_INGEST_BATCH}"`);
  }

  // ── 控制台 / operator 认证（docs/console/auth/PLAN.md）─────────────────────
  // on（默认）：挂 /v1/console/* 控制面路由。凭据三态（镜像 resolveSecret）：
  //   GATEWAY_OPERATOR_TOKEN（内联）> state/operator-token（文件）> 自动生成并
  //   持久化（与桥接 consoleToken 同语义）。**绝不无凭据开放控制面**：
  //   自动生成写盘失败 = 启动失败（fail-closed）。
  const consoleModeRaw = String(env.GATEWAY_CONSOLE ?? 'on').trim().toLowerCase();
  if (!['off', 'on'].includes(consoleModeRaw)) {
    throw new Error(`GATEWAY_CONSOLE must be off|on, got "${env.GATEWAY_CONSOLE}"`);
  }
  const operatorTokenFile = path.join(dir, 'operator-token');
  let operatorToken = typeof env.GATEWAY_OPERATOR_TOKEN === 'string' ? env.GATEWAY_OPERATOR_TOKEN.trim() : '';
  let operatorTokenGenerated = false;
  if (!operatorToken && fs.existsSync(operatorTokenFile)) {
    operatorToken = fs.readFileSync(operatorTokenFile, 'utf8').trim();
  }
  if (operatorToken && !OPERATOR_TOKEN_PATTERN.test(operatorToken)) {
    throw new Error(`operator token (env or ${operatorTokenFile}) must match ${OPERATOR_TOKEN_PATTERN.source}`);
  }
  if (consoleModeRaw === 'on' && !operatorToken) {
    operatorToken = randomBytes(24).toString('base64url');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(operatorTokenFile, `${operatorToken}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      throw new Error(
        `console is enabled but operator token could not be persisted to ${operatorTokenFile}: ${error?.message ?? error}`,
      );
    }
    operatorTokenGenerated = true;
  }
  const consoleConfig = {
    mode: consoleModeRaw,
    operatorToken: consoleModeRaw === 'on' ? operatorToken : '',
    tokenFile: operatorTokenFile,
    generated: operatorTokenGenerated,
    // 下限 1s：控制台会话过期用例需要它；上限 7 天（再长就等于永不过期）。
    sessionTtlMs: intInRange('GATEWAY_CONSOLE_SESSION_TTL_MS', env.GATEWAY_CONSOLE_SESSION_TTL_MS, {
      min: 1000, max: 7 * 24 * 60 * 60 * 1000, fallback: 12 * 60 * 60 * 1000,
    }),
  };

  // ── 价目表覆盖（usage-billing）：GATEWAY_PRICING 为 JSON 字符串，缺省用内置表。
  let pricing;
  if (typeof env.GATEWAY_PRICING === 'string' && env.GATEWAY_PRICING.trim()) {
    try {
      pricing = JSON.parse(env.GATEWAY_PRICING);
    } catch {
      throw new Error('GATEWAY_PRICING must be valid JSON (a resolvePriceTable override)');
    }
  }

  return {
    mode,
    host,
    port,
    stateDir: dir,
    adaptersFile: file,
    maxBodyBytes: MAX_BODY_BYTES,
    replayWindowMs: intInRange('GATEWAY_REPLAY_WINDOW_MS', env.GATEWAY_REPLAY_WINDOW_MS, {
      min: 1000, max: 3_600_000, fallback: 5 * 60 * 1000,
    }),
    turnsFile: path.join(dir, 'turns.jsonl'),
    idempotencyFile: path.join(dir, 'idempotency.json'),
    spoolFile: path.join(dir, 'raw-spool.jsonl'),
    sessionsFile: path.join(dir, 'sessions.json'),
    adapters: resolved,
    conversations,
    dsh,
    chat,
    pipeline,
    memoryIngest,
    registrations,
    tools,
    webSearch,
    pendingForward,
    ws,
    state,
    console: consoleConfig,
    pricing,
  };
}

/** 灰度白名单匹配：精确键或 `前缀*`。 */
export function isConversationAllowed(config, sessionKey) {
  if (config.conversations.length === 0) return false;
  return config.conversations.some((pattern) =>
    pattern === '*' || pattern === sessionKey
    || (pattern.endsWith('*') && sessionKey.startsWith(pattern.slice(0, -1))));
}

/** 只读回环探测用：不需要适配器配置的最小视图。 */
export function configSummary(config) {
  return {
    mode: config.mode,
    host: config.host,
    port: config.port,
    adapters: config.adapters.map(({ id, kind, transport, platform, capabilities, callbackBase }) => ({
      id,
      kind: kind ?? 'platform',
      transport: transport ?? 'auto',
      platform,
      // 运维要能一眼看出「这个平台声明了什么、动作会回投到哪」，
      // 否则「模型说了没发生」只能靠翻日志定位。
      capabilities: capabilities ?? 'all',
      actionsEndpoint: callbackBase ? `${callbackBase}/v1/actions` : null,
    })),
    ws: config.ws
      ? { mode: config.ws.mode, path: config.ws.path }
      : { mode: 'off' }, // 兼容手工构造的测试 config（没有 ws 块）
  };
}
