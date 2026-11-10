/**
 * 目录与 Schema 生成（清单条目 → 工具描述符）+ kind 分档预算（装配机器）。
 */

const KIND_LABEL = { read: '读', write: '写', sensitive: '敏感' };

/** 工具描述：kind 前缀帮模型判断读写与敏感，摘要来自清单（≤500 字由接口校验兜底）。 */
export function describeAction(entry) {
  const label = KIND_LABEL[entry.kind] ?? '';
  const summary = typeof entry.summary === 'string' && entry.summary.trim() ? entry.summary.trim() : entry.type;
  const text = label ? `[${label}] ${summary}` : summary;
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

export function toInputSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  return schema;
}

/**
 * kind 分档预算：读/写跟随预算授予；敏感动作封顶——敏感能力不该被长超时放大。
 * 预算来自 tool-host，executor 侧只做减法（封顶）不做加法（放宽）。
 */
const DEFAULT_TIMEOUT_MS = 10_000;
const SENSITIVE_CAP_MS = 10_000;
export function resolveTimeoutMs({ kind, budget, timeoutMs } = {}) {
  const fallback = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const granted = budget?.timeoutMs;
  if (!Number.isFinite(granted) || granted <= 0) return fallback;
  return kind === 'sensitive' ? Math.min(granted, SENSITIVE_CAP_MS) : granted;
}

/**
 * 清单 × 平台能力模块 → 工具面（单平台一次调用）。
 *
 * 覆盖完整性（决策 12）在这里双向强制：
 *   - 清单条目没有宿主模块 → 装配错误（孤儿条目）；
 *   - 宿主模块没有清单条目 → 装配错误（孤儿模块）。
 * 清单与平台目录必须同步演进，半套目录不允许存在。
 *
 * 过滤规则（清单是唯一事实源）：
 *   - `enabled:false` 不暴露。适配器在 `GET /v1/actions/manifest` 时按「实现覆盖 +
 *     configFlag」现算该字段，因此「清单有、实现没有」的条目不会变成必然失败的工具；
 *   - 不再按 kind 过滤：敏感能力（如 set_wake）是否可用同样由清单的 enabled 决定，
 *     否则提示词要求调用、工具面却没有，属于两边打架。
 *   - 缺省（无 enabled 字段）视为可用，兼容只实现了 wired 字段的旧清单。
 */
export function planTools({ platform, manifest, capabilities }) {
  const declared = Array.isArray(manifest?.actions) ? manifest.actions : [];

  const modules = new Map();
  for (const cap of capabilities) {
    if (!cap || typeof cap.type !== 'string' || !cap.type) {
      throw new TypeError(`capability module without a type is not allowed (platform "${platform}")`);
    }
    if (modules.has(cap.type)) {
      throw new TypeError(`duplicate capability module for type "${cap.type}" (platform "${platform}")`);
    }
    modules.set(cap.type, cap);
  }
  for (const cap of modules.values()) {
    if (!declared.some((entry) => entry?.type === cap.type)) {
      throw new TypeError(`capability module "${cap.type}" is not declared in the manifest (platform "${platform}")`);
    }
  }

  const seen = new Set();
  const routed = [];
  const tools = [];
  const skipped = { disabled: [], invalid: [] };

  for (const entry of declared) {
    const type = typeof entry?.type === 'string' ? entry.type : '';
    if (!type) { skipped.invalid.push(String(entry?.type)); continue; }
    if (seen.has(type)) throw new TypeError(`duplicate action type in manifest: ${type}`);
    seen.add(type);
    const cap = modules.get(type);
    if (!cap) {
      throw new TypeError(`manifest action "${type}" has no capability module (platform "${platform}") — manifest and platform folder must stay 1:1`);
    }
    if (entry.enabled === false || entry.wired === false) { skipped.disabled.push(type); continue; }
    routed.push({ action: type, entry, capability: cap });
    tools.push({
      name: `chat_${platform}_${type}`,
      description: typeof cap.describe === 'function' ? cap.describe(entry) : describeAction(entry),
      action: type,
      inputSchema: typeof cap.schema === 'function' ? cap.schema(entry) : toInputSchema(entry.payloadSchema),
    });
  }
  return { routed, tools, skipped };
}
