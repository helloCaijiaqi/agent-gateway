/**
 * 网关的线缆契约（wire contracts）。
 *
 * 为什么单独一个文件：
 *   适配器（各平台各自实现）与网关分属两个进程，唯一能保证「双方对同一件事
 *   理解一致」的东西就是这里的 schema。把契约散在各自的 handler 里，第一次改动就会
 *   出现「适配器多传一个字段、网关默默忽略」这类不可回归的偏差。
 *
 * 三个刻意的选择：
 *
 *  1. **strict**：未知字段直接拒绝。宁可让适配器报错，也不要让一个拼错的
 *     `conversationId` 悄悄落进 `payload` 然后发到错误的群。
 *  2. **鉴权在 HTTP 头，不在 body**：body 里的 `auth` 只为兼容早期草案保留，
 *     网关一律以 `X-Signature` 为准。否则一个被转发过的 body 可以自带「签名」。
 *  3. **payload 按 type 二次校验**：zod 只能校验「payload 是对象」，真正决定
 *     动作能不能执行的是 `validateActionPayload`。没有这一步，模型传
 *     `{ type:'send_text' }` 会一路走到适配器才炸。
 */
import crypto from 'node:crypto';
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const PLATFORMS = Object.freeze(['qq', 'wx']);
export const CONVERSATION_KINDS = Object.freeze(['group', 'private', 'room']);
export const SENDER_ROLES = Object.freeze(['owner', 'member', 'bot']);
export const MEDIA_KINDS = Object.freeze(['image', 'voice', 'video', 'file', 'sticker']);

/**
 * 动作类型。新增类型必须同时补三处：这里、`ACTION_PAYLOAD_RULES`、
 * 适配器的 `capabilities`。少任何一处都会变成「模型说了但没发生」。
 *
 * 阶段 1 清单驱动扩容：qq 适配器的能力面改为 actions-manifest.json 声明
 * （桥接侧唯一事实源），这里的清单只扩「网关认识的线缆词汇表」，让
 * /v1/tools/call → adapter-tools 的动作不再被信封 schema 拦截；payload 的
 * 逐字段语义校验下沉到适配器清单的 payloadSchema（E_SCHEMA 在适配器侧判），
 * 网关对新类型只做信封级校验——避免同一份 schema 在两仓各维护一份。
 */
export const ACTION_TYPES = Object.freeze([
  'send_text', 'reply', 'send_media', 'send_sticker', 'send_voice',
  'send_file', 'poke', 'mark_read', 'wait', 'set_wake', 'noop',
  // 适配器清单驱动扩容（能力事实源在适配器仓 src/actions-manifest.json）
  'send_message', 'send_burst', 'send_group_message', 'send_private_message',
  'get_prompt', 'get_unread', 'get_recent', 'get_my_recent', 'social_state',
  'get_message_detail', 'get_message_images', 'get_forward_msg',
  'get_active_members', 'get_group_members', 'list_groups', 'get_history',
  'list_stickers', 'get_sticker_image', 'get_self_image',
  'collect_sticker', 'sticker_note', 'set_sticker_remark', 'list_voices',
  'memory_append', 'memory_query', 'memory_remove', 'memory_clear',
  // pending 平台转发（docs/console/dsh-pending/PLAN.md 第二阶段）：
  // ask 把 DSH 提问转达给会话；approve 转达工具审批请求（均通知性质、不自动应答）。
  'ask', 'approve',
]);

export const ERROR_CODES = Object.freeze([
  'E_AUTH', 'E_REPLAY', 'E_SCHEMA', 'E_DUP', 'E_BUSY', 'E_POLICY',
  'E_DSH_DOWN', 'E_TIMEOUT', 'E_ACTION', 'E_PLATFORM', 'E_EXPIRED',
  'E_UNSUPPORTED', 'E_DISABLED', 'E_INTERNAL', 'E_FORBIDDEN', 'E_RATE_LIMITED',
]);

/** 契约错误：带稳定 code，调用方可据此决定重试还是告警。 */
export class ContractError extends Error {
  constructor(code, message, issues) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
    this.issues = issues ?? [];
  }
}

const compactText = (max) => z.string().min(1).max(max);
const idText = (max = 128) => z.string().min(1).max(max).regex(/^[^\u0000-\u001f]+$/, 'id must not contain control characters');

const conversationSchema = z.strictObject({
  kind: z.enum(CONVERSATION_KINDS),
  id: idText(128),
});

