/**
 * V2 P2 管线服务登记（core）：服务身份来自登记目录，向 ws-hub 提供客户端
 * 身份合并表，向管线引擎提供步骤解析与统一的 tool.call 出站调用。
 *
 * 设计边界（docs/design/GATEWAY_V2_REFACTOR.md §3）：
 *  - 服务与消费者**同构**：id + HMAC secret（与登记契约同一口径，密钥
 *    解析直接复用 config 的 resolveSecret）+ transport（ws/http/auto）。网关
 *    不关心服务内部是什么——管线步骤一律走 tool.call（decorator 注入 / filter 改写）。
 *  - pipelines.json 承载 per-consumer 管线编排（pipelines/returnPipelines）：键为消费者 id
 *    或 "default"，值为步骤名数组。步骤解析两级（tool.call 统一改造后）：
 *    builtin protocol（main.mjs 注入，本层不认识内置名）→ decorator/filter
 *    角色的登记工具名（resolveToolStep）。**服务 id 直接当步骤不再合法**——
 *    管线引擎对其报错并给迁移文案。
 *  - 文件不存在 = 没有外部服务、没有编排 = 空登记（管线只剩内置步骤，不算错）。
 *    文件存在但非法 = 启动失败（fail-closed，与 pipelines.json 同口径）。
 *  - 回环-only 外壳不变：http transport 的 url 必须指向回环地址——「回环」不是
 *    信任凭据（签名才是），但它是不变量 §5.4 的一部分，出站同样遵守。
 *
 * V2 P3 服务自主登记（docs/design/GATEWAY_V2_REFACTOR.md §3/§4 P3）：
 *  - 登记目录（config.registrations.dir）：每个服务一份 `<id>.json` 登记文件，
 *    声明类型（consumer/resource；装饰/过滤职责由工具 role 声明）、transport、
 *    密钥引用与自有工具。
 *    id 是随机 hash（contracts.newRegistrationId 生成，32 位十六进制）——对象
 *    唯一性由 hash 确认（数据库主键风格），`name` 只是展示名；文件名即身份。
 *    注册 = 放入文件，卸载 = 移除文件——文件系统就是登记 API 的磁盘形态，
 *    P4 UI 复用同一套校验/装载逻辑（UI 只是目录的前端）。
 *  - 与编排文件（pipelines.json）的 fail-closed 不同，登记文件按份 fail-safe：坏文件拒载、
 *    记台账（reject）+ 日志，不影响其他服务——运维放错一个文件不该拖垮网关。
 *  - 注册/卸载/拒绝事件全部落 append-only 台账（registration-ledger.mjs），
 *    snapshot 携带脱敏后的登记内容——「保存注册内容 + 记录」的落点。
 *  - 热加载：轮询指纹（mtime+size）比对，reloadMs=0 关闭；变更后通知监听方
 *    （工具面缓存刷新，tool-routing 用）。
 *
 * V2 P4 编排 UI 支撑：
 *  - pipelines.json 热加载（reloadPipelines）：编排 PUT 保存后即时生效，
 *    指纹比对与登记目录同模式；校验与启动同口径（fail-closed，坏文件抛错、
 *    编排面不变），成功后整面换装 + 通知 onReload 监听方。
 *  - 编排条目双形态（P4.x）：字符串（纯步骤名）或规则对象
 *    { step, once?, join?, text?, pattern?, replacement?, flags?, fn? }——
 *    见 normalizePipelineStepEntry；视图（pipelinesView）原样透出。
 *
 * 本文件不 import 上层模块；WS 通道以 attachWs() 注入（装配在 main.mjs，
 * 先建 registry 再建 ws-hub，存在装配顺序依赖，用后挂接解掉）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveSecret } from './config.mjs';
import { signRequest } from './auth.mjs';
import { CONSUMER_ID_RE, ContractError, parseDecoratorResult, parseFilterResult, parseServiceRegistration, parseToolResult, presetsDeclarationSchema, serviceToolDeclarationSchema } from './contracts.mjs';
import { createRegistrationLedger, redactRegistration } from './registration-ledger.mjs';
import { createHttpClient } from '../shared/http-client.mjs';

const SERVICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STEP_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_STEPS_PER_PIPELINE = 16;

// ── P4.x 编排步骤条目：字符串或对象双形态 ─────────────────────────────────────
// 字符串 = 纯步骤名（两级解析：builtin protocol → decorator/filter 工具名；
// 服务 id 直接当步骤非法——管线引擎报迁移错）。
// 对象 = 带注入规则的步骤条目（字段全集，多字段即拒——strict 形状）：
//   { step, once?, join?('prefix'|'suffix'|'regex'|'function'),
//     text?, pattern?, replacement?, flags?, fn? }
//  - text：本地静态供料步骤——内容直接落编排配置、零服务调用（step 名仅为
//    标识，不做三级解析）；配置 join 缺省按 'suffix'（与 sections 语义同向）。
//  - join：外部装饰器步骤配置了 join 时，其产出（sections 文本，decorator 已
//    无 message 改写职责）视为 extra，由管线引擎接管拼接；缺省 = sections 追加。
//  - once：仅会话首轮执行（首轮判定归网关——isFirstTurnOfSession ctx）。
//    非首轮整个步骤跳过（供料型不调服务；filter 同口径）。
//  - regex 规则：pattern 匹配当前消息，replacement 可含 {extra} 占位符；
//    flags 缺省 'g'。编译失败保存即拒（fail-closed，与启动同口径）。
//  - function 规则：fn 为函数体字符串，签名 (message, extra) => string，
//    强制 return。保存/装载期编译 + 试运行校验；安全前提「operator 可信 +
//    回环-only」（运行期异常由管线 fail-safe 降级，不中断）。
const PIPELINE_RULE_JOIN_MODES = Object.freeze(['prefix', 'suffix', 'regex', 'function']);
const PIPELINE_RULE_KEYS = Object.freeze(['step', 'once', 'join', 'text', 'pattern', 'replacement', 'flags', 'fn']);
const PIPELINE_RULE_FLAGS_PATTERN = /^[dgimsuvy]*$/;
const PIPELINE_RULE_MAX_TEXT = 20000;

/**
 * 校验并归一单个编排步骤条目。返回
 * { name, static: boolean, rule: { once, join, text?, re?, replacement?, fn? } | null }。
 * 一切形状/规则问题以异常抛出（fail-closed：装载、热加载、控制面保存三处共用）。
 */
