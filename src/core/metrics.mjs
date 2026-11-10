/**
 * 极简指标：计数器 + 耗时摘要。
 *
 * 不引入 Prometheus 客户端：当前是单机进程，导出 JSON 足够被控制台或
 * 运维脚本消费。标签用 `name{k=v,k2=v2}` 编成一个字符串键，避免维护
 * 嵌套 Map 的样板代码。
 */
/** 单个进程允许的时间线数量上限：标签若来自请求内容（路径/工具名），必须封顶。 */
const MAX_SERIES = 2000;

export function createMetrics() {
  /** @type {Map<string, number>} */
  const counters = new Map();
  /** @type {Map<string, {count: number, sum: number, min: number, max: number}>} */
  const timings = new Map();

  function labelKey(name, labels) {
    const pairs = Object.entries(labels ?? {})
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      // 标签值也做长度封顶：一个超长 URL/工具名不该在快照里复制一份完整原文。
      .map(([k, v]) => [k, String(v).slice(0, 120)])
      .sort(([a], [b]) => a.localeCompare(b));
    return pairs.length === 0 ? name : `${name}{${pairs.map(([k, v]) => `${k}=${v}`).join(',')}}`;
  }

  /**
   * 写入前的基数闸门：新序列超过上限时折叠进 `name{overflow=1}`。
   * 不做这层，任何「拿请求内容当标签」的调用点（历史上有 route=完整 pathname）
   * 都能被扫描流量打爆内存。
   */
  function boundedKey(map, name, labels) {
    const key = labelKey(name, labels);
    if (map.has(key) || map.size < MAX_SERIES) return key;
    return `${name}{overflow=1}`;
  }

  return {
    inc(name, labels) {
      const key = boundedKey(counters, name, labels);
      counters.set(key, (counters.get(key) ?? 0) + 1);
    },

    add(name, value, labels) {
      const key = boundedKey(counters, name, labels);
      counters.set(key, (counters.get(key) ?? 0) + value);
    },

    observe(name, value, labels) {
      if (!Number.isFinite(value) || value < 0) return;
      const key = boundedKey(timings, name, labels);
      const current = timings.get(key);
      if (!current) {
        timings.set(key, { count: 1, sum: value, min: value, max: value });
        return;
      }
      current.count += 1;
      current.sum += value;
      if (value < current.min) current.min = value;
      if (value > current.max) current.max = value;
    },

    snapshot() {
      const out = { counters: {}, timings: {} };
      for (const [key, value] of [...counters.entries()].sort()) out.counters[key] = value;
      for (const [key, value] of [...timings.entries()].sort()) {
        out.timings[key] = {
          count: value.count,
          sum: Math.round(value.sum),
          min: Math.round(value.min),
          max: Math.round(value.max),
          avg: value.count ? Math.round(value.sum / value.count) : 0,
        };
      }
      return out;
    },
  };
}