const senderSchema = z.strictObject({
  id: idText(128),
  name: z.string().max(64),
  roles: z.array(z.enum(SENDER_ROLES)).max(3),
});

const mediaSchema = z.strictObject({
  kind: z.enum(MEDIA_KINDS),
  ref: compactText(2048),
  mime: z.string().max(128).optional(),
  size: z.number().int().nonnegative().optional(),
});

const quoteSchema = z.strictObject({
  messageId: idText(128),
  sender: z.string().max(64).optional(),
  text: z.string().max(2000).optional(),
});

const messageSchema = z.strictObject({
  id: idText(128),
  seq: z.number().int().nonnegative().optional(),
  sender: senderSchema,
  text: z.string().max(20000),
  mentions: z.array(z.string().max(128)).max(64).optional(),
  quote: quoteSchema.optional(),
  media: z.array(mediaSchema).max(16).optional(),
});

const authSchema = z.strictObject({
  timestamp: z.number().int().nonnegative(),
  nonce: idText(128),
  signature: compactText(256),
});

/**
 * 合成唤醒标记（阶段 2）：适配器把「模型登记过的等待已满足」这类**事件**随入站
 * 信封一起送来。它不是用户消息，网关据此决定这一轮是「唤醒回推」而不是普通聊天：
 *   · kind=wait：chat_qq_wait 登记的消息到了；
 *   · kind=proactive：适配器侧定时器（冒泡）合成的事件。
 * status 缺省视为 arrived（正常到达），timeout 只用于将来「等待超时也回推」的扩展。
 */
const wakeSchema = z.strictObject({
  kind: z.enum(['wait', 'proactive']),
  status: z.enum(['arrived', 'timeout']).optional(),
  purpose: z.enum(['messages', 'reply']).optional(),
  registeredAt: z.number().int().nonnegative().optional(),
  expiresAt: z.number().int().nonnegative().optional(),
  baselineSeq: z.number().int().nonnegative().optional(),
  satisfiedSeq: z.number().int().nonnegative().optional(),
});

export const inboundSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  platform: z.enum(PLATFORMS),
  adapterId: idText(64),
  traceId: idText(128),
  receivedAt: z.number().int().nonnegative(),
  conversation: conversationSchema,
  message: messageSchema,
  // 合成事件信封：没有 prompt.text、由网关按 wake + snapshot 合成 prompt 的唤醒轮。
  // 只在 kind=event 时允许缺 prompt（普通消息仍走适配器/装配器拼装）。
  kind: z.literal('event').optional(),
  wake: wakeSchema.optional(),
  // P1 过渡字段：适配器已拼好的 prompt 终稿（唤醒合批 + 快照 + 时间/黑话）。
  // V2 P2 起管线引擎接管拼装，本字段弃用（保留一个兼容期）。
  prompt: z.strictObject({ text: compactText(20000) }).optional(),
  // P2：唤醒快照的结构化载荷（供 snapshot-section 渲染）。loose 是刻意的：
  // 快照条目形状由适配器演进，网关只消费 sender/text/at 等少数已知键。
  snapshot: z.array(z.looseObject({})).max(50).optional(),
  // 兼容草案；网关以 HTTP 头为准（见文件头第 2 条）。
  auth: authSchema.optional(),
});

const targetSchema = z.strictObject({
  platform: z.enum(PLATFORMS),
  conversationId: idText(128),
  // 会话类型必须随动作一起下去：QQ 的 group/private 与微信的 room/private 共用
  // 数字 id 空间，只给 conversationId 时适配器无法拼出本地 key（`group:456`），
  // 只能猜。可选是为了兼容 P1 初期只发 id 的调用方。
  kind: z.enum(CONVERSATION_KINDS).optional(),
});

export const actionSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  actionId: idText(128),
  turnId: idText(128),
  type: z.enum(ACTION_TYPES),
  target: targetSchema,
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: idText(256),
  expiresAt: z.number().int().nonnegative().optional(),
});

const errorSchema = z.strictObject({
  code: z.enum(ERROR_CODES),
  message: z.string().max(1000),
});

export const receiptSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  actionId: idText(128),
  ok: z.boolean(),
  platformMessageId: idText(128).optional(),
  // 读类动作（清单驱动）的返回数据：结构由各适配器清单 payloadSchema 的对偶
  // 声明演进，网关不做深校验（与 toolResultSchema.data 同哲学）。
  data: z.unknown().optional(),
  error: errorSchema.optional(),
  at: z.number().int().nonnegative(),
}).refine((value) => value.ok || value.error !== undefined, {
  message: 'a failed receipt must carry error',
  path: ['error'],
});