export function normalizePipelineStepEntry(step) {
  if (typeof step === 'string') {
    if (!STEP_NAME_PATTERN.test(step)) {
      throw new Error(`pipeline step name invalid: ${JSON.stringify(step)}`);
    }
    return { name: step, static: false, rule: null };
  }
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    throw new Error(`pipeline step name invalid: ${JSON.stringify(step)} (must be a name string or a rule object)`);
  }
  const unknown = Object.keys(step).filter((key) => !PIPELINE_RULE_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new Error(`pipeline step rule has unknown field(s): ${unknown.join(', ')} (allowed: ${PIPELINE_RULE_KEYS.join(', ')})`);
  }
  const name = step.step;
  if (typeof name !== 'string' || !STEP_NAME_PATTERN.test(name)) {
    throw new Error(`pipeline step rule "step" name invalid: ${JSON.stringify(name)}`);
  }
  if (name === 'protocol') {
    throw new Error('protocol step must stay a plain string (security token injection takes no rules)');
  }
  const once = step.once ?? false;
  if (typeof once !== 'boolean') throw new Error(`pipeline step "${name}": once must be a boolean`);
  const hasText = step.text !== undefined;
  if (hasText && (typeof step.text !== 'string' || step.text.length === 0 || step.text.length > PIPELINE_RULE_MAX_TEXT)) {
    throw new Error(`pipeline step "${name}": text must be a non-empty string (<= ${PIPELINE_RULE_MAX_TEXT} chars)`);
  }
  const join = step.join ?? (hasText ? 'suffix' : undefined);
  if (join !== undefined && !PIPELINE_RULE_JOIN_MODES.includes(join)) {
    throw new Error(`pipeline step "${name}": join must be one of ${PIPELINE_RULE_JOIN_MODES.join('|')}`);
  }
  const cross = [];
  if (step.pattern !== undefined && join !== 'regex') cross.push('pattern');
  if (step.replacement !== undefined && join !== 'regex') cross.push('replacement');
  if (step.flags !== undefined && join !== 'regex') cross.push('flags');
  if (step.fn !== undefined && join !== 'function') cross.push('fn');
  if (!hasText && join === 'regex' && step.pattern === undefined) cross.push('pattern(required)');
  if (!hasText && join === 'regex' && step.replacement === undefined) cross.push('replacement(required)');
  if (!hasText && join === 'function' && step.fn === undefined) cross.push('fn(required)');
  if (cross.length > 0) {
    throw new Error(`pipeline step "${name}": rule field(s) missing or not valid for join=${join}: ${cross.join(', ')}`);
  }
  const rule = { once, join, text: hasText ? step.text : undefined, re: null, replacement: undefined, fn: null };
  if (join === 'regex') {
    const flags = step.flags ?? 'g';
    if (typeof flags !== 'string' || !PIPELINE_RULE_FLAGS_PATTERN.test(flags)) {
      throw new Error(`pipeline step "${name}": flags must match ${PIPELINE_RULE_FLAGS_PATTERN.source}`);
    }
    if (typeof step.pattern !== 'string' || step.pattern.length === 0) {
      throw new Error(`pipeline step "${name}": pattern must be a non-empty string`);
    }
    if (typeof step.replacement !== 'string' || step.replacement.length > PIPELINE_RULE_MAX_TEXT) {
      throw new Error(`pipeline step "${name}": replacement must be a string (<= ${PIPELINE_RULE_MAX_TEXT} chars)`);
    }
    try {
      rule.re = new RegExp(step.pattern, flags);
    } catch (error) {
      throw new Error(`pipeline step "${name}": pattern does not compile: ${error?.message ?? error}`);
    }
    rule.replacement = step.replacement;
  }
  if (join === 'function') {
    if (typeof step.fn !== 'string' || step.fn.length === 0 || step.fn.length > PIPELINE_RULE_MAX_TEXT) {
      throw new Error(`pipeline step "${name}": fn must be a non-empty function body string`);
    }
    if (!/\breturn\b/.test(step.fn)) {
      throw new Error(`pipeline step "${name}": fn must contain a return statement`);
    }
    let compiled;
    try {
      compiled = new Function('message', 'extra', step.fn);
    } catch (error) {
      throw new Error(`pipeline step "${name}": fn does not compile: ${error?.message ?? error}`);
    }
    // 试运行（哨兵输入）：能编译 ≠ 能执行——返回类型错误在这里挡下。
    let sample;
    try {
      sample = compiled('__pipeline_check__', '__pipeline_check__');
    } catch (error) {
      throw new Error(`pipeline step "${name}": fn trial run failed: ${error?.message ?? error}`);
    }
    if (typeof sample !== 'string') {
      throw new Error(`pipeline step "${name}": fn must return a string (got ${typeof sample})`);
    }
    rule.fn = compiled;
  }
  return { name, static: hasText, rule };
}

