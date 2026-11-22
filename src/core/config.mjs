/**
 * 网关配置的加载与校验。
 *
 * 设计原则：**fail-closed 且可解释**。
 *  - 没有任何消费端登记时拒绝启动（而不是回退到无鉴权）——一个能被任意
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

// 数据面状态（原 GATEWAY_MODES，随环境变量正名）：off=数据面禁用（入站 503/
// WS 帧 E_DISABLED），shadow=影子灰度（受理只记 status），on=常驻放行。
export const DATA_PLANE_MODES = Object.freeze(['off', 'shadow', 'on']);
export const DEFAULT_PORT = 7190;
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * 适配器能「真的执行」的动作子集（网关认识的线缆词汇表）。
 *
 * `wait / set_wake / noop` 是模型侧语义，网关自己消费，永远不该出现在适配器的
 * actions manifest 里——允许它们会让适配器声称支持一个根本不存在的投递动作。
 * 具体某个适配器实现了哪些动作，唯一事实源是它自己暴露的 actions-manifest。
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

export function loadConfig({ env = process.env, stateDir } = {}) {
  const dir = stateDir ?? path.join(PACKAGE_ROOT, 'state', 'gateway');
  // 数据面状态（2026-11-18 正名）：GATEWAY_MODE → GATEWAY_DATA_PLANE。旧名仍被
  // 读取（回退），但打 deprecation 告警——防止存量 env 升级后数据面被静默关闭。
  const dataPlaneRaw = String(env.GATEWAY_DATA_PLANE ?? env.GATEWAY_MODE ?? 'off').trim().toLowerCase();
  if (env.GATEWAY_DATA_PLANE == null && env.GATEWAY_MODE != null) {
    console.warn('[gateway] GATEWAY_MODE 已更名 GATEWAY_DATA_PLANE（值沿用）；请更新 env 文件');
  }
  if (!DATA_PLANE_MODES.includes(dataPlaneRaw)) {
    throw new Error(`GATEWAY_DATA_PLANE must be one of ${DATA_PLANE_MODES.join(' | ')}, got "${env.GATEWAY_DATA_PLANE ?? env.GATEWAY_MODE}"`);
  }
  const mode = dataPlaneRaw;

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

  // ── 消费端身份唯一事实源 = 登记目录 ────────────────────────────────────────
  // 两条兼容通道（env 单适配器三元组 / adapters.json）已整体退役：消费端身份
  // 只认 <stateDir>/services/<id>.json（kind=consumer）。静默忽略会让运维以为旧
  // 配置仍生效（与 GATEWAY_CONTEXT / GATEWAY_SERVICES_FILE 同范式），故读到即
  // 拒载，并把迁移步骤直接写进错误文案。
  const retiredEnvKeys = ['GATEWAY_ADAPTER_ID', 'GATEWAY_ADAPTER_PLATFORM', 'GATEWAY_SECRET', 'GATEWAY_DISABLED_ADAPTERS']
    .filter((key) => env[key] !== undefined && String(env[key]).trim() !== '');
  if (retiredEnvKeys.length > 0) {
    throw new Error([
      `${retiredEnvKeys.join(' / ')} retired: consumer identity now lives ONLY in the registration dir.`,
      'Migration: (1) run "npm run secrets:gen" (default id = svc-<hash>) to create the secret + handoff file;',
      `(2) write ${path.join(dir, 'services', '<svc-id>.json')} as`,
      '{"v":1,"id":"svc-<hash>","name":"<consumer-name>","kind":"consumer","transport":"auto","platform":"<platform>",'
        + '"url":"http://127.0.0.1:3100","secretFile":"secrets/svc-<hash>.secret"}',
      '(or register it in the console: POST /v1/console/services with kind=consumer);',
      '(3) delete these env vars and restart.',
    ].join(' '));
  }

  const legacyAdaptersFile = path.join(dir, 'adapters.json');
  if (fs.existsSync(legacyAdaptersFile)) {
    throw new Error([
      `${legacyAdaptersFile} retired: adapters.json is no longer read (the registration dir is the only consumer source).`,
      'Migration: for every "adapters" entry create',
      `${path.join(dir, 'services', '<id>.json')} with kind="consumer", platform, url (= old callbackBase),`
        + ' transport (default "auto") and secretFile/secretEnv;',
      'then delete adapters.json (and the entry from GATEWAY_DISABLED_ADAPTERS, if any) and restart.',
      'Registration ids are normally svc-<hash>; the console (POST /v1/console/services) generates them for you.',
    ].join(' '));
  }

  // ── V2 客户端通道（WebSocket，常驻能力，2026-11-18 起无开关）──────────────
  // 曾有 GATEWAY_WS=off|on 开关：on 时适配器没连 WS 自然落 HTTP，off 的唯一
  // 作用是「即使连着也不走帧」——消费端早已 WS 优先/HTTP 兜底自协商，开关没有
  // 独立价值，已移除（传输层行为固定，纯 HTTP 部署形态退役）。下方两项是
  // 常驻端点的运维参数，不是开关。
  const wsPathRaw = String(env.GATEWAY_WS_PATH ?? '/v1/ws');
  if (!wsPathRaw.startsWith('/')) {
    throw new Error(`GATEWAY_WS_PATH must start with "/", got "${env.GATEWAY_WS_PATH}"`);
  }
  const ws = {
    path: wsPathRaw.replace(/\/+$/, '') || '/v1/ws',
    // 服务端心跳间隔：每周期发一次 ping；连续两个周期没有任何入站帧（含 pong）
    // 视为半开连接，ws-hub 会 terminate 掉（见 ws-hub.mjs armHeartbeat）。
    heartbeatMs: Number(env.GATEWAY_WS_HEARTBEAT_MS ?? 30000),
  };
  if (!Number.isSafeInteger(ws.heartbeatMs) || ws.heartbeatMs < 5000 || ws.heartbeatMs > 300000) {
    throw new Error(`GATEWAY_WS_HEARTBEAT_MS must be an integer in [5000, 300000], got "${env.GATEWAY_WS_HEARTBEAT_MS}"`);
  }

  // ── P1 runtime 配置 ────────────────────────────────────────────────────────
  // 会话白名单**不在网关**（2026-11-16 起）：号码级白名单是平台知识，由适配器
  // 在自己那一侧裁决——不在白名单的消息根本到不了这里。网关只认「已登记适配器
  // 的 HMAC 签名 + 重放窗口」，这是它的安全边界。
  // 旧变量 GATEWAY_CONVERSATIONS 已无效果，main.mjs 会在启动时打一行提示。

  const dsh = {
    baseUrl: String(env.GATEWAY_DSH_BASE_URL ?? 'http://127.0.0.1:3080').replace(/\/+$/, ''),
    authToken: String(env.GATEWAY_DSH_TOKEN ?? ''),
    allowRemote: env.GATEWAY_DSH_ALLOW_REMOTE === 'true',
    timeoutMs: intInRange('GATEWAY_DSH_TIMEOUT_MS', env.GATEWAY_DSH_TIMEOUT_MS, {
      min: 1000, max: 600_000, fallback: 30_000,
    }),
  };

  const chat = {
    // 注意：这里**没有** preset 字段。preset 由适配器登记声明（registration.presets，
    // 见 session-registry），缺失时回退 DSH 内置 minimal（无本地工具）。
    // 曾经用 GATEWAY_PRESET 全局写死，多平台下必然把人设串平台，已移除。
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
  // 登记目录：每个服务一份登记文件（<id>.json），声明类型（consumer/resource；
  // 装饰/过滤职责由工具 role 声明）、transport、密钥引用与自有工具。注册=放入文件，卸载=移除文件；
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

  // 消费端收编校验已从启动期挪到切换点（2026-11-16 常驻装配改造）：mode 变成
  // 纯请求期活读门禁，on + 零消费端启动合法（消息面武装但无人能入站，main.mjs
  // 会打显式告警）。fail-closed 校验链（消费端非空 + 编排键有主 + 步骤名合法）
  // 在 POST /v1/console/mode 切 on 时执行，错误当场 400 回给 UI——配置错误仍
  // 第一时间可见，只是不再拦住整个网关启动。

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
  // 文件单源：<stateDir>/mcp-bus.secret（薄壳经 DSH 条目的 --token-file 读同一份）。
  // env 通道（GATEWAY_MCP_BUS_TOKEN 及旧名）已整体退役：双源需要「保持一致」
  // 这种人工对账，漂移只会在运行期 401 才暴露——读到即拒载，与 GATEWAY_CONTEXT
  // 同范式；密钥文件由 `npm run env:init` 生成/维护。
  const retiredBusTokenKeys = ['GATEWAY_MCP_BUS_TOKEN', 'GATEWAY_MCP_TOKEN', 'GATEWAY_MCP_BUS_TOKEN_FILE', 'GATEWAY_MCP_TOKEN_FILE']
    .filter((key) => env[key] !== undefined && String(env[key]).trim() !== '');
  if (retiredBusTokenKeys.length > 0) {
    throw new Error([
      `${retiredBusTokenKeys.join(' / ')} retired: the mcp-bus shared secret now lives ONLY in ${path.join(dir, 'mcp-bus.secret')}.`,
      'Migration: delete these keys from .env (npm run env:init does it in place), then restart.',
    ].join(' '));
  }
  const busSecretFile = path.join(dir, 'mcp-bus.secret');
  const busSecret = fs.existsSync(busSecretFile)
    ? fs.readFileSync(busSecretFile, 'utf8').trim()
    : '';
  if (toolsModeRaw === 'on' && busSecret.length < 16) {
    throw new Error(
      `GATEWAY_TOOLS=on requires ${busSecretFile} (a >=16 char random string shared with mcp-bus) — file missing or too short; run "npm run env:init".`,
    );
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

  // ── §6 会话缓冲与 save 调度（tool.call 统一改造：缓冲上移网关）──────────────
  // off（默认）：不装配 session-save（观察点空转）；on：入站消息与发送成功的
  // 出站文本按 sessionKey 缓冲（state/gateway/session-buffer/<key>.jsonl 逐条
  // 持久化，崩溃恢复），空闲超时（GATEWAY_MEMORY_SAVE_IDLE_MS）/触顶分段
  // （_MAX_MESSAGES / _MAX_CHARS）/进程关停时经 tool.call chat_memory_save
  // 整段落地。落地时机完全由网关裁决，记忆侧不再有内部调度器。
  //
  // 目标服务仍由登记目录解析：GATEWAY_MEMORY_SERVICE 显式指定 id；缺省走
  // selectMemoryService（登记声明 memoryService:true 的服务，多声明取字典序
  // 首个 + 一次性告警；不再看 chat_memory_record 工具标记）。鉴权复用登记
  // HMAC 密钥——同一份身份、同一套 transport（WS 优先 / HTTP 兜底）。
  // 旧 GATEWAY_MEMORY_INGEST* 全家已退役：仍设置时只记告警（retired 数组，
  // main.mjs 打印），不 fail-closed——致命会让存量 .env 升级即挂。
  const memorySaveModeRaw = String(env.GATEWAY_MEMORY_SAVE ?? 'off').trim().toLowerCase();
  if (!['off', 'on'].includes(memorySaveModeRaw)) {
    throw new Error(`GATEWAY_MEMORY_SAVE must be off|on, got "${env.GATEWAY_MEMORY_SAVE}"`);
  }
  const retiredMemoryEnv = [
    'GATEWAY_MEMORY_INGEST',
    'GATEWAY_MEMORY_INGEST_WINDOW_MS',
    'GATEWAY_MEMORY_INGEST_BATCH',
    'GATEWAY_MEMORY_INGEST_URL',
    'GATEWAY_MEMORY_INGEST_TOKEN',
    'GATEWAY_MEMORY_INGEST_TOKEN_FILE',
    'GATEWAY_MEMORY_INGEST_TOKEN_ENV',
  ].filter((key) => env[key] !== undefined && String(env[key]).trim() !== '');
  const memorySave = {
    mode: memorySaveModeRaw,
    // 显式指定登记服务 id（可空 = selectMemoryService 自动选路）。id 口径与登记文件一致。
    serviceId: String(env.GATEWAY_MEMORY_SERVICE ?? '').trim() || null,
    // 缓冲持久化目录（JSONL 逐条追加；崩溃恢复的事实源）。
    bufferDir: path.join(dir, 'session-buffer'),
    // 空闲超时（会话收尾 save）与触顶分段阈值。
    idleMs: Number(env.GATEWAY_MEMORY_SAVE_IDLE_MS ?? 3_600_000),
    maxMessages: Number(env.GATEWAY_MEMORY_SAVE_MAX_MESSAGES ?? 200),
    maxChars: Number(env.GATEWAY_MEMORY_SAVE_MAX_CHARS ?? 20_000),
    retired: retiredMemoryEnv,
  };
  if (memorySave.serviceId !== null && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(memorySave.serviceId)) {
    throw new Error(`GATEWAY_MEMORY_SERVICE must match /^[a-z0-9][a-z0-9-]{0,63}$/, got "${env.GATEWAY_MEMORY_SERVICE}"`);
  }
  if (!Number.isSafeInteger(memorySave.idleMs) || memorySave.idleMs < 1000 || memorySave.idleMs > 86_400_000) {
    throw new Error(`GATEWAY_MEMORY_SAVE_IDLE_MS must be an integer in [1000, 86400000], got "${env.GATEWAY_MEMORY_SAVE_IDLE_MS}"`);
  }
  if (!Number.isSafeInteger(memorySave.maxMessages) || memorySave.maxMessages < 1 || memorySave.maxMessages > 5000) {
    throw new Error(`GATEWAY_MEMORY_SAVE_MAX_MESSAGES must be an integer in [1, 5000], got "${env.GATEWAY_MEMORY_SAVE_MAX_MESSAGES}"`);
  }
  if (!Number.isSafeInteger(memorySave.maxChars) || memorySave.maxChars < 100 || memorySave.maxChars > 1_000_000) {
    throw new Error(`GATEWAY_MEMORY_SAVE_MAX_CHARS must be an integer in [100, 1000000], got "${env.GATEWAY_MEMORY_SAVE_MAX_CHARS}"`);
  }

  // ── 控制台 / operator 认证（docs/console/auth/PLAN.md）─────────────────────
  // on（默认）：挂 /v1/console/* 控制面路由。凭据文件单源（与 mcp-bus.secret
  // 同口径）：<stateDir>/operator-token 文件 > 缺失时自动生成并持久化（与桥接
  // consoleToken 同语义）。**绝不无凭据开放控制面**：自动生成写盘失败 = 启动
  // 失败（fail-closed）。env 通道 GATEWAY_OPERATOR_TOKEN 已退役：读到即拒载。
  //
  // 命名说明（为什么叫 operator 而不是 console）：这里的 operator 指「控制台
  // 操作员」这一人身份——x-operator-token 请求头直传与 console_session Cookie
  // 签名**共用同一个值**。它与数据面的适配器 HMAC、工具面的 mcp-bus.secret
  // 是三套互不复用的身份。历史命名保留：全量改为 console-auth* 会牵动控制台
  // 前端、脚本与文档约 250 处引用，收益不足以覆盖回归成本（如需改名请单独立项）。
  const consoleModeRaw = String(env.GATEWAY_CONSOLE ?? 'on').trim().toLowerCase();
  if (!['off', 'on'].includes(consoleModeRaw)) {
    throw new Error(`GATEWAY_CONSOLE must be off|on, got "${env.GATEWAY_CONSOLE}"`);
  }
  const retiredOperatorKeys = ['GATEWAY_OPERATOR_TOKEN']
    .filter((key) => env[key] !== undefined && String(env[key]).trim() !== '');
  if (retiredOperatorKeys.length > 0) {
    throw new Error([
      `${retiredOperatorKeys.join(' / ')} retired: the console credential now lives ONLY in ${path.join(dir, 'operator-token')}.`,
      'Migration: delete these keys from .env (npm run env:init does it in place and generates the file if missing), then restart.',
    ].join(' '));
  }
  const operatorTokenFile = path.join(dir, 'operator-token');
  let operatorToken = '';
  let operatorTokenGenerated = false;
  if (fs.existsSync(operatorTokenFile)) {
    operatorToken = fs.readFileSync(operatorTokenFile, 'utf8').trim();
  }
  if (operatorToken && !OPERATOR_TOKEN_PATTERN.test(operatorToken)) {
    throw new Error(`operator token file ${operatorTokenFile} must match ${OPERATOR_TOKEN_PATTERN.source}`);
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
    maxBodyBytes: MAX_BODY_BYTES,
    replayWindowMs: intInRange('GATEWAY_REPLAY_WINDOW_MS', env.GATEWAY_REPLAY_WINDOW_MS, {
      min: 1000, max: 3_600_000, fallback: 5 * 60 * 1000,
    }),
    turnsFile: path.join(dir, 'turns.jsonl'),
    idempotencyFile: path.join(dir, 'idempotency.json'),
    spoolFile: path.join(dir, 'raw-spool.jsonl'),
    sessionsFile: path.join(dir, 'sessions.json'),
    dsh,
    chat,
    pipeline,
    memorySave,
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

// 会话白名单判定（isConversationAllowed / matchConversationPattern）已删除：
// 号码白名单由各自的平台适配器负责（allow/deny），网关不再持有平台身份知识。

/**
 * 只读回环探测用：不需要服务登记的最小视图。
 * 消费端清单不在这里：它来自登记目录（service-registry.consumers()），随热注册
 * 变化——静态快照会骗人。
 */
export function configSummary(config) {
  return {
    mode: config.mode,
    host: config.host,
    port: config.port,
    // WS 通道常驻（2026-11-18 起）：只汇报端点运维参数，不再有 mode 开关语义。
    ws: { path: config.ws?.path ?? '/v1/ws' },
  };
}