export const turnResultSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  turnId: idText(128),
  status: z.enum(['completed', 'aborted', 'error', 'unknown']),
  actions: z.array(actionSchema).max(64),
  text: z.string().max(20000).optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
  degraded: z.array(z.string().max(64)).max(16).optional(),
  error: errorSchema.optional(),
});

// ── P3：统一工具调用（MCP 薄壳 → /v1/tools/call → ToolHost）──────────────────
// tool 名统一 chat_*（如 chat_memory_recall）；args 是 loose record——工具参数
// 由各 executor 的 inputSchema 负责，网关只挡「不是对象」与总量，不在这一层
// 逐字段校验（工具面演进不该每次都改线缆契约）。
// sessionKey/turnId 可选：唯一凭据是 turnToken（ToolHost 由令牌反查活跃 turn）；
// 显式携带时必须与令牌一致，防止串会话。
export const toolCallSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  callId: idText(128),
  tool: idText(128),
  args: z.record(z.string(), z.unknown()).default({}),
  turnToken: idText(256),
  sessionKey: idText(256).optional(),
  turnId: idText(128).optional(),
});

export const toolResultSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  callId: idText(128),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: errorSchema.optional(),
}).refine((value) => value.ok || value.error !== undefined, {
  message: 'a failed tool result must carry error',
  path: ['error'],
});

// ── V2 P2：管线服务调用（装饰器/过滤器，service.call）────────────────────────
// 服务与消费者同构登记（登记目录 + HMAC 身份），但契约刻意收窄到
// 「一个入口一个出口」：网关把当前消息推给它，它返回放行/丢弃判定与增强内容。
// 与 toolResult 同哲学：响应在网关侧 fail-safe——schema 不过或 verdict 非法
// 一律记 degraded 放行，绝不让一个坏响应变成误杀消息。
export const SERVICE_KINDS = Object.freeze(['decorator', 'filter', 'shadow']);

export const serviceCallRequestSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  callId: idText(128),
  // 目标服务与管线步骤身份：服务按 step/kind 判断自己被编排成什么角色（诊断
  // 用），网关不依赖它们做路由——路由靠连接（WS）或 URL（HTTP）。
  service: idText(64),
  step: idText(64),
  kind: z.enum(SERVICE_KINDS),
  sessionKey: idText(256),
  turnId: idText(128).optional(),
  // 当前累积 prompt 文本。允许缺省/空：唤醒事件轮 prompt 可为空，装饰器照样
  // 可以追加 sections；filter 在空文本上同样可以判 drop。
  text: z.string().max(20000).optional(),
  // P4.x 会话首轮标记（仅首轮为 true）：加工型装饰器可据此自治实现「仅首轮
  // 注入」——判定数据源（turn store 会话历史）归网关，服务保持无状态。
  firstTurn: z.boolean().optional(),
  // P5 管线方向：forward = 入站（consumer → DSH，含 protocol 令牌注入）；
  // return = 出站（DSH 产出 → consumer，发送动作外发文本过链，无 protocol）。
  // 缺省 forward——既有服务无需感知此字段即可继续工作。
  direction: z.enum(['forward', 'return']).default('forward'),
});

const serviceSectionSchema = z.strictObject({
  name: idText(64),
  text: z.string().max(20000),
  // 与 context section 词典同义：预算超限时整段丢弃最低优先级。
  priority: z.number().int().optional(),
});

export const serviceCallResultSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  callId: idText(128),
  verdict: z.enum(['pass', 'drop']),
  // decorator 产出：message = 改写后的整段消息（缺省 = 原样保留）；
  // sections = 追加的具名文本块。拼接顺序与预算裁剪都在网关做——服务只表达
  // 「我想加什么」，不决定最终 prompt 形状（protocol 段永不经过服务）。
  message: z.string().max(20000).optional(),
  sections: z.array(serviceSectionSchema).max(16).optional(),
  // 判定理由（drop 时进日志/诊断；约定不含消息正文，服务自行保证）。
  reason: z.string().max(300).optional(),
}).refine((value) => value.verdict === 'pass'
  || (value.message === undefined && (value.sections ?? []).length === 0), {
  message: 'a "drop" verdict must not carry message or sections',
  path: ['verdict'],
});