/** 回环 URL 判定：不变量 §5.4（回环-only 外壳）在出站方向的镜像。 */
export function assertLoopbackUrl(raw, id) {
  let parsed;
  try {
    parsed = new URL(String(raw));
  } catch {
    throw new Error(`service "${id}": url is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error(
      `service "${id}": url must be a loopback http URL (got ${parsed.protocol}//${parsed.hostname})——`
      + '服务调用只允许回环，跨机部署需要先过网络层访问控制评审',
    );
  }
  return parsed.toString().replace(/\/+$/, '');
}

// selectMemoryService 的「多声明取首个」一次性告警去重（按候选 id 集合）。
const memoryServiceAmbiguityWarned = new Set();
// 布尔旧形态 memoryService:true 的一次性迁移告警去重（按服务 id）。
const memoryServiceLegacyFormWarned = new Set();
// 消费端非 hash id（qq-main 之类可读 id）的迁移告警去重（按服务 id）。
const legacyIdWarned = new Set();

/**
 * 管线步骤结果的改写器解析（tool.call 统一改造）：toolResult.ok 时的 data 按
 * 工具 role 用契约 schema 收口——decorator → { sections?, epoch? }（纯注入），
 * filter → { text, reason? }（改写器；text 空串 = 丢弃消息）。tool 角色 result
 * 不透明，不经此函数。非法结果抛 ContractError（管线捕获后记 degraded 放行）。
 *
 * @param {'decorator'|'filter'} role 被编排工具的单值角色
 * @param {unknown} data toolResult.data
 */
export function parsePipelineStepResult(role, data) {
  return role === 'filter' ? parseFilterResult(data) : parseDecoratorResult(data);
}

/**
 * 记忆服务选路（session-save 缓冲的 save 目标）。
 *
 * 三级优先：
 *   1. 显式 `GATEWAY_MEMORY_SERVICE`（必须已登记且未禁用，否则报错）；
 *   2. 唯一声明 `memoryService` 的登记服务；
 *   3. 多个声明 = 配置歧义：按 id 字典序取首个 + 一次性告警（onAmbiguous
 *      缺省 'first-warn'；'error' 则改为抛错——宁可报错也不猜）。
 *
 * saveTool 解耦（登记能力对象）：声明形态 `memoryService: { saveTool }` 为
 * 权威——网关按声明的工具名动态调用；旧布尔形态 `true` 兼容读取，saveTool
 * 取 `defaultSaveTool`（组合根注入的存量缺省）并一次性告警提示迁移。
 *
 * @param {Array<{id: string, enabled?: boolean, memoryService?: boolean|{saveTool: string}}> } services
 *        registry.services() 形状
 * @param {{explicit?: string|null, defaultSaveTool?: string|null,
 *          onAmbiguous?: 'first-warn'|'error', warn?: Function}} [options]
 * @returns {{id: string, saveTool: string|null}|null} 选路结果；null = 没有候选
 *          （服务未上线，调用方可重试）。saveTool null = 布尔旧形态且未提供缺省。
 */
export function selectMemoryService(services, { explicit = null, defaultSaveTool = null, onAmbiguous = 'first-warn', warn = () => {} } = {}) {
  const visible = (services ?? []).filter((service) => service.enabled !== false);
  const declared = visible.filter((service) => Boolean(service.memoryService));
  const pick = (service) => {
    const declaration = service.memoryService;
    if (declaration && typeof declaration === 'object') return declaration.saveTool ?? null;
    // 布尔旧形态：saveTool 交给组合根的存量缺省，一次性告警提示迁移。
    if (!memoryServiceLegacyFormWarned.has(service.id)) {
      memoryServiceLegacyFormWarned.add(service.id);
      warn(`服务 ${service.id} 的 memoryService 仍是旧布尔形态——请迁移为对象形态 `
        + `{"saveTool": "<chat_* 工具名>"}（旧形态按网关内置缺省工具处理，即将退役）`);
    }
    return defaultSaveTool;
  };
  if (explicit) {
    const service = visible.find((entry) => entry.id === explicit);
    if (!service) {
      const known = visible.map((entry) => entry.id).join(', ') || '无';
      throw new Error(`GATEWAY_MEMORY_SERVICE=${explicit} 未登记或已禁用（可用登记：${known}）`);
    }
    return { id: explicit, saveTool: pick(service) };
  }
  const candidates = [...declared].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (candidates.length <= 1) {
    const picked = candidates[0];
    return picked ? { id: picked.id, saveTool: pick(picked) } : null;
  }
  const ids = candidates.map((service) => service.id);
  if (onAmbiguous === 'error') {
    throw new Error(
      `多个登记服务声明了 memoryService（${ids.join(', ')}）：请用 GATEWAY_MEMORY_SERVICE 指定其一`,
    );
  }
  // first-warn：字典序首个 + 一次性告警（同一候选集合只告警一次）。
  const dedupeKey = ids.join('\u0000');
  if (!memoryServiceAmbiguityWarned.has(dedupeKey)) {
    memoryServiceAmbiguityWarned.add(dedupeKey);
    warn(
      `多个登记服务声明了 memoryService（${ids.join(', ')}）：按 id 字典序取 ${ids[0]}；`
      + '请用 GATEWAY_MEMORY_SERVICE 显式指定其一',
    );
  }
  const winner = candidates[0];
  return { id: winner.id, saveTool: pick(winner) };
}

/**
 * @param {object} options
 * @param {string}   options.pipelinesFile    pipelines.json 路径（config.pipeline.file 提供）
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string}   [options.stateDir]       相对 secretFile 的基准目录
 * @param {number}   [options.defaultTimeoutMs] 步骤缺省超时（config.pipeline.stepTimeoutMs）
 * @param {{dir: string, ledgerFile: string, reloadMs: number}|null} [options.registrations]
 *        登记目录配置（config.registrations）；null = 不启用自主登记（无外部服务）
 * @param {Function} [options.logger]
 * @param {Function} [options.now]
 */
export function createServiceRegistry({
  pipelinesFile,
  env = process.env,
  stateDir,
  defaultTimeoutMs = 8000,
  registrations: registrationsConfig = null,
  logger = () => {},
  now = Date.now,
}) {
  let wsHub = null;
  let pollTimer = null;
  // 编排权限门禁的「已知未注册身份」去重（pipelineFor 每消息调用，告警只发一次）。
  const warnedNonConsumers = new Set();

  /**
   * 消费端统一活视图（登记目录 = 唯一事实源）：
   *   - 登记目录 kind=consumer 且启用的条目（登记条目的 url 即 callbackBase、
   *     platform 为声明平台）。
   * 条目形状与 transport.deliverAction 的 adapter 参数同构
   * （{id, platform, callbackBase, secret, transport, timeoutMs}），
   * server.authenticate（HTTP 入站验签）、adapter-tools 清单拉取、动作下行、
   * 编排门禁全部消费这一份视图——消费端断点一次收编。
   */
  function consumers() {
    const out = new Map();
    for (const entry of registeredById.values()) {
      if (entry.kind !== 'consumer' || entry.enabled === false) continue;
      out.set(entry.id, {
        id: entry.id,
        platform: entry.platform,
        callbackBase: entry.url,
        secret: entry.secret,
        transport: entry.transport,
        timeoutMs: entry.timeoutMs,
        source: 'registry',
      });
    }
    return [...out.values()];
  }

  /** 单个消费端查视图（authenticate / deliverAction 的 O(1) 入口；未命中 null）。 */
  function consumerById(id) {
    return consumers().find((consumer) => consumer.id === id) ?? null;
  }

  // 多消费端收编：不再限制「一个平台一个消费端」——qq 多账号 = 多份 kind=consumer
  // 登记文件（各自 svc-<hash> id 与密钥），动作按会话键第 2 段（consumerId）路由，
  // 见 pending-forwarder 与 adapter-tools executor 的 byConsumer。

  /**
   * 消费端身份集（编排权限的判定源，P3）：只由登记消费端派生。编排是消费端
   * 才有的能力——注册为消费端后即拥有编排权限，登记卸载/停用即刻撤销
   * （下次 pipelineFor 生效，无需重启）。
   */
  function consumerIdSet() {
    const ids = new Set();
    for (const consumer of consumers()) ids.add(consumer.id);
    return ids;
  }

  // ── 文件加载 ───────────────────────────────────────────────────────────────
  // 编排文件只承载 pipelines / returnPipelines 两块（键是消费端）；服务登记在
  // 登记目录。parse 只读盘 + 形状校验并记录指纹（mtime+size，热加载比对用）；
  // 编排解析拆 buildPipelineEntries，初始装载与 reloadPipelines 共用同一套校验。
  const svcFingerprint = { exists: false, mtimeMs: 0, size: -1 };

  /** 读 pipelines.json：返回编排原始形状并记录指纹；文件不存在 = 无编排（透传）。 */
  function parsePipelinesFile() {
    if (!fs.existsSync(pipelinesFile)) {
      svcFingerprint.exists = false;
      return { rawPipelines: {}, rawReturnPipelines: {} };
    }
    const st = fs.statSync(pipelinesFile);
    svcFingerprint.exists = true;
    svcFingerprint.mtimeMs = st.mtimeMs;
    svcFingerprint.size = st.size;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(pipelinesFile, 'utf8'));
    } catch (error) {
      throw new Error(`failed to read ${pipelinesFile}: ${error?.message ?? error}`);
    }
    if (parsed && 'services' in parsed) {
      throw new Error([
        `${pipelinesFile} must be {"pipelines"?: {...}, "returnPipelines"?: {...}} but contains a "services" key.`,
        'Migration: (1) move each inline service into its own file under the registration dir;',
        '(2) copy "pipelines"/"returnPipelines" into a fresh pipelines.json;',
        '(3) delete the old services.json (and GATEWAY_SERVICES_FILE if set).',
      ].join(' '));
    }
    return {
      rawPipelines: parsed?.pipelines ?? {},
      // 回路链编排（通路/回路同形状）；runReturn 已接编排为真实执行器
      //（与 runForward 同构），returnEffective 为真实开关。
      rawReturnPipelines: parsed?.returnPipelines ?? {},
    };
  }

  // ── 管线编排解析（只做形状校验；步骤名解析在管线引擎，本层不认识内置名）────
  const pipelines = new Map();

  /** 校验并构建编排表（纯函数式：构建到新 Map，成功后由调用方换装）。条目存储原始形态
   *  （字符串或规则对象）——引擎按双形态消费，视图原样透出。
   *  options.forbidProtocol：回路链（P5）拒绝 protocol 条目——协议令牌只在
   *  入站方向有意义，出现在 returnPipelines 是配置错误（fail-closed）。 */
  function buildPipelineEntries(rawPipelines, { forbidProtocol = false } = {}) {
    const next = new Map();
    for (const [key, steps] of Object.entries(rawPipelines)) {
      if (typeof key !== 'string' || !/^[a-z0-9][a-z0-9:_-]{0,63}$/i.test(key)) {
        throw new Error(`pipelines key must be a consumer id or "default", got ${JSON.stringify(key)}`);
      }
      if (!Array.isArray(steps) || steps.length === 0) {
        throw new Error(`pipelines["${key}"] must be a non-empty array of step names or rule objects`);
      }
      if (steps.length > MAX_STEPS_PER_PIPELINE) {
        throw new Error(`pipelines["${key}"] exceeds ${MAX_STEPS_PER_PIPELINE} steps`);
      }
      for (const step of steps) {
        normalizePipelineStepEntry(step); // fail-closed
        if (forbidProtocol && (typeof step === 'string' ? step : step?.step) === 'protocol') {
          throw new Error(`pipelines["${key}"]: protocol is forward-only and must not appear in returnPipelines`);
        }
      }
      next.set(key, [...steps]);
    }
    return next;
  }

  // 初始装载（fail-closed：文件坏/形状错 = 启动失败，与 P2 语义一致）。
  const returnPipelines = new Map();
  {
    const { rawPipelines, rawReturnPipelines } = parsePipelinesFile();
    for (const [key, value] of buildPipelineEntries(rawPipelines)) pipelines.set(key, value);
    for (const [key, value] of buildPipelineEntries(rawReturnPipelines, { forbidProtocol: true })) returnPipelines.set(key, value);
  }

  // ── V2 P3 服务自主登记（登记目录扫描 + 热加载 + 注册台账）──────────────────
  // registeredById：登记文件装载出的服务（服务身份的唯一来源，内联 services
  // 已随编排硬切退役）。regFiles：文件指纹台账（mtime+size），驱动增量热加载。
  const registeredById = new Map();
  const regFiles = new Map();
  const regListeners = new Set();
  const regLedger = registrationsConfig
    ? createRegistrationLedger({ file: registrationsConfig.ledgerFile, now })
    : null;

  /** 单份登记文件的解析与校验。返回 { reg, entry }；一切问题以异常抛出。 */
  function resolveRegistrationFile(filePath) {
    const stem = path.basename(filePath).replace(/\.json$/i, '');
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      throw new Error(`invalid JSON: ${error?.message ?? error}`);
    }
    // 文件名即身份（<id>.json）：卸载检测靠文件消失，改名 = 先卸旧的再注册新的。
    const reg = parseServiceRegistration(parsed);
    if (reg.id !== stem) {
      throw new Error(`file name must be "<id>.json" matching the id inside (file "${path.basename(filePath)}", id "${reg.id}")`);
    }
    if (!SERVICE_ID_PATTERN.test(reg.id)) {
      throw new Error(`id must match ${SERVICE_ID_PATTERN.source}`);
    }
    if (registeredById.has(reg.id) && registeredById.get(reg.id).file !== filePath) {
      throw new Error(`id "${reg.id}" already registered from ${path.basename(registeredById.get(reg.id).file)}`);
    }
    // 消费端 id 词法（hash 化，多消费端收编）：id 只标识服务实例、与平台解耦。
    // 非 svc-<hash> 的存量可读 id（qq-main 之类）兼容读取但告警迁移——新登记
    // 由控制台/gen-secret 直接生成 svc- id，不再发可读形态。
    if (reg.kind === 'consumer' && !CONSUMER_ID_RE.test(reg.id) && !legacyIdWarned.has(reg.id)) {
      legacyIdWarned.add(reg.id);
      logger(`警告：消费端 "${reg.id}" 的 id 不是 svc-<hash> 形态（id 应与平台名解耦，同平台多账号互不冲突）`
        + `——请迁为 state/gateway/services/svc-<hash>.json 并同步编排键与桥接 gateway.json 的 id`);
    }
    // http/auto 的 url 是服务基址（origin）：回环校验与登记契约同口径。
    const url = typeof reg.url === 'string' && reg.url
      ? assertLoopbackUrl(reg.url, reg.id) : null;
    const timeoutMs = reg.timeoutMs ?? defaultTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
      throw new Error(`timeoutMs must be an integer in [1000, 60000]`);
    }
    return {
      reg,
      entry: {
        id: reg.id,
        name: reg.name,
        kind: reg.kind,
        transport: reg.transport,
        url,
        timeoutMs,
        // consumer 平台声明（动作会话定位 + 入站验签 expectedPlatform）；
        // 非 consumer 恒 null。平台唯一性在 assertConsumerPlatforms 校验。
        platform: reg.kind === 'consumer' ? (reg.platform ?? null) : null,
        secret: resolveSecret(reg, env, stateDir, 'registered service'),
        enabled: reg.enabled,
        // memoryService 声明原样保存（boolean|{saveTool}）——saveTool 解析在
        // selectMemoryService（布尔旧形态的缺省工具由组合根注入，core 无字面量）。
        memoryService: reg.memoryService ?? null,
        tools: reg.tools ?? [],
        // 平台→预设声明原样保存：建会话时的 preset 唯一来源（见 session-registry）。
        presets: reg.presets ?? null,
        file: filePath,
        reg,
      },
    };
  }

  /**
   * 扫描登记目录，增量装载/卸载。source 记进台账：'startup'（初始装载）/
   * 'file'（热加载轮询）/ 'operator'（P4 UI 预留）。
   * @returns {boolean} 服务面是否发生变化（含坏文件首见 reject）
   */
  function scanRegistrations(source) {
    if (!registrationsConfig) return false;
    let changed = false;

    // 1) 磁盘清单（只看 *.json，忽略子目录与临时文件）
    const filesOnDisk = new Map();
    if (fs.existsSync(registrationsConfig.dir)) {
      for (const name of fs.readdirSync(registrationsConfig.dir)) {
        if (!name.toLowerCase().endsWith('.json')) continue;
        const full = path.join(registrationsConfig.dir, name);
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue; // 竞态：扫描间隙文件被删，下轮再看
        }
        if (st.isFile()) filesOnDisk.set(full, { mtimeMs: st.mtimeMs, size: st.size });
      }
    }

    // 2) 新增 / 变更：按份 fail-safe——坏文件 reject（记台账+日志），
    //    同 id 此前由该文件装载成功的旧登记保持原状，等服务修好。
    for (const [file, fp] of filesOnDisk) {
      const known = regFiles.get(file);
      if (known && known.mtimeMs === fp.mtimeMs && known.size === fp.size) continue;
      try {
        const { reg, entry } = resolveRegistrationFile(file);
        registeredById.set(reg.id, entry);
        regFiles.set(file, { id: reg.id, ...fp });
        // url/secret 可能变了：作废缓存的 HTTP 客户端，下次调用重建。
        httpClients.delete(reg.id);
        // register 覆盖首装与变更（upsert 语义）：台账只需这一种正向动作。
        regLedger.append({
          serviceId: reg.id, action: 'register', source,
          snapshot: redactRegistration(reg),
        });
        logger(`service registered: ${reg.id} (kind=${reg.kind} transport=${reg.transport} `
          + `tools=${entry.tools.length} enabled=${reg.enabled}) [${source}]`);
        changed = true;
      } catch (error) {
        const stem = path.basename(file).replace(/\.json$/i, '');
        const previousId = known?.id ?? null;
        regLedger.append({
          serviceId: stem, action: 'reject', source,
          reason: String(error?.message ?? error).slice(0, 300),
        });
        logger(`registration rejected: ${path.basename(file)}: ${error?.message ?? error} [${source}]`);
        // 指纹照样更新：同内容不重复 reject；previousId 保留以便该文件之后
        // 被删除时能撤销它此前装载成功的旧登记。
        regFiles.set(file, { id: previousId, ...fp });
        changed = true;
      }
    }

    // 3) 消失的文件 = 卸载：服务面即刻失效（工具面消失、管线步骤 degraded）。
    for (const [file, known] of [...regFiles]) {
      if (filesOnDisk.has(file)) continue;
      regFiles.delete(file);
      const entry = known.id ? registeredById.get(known.id) : null;
      if (entry && entry.file === file) {
        registeredById.delete(known.id);
        httpClients.delete(known.id);
        regLedger.append({
          serviceId: known.id, action: 'unregister', source,
          snapshot: redactRegistration(entry.reg),
        });
        logger(`service unregistered: ${known.id} (registration file removed) [${source}]`);
        changed = true;
      }
    }

    if (changed) {
      for (const listener of regListeners) {
        try {
          listener();
        } catch (error) {
          logger(`registration reload listener failed: ${error?.message ?? error}`);
        }
      }
    }
    return changed;
  }

  /**
   * pipelines.json 热加载（P4 编排 UI）：编排 PUT 保存后调它即时生效。
   * 指纹（mtime+size）比对跳过无变化；force=true 跳过比对（写后重读场景）。
   * 校验与启动同口径（fail-closed）：文件坏/形状错抛错上抛，服务面保持原状——
   * 调用方（控制面路由）负责把错误转成 E_* 响应。成功后整面换装、作废全部
   * HTTP 客户端缓存（url/secret/timeout 可能变了）并通知 onReload 监听方。
   * @returns {boolean} 服务面/编排是否发生变化
   */
  function reloadPipelines({ force = false } = {}) {
    if (fs.existsSync(pipelinesFile)) {
      const st = fs.statSync(pipelinesFile);
      if (!force && svcFingerprint.exists
        && svcFingerprint.mtimeMs === st.mtimeMs && svcFingerprint.size === st.size) {
        return false;
      }
    } else if (!force && !svcFingerprint.exists) {
      return false;
    }
    const { rawPipelines, rawReturnPipelines } = parsePipelinesFile();
    const nextPipelines = buildPipelineEntries(rawPipelines);
    const nextReturnPipelines = buildPipelineEntries(rawReturnPipelines, { forbidProtocol: true });
    pipelines.clear();
    for (const [key, value] of nextPipelines) pipelines.set(key, value);
    returnPipelines.clear();
    for (const [key, value] of nextReturnPipelines) returnPipelines.set(key, value);
    logger(`pipelines.json reloaded: pipelines=[${[...pipelines.keys()].join(', ')}] returns=[${[...returnPipelines.keys()].join(', ')}]`);
    for (const listener of regListeners) {
      try {
        listener();
      } catch (error) {
        logger(`pipelines.json reload listener failed: ${error?.message ?? error}`);
      }
    }
    return true;
  }

  /**
   * 单消费者编排写入（P4 编排 UI）：更新一个消费者（或 "default"）的通路/
   * 回路序列并原子落盘 + 热加载。forward / returnSteps 传 null = 删除该方向
   * 编排（空 = 透传，语义同「键不存在」）。形状校验复用 buildPipelineEntries
   * （与启动同口径）；消费端身份的门禁在这里挡（consumerIdSet）。落盘 =
   * 临时文件 + rename 原子替换，文件是唯一事实源——写完 reloadPipelines(force)
   * 整面重读。文件只写 pipelines/returnPipelines 两块，绝不补 services。
   */
  function updateConsumerPipeline(consumerId, forward, returnSteps) {
    if (consumerId !== 'default' && !consumerIdSet().has(consumerId)) {
      throw new Error(`pipelines key "${consumerId}" has no consumer behind it — register "${consumerId}" as a consumer or use "default"`);
    }
    if (forward) buildPipelineEntries({ [consumerId]: forward });
    // 回路方向 fail-closed 拒 protocol（P5：令牌只在入站方向有意义）。
    if (returnSteps) buildPipelineEntries({ [consumerId]: returnSteps }, { forbidProtocol: true });
    const doc = fs.existsSync(pipelinesFile)
      ? JSON.parse(fs.readFileSync(pipelinesFile, 'utf8'))
      : {};
    // 旧文件残留的 services 键在这里同样 fail-closed（启动/热加载已拦，写路径兜底）。
    if (doc && 'services' in doc) {
      throw new Error(`${pipelinesFile} still contains a "services" key — migrate inline services to the registration dir before editing pipelines`);
    }
    const apply = (block, steps) => {
      if (steps) {
        doc[block] = { ...(doc[block] ?? {}), [consumerId]: [...steps] };
      } else if (doc[block]) {
        delete doc[block][consumerId];
      }
    };
    apply('pipelines', forward);
    apply('returnPipelines', returnSteps);
    const mode = fs.existsSync(pipelinesFile) ? (fs.statSync(pipelinesFile).mode & 0o777) : 0o600;
    const tmp = `${pipelinesFile}.tmp-${process.pid}-${now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode });
    fs.renameSync(tmp, pipelinesFile);
    reloadPipelines({ force: true });
  }

  // （登记启动装载在下方 httpClients 声明之后执行——scan 会 invalidate 其缓存。）

  // ── HTTP 出站（备用通道，协议一律走库：shared/http-client）─────────────────
  const httpClients = new Map();
  function httpClientFor(service) {
    if (!httpClients.has(service.id)) {
      httpClients.set(service.id, createHttpClient({
        baseUrl: service.url,
        timeoutMs: service.timeoutMs,
        logger,
        // 签名格式与入站鉴权完全一致（auth.mjs v1），服务侧用同一套 verify 即可。
        sign: ({ body }) => signRequest({ secret: service.secret, adapterId: service.id, body, timestamp: now() }),
      }));
    }
    return httpClients.get(service.id);
  }

  // ── 登记启动装载（在 httpClients 之后：scan 会 invalidate 其缓存）───────────
  if (registrationsConfig) {
    scanRegistrations('startup');
    if (registrationsConfig.reloadMs > 0) {
      const timer = setInterval(() => scanRegistrations('file'), registrationsConfig.reloadMs);
      timer.unref?.();
      pollTimer = timer;
    }
  }
  // 多消费端收编：同平台多 consumer 合法（会话键绑消费端路由），无全局唯一性校验。


  return {
    /** ws-hub 建好后挂接（main.mjs 装配顺序：registry → ws-hub → attach）。 */
    attachWs(hub) { wsHub = hub; },

    /** 健康视图（不含 secret）：登记目录里的全部服务（内联 services 已退役）。 */
    services() {
      const merge = ({
        id, kind, transport, url, timeoutMs, enabled = true, platform,
        memoryService, tools = [], presets = null, file = null,
      }) => ({
        id,
        kind,
        transport,
        url,
        timeoutMs,
        enabled,
        // consumer 平台声明（其余 kind 恒 null）。
        platform,
        // 记忆服务声明原样透出（boolean|{saveTool}；selectMemoryService 选路依据，
        // 控制台记忆徽标只看真值）。
        memoryService,
        // 登记服务携带的工具名。
        tools: tools.map((tool) => tool.name),
        // 平台→预设声明（{qq:'qq-chat'}）。建会话时网关按它选 preset——
        // 平台身份知识归适配器，网关不持有任何平台映射表。
        presets: presets ?? null,
        // 来源文件（排障「这个服务从哪来的」）。
        file: file ? path.basename(file) : null,
        // 连接状态只有挂了 ws-hub 之后才有意义；http-only 服务恒为 false。
        connected: Boolean(wsHub?.isConnected?.(id)),
      });
      return [...registeredById.values()].map(merge);
    },

    resolveService(id) { return registeredById.get(id) ?? null; },

    /**
     * 控制台「编辑消费端预设」（2026-11-17）：只写 presets 一个字段。
     *
     * 声明只是名字（内容归消费端），但它是登记文件的一部分——写回必须保留
     * 其它字段原样：读文件 → 合并 → 0600 原子写 → scanRegistrations('operator')
     * 重载内存并记台账（与 POST 注册同一口径，热生效、无需重启网关）。
     *
     * @param {string} id consumer id（svc-*）
     * @param {Record<string,string>|null} presets null = 清除声明（回退 minimal）
     * @returns {{ok:true, id:string, presets:(object|null)}|
     *           {ok:false, status:number, error:string}}
     */
    updateRegistrationPresets(id, presets) {
      const entry = registeredById.get(String(id ?? ''));
      if (!entry) return { ok: false, status: 404, error: `登记不存在：${id}` };
      if (entry.kind !== 'consumer') {
        return { ok: false, status: 400, error: `${id} 的 kind=${entry.kind}，preset 声明只对 consumer 有意义` };
      }
      let normalized = null;
      if (presets !== null && presets !== undefined) {
        const parsed = presetsDeclarationSchema.safeParse(presets);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          return {
            ok: false,
            status: 400,
            error: `presets 形状非法（${issue?.path?.join('.') || 'body'}）：${issue?.message ?? 'schema 校验失败'}`,
          };
        }
        normalized = parsed.data;
      }
      if (!entry.file) return { ok: false, status: 500, error: '登记记录缺少 file 字段，无法写回' };
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
      } catch (error) {
        return { ok: false, status: 500, error: `登记文件不可读：${error?.message ?? error}` };
      }
      if (normalized === null) delete raw.presets;
      else raw.presets = normalized;
      try {
        fs.writeFileSync(entry.file, `${JSON.stringify(raw, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      } catch (error) {
        return { ok: false, status: 500, error: `登记文件写入失败：${error?.message ?? error}` };
      }
      scanRegistrations('operator');
      return { ok: true, id: String(id), presets: normalized };
    },

    /**
     * 消费端统一活视图（只由登记目录 kind=consumer 派生；条目形状与
     * transport.deliverAction 的 adapter 参数同构）。HTTP 入站验签、WS 握手身份、
     * 动作下行、清单拉取、编排门禁全部消费这一份视图。
     */
    consumers,

    /** 单个消费端查视图（O(1) 入口；未命中 null）。 */
    consumerById,

    /**
     * 登记目录视图（健康/排障用；与 services() 的区别是带文件名与原始状态）。
     * platform 只对 kind=consumer 有意义（动作会话定位 + 入站验签）。
     */
    registrations() {
      return [...registeredById.values()].map(({
        id, name, kind, transport, url, platform, enabled, memoryService, file, tools = [], presets = null,
      }) => ({
        id,
        name,
        kind,
        // 与 services() 字段对齐（同一服务的两条视图路径同形）：transport 缺省
        // 'http'（resource 契约强制 http，consumer 合法 auto/ws/http）；url 缺省
        // null——控制台 svcCard 的徽标裸插值依赖这里输出完整字段。
        transport: transport ?? 'http',
        url: url ?? null,
        platform: platform ?? null,
        enabled,
        memoryService: Boolean(memoryService),
        file: path.basename(file),
        tools: tools.map((tool) => tool.name),
        presets: presets ?? null,
      }));
    },

    /** 已登记且启用的工具面（tool-routing 的 /v1/tools 合并源）。 */
    registeredTools() {
      const out = [];
      for (const entry of registeredById.values()) {
        if (entry.enabled === false) continue;
        for (const tool of entry.tools) {
          out.push({
            serviceId: entry.id,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            // 单值角色随声明透出：tool-host 只关心 tool，管线解析看 decorator/filter。
            role: tool.role,
          });
        }
      }
      return out;
    },

    /**
     * 管线步骤解析的第二级：decorator/filter 角色的登记工具名（工具即步骤）。
     * 管线步骤名直接写工具名（如 chat_memory_get）即可把该工具编排为步骤，
     * 工具调用与装饰器注入共用服务侧同一实现（全部走 tool.call）。
     * 返回 { service, kind, tool } 或 null。
     */
    resolveToolStep(name) {
      for (const entry of registeredById.values()) {
        if (entry.enabled === false) continue;
        const tool = entry.tools.find((candidate) => candidate.name === name
          && (candidate.role === 'decorator' || candidate.role === 'filter'));
        if (tool) return { service: entry, kind: entry.kind, tool };
      }
      return null;
    },

    /** 登记面变更回调（返回退订函数）。工具面缓存刷新在 tool-routing 挂这里。 */
    onReload(listener) {
      regListeners.add(listener);
      return () => regListeners.delete(listener);
    },

    /** pipelines.json 热加载（P4 编排 UI 保存后调用；语义见函数注释）。 */
    reloadPipelines,

    // ── P4 编排 UI 读面 ─────────────────────────────────────────────────────
    /** 通路编排视图：[{ key, steps }]。 */
    pipelinesView() { return [...pipelines].map(([key, steps]) => ({ key, steps })); },
    /** 回路编排视图：[{ key, steps }]（P5 起 runReturn 已接编排，returnEffective 为真实开关）。 */
    returnPipelinesView() { return [...returnPipelines].map(([key, steps]) => ({ key, steps })); },
    /** 消费端身份判定（编排权限门禁的查询面；'default' 由调用方单独放行）。 */
    isConsumer(id) { return consumerIdSet().has(id); },
    /** 登记目录扫描（P4 UI 注册/卸载后即时生效；source 记台账）。 */
    scanRegistrations,
    /** 单消费者通路/回路编排写入（身份门禁 + 形状校验 + 原子落盘 + 热加载）。 */
    updateConsumerPipeline,
    /**
     * 编排步骤条目校验（P4.x 控制面保存前置）：复用 buildPipelineEntries 的
     * 条目校验（形状 + regex/fn fail-closed），返回归一清单
     * [{ name, static }]——控制面用它做「未知步骤」三级解析前置校验
     * （static 条目不解析）。校验失败抛错（调用方转 E_SCHEMA）。
     */
    inspectPipelineSteps(steps) {
      return steps.map((step) => {
        const normalized = normalizePipelineStepEntry(step);
        return { name: normalized.name, static: normalized.static };
      });
    },
    /** 登记台账读取（P4 审计页）：尾部 limit 条（新在前）+ 坏行计数；未启用登记 = null。 */
    registrationLedger({ limit = 100 } = {}) {
      if (!regLedger) return null;
      const { events, corrupt } = regLedger.readAll();
      return { events: events.slice(-limit).reverse(), corrupt, total: events.length };
    },

    /** 停止热加载轮询（main.mjs shutdown 调；不撤销已装载的服务）。 */
    stop() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },

    /**
     * per-consumer 步骤序列：精确键 → default → 空管线（透传）。
     * 编排权限门禁（P3）：编排是消费端才有的能力——consumerId 必须是登记的
     * 消费端（kind=consumer 且启用）或过渡期的既有 adapter，否则不享受编排
     * （含 default 键），消息透传。装饰器步骤由网关替消费端执行，编排声明
     * 归属消费端，与模型主动的 tool.call 是两条出路（模型只能经网关调工具）。
     */
    pipelineFor(consumerId) {
      if (!consumerIdSet().has(consumerId)) {
        if (!warnedNonConsumers.has(consumerId)) {
          warnedNonConsumers.add(consumerId);
          logger(`pipeline skipped for "${consumerId}": not a registered consumer (orchestration is a consumer capability)`);
        }
        return [];
      }
      return pipelines.get(consumerId) ?? pipelines.get('default') ?? [];
    },

    /**
     * 回路编排读取口（P5 runReturn 引擎）：方向 = DSH 产出 → 消费者。
     * 键解析与 pipelineFor 同口径（精确 consumerId → 'default' 回退 → 空 = 透传）；
     * 条目已在校验层拒 protocol（令牌只在入站有意义）。
     */
    pipelineForReturn(consumerId) {
      if (!consumerIdSet().has(consumerId)) {
        if (!warnedNonConsumers.has(consumerId)) {
          warnedNonConsumers.add(consumerId);
          logger(`return pipeline skipped for "${consumerId}": not a registered consumer (orchestration is a consumer capability)`);
        }
        return [];
      }
      return returnPipelines.get(consumerId) ?? returnPipelines.get('default') ?? [];
    },

    /**
     * 启动期编排权限校验（fail-closed，main.mjs 装配时调用）：管线键必须对应
     * 消费端身份或 "default"。给未注册消费端预配的编排是配置错误——挡在启动，
     * 与步骤名校验（pipeline.validate）同口径。
     */
    assertPipelinePermissions() {
      const consumers = consumerIdSet();
      for (const key of pipelines.keys()) {
        if (key !== 'default' && !consumers.has(key)) {
          throw new Error(`pipelines key "${key}" has no consumer behind it — register "${key}" as a consumer or remove the orchestration`);
        }
      }
      // 回路编排同口径（P5）：预配给未注册消费端的回路编排同为配置错误。
      for (const key of returnPipelines.keys()) {
        if (key !== 'default' && !consumers.has(key)) {
          throw new Error(`returnPipelines key "${key}" has no consumer behind it — register "${key}" as a consumer or remove the orchestration`);
        }
      }
    },

    /** 已编排的键（健康视图用）。 */
    pipelineKeys() { return [...pipelines.keys()]; },

    /** 已编排回路键（健康视图用，P5）。 */
    returnPipelineKeys() { return [...returnPipelines.keys()]; },

    /**
     * V2 P3 → tool.call 统一改造：向已登记服务发起一次工具调用（tool.call），
     * 返回 parseToolResult 形状（{ ok, data?, error? }）。业务失败（ok:false）
     * 是正常结果，只有传输/契约问题抛 ContractError——调用方（ToolHost 服务
     * 执行器 / 管线引擎）把传输失败翻译成 degraded 结果。
     *
     * 这是服务间调用的唯一信封（service.call 已全链路下线）：HTTP POST
     * /v1/tools/call（资源服务纯被动，传输非对称后 HTTP 是唯一通道——
     * WS tool.call 帧已随资源侧连接器退役），响应复用 toolResultSchema
     * （callId 关联 + ok/data/error 形状），网关侧核对 callId。
     *
     * 安全边界：request 不含 turnToken——安全链不下放（不变量 §5.2），
     * 令牌校验在网关 ToolHost 层完成，这里只下发会话标识与 context。
     *
     * @param {string} id 服务 id（登记目录）
     * @param {{tool: string, args?: object, sessionKey?: string, turnId?: string,
     *          context?: {senderId?: string, text?: string}}} request
     *        context.text 仅 filter 步骤下发（当前工作文本）；decorator/tool 不带。
     */
    async callServiceTool(id, request) {
      const service = registeredById.get(id);
      if (!service) throw new ContractError('E_SCHEMA', `unknown service: ${id}`);
      if (service.enabled === false) {
        throw new ContractError('E_DISABLED', `service "${id}" is disabled by its registration`);
      }
      const callId = `svctool-${randomUUID()}`;
      const body = {
        v: 1,
        callId,
        tool: String(request?.tool ?? ''),
        args: request?.args ?? {},
        sessionKey: request?.sessionKey,
        turnId: request?.turnId,
        context: request?.context,
      };

      // HTTP-only（传输非对称）：资源服务 transport 已强制 http，恒走
      // POST <url>/v1/tools/call（HMAC 头验签 + 幂等 callId）。
      const response = await httpClientFor(service)
        .post('/v1/tools/call', body, { timeoutMs: service.timeoutMs });
      if (!response.ok) {
        throw new ContractError(
          response.code === 'E_NETWORK' ? 'E_NETWORK' : response.code,
          `tool.call to "${id}" failed: ${response.error}`,
        );
      }
      const raw = response.body;

      let result;
      try {
        result = parseToolResult(raw);
      } catch (error) {
        throw new ContractError('E_SCHEMA', `service "${id}" returned an invalid tool result: ${error?.message ?? error}`);
      }
      if (result.callId !== callId) {
        throw new ContractError('E_SCHEMA', `service "${id}" tool result callId mismatch (got ${result.callId})`);
      }
      return result;
    },

    /**
     * 拉取 resource 服务的工具清单（GET /v1/tools，控制台「拉取清单预填」数据源）。
     * 只读：不写登记、不进 toolHost 词典；凭据直接用登记自身的 url+secret——
     * 调用方（operator）无需也无法经 UI 提供凭据，安全面不变。
     * consumer 不适用：能力面由适配器 manifest 现拉，静态声明反而是错误形态。
     */
    async fetchServiceManifest(id) {
      const service = registeredById.get(String(id ?? ''));
      if (!service) return { ok: false, status: 404, error: `登记不存在：${id}` };
      if (service.enabled === false) return { ok: false, status: 400, error: `服务 "${id}" 已被登记停用` };
      if (service.kind === 'consumer') {
        return { ok: false, status: 400, error: 'consumer 的能力面由适配器 manifest 现拉，无需静态声明工具清单' };
      }
      const response = await httpClientFor(service).get('/v1/tools', { timeoutMs: 5000 });
      if (!response.ok) {
        return { ok: false, status: 502, error: `拉取清单失败（${response.code}）：${response.error}——服务未在线或未升级清单端点` };
      }
      const raw = response.body;
      if (raw?.ok !== true || !Array.isArray(raw?.tools)) {
        return { ok: false, status: 502, error: '服务清单形状不符（期望 {ok:true, tools:[…]}）' };
      }
      const named = raw.tools.filter((tool) => tool && typeof tool.name === 'string');
      // 与登记 schema 对齐：≤32 条；超出截断并如实标记（不静默丢弃）。
      return { ok: true, id: service.id, tools: named.slice(0, 32), truncated: named.length > 32 };
    },

    /**
     * 写回登记的 tools 声明（PUT /v1/console/services/<id>/tools）。镜像
     * updateRegistrationPresets：只动 tools 字段、逐条 schema 校验、原子写回 +
     * 立即重扫（热加载生效——编排步骤/registeredTools 下一拍可用，无需重启）。
     */
    updateRegistrationTools(id, tools) {
      const entry = registeredById.get(String(id ?? ''));
      if (!entry) return { ok: false, status: 404, error: `登记不存在：${id}` };
      if (entry.kind === 'consumer') {
        return { ok: false, status: 400, error: 'consumer 登记不声明工具清单（能力面走适配器 manifest）' };
      }
      if (!Array.isArray(tools)) return { ok: false, status: 400, error: 'body 需要 tools 数组' };
      if (tools.length > 32) return { ok: false, status: 400, error: 'tools 超过 32 条上限（与登记 schema 对齐）' };
      const normalized = [];
      for (const [i, tool] of tools.entries()) {
        const parsed = serviceToolDeclarationSchema.safeParse(tool);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          return { ok: false, status: 400, error: `tools[${i}] 形状非法：${issue?.message ?? 'schema 校验失败'}` };
        }
        normalized.push(parsed.data);
      }
      if (!entry.file) return { ok: false, status: 500, error: '登记记录缺少 file 字段，无法写回' };
      let doc;
      try {
        doc = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
      } catch (error) {
        return { ok: false, status: 500, error: `登记文件不可读：${error?.message ?? error}` };
      }
      doc.tools = normalized;
      try {
        fs.writeFileSync(entry.file, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      } catch (error) {
        return { ok: false, status: 500, error: `登记文件写入失败：${error?.message ?? error}` };
      }
      scanRegistrations('operator');
      return { ok: true, id: entry.id, tools: normalized };
    },
  };
}
