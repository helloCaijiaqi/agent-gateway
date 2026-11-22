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

/**
 * 平台→DSH agent preset 声明（{ qq: 'qq-chat' }）。
 *
 * 单独导出：登记契约（serviceRegistrationSchema）与控制台的「编辑消费端预设」
 * 端点共用同一份校验，避免两处漂移。键=平台（小写单段），值=preset 名
 * （lowercase kebab）——**只是名字**，内容归消费端适配器。
 */
export const presetsDeclarationSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, 'preset id must be lowercase kebab-case'),
);

/**
 * 声明的 preset 没装时的回退目标（DSH 内置、无人格、无本地工具）。
 *
 * 属于 DSH 语义常量而非平台知识，所以放在 core：server.mjs（控制台回显）与
 * session-registry（建会话回退）共用同一份，不会漂移。
 */
export const FALLBACK_PRESET = 'minimal';

export const PLATFORMS = Object.freeze(['qq', 'wx']);
export const CONVERSATION_KINDS = Object.freeze(['group', 'private', 'room']);
export const SENDER_ROLES = Object.freeze(['owner', 'member', 'bot']);
export const MEDIA_KINDS = Object.freeze(['image', 'voice', 'video', 'file', 'sticker']);

/**
 * 动作类型。新增类型必须同时补两处：这里、`ACTION_PAYLOAD_RULES`，
 * 并在适配器的 actions-manifest 里声明（wired + payloadSchema）。
 * 少任何一处都会变成「模型说了但没发生」。
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

/**
 * 发送者展示名（V2 统一改造新增）：nickname = 平台昵称，card = 群名片。
 * name 保留兼容 = card || nickname（适配器未升级时的单一展示名）。
 * subject 身份层据此登记别名索引（群名片 → 会话内别名，昵称 → 全局别名）。
 */
const senderNamesSchema = z.strictObject({
  nickname: z.string().max(64).optional(),
  card: z.string().max(64).optional(),
});

