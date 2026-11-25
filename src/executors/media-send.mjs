/**
 * media-send executor（多媒体记忆层发送适配，2026-11-24；2026-11-25 三工具拆分）：
 * chat_media_send 单一工具退役，拆为三个语义明确的发送工具——
 *   chat_image_send（图片/表情）、chat_voice_send（语音）、chat_file_send（视频/ppt 等文件）。
 * 动因：音频发送链路复杂（克隆音色/情绪参考），模型需要明确知道自己在发哪类媒体；
 * 三工具共用同一查询/投递链，只在入口按工具语义校验 asset.kind（错 kind 显式报错，
 * 不再让单一工具「猜」类型）。
 *
 * 适配层语义（用户定案）：适配的是**不同平台发送媒体文件格式不同**，不是媒体
 * 类型路由。memory 层的 media_asset 完全平台无关（kind: image|voice|video|file，
 * ref/sendHints 存平台发送凭据），平台差异被这里的转换器吃掉；新增平台 = 新增
 * 一个 convertSend 分支，工具主体零改动。
 *
 * qq 平台转换规则：
 *   image + sourcePath（memory 侧落盘）  → send_image { fileRef }（同机路径）
 *   image + ref 是 URL                   → send_image { url }
 *   voice + ref（语音库相对路径）        → send_voice { voice }
 *   file / video + 同机路径              → send_file { fileRef }（bridge 未启用该动作时 E_PLATFORM 降级）
 *
 * 旧的 image+resId 收藏通道（send_sticker）已随 sticker 工具族物理删除
 * （2026-11-24）：发送统一走 send_image 的 fileRef/URL 通道。
 *
 * 查询链路：mediaId 直查 chat_media_get；query 走 chat_media_search 取最佳
 * （只认 ready 且有描述的资产）。发送成功回写 chat_media_mark_used（学习信号，
 * 【多媒体】注入排序依据）。memory-mcp 未装配/查询失败 → 结构化降级（模型看到
 * 明确错误），绝不静默。
 */
import { registerExecutor } from './executor-interface.mjs';

const MEDIA_ID_RE = /^ma_[0-9a-f]{12}$/;
const SEND_TIMEOUT_MS = 25000;

/**
 * @param {object} options
 * @param {Array<{adapter: object, manifest: object}>} options.adapters
 *        已拉取清单的适配器（与 createAdapterToolsExecutor 同结构，main.mjs 传入）
 * @param {Function} options.deliver
 *        投递载体 deliverActionWithWs（{adapter, action, entry, ctx, timeoutMs}）
 * @param {Function} options.resolveMemoryService
 *        () => 登记视图里媒体工具所属 serviceId（找不到 = null，memory 未装配）
 * @param {Function} options.callServiceTool
 *        (serviceId, request) => Promise<result>（serviceRegistry.callServiceTool）
 * @param {(line: string) => void} [options.logger]
 */
