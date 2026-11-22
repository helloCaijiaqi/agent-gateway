/**
 * adapter-tools 装配机器：N 个消费端清单 × 各平台能力模块 → 单个 executor。
 *
 * 为什么是单 executor 而不是每平台/每账号一个：registry 按 action 全局路由
 * （一 action 一 owner），而清单里 get_unread 这类通用 type 天然跨平台/跨账号
 * 重复——单 executor 内部两级分派，工具名命名空间 chat_<platform>_<type> 保证
 * 全局唯一（多消费端收编：同平台多账号**共享**一套 chat_<platform>_* 工具，
 * 模型视角不变）。
 *
 * 路由（两级）：
 *   1. 平台：工具名前缀（模型的选择）权威——chat_<平台>_* 一定进该平台；缺省
 *      回退会话键首段。两处都解析不出来时结构化失败，绝不猜平台。
 *   2. 消费端（账号）：**会话绑消费端**——4 段会话键 `platform:consumerId:kind:id`
 *      第 2 段精确路由到该账号（「dsh 开启会话是对应消费端的会话」）；3 段旧键
 *      或账号已下线时回退该平台的字典序首个消费端（一次告警——宁可显式回退也
 *      不静默换线）。会话所属账号未接线该动作 = 结构化失败（诚实，不借道别的
 *      账号发消息）。
 */
import { registerExecutor } from '../../executor-interface.mjs';
import { planTools } from './catalog.mjs';
import { deliverAction } from './transport.mjs';

const PLATFORM_RE = /^[a-z][a-z0-9]*$/;
const TOOL_PLATFORM_RE = /^chat_([a-z][a-z0-9]*)_/, SESSION_PLATFORM_RE = /^[a-z][a-z0-9]*/;

/** 4 段会话键第 2 段 = 消费端 id；3 段旧键返回 null（回退平台级路由）。 */
function consumerIdOf(sessionKey) {
  const parts = String(sessionKey ?? '').split(':');
  return parts.length === 4 && parts[1] ? parts[1] : null;
}

export function createAdapterToolsExecutor({
  adapters, // [{ adapter, manifest, capabilities }]（同平台可多账号）
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

  // 组装：平台 → { byConsumer: consumerId → { adapter, byType }, tools(并集) }。
  const byPlatform = new Map();
  for (const item of [...adapters].sort((a, b) => String(a.adapter?.id ?? '').localeCompare(String(b.adapter?.id ?? '')))) {
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
    const planned = planTools({ platform: adapter.platform, manifest, capabilities });
    const skippedSummary = Object.entries(planned.skipped)
      .filter(([, list]) => list.length > 0)
      .map(([reason, list]) => `${reason}:${list.length}`)
      .join(' ');
    logger(`adapter-tools plan (${adapter.id}): ${planned.routed.length} actions -> ${planned.tools.length} tools${skippedSummary ? ` (skipped ${skippedSummary})` : ''}`);

    let group = byPlatform.get(adapter.platform);
    if (!group) {
      group = { byConsumer: new Map(), tools: [] };
      byPlatform.set(adapter.platform, group);
    } else {
      // 同平台多账号 = 共享工具（不再视为装配冲突）；每个账号仍独立解析自己的清单。
      logger(`adapter-tools: platform "${adapter.platform}" has multiple consumers (shared tool namespace)`);
    }
    group.byConsumer.set(adapter.id, { adapter, byType: new Map(planned.routed.map((routed) => [routed.action, routed])) });
    for (const tool of planned.tools) {
      if (!group.tools.some((existing) => existing.name === tool.name)) group.tools.push(tool);
    }
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

      // 消费端选择（会话绑消费端）：4 段会话键第 2 段精确路由；旧键/账号下线
      // 回退该平台字典序首个消费端（一次告警，不静默换线）。
      const wanted = consumerIdOf(ctx.sessionKey);
      let entry = wanted ? group.byConsumer.get(wanted) : null;
      if (!entry) {
        const firstId = [...group.byConsumer.keys()][0];
        entry = group.byConsumer.get(firstId);
        logger(`adapter-tools: session "${ctx.sessionKey}" has no consumer "${wanted ?? '(legacy 3-seg key)'}" `
          + `on platform "${platform}", falling back to "${firstId}"`);
        if (!entry) {
          return {
            ok: false, degraded: true, code: 'E_UNSUPPORTED',
            message: `no consumer for session "${ctx.sessionKey}" on platform "${platform}"`,
          };
        }
      }

      const routed = entry.byType.get(action);
      if (!routed) {
        // 会话所属账号未接线该动作：诚实失败（不借道其它账号）。
        return {
          ok: false, degraded: true, code: 'E_UNSUPPORTED',
          message: `consumer "${entry.adapter.id}" (${platform}) does not wire action "${action}"`,
        };
      }
      if (typeof routed.capability.handle === 'function') {
        return routed.capability.handle({ action, entry: routed.entry, ctx, adapter: entry.adapter });
      }
      return deliver({ adapter: entry.adapter, action, entry: routed.entry, ctx, timeoutMs, returnPipeline });
    },
  });
}
