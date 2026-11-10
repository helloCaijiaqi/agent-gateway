/**
 * adapter-tools 装配机器：N 个适配器清单 × 各平台能力模块 → 单个 executor。
 *
 * 为什么是单 executor 而不是每平台一个：registry 按 action 全局路由（一 action
 * 一 owner），而清单里 get_unread 这类通用 type 天然跨平台重复——单 executor
 * 内部按平台分派（沿用 platform-actions 的 byPlatform 模式），工具名命名空间
 * chat_<platform>_<type> 保证全局唯一。
 *
 * 路由：模型调用的工具名就是平台选择（chat_<平台>_* 一定进该平台的适配器）——平台从
 * ctx.tool 前缀解析（tool-host 注入）；ctx.tool 缺省时回退 ctx.sessionKey 的平台。
 * 两处都解析不出来时结构化失败，绝不猜适配器。
 */
import { registerExecutor } from '../../executor-interface.mjs';
import { planTools } from './catalog.mjs';
import { deliverAction } from './transport.mjs';

const PLATFORM_RE = /^[a-z][a-z0-9]*$/;
const TOOL_PLATFORM_RE = /^chat_([a-z][a-z0-9]*)_/, SESSION_PLATFORM_RE = /^[a-z][a-z0-9]*/;

export function createAdapterToolsExecutor({
  adapters, // [{ adapter, manifest, capabilities }]
  timeoutMs = 10_000,
  logger = () => {},
  /**
   * P5 回路链钩子（可选）：async ({ consumerId, sessionKey, turnId, text }) =>
   * Promise<{ verdict: 'pass'|'drop', text?, degraded? }>——发送动作外发文本在
   * 投递前过 returnPipelines（装配自 pipeline.runReturn，见 main.mjs）。
   * 缺省 null = 不拦截（透传语义）。
   */
  returnPipeline = null,
  /**
   * 投递载体（可选，组合根注入）：默认 deliverAction（纯 HTTP）。
   * 传 WS 优先/HTTP 兜底的包装函数即可把动作下发切到 WS——本层不 import
   * core/ws-hub（依赖方向不变，test-layering 钉住）。
   * 签名：({ adapter, action, entry, ctx, timeoutMs, returnPipeline }) => Promise<result>
   */
  deliver = deliverAction,
} = {}) {
  if (!Array.isArray(adapters) || adapters.length === 0) {
    throw new TypeError('createAdapterToolsExecutor: at least one {adapter, manifest, capabilities} is required');
  }

  const byPlatform = new Map();
  for (const item of adapters) {
    const { adapter, manifest, capabilities } = item ?? {};
    if (!adapter?.platform || !adapter?.callbackBase || !adapter?.secret) {
      throw new TypeError('createAdapterToolsExecutor: adapter with platform/callbackBase/secret is required');
    }
    if (!PLATFORM_RE.test(adapter.platform)) {
      throw new TypeError(`createAdapterToolsExecutor: invalid platform "${adapter.platform}"`);
    }
    if (!manifest || manifest.v !== 1 || !Array.isArray(manifest.actions)) {
      throw new TypeError(`createAdapterToolsExecutor: a conforming manifest is required (adapter "${adapter.id}")`);
    }
    if (manifest.platform !== adapter.platform) {
      // 平台不匹配 = 装错了适配器/清单：宁可没有工具，也不能把 A 平台的能力挂到 B 平台名下。
      throw new TypeError(`manifest platform "${manifest.platform}" does not match adapter platform "${adapter.platform}"`);
    }
    if (!Array.isArray(capabilities) || capabilities.length === 0) {
      throw new TypeError(`createAdapterToolsExecutor: platform "${adapter.platform}" has an empty capability registry`);
    }
    if (byPlatform.has(adapter.platform)) {
      // 目录合并冲突显式拒绝：同平台两份清单必撞工具名，宁可缺工具不可静默串线。
      throw new TypeError(`duplicate adapter platform "${adapter.platform}" (adapter "${adapter.id}")`);
    }
    const planned = planTools({ platform: adapter.platform, manifest, capabilities });
    const skippedSummary = Object.entries(planned.skipped)
      .filter(([, list]) => list.length > 0)
      .map(([reason, list]) => `${reason}:${list.length}`)
      .join(' ');
    logger(`adapter-tools plan (${adapter.id}): ${planned.routed.length} actions -> ${planned.tools.length} tools${skippedSummary ? ` (skipped ${skippedSummary})` : ''}`);
    byPlatform.set(adapter.platform, {
      adapter,
      byType: new Map(planned.routed.map((routed) => [routed.action, routed])),
      tools: planned.tools,
    });
  }

  const allTools = [...byPlatform.values()].flatMap((group) => group.tools);
  const actions = [...new Set(allTools.map((tool) => tool.action))];
  if (actions.length === 0) {
    // 空工具面是装配错误而不是合法状态：调用方据此跳过注册并记日志。
    throw new TypeError('createAdapterToolsExecutor: manifests yielded no usable actions (all filtered)');
  }

  return registerExecutor({
    name: 'adapter-tools',
    actions,
    tools: allTools,
    call: async ({ action, ctx }) => {
      // 平台选择：工具名前缀（模型的选择）权威；缺省回退会话平台；都不行 = 结构化失败。
      const fromTool = typeof ctx.tool === 'string' ? TOOL_PLATFORM_RE.exec(ctx.tool)?.[1] : null;
      const fromSession = SESSION_PLATFORM_RE.exec(String(ctx.sessionKey ?? ''))?.[0] ?? null;
      const platform = byPlatform.has(fromTool) ? fromTool : (byPlatform.has(fromSession) ? fromSession : null);
      if (!platform) {
        return {
          ok: false, degraded: true, code: 'E_UNSUPPORTED',
          message: `no adapter for platform (tool "${ctx.tool ?? ''}", session "${ctx.sessionKey}")`,
        };
      }
      const group = byPlatform.get(platform);
      const routed = group.byType.get(action);
      if (!routed) {
        return {
          ok: false, degraded: true, code: 'E_UNSUPPORTED',
          message: `adapter-tools (${platform}) does not own action "${action}"`,
        };
      }
      if (typeof routed.capability.handle === 'function') {
        return routed.capability.handle({ action, entry: routed.entry, ctx, adapter: group.adapter });
      }
      return deliver({ adapter: group.adapter, action, entry: routed.entry, ctx, timeoutMs, returnPipeline });
    },
  });
}