// ── V2 P3：服务自主登记（登记文件 / 工具声明 / 注册台账）─────────────────────
// 服务像消费端一样向网关注册自身：一份登记文件声明类型、transport、密钥引用
// 与自有工具；注册 = 文件进入登记目录，卸载 = 文件移除，网关校验装载并落台账。
// 注册 kind 与管线编排 kind 是两套词典：登记 kind 说「我是什么」（decorator /
// filter / shadow / consumer），编排 kind（SERVICE_KINDS，含 shadow）说「这条
// 管线步骤怎么用我」。shadow 可直接登记：它天生只产 diff 不改流量，编排成
// 通路/回路步骤即灰度对账（内联 services.json 退役后这里是唯一入口）。
export const SERVICE_REGISTRATION_KINDS = Object.freeze(['decorator', 'filter', 'shadow', 'consumer']);

/**
 * 登记身份：自主登记默认随机 hash（数据库主键风格）= crypto.randomUUID() 去
 * 横线（UUIDv4，122 位随机量）；正则同时放行可读 id（运维手工挂载的登记文件，
 * 如 safety-filter.json）。全局唯一性由随机量保证，对象唯一性由 id/hash 确认——
 * 同名 `name` 的两次登记是两个不同对象，id 相同才是同一个对象（幂等重登记）。
 */
export const REGISTRATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function newRegistrationId() {
  return crypto.randomUUID().replaceAll('-', '');
}

/**
 * 工具角色（两层声明：服务级 kind 说「我是什么」，工具级 roles 说「这个工具能
 * 以什么身份被使用」）。tool = 模型可调的工具面（默认）；decorator / filter =
 * 该工具同时是管线可编排的步骤——如 memory 的 recall 既是 chat_memory_recall
 * 工具（模型主动调，tool.call 路由），又是装饰器（管线被动注入回忆段，
 * service.call 编排），两条出路共用同一实现。同一服务可以有多个工具标
 * decorator/filter；管线步骤名直接写工具名即可选中（见 pipeline resolveStep）。
 */
export const SERVICE_TOOL_ROLES = Object.freeze(['tool', 'decorator', 'filter']);

/** 登记文件里的一条工具声明：名字、描述、角色与 JSON-Schema 形状的参数定义。 */
export const serviceToolDeclarationSchema = z.strictObject({
  // 工具名统一 chat_* 前缀（与 mcp-bus /v1/tools 既有词典一致，模型视角同一命名空间）。
  name: z.string().regex(/^chat_[a-z][a-z0-9_]{2,120}$/, 'tool name must be chat_* with lowercase snake case'),
  description: z.string().min(1).max(500),
  // JSON-Schema 形状的 loose record：字段语义由服务自行演进，网关只挡「不是对象」。
  inputSchema: z.record(z.string(), z.unknown()).default({}),
  // 角色可多选（一个工具同时是工具面成员和管线步骤）；缺省纯工具面。
  roles: z.array(z.enum(SERVICE_TOOL_ROLES)).min(1).default(['tool']),
});

export const serviceRegistrationSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  // 对象身份：32 位随机 hash（自主登记默认）或可读 id（运维挂载的登记文件）；
  // 文件名必须是 "<id>.json"。
  id: z.string().regex(REGISTRATION_ID_PATTERN, 'registration id must match /^[a-z0-9][a-z0-9-]{0,63}$/'),
  // 人可读展示名（健康视图/台账/控制台用）；不参与身份判定，可重名。
  name: z.string().min(1).max(64),
  kind: z.enum(SERVICE_REGISTRATION_KINDS),
  transport: z.enum(['ws', 'http', 'auto']),
  // 服务基址（http/auto 必填，loopback 校验在装载器做——与 P2 adapters 同口径）。
  url: z.string().max(256).optional(),
  timeoutMs: z.number().int().min(1000).max(60_000).optional(),
  // 密钥三选一（内联/文件/环境变量），口径与消费者同构（resolveSecret 校验）。
  secret: z.string().min(1).max(256).optional(),
  secretFile: z.string().min(1).max(256).optional(),
  secretEnv: z.string().min(1).max(64).optional(),
  // 自有工具面：decorator/consumer 可声明（filter 纯管道判断，通常没有工具）。
  tools: z.array(serviceToolDeclarationSchema).max(32).optional(),
  enabled: z.boolean().default(true),
}).refine((value) => value.transport !== 'http' || (typeof value.url === 'string' && value.url.length > 0), {
  message: 'transport "http" requires url',
  path: ['url'],
}).refine(
  // 带 decorator/filter 角色的工具要求服务级 kind 对应：filter 服务不该声明
  // decorator 工具，反之亦然——两层声明不能互相矛盾。
  (value) => (value.tools ?? []).every((tool) => tool.roles.every((role) => role === 'tool' || role === value.kind)),
  { message: 'tools with "decorator"/"filter" roles require the service kind to match', path: ['tools'] },
);

