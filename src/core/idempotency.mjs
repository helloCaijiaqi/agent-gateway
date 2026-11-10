/**
 * 幂等键存储：入站消息与出站动作各一份。
 *
 * 为什么必须落盘：
 *   网关重启后适配器会重发未确认的入站（这是正确行为）。如果幂等表只在内存，
 *   重启窗口内的重发会被当成新消息，模型于是对同一句话回两次。
 *
 * 为什么是有界 LRU 而不是全量历史：
 *   幂等只需要覆盖「重试可能发生的窗口」——平台重试、网关重启、网络抖动。
 *   24 小时后同一条消息再出现，几乎必然是平台侧的新消息（QQ 的 message_id
 *   不复用），继续去重反而会吞掉真实消息。
 *
 * 写盘策略：内存先改，50ms 去抖后原子写（tmp + rename）。崩溃最多丢 50ms
 * 的幂等记录，而这段时间内的入站还没有被 ack，所以不会产生「已回复但记录丢失」。
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_ENTRIES = 5000;

export function createIdempotency({
  file = null,
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = Date.now,
  flushDelayMs = 50,
  logger = () => {},
} = {}) {
  /** @type {Map<string, {value: unknown, at: number}>} */
  const entries = new Map();
  let timer = null;
  let dirty = false;

  if (file) load();

  function load() {
    try {
      if (!fs.existsSync(file)) return;
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw);
      const at = now();
      for (const [key, record] of Object.entries(parsed?.entries ?? {})) {
        if (!record || typeof record.at !== 'number') continue;
        if (at - record.at > ttlMs) continue;
        entries.set(key, { value: record.value, at: record.at });
      }
    } catch (error) {
      // 损坏的幂等表不应该阻断启动：它只是防重复的优化，不是真相源。
      // 但必须留下证据，否则「为什么今天重复回复了」会无从查起。
      logger(`idempotency: failed to load ${file}: ${error?.message ?? error}`);
      try {
        if (file) fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {}
    }
  }

  function prune(at) {
    for (const [key, record] of entries) {
      if (at - record.at <= ttlMs) continue;
      entries.delete(key);
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
    }
  }

  function scheduleFlush() {
    dirty = true;
    if (!file || timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, flushDelayMs);
    // 不阻止进程退出：退出前由 close() 显式 flush。
    timer.unref?.();
  }

  function flush() {
    if (!file || !dirty) return;
    dirty = false;
    const at = now();
    prune(at);
    const payload = { version: 1, savedAt: at, entries: Object.fromEntries(entries) };
    const dir = path.dirname(file);
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) {
      logger(`idempotency: failed to flush ${file}: ${error?.message ?? error}`);
    }
  }

  return {
    /** 命中返回记录；不命中返回 null。 */
    get(key) {
      const record = entries.get(key);
      if (!record) return null;
      if (now() - record.at > ttlMs) {
        entries.delete(key);
        return null;
      }
      // 刷新 LRU 位置：频繁重试的键不应该先被淘汰。
      entries.delete(key);
      entries.set(key, record);
      return record.value;
    },

    put(key, value) {
      const at = now();
      entries.delete(key);
      entries.set(key, { value, at });
      prune(at);
      scheduleFlush();
    },

    /**
     * 删除幂等记录（提交同步失败时回滚）。
     *
     * 先落盘再去 submit 是为了「崩溃后重发能命中」；但 submit 同步抛错时如果不
     * 回滚，适配器重试会被判 deduped、永远拿不到那一轮 —— 既要先落盘，也要能撤。
     */
    delete(key) {
      const had = entries.delete(key);
      if (had) scheduleFlush();
      return had;
    },

    /** 测试与优雅退出用；返回是否真的写了盘。 */
    flush() {
      if (!file) return false;
      dirty = true;
      flush();
      return true;
    },

    close() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      flush();
    },

    get size() { return entries.size; },
  };
}