export function createMediaSendExecutor({
  adapters,
  deliver,
  resolveMemoryService,
  callServiceTool,
  logger = () => {},
} = {}) {
  const pool = (Array.isArray(adapters) ? adapters : []).filter(
    (item) => item?.adapter && item?.manifest,
  );

  /** manifest 里找动作条目（entry：adapter-tools 同款 routing 形态）。 */
  function findEntry(platform, action) {
    for (const { adapter, manifest } of pool) {
      if ((adapter.platform ?? '').toLowerCase() !== platform) continue;
      const actions = Array.isArray(manifest?.actions) ? manifest.actions : [];
      const entry = actions.find((item) => (item.type ?? item.name ?? item.id) === action);
      if (entry) return { adapter, entry };
    }
    return null;
  }

  // ── 平台格式转换器（适配层核心）──────────────────────────────────────────
  /**
   * convertSend(asset, platform) → { action, args } | { unsupported, reason }
   * asset 是 memory-mcp 认知面形状（chat_media_get/search 返回）。
   */
  function convertSend(asset, platform) {
    if (platform !== 'qq') return { unsupported: true, reason: `platform "${platform}" has no media converter yet` };
    const kind = String(asset?.kind ?? 'image');
    const ref = String(asset?.ref ?? '');
    const sourcePath = String(asset?.sourcePath ?? '');
    if (kind === 'image') {
      // 发送凭据三级回退（2026-11-25 修集成错位）：显式 sourcePath > http URL >
      // ref 同机路径。memory 认知面（chat_media_get/search）把 memory 侧落盘
      // 路径放在 ref（sendHints 之外的通用凭据位），bridge 与 memory 同机部署
      // 时路径可直接读——旧实现只认 sourcePath 字段名，导致所有落盘资产都
      // E_UNSUPPORTED（发图链路端到端失败）。
      if (sourcePath) return { action: 'send_image', args: { fileRef: sourcePath } };
      if (/^https?:\/\//.test(ref)) return { action: 'send_image', args: { url: ref } };
      if (ref) return { action: 'send_image', args: { fileRef: ref } };
      return { unsupported: true, reason: 'image asset has no sourcePath/url to send from' };
    }
    if (kind === 'voice') {
      if (ref) return { action: 'send_voice', args: { voice: ref } };
      return { unsupported: true, reason: 'voice asset has no library ref' };
    }
    if (kind === 'file' || kind === 'video') {
      // 视频/文件不进收藏详情表（2026-11-25）：本分支只服务历史遗留资产与新平台；
      // bridge 未启用 send_file 动作时在路由层 E_PLATFORM 降级。
      const fileRef = sourcePath || ref;
      if (fileRef && !/^https?:\/\//.test(fileRef)) return { action: 'send_file', args: { fileRef } };
      return { unsupported: true, reason: 'file asset has no local path to send from' };
    }
    return { unsupported: true, reason: `kind "${kind}" has no send channel on ${platform}` };
  }

  // ── memory 认知面查询 ───────────────────────────────────────────────────
  async function fetchAsset({ mediaId, query, ctx }) {
    const serviceId = resolveMemoryService?.();
    if (!serviceId) {
      return { error: 'E_SERVICE', message: 'memory-mcp 未装配媒体工具面（检查登记与 memory 服务）' };
    }
    const tool = mediaId ? 'chat_media_get' : 'chat_media_search';
    const args = mediaId
      ? { mediaId }
      : { query: String(query ?? '').trim(), limit: 5 };
    const result = await callServiceTool(serviceId, { tool, args, ctx: { sessionKey: ctx.sessionKey } });
    // toolResult 信封解包（2026-11-25 修正形状错位）：callServiceTool 返回
    // {v, callId, ok, data}，业务载荷在 data 层——旧实现直读 result.found /
    // result.media 恒 undefined，ready 资产被误报 E_NOT_FOUND（发图链路假失败）。
    const payload = result?.data ?? {};
    if (tool === 'chat_media_get') {
      if (!payload?.found) return { error: 'E_NOT_FOUND', message: `媒体 ${mediaId} 不存在或未就绪` };
      const media = payload.media ?? {};
      if (media.status && media.status !== 'ready') {
        return { error: 'E_NOT_READY', message: `媒体 ${mediaId} 尚未解析完成（status=${media.status}），稍后再试` };
      }
      return { asset: media };
    }
    const items = Array.isArray(payload?.media) ? payload.media : [];
    if (items.length === 0) {
      return { error: 'E_NOT_FOUND', message: `没有匹配「${query}」的已识别媒体（换个更具体的描述词试试）` };
    }
    // search 已在 memory 侧过滤 ready；取第一个（收藏池评分序）。
    return { asset: items[0], candidates: items };
  }

  // ── 三工具声明（2026-11-25 拆分）：chat_media_send 退役 ──────────────────
  // 每个工具声明自己只发哪类 kind：fetchAsset 后校验，错 kind 显式 E_UNSUPPORTED。
  const TOOL_KINDS = {
    chat_image_send: ['image'],
    chat_voice_send: ['voice'],
    chat_file_send: ['file', 'video'], // 视频/文件一类（视频等大文件已不入详情表，仅遗留资产）
  };
  const MEDIA_ID_DESC = '媒体资产 id（chat_media_search 或记忆文本里 [图片|ma_xxx] 占位符的 id）';

  return registerExecutor({
    name: 'media-send',
    actions: ['chat_image_send', 'chat_voice_send', 'chat_file_send'],
    tools: [
      {
        name: 'chat_image_send',
        description: '[写] 发送图片/表情：按 mediaId 或含义描述（query）从记忆里找到图片并发送；caption 是随图文字（可选）',
        action: 'chat_image_send',
        inputSchema: {
          type: 'object',
          properties: {
            mediaId: { type: 'string', pattern: '^ma_[0-9a-f]{12}$', description: MEDIA_ID_DESC },
            query: { type: 'string', maxLength: 120, description: '按含义检索（如「橘猫梗图」「开心表情」）；与 mediaId 二选一' },
            caption: { type: 'string', maxLength: 300, description: '随图发送的文字说明（可选）' },
          },
        },
      },
      {
        name: 'chat_voice_send',
        description: '[写] 发送语音：发送语音库里的语音资产（克隆合成的产物或归档语音）。要主动开口说话时先用 chat_voice_synthesize 合成，ready 后用本工具发送',
        action: 'chat_voice_send',
        inputSchema: {
          type: 'object',
          properties: {
            mediaId: { type: 'string', pattern: '^ma_[0-9a-f]{12}$', description: '语音资产 id（chat_voice_synthesize 返回的 mediaId 或记忆里的 [语音|ma_xxx] 占位符）' },
          },
        },
      },
      {
        name: 'chat_file_send',
        description: '[写] 发送文件：发送文件型资产（ppt/文档等；视频等大文件默认不入记忆库，仅限历史遗留资产）',
        action: 'chat_file_send',
        inputSchema: {
          type: 'object',
          properties: {
            mediaId: { type: 'string', pattern: '^ma_[0-9a-f]{12}$', description: MEDIA_ID_DESC },
          },
        },
      },
    ],
    call: async ({ action, ctx }) => {
      const expectKinds = TOOL_KINDS[action];
      if (!expectKinds) {
        return { ok: false, degraded: true, code: 'E_UNSUPPORTED', message: `media-send does not own action "${action}"（chat_media_send 已退役：发图片用 chat_image_send，发语音用 chat_voice_send，发文件用 chat_file_send）` };
      }
      const mediaId = String(ctx.payload?.mediaId ?? '').trim();
      const query = String(ctx.payload?.query ?? '').trim();
      if (!mediaId && !query && action !== 'chat_voice_send') {
        return { ok: false, degraded: true, code: 'E_ACTION', message: 'mediaId 与 query 必居其一' };
      }
      if (!mediaId && action === 'chat_voice_send') {
        return { ok: false, degraded: true, code: 'E_ACTION', message: '发送语音需要 mediaId（先 chat_media_search 找语音资产，或 chat_voice_synthesize 合成）' };
      }
      if (!mediaId && !query) {
        return { ok: false, degraded: true, code: 'E_ACTION', message: 'mediaId 与 query 必居其一' };
      }
      if (mediaId && !MEDIA_ID_RE.test(mediaId)) {
        return { ok: false, degraded: true, code: 'E_ACTION', message: `mediaId 格式非法（应形如 ma_0123456789ab）：${mediaId.slice(0, 40)}` };
      }
      try {
        const fetched = await fetchAsset({ mediaId, query, ctx });
        if (fetched.error) {
          return { ok: false, degraded: true, code: fetched.error, message: fetched.message };
        }
        const asset = fetched.asset;
        // 工具语义校验：每个发送工具只发自己声明的 kind，错配显式报错（不猜类型）
        if (!expectKinds.includes(String(asset.kind ?? ''))) {
          return {
            ok: false, degraded: true, code: 'E_UNSUPPORTED',
            message: `此工具只发 ${expectKinds.join('/')}，资产 ${asset.mediaId ?? mediaId} 的 kind 是 ${asset.kind}（选对发送工具，或用 chat_media_search 按类型检索）`,
          };
        }
        // 平台判定：sessionKey 首段（qq:group:xxx → qq）。未知平台显式报错。
        const platform = String(ctx.sessionKey ?? '').split(':')[0] || '';
        const converted = convertSend(asset, platform);
        if (converted.unsupported) {
          return { ok: false, degraded: true, code: 'E_UNSUPPORTED', message: converted.reason };
        }
        const routed = findEntry(platform, converted.action);
        if (!routed) {
          return { ok: false, degraded: true, code: 'E_PLATFORM', message: `${platform} 平台清单里没有 ${converted.action} 动作（bridge 未启用或未拉到清单）` };
        }
        // caption 只对图片类有意义：塞进 args 由 bridge send_image 拼段；其它动作忽略。
        const args = { ...converted.args };
        if (converted.action === 'send_image' && ctx.payload?.caption) args.caption = String(ctx.payload.caption).slice(0, 300);
        const delivery = await deliver({
          adapter: routed.adapter,
          action: converted.action,
          entry: routed.entry,
          ctx: { ...ctx, payload: args },
          timeoutMs: SEND_TIMEOUT_MS,
        });
        if (!delivery?.ok) {
          return {
            ok: false, degraded: true, code: delivery?.code ?? 'E_PLATFORM',
            message: `发送失败（${converted.action}）：${delivery?.message ?? '未知错误'}`,
          };
        }
        // 发送成功 → 学习信号（best-effort，失败不影响回执）。
        try {
          const serviceId = resolveMemoryService?.();
          if (serviceId && asset.mediaId) {
            await callServiceTool(serviceId, { tool: 'chat_media_mark_used', args: { mediaId: asset.mediaId }, ctx: { sessionKey: ctx.sessionKey } });
          }
        } catch { /* 学习信号失败不阻断 */ }
        logger(`media-send: ${asset.mediaId ?? mediaId} (${asset.kind}) -> ${converted.action} via ${routed.adapter.id}`);
        return { ok: true, receipt: { sent: converted.action, mediaId: asset.mediaId ?? mediaId, kind: asset.kind, desc: String(asset.desc ?? '').slice(0, 80), ...(fetched.candidates && fetched.candidates.length > 1 ? { alternatives: fetched.candidates.slice(1, 4).map((c) => ({ mediaId: c.mediaId, desc: c.desc })) } : {}) } };
      } catch (error) {
        return { ok: false, degraded: true, code: 'E_PLATFORM', message: String(error?.message ?? 'media send failed') };
      }
    },
  });
}