/**
 * 注册台账事件（append-only JSONL，一行一个事件）。
 * snapshot 携带登记内容快照（密钥字段装载前已剔除，见 registration-ledger.mjs），
 * 满足「保存注册内容 + 记录」：台账即注册历史的唯一事实源。
 */
export const REGISTRATION_LEDGER_ACTIONS = Object.freeze(['register', 'unregister', 'reject']);

export const registrationLedgerEventSchema = z.strictObject({
  at: z.number().int().nonnegative(),
  serviceId: idText(64),
  action: z.enum(REGISTRATION_LEDGER_ACTIONS),
  // 谁触发的：'file'（登记目录变更）/ 'startup' / 'operator'（P4 UI）等。
  source: idText(64),
  // reject / unregister 的补充说明（不含消息正文与服务密钥）。
  reason: z.string().max(300).optional(),
  // register / unregister 时的登记内容快照（已脱敏）。
  snapshot: z.record(z.string(), z.unknown()).optional(),
});

// ── P4：会话状态更新（适配器镜像写 → 网关 mailbox）───────────────────────────
// 迁移的是「丢了无法重建」的传输状态与策略状态（设计文档 §4 状态归属）：已读
// 水位、未读游标、唤醒配置、agentToken。P4 是镜像期：适配器本地 social-v2.json
// 继续写（回滚 = 关 GATEWAY_STATE），网关这份用于控制台只读查询与后续接管。
// 消息**内容**不在这里——原文走语义记忆服务单写（P2），未读消息体留在适配器。
export const STATE_UPDATE_ACTIONS = Object.freeze(['inbound', 'mark_read', 'set_wake_config', 'agent_token', 'reset']);

// 唤醒配置是 loose 的：字段由适配器演进（P5 微信会加平台专属触发器），
// 网关只挡「已知字段的类型错了」。未知字段原样保留，控制台展示时可见。
const wakeTriggerSchema = z.looseObject({
  atMention: z.boolean().optional(),
  nameMention: z.boolean().optional(),
  speakerIds: z.array(z.string().max(64)).max(100).optional(),
  keywords: z.array(z.string().max(100)).max(50).optional(),
  question: z.boolean().optional(),
  poke: z.boolean().optional(),
  anyMessage: z.boolean().optional(),
  probability: z.number().min(0).max(1).optional(),
});

const wakeConfigSchema = z.looseObject({
  mode: z.enum(['diving', 'active']).optional(),
  infinite: z.boolean().optional(),
  sleepUntil: z.string().max(64).nullable().optional(),
  batchWindowMs: z.number().int().nonnegative().optional(),
  triggers: wakeTriggerSchema.optional(),
});

export const stateUpdateSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  action: z.enum(STATE_UPDATE_ACTIONS),
  sessionKey: idText(256),
  // inbound：新消息的游标
  seq: z.number().int().nonnegative().optional(),
  messageId: idText(128).optional(),
  senderId: idText(128).optional(),
  // mark_read / set_wake_config：已读水位
  throughSeq: z.number().int().nonnegative().optional(),
  // set_wake_config：完整唤醒配置（适配器归一化后的权威值）
  wakeConfig: wakeConfigSchema.optional(),
  confirmedBy: z.enum(['default', 'mark_read', 'set_wake_config', 'console']).optional(),
  // agent_token：会话令牌（适配器生成与轮换，网关只持久化）
  agentToken: idText(128).optional(),
  source: z.enum(['model', 'console', 'adapter', 'system']).default('adapter'),
  reason: z.string().max(200).optional(),
});