const senderSchema = z.strictObject({
  id: idText(128),
  name: z.string().max(64),
  names: senderNamesSchema.optional(),
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
 *   · kind=proactive：适配器侧定时器（冒泡）合成的事件；
 *   · kind=user：适配器侧判定「这一轮是被真实用户消息触发」的唤醒（2026-11-18）。
 *     曾经 user 消息唤醒也误标 proactive，提示词写着「不是有人点名你，可以不说话」，
 *     直接压制模型回复意愿（间歇性 sent=0 忘发的根因）。
 * status 缺省视为 arrived（正常到达），timeout 只用于将来「等待超时也回推」的扩展。
 */
const wakeSchema = z.strictObject({
  kind: z.enum(['wait', 'proactive', 'user']),
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
  // 2026-11-20 放宽为 optional：内部白名单通道（ToolHost INTERNAL_TOOLS，如
  // persona 插件装配期拉渲染）不带会话令牌。真正的校验权在 ToolHost.handle——
  // 无 token 且不在白名单一律 E_FORBIDDEN，语义不变；模型调用面仍恒带 token。
  turnToken: idText(256).optional(),
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

// ── V2 统一改造：管线步骤结果契约（decorator / filter，经 tool.call 承载）────
// service.call 信封已全链路下线：decorator/filter 步骤一律走 tool.call（HTTP
// /v1/tools/call + WS tool.call 帧），结果装在 toolResult.data 里，网关按工具
// role 用下面的 schema 解析。与 toolResult 同哲学：响应在网关侧 fail-safe——
// schema 不过一律记 degraded 放行，绝不让一个坏响应变成误杀消息。
//
// 角色契约（三选一，单值 role）：
//   tool      = 模型可调的工具面，result 不透明（网关原样透传）；
//   decorator = 仅网关管线，纯注入，result = { sections[]?, epoch? }；
//   filter    = 仅网关管线（入站 + returnPipelines），改写器，result = { text, reason? }，
//               text 空串 = 丢弃该消息（入站不建 turn；出站不发送）。

/** decorator 产出：具名文本块（拼接顺序与预算裁剪都在网关做）。 */
const decoratorSectionSchema = z.strictObject({
  name: idText(64),
  text: z.string().max(20000),
  // 与 context section 词典同义：预算超限时整段丢弃最低优先级。
  priority: z.number().int().optional(),
});

export const decoratorResultSchema = z.strictObject({
  sections: z.array(decoratorSectionSchema).max(16).optional(),
  // 会话纪元（§6.4，记忆装饰器专用，可选）：服务端在 save 事务推进。网关按
  // (sessionKey, senderId, epoch) 去重 identity 类 block，实现「会话首轮注入一次」。
  // 缺省 = 服务不区分纪元，此时按 sections 全量拼接；null 是
  // 「本次渲染失败/无纪元状态」的既有表示（记忆服务降级路径会发 null）。
  epoch: z.number().int().nonnegative().nullable().optional(),
});

/** filter 产出：过滤后的消息文本（无 verdict 枚举）。 */
export const filterResultSchema = z.strictObject({
  text: z.string().max(20000),
  // 判定/改写理由（仅进日志/诊断；约定不含消息正文，服务自行保证）。
  reason: z.string().max(300).optional(),
});

// ── V2 P3：服务自主登记（登记文件 / 工具声明 / 注册台账）─────────────────────
// 服务像消费端一样向网关注册自身：一份登记文件声明类型、transport、密钥引用
// 与自有工具；注册 = 文件进入登记目录，卸载 = 文件移除，网关校验装载并落台账。
// 注册 kind 与工具 role 是两套概念：登记 kind 说「我是什么」（resource =
// 提供能力的资源服务——记忆/角色卡/灰度对账皆属此类；consumer = 消息来源/
// 动作下行端），工具 role 说「这个工具怎么被使用」（tool / decorator / filter）。
// 装饰/过滤职责完全由 role 承担（管线步骤解析、编排候选过滤均按 role 驱动），
// 旧 kind 取值 decorator/filter/shadow 已退役（parseServiceRegistration 对其
// fail-closed 拒载并给迁移文案 → resource）。
//
// 传输层按角色非对称（传输与 kind 的交叉约束，见 schema refine）：
//   - consumer（双向流：入站信封 ↑ / 动作下行 ↓）→ ws/http/auto 三态保留
//     （auto = WS 优先、失败回落 HTTP，与桥接侧 gateway-client 同语义）；
//   - resource（纯被动被调方）→ 仅 http：网关 → 资源的 POST /v1/tools/call
//     是唯一通道，资源服务不向网关发消息，WS 能力已整体退役。

export const SERVICE_REGISTRATION_KINDS = Object.freeze(['consumer', 'resource']);

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
 * 消费端登记 id 词法（多消费端收编）：`svc-<12hex>`。id 只标识「这个注册的
 * 服务实例」，与平台无关（平台是独立字段 platform）——`qq-main` 这类与平台名
 * 混义的 id 不再新发（存量兼容读取 + 迁移告警，见 service-registry 装载警告）。
 * 同平台多账号 = 多份登记文件、各自的 svc- id 与密钥，互不冲突。
 */
export const CONSUMER_ID_RE = /^svc-[a-z0-9]{6,32}$/;

export function newConsumerRegistrationId() {
  return `svc-${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * 工具角色（单值，三选一硬切）：服务级 kind 说「我是什么」，工具级 role 说
 * 「这个工具以什么身份被使用」。tool = 模型可调的工具面（默认）；decorator /
 * filter = 仅网关管线可编排的步骤——管线步骤名直接写工具名即可选中
 * （见 pipeline resolveStep）。一个工具只能有一个 role：改写/丢弃职责归
 * filter、纯注入归 decorator，不再允许一个工具身兼数职。
 * 历史形态 `roles` 数组一律非法：parseServiceRegistration 对其显式报错并给
 * 迁移文案（如 "roles":["tool","decorator"] → "role":"decorator"）。
 */
export const SERVICE_TOOL_ROLES = Object.freeze(['tool', 'decorator', 'filter']);

/** 登记文件里的一条工具声明：名字、描述、单值角色与 JSON-Schema 形状的参数定义。 */
export const serviceToolDeclarationSchema = z.strictObject({
  // 工具名统一 chat_* 前缀（与 mcp-bus /v1/tools 既有词典一致，模型视角同一命名空间）。
  name: z.string().regex(/^chat_[a-z][a-z0-9_]{2,120}$/, 'tool name must be chat_* with lowercase snake case'),
  description: z.string().min(1).max(500),
  // JSON-Schema 形状的 loose record：字段语义由服务自行演进，网关只挡「不是对象」。
  inputSchema: z.record(z.string(), z.unknown()).default({}),
  // 单值角色（三选一）；缺省纯工具面。
  role: z.enum(SERVICE_TOOL_ROLES).default('tool'),
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
  // consumer 语义 = callbackBase（网关动作下行 POST <url>/v1/actions 与清单
  // GET <url>/v1/actions/manifest 的基址；WS-only 消费者可缺省，缺省即无 HTTP 兜底）。
  url: z.string().max(256).optional(),
  timeoutMs: z.number().int().min(1000).max(60_000).optional(),
  // 密钥三选一（内联/文件/环境变量），口径与消费者同构（resolveSecret 校验）。
  secret: z.string().min(1).max(256).optional(),
  secretFile: z.string().min(1).max(256).optional(),
  secretEnv: z.string().min(1).max(64).optional(),
  // 自有工具面：resource 服务可声明 tool/decorator/filter 三种 role 的工具；
  // consumer 通常不声明工具（只允许 role:'tool'，见 schema refine）。
  tools: z.array(serviceToolDeclarationSchema).max(32).optional(),
  // 记忆服务能力声明（会话缓冲的 save 目标选路依据，selectMemoryService 三级
  // 选路的第二级）。两种形态：
  //   true                         旧布尔形态（兼容读取，运行时按内置缺省
  //                                saveTool 处理并告警提示迁移——平滑存量）；
  //   { saveTool: 'chat_memory_*' } 权威形态：saveTool = 该服务承接会话缓冲
  //                                落地的工具名，网关 session-save 按声明动态
  //                                调用（网关 src 不含具体工具名字面量）。
  //                                loose() 允许后续扩展字段（如 batchSize）。
  memoryService: z.union([
    z.boolean(),
    z.object({ saveTool: z.string().regex(/^chat_[a-z][a-z0-9_]{2,120}$/, 'memoryService.saveTool must be a chat_* tool name') }).loose(),
  ]).optional(),
  // 消费端平台（kind=consumer 必填）：动作会话定位（resolveTarget 按平台派生
  // 会话）与 HTTP 入站 expectedPlatform 验签的声明来源；一个平台同时只允许
  // 一个 enabled 的动作接收者（装载器校验）。resource 服务不声明。
  platform: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).optional(),
  // 平台→DSH agent preset 声明（形如 { qq: 'qq-chat' }）。
  //
  // 为什么在适配器侧：预设是「这个平台该用哪个人设」，属于平台知识；网关若自己
  // 维护平台映射表，就等于把身份知识抄了一份（2026-11-16 起单一来源）。
  // 网关只做两件事：按 adapter 的声明去 DSH 清单里核对，不在清单里就回退 minimal。
  // 注意：这里只是**名字**；预设内容的编辑与安装归消费端适配器（dsh/<平台>/**
  // + install:preset）。
  presets: presetsDeclarationSchema.optional(),
  enabled: z.boolean().default(true),
}).refine((value) => value.transport !== 'http' || (typeof value.url === 'string' && value.url.length > 0), {
  message: 'transport "http" requires url',
  path: ['url'],
}).refine((value) => value.kind !== 'consumer' || typeof value.platform === 'string', {
  message: 'consumer registrations must declare "platform" (action session targeting + inbound signature check)',
  path: ['platform'],
}).refine(
  // 资源服务纯被动：只接受网关的 HTTP tool.call，不向网关发消息——WS 能力
  // 已退役（网关侧 ws-hub 的 tool.call 帧与资源侧连接器均已拆除），配置
  // ws/auto 属配置错误（迁移文案由 parseServiceRegistration 前置给出）。
  (value) => value.kind !== 'resource' || value.transport === 'http',
  { message: 'resource registrations only support transport "http" (gateway → service tool.call)', path: ['transport'] },
).refine(
  // 管线型工具（decorator/filter role）只属于 resource 服务：装饰/过滤职责
  // 由 role 声明，服务级 kind 只区分 consumer/resource——consumer 不该声明
  // 管线型工具（两层声明不能互相矛盾）。
  (value) => (value.tools ?? []).every((tool) => tool.role === 'tool' || value.kind === 'resource'),
  { message: 'tools with "decorator"/"filter" roles require kind "resource"', path: ['tools'] },
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
  // 统一改造新增：调用方身份与工作文本。senderId = 发送者平台用户 id（QQ 号/
  // OneBot user_id，来自 message.sender.id；出站消息与合成事件可缺省）；
  // text = 仅 filter 调用时由网关下发的当前工作文本（decorator/tool 调用不带）。
  // firstTurn/direction 已随 service.call 下线（无服务端消费；首轮语义由网关
  // once 规则 + epoch 去重覆盖）。
  context: z.strictObject({
    senderId: idText(128).optional(),
    text: z.string().max(20000).optional(),
  }).optional(),
});

/** 管线 decorator 步骤结果解析（toolResult.data 的对偶校验）。 */
export function parseDecoratorResult(value) {
  return parseWith(decoratorResultSchema, value, 'decoratorResult');
}

/** 管线 filter 步骤结果解析（toolResult.data 的对偶校验）。 */
export function parseFilterResult(value) {
  return parseWith(filterResultSchema, value, 'filterResult');
}

export function parseServiceToolCall(value) {
  return parseWith(serviceToolCallSchema, value, 'serviceToolCall');
}

export function parseServiceRegistration(value) {
  // 资源服务传输非对称护栏：strictObject 对交叉约束的报错不够可操作，
  // resource + ws/auto 在这里先行拦截并给迁移文案（fail-closed：启动装载/
  // 热加载/控制台写入三处共用）。消费端不受限（ws/http/auto 三态合法）。
  if (value?.kind === 'resource' && typeof value?.transport === 'string' && value.transport !== 'http') {
    throw new ContractError(
      'E_SCHEMA',
      `serviceRegistration invalid: kind "resource" with transport "${value.transport}" is not supported — resource services are passive `
        + `(gateway → service HTTP tool.call only, WS is retired for resources); migrate "transport": "${value.transport}" → "transport": "http"`,
      [{ path: 'transport', message: 'resource transport ws/auto is no longer legal' }],
    );
  }
  // 旧 kind fail-closed 拒载：strictObject 对非法 enum 的报错不够可操作，
  // decorator/filter/shadow 在这里先行拦截并给迁移文案（fail-closed：启动
  // 装载/热加载/控制台写入三处共用）。
  const legacyKind = typeof value?.kind === 'string'
    && ['decorator', 'filter', 'shadow'].includes(value.kind) ? value.kind : null;
  if (legacyKind) {
    throw new ContractError(
      'E_SCHEMA',
      `serviceRegistration invalid: kind "${legacyKind}" is retired — registration kinds are now consumer|resource `
        + `(tool roles tool|decorator|filter carry the decorator/filter duties); migrate "kind": "${legacyKind}" → "kind": "resource"`,
      [{ path: 'kind', message: 'kind decorator/filter/shadow is no longer legal' }],
    );
  }
  // 单值 role 硬切护栏：strictObject 对未知键的报错不够可操作，roles 数组在这里
  // 先行拦截并给出迁移文案（fail-closed：启动装载/热加载/控制台写入三处共用）。
  for (const tool of Array.isArray(value?.tools) ? value.tools : []) {
    if (tool && typeof tool === 'object' && 'roles' in tool) {
      throw new ContractError(
        'E_SCHEMA',
        `serviceRegistration invalid: tool "${tool?.name ?? '?'}" declares a "roles" array — "role" is now a single value (one of tool|decorator|filter); `
        + 'migrate e.g. "roles": ["tool","decorator"] → "role": "decorator" (one role per tool)',
        [{ path: `tools.roles`, message: 'roles array is no longer legal' }],
      );
    }
  }
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

/**
 * 由入站推导会话键（多消费端收编）：带 consumerId 时为 4 段
 * `platform:consumerId:kind:id`（如 `qq:svc-a3f2b9c1d4e5:group:123`）——**会话绑
 * 消费端**（「dsh 开启会话是对应消费端的会话」）：同群双账号各自成会话，记忆/
 * once 规则/白名单不串号；动作下行由会话键第 2 段直接定位消费端（见
 * session.parseSessionKey 与 adapter-tools executor 的 byConsumer 路由）。
 * 不带 consumerId 时为旧 3 段 `platform:kind:id`（无消费端上下文的调用方兼容；
 * 存量数据按旧键读取）。记忆服务的 sessionId 用同一形状（session-id.js 已放宽
 * 为 3/4 段皆可，platform 恒为首段——subject 身份层按 platform+subject_id 全局
 * 共享，「物理一个人」不变式不受影响）。
 */
export function sessionKeyOf(envelope, { consumerId } = {}) {
  const base = `${envelope.conversation.kind}:${envelope.conversation.id}`;
  return consumerId
    ? `${envelope.platform}:${consumerId}:${base}`
    : `${envelope.platform}:${base}`;
}