/** action 语义校验（形状过了 schema 再跑这步）。返回 null 或拒绝原因。 */
export function validateStateUpdatePayload(update) {
  const has = (key) => update?.[key] !== undefined;
  switch (update?.action) {
    case 'inbound':
      if (!has('seq')) return 'action "inbound" requires seq';
      return null;
    case 'mark_read':
      if (!has('throughSeq')) return 'action "mark_read" requires throughSeq';
      return null;
    case 'set_wake_config':
      if (!has('wakeConfig')) return 'action "set_wake_config" requires wakeConfig';
      return null;
    case 'agent_token':
      if (!has('agentToken')) return 'action "agent_token" requires agentToken';
      return null;
    case 'reset':
      // 控制台重置/会话退役：适配器清空本地会话后同步删掉网关这份孤儿状态。
      // 不要求额外字段——sessionKey 已在 schema 里必填。
      return null;
    default:
      return `unknown state update action: ${String(update?.action)}`;
  }
}


/**
 * 每种动作的 payload 规则。返回 `null` 表示通过，否则返回人可读的拒绝原因。
 *
 * 这里不重复做「type 是否合法」——那由 schema 负责。这里只回答
 * 「这个 type 需要的字段齐了吗、类型对吗、长度在预算内吗」。
 */
const ACTION_PAYLOAD_RULES = Object.freeze({
  send_text: (p) => requireText(p, 'text', 4000),
  reply: (p) => requireText(p, 'messageId', 128) ?? requireText(p, 'text', 4000),
  send_media: (p) => requireEnum(p, 'kind', ['image', 'voice', 'video', 'file'])
    ?? requireText(p, 'ref', 2048),
  send_sticker: (p) => requireText(p, 'id', 128),
  send_voice: (p) => requireText(p, 'ref', 2048),
  send_file: (p) => requireText(p, 'ref', 2048) ?? requireText(p, 'name', 255),
  poke: (p) => requireText(p, 'userId', 128),
  mark_read: (p) => requireNonNegativeInt(p, 'throughSeq'),
  wait: (p) => optionalText(p, 'reason', 200) ?? optionalRange(p, 'timeoutMs', 0, 300000),
  set_wake: (p) => (p.config !== undefined && p.config !== null && typeof p.config === 'object'
    ? null : 'set_wake.payload.config must be an object'),
  noop: () => null,
  // ── 清单驱动扩容的类型：payload 语义校验下沉到适配器清单 payloadSchema ──
  // （唯一例外 send_message：messages 是所有变体的公共必填，值得在网关挡一道。）
  send_message: (p) => {
    const value = p?.messages;
    if (typeof value === 'string' && value.length > 0) return null;
    if (Array.isArray(value) && value.length > 0) return null;
    return 'send_message.payload.messages must be a non-empty string or array';
  },
  send_burst: () => null,
  send_group_message: () => null,
  send_private_message: () => null,
  get_prompt: () => null,
  get_unread: () => null,
  get_recent: () => null,
  get_my_recent: () => null,
  get_message_detail: () => null,
  get_message_images: () => null,
  get_forward_msg: () => null,
  get_active_members: () => null,
  get_group_members: () => null,
  list_groups: () => null,
  get_history: () => null,
  list_stickers: () => null,
  get_sticker_image: () => null,
  get_self_image: () => null,
  collect_sticker: () => null,
  sticker_note: () => null,
  set_sticker_remark: () => null,
  list_voices: () => null,
  memory_append: () => null,
  memory_query: () => null,
  memory_remove: () => null,
  memory_clear: () => null,
});

function requireText(payload, key, max) {
  const value = payload?.[key];
  if (typeof value !== 'string' || value.length === 0) return `payload.${key} must be a non-empty string`;
  if (value.length > max) return `payload.${key} exceeds ${max} characters`;
  return null;
}

function optionalText(payload, key, max) {
  const value = payload?.[key];
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > max) return `payload.${key} must be a string <= ${max} characters`;
  return null;
}

function requireEnum(payload, key, allowed) {
  const value = payload?.[key];
  return allowed.includes(value) ? null : `payload.${key} must be one of ${allowed.join(', ')}`;
}

function requireNonNegativeInt(payload, key) {
  const value = payload?.[key];
  return Number.isSafeInteger(value) && value >= 0 ? null : `payload.${key} must be a non-negative safe integer`;
}

function optionalRange(payload, key, min, max) {
  const value = payload?.[key];
  if (value === undefined) return null;
  return Number.isSafeInteger(value) && value >= min && value <= max
    ? null : `payload.${key} must be an integer in [${min}, ${max}]`;
}

/** 动作的语义校验。schema 通过后再跑这一步。 */
export function validateActionPayload(action) {
  const rule = ACTION_PAYLOAD_RULES[action?.type];
  if (!rule) return `unknown action type: ${String(action?.type)}`;
  return rule(action.payload ?? {});
}

function issuesOf(result) {
  return result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

function parseWith(schema, value, label) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = issuesOf(result);
    const first = issues[0];
    throw new ContractError(
      'E_SCHEMA',
      `${label} invalid${first ? `: ${first.path || '(root)'} ${first.message}` : ''}`,
      issues,
    );
  }
  return result.data;
}

export function parseInbound(value) {
  return parseWith(inboundSchema, value, 'inbound');
}

export function parseAction(value) {
  const action = parseWith(actionSchema, value, 'action');
  const reason = validateActionPayload(action);
  if (reason) throw new ContractError('E_SCHEMA', `action invalid: ${reason}`, [{ path: 'payload', message: reason }]);
  return action;
}

export function parseReceipt(value) {
  return parseWith(receiptSchema, value, 'receipt');
}

export function parseTurnResult(value) {
  return parseWith(turnResultSchema, value, 'turnResult');
}

export function parseToolCall(value) {
  return parseWith(toolCallSchema, value, 'toolCall');
}

export function parseToolResult(value) {
  return parseWith(toolResultSchema, value, 'toolResult');
}

export function parseServiceCallRequest(value) {
  return parseWith(serviceCallRequestSchema, value, 'serviceCallRequest');
}

// V2 P3：网关 → 已登记服务的工具调用（tool.call）。形状与 DSH→网关的
// toolCallSchema 同构，但有两点刻意差异：**没有 turnToken**——安全链不下放
//（不变量 §5.2：令牌铸造与校验永远在网关侧完成，服务只见会话标识不见凭据）；
// args 原样透传，按登记声明的 inputSchema 校验属服务自身职责。响应复用
// toolResultSchema（callId 关联 + ok/data/error 形状），网关侧核对 callId。
export const serviceToolCallSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  callId: idText(128),
  tool: idText(128),
  args: z.record(z.string(), z.unknown()).default({}),
  // 会话上下文随调用下发（服务按 sessionKey 隔离数据）；不含任何凭据字段。
  sessionKey: idText(256).optional(),
  turnId: idText(128).optional(),
});

export function parseServiceCallResult(value) {
  return parseWith(serviceCallResultSchema, value, 'serviceCallResult');
}

export function parseServiceToolCall(value) {
  return parseWith(serviceToolCallSchema, value, 'serviceToolCall');
}

export function parseServiceRegistration(value) {
  return parseWith(serviceRegistrationSchema, value, 'serviceRegistration');
}

export function parseRegistrationLedgerEvent(value) {
  return parseWith(registrationLedgerEventSchema, value, 'registrationLedgerEvent');
}

export function parseStateUpdate(value) {
  const update = parseWith(stateUpdateSchema, value, 'stateUpdate');
  const reason = validateStateUpdatePayload(update);
  if (reason) throw new ContractError('E_SCHEMA', `stateUpdate invalid: ${reason}`, [{ path: 'action', message: reason }]);
  return update;
}

/**
 * 从入站信封推导幂等键。
 *
 * 平台消息 id 优先；没有 id 的事件（戳一戳、撤回）用适配器合成的 id。
 * 群号与私聊号共用数字空间，所以 key 必须带 kind，否则 `group:123` 与
 * `private:123` 会互相吞消息。
 *
 * 第二个参数 adapterId（2026-11-09 起）：同一平台可能挂多个适配器，旧键
 * `platform:kind:id:msgId` 会让 A 适配器上报的消息把 B 的同一 platform 消息
 * 判成重复。传 adapterId 时键空间按消费者隔离；不传则保持旧格式（用于兼容
 * 读取已落盘的旧键——灰度升级期旧记录仍然要能命中）。
 */
export function inboundIdempotencyKey(envelope, adapterId) {
  const base = `${envelope.platform}:${envelope.conversation.kind}:${envelope.conversation.id}:${envelope.message.id}`;
  return adapterId ? `${adapterId}:${base}` : base;
}

/** 由入站推导会话键，例如 `qq:group:123`。记忆服务的 sessionId 用同一形状。 */
export function sessionKeyOf(envelope) {
  return `${envelope.platform}:${envelope.conversation.kind}:${envelope.conversation.id}`;
}
