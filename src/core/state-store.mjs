/**
 * 会话状态的持久化底座（P4）。
 *
 * 存的是「丢了无法重建」的传输/策略状态：已读水位、未读游标、唤醒配置、
 * agentToken。因此持久化策略与幂等表一致（内存先改、去抖原子写），但**没有
 * TTL、没有上限淘汰**——游标和唤醒配置是权威数据，淘汰等于状态丢失。
 *
 * 为什么不复用 idempotency.mjs：那张表是「防重复的优化」，损坏可以丢弃重建；
 * 这里的数据损坏必须显式改名留证（`.corrupt-*`）并从空开始，让适配器的镜像
 * 写尽快把它补齐，而不是静默吞掉旧水位。
 */
import fs from 'node:fs';
import path from 'node:path';

export function createStateStore({
  file,
  flushDelayMs = 200,
  logger = () => {},
} = {}) {
  /** @type {Map<string, object>} sessionKey -> state */
  const sessions = new Map();
  let timer = null;
  let dirty = false;

  if (file) load();

  function load() {
    try {
      if (!fs.existsSync(file)) return;
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw);
      for (const [key, state] of Object.entries(parsed?.sessions ?? {})) {
        if (!state || typeof state !== 'object') continue;
        sessions.set(key, state);
      }
    } catch (error) {
      logger(`state-store: failed to load ${file}: ${error?.message ?? error}`);
      try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {}
    }
  }

  function scheduleFlush() {
    dirty = true;
    if (!file || timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, flushDelayMs);
    timer.unref?.();
  }

  function flush() {
    if (!file || !dirty) return;
    dirty = false;
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, savedAt: Date.now(), sessions: Object.fromEntries(sessions) }, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) {
      // 写失败保持 dirty，下一条更新会再试；调用方不需要感知（镜像写是
      // best-effort，本地 social-v2.json 在 P4 仍是权威）。
      dirty = true;
      logger(`state-store: flush failed: ${error?.message ?? error}`);
    }
  }

  return {
    get(sessionKey) { return sessions.get(sessionKey) ?? null; },
    has(sessionKey) { return sessions.has(sessionKey); },
    put(sessionKey, state) {
      sessions.set(sessionKey, state);
      scheduleFlush();
    },
    delete(sessionKey) {
      const existed = sessions.delete(sessionKey);
      if (existed) scheduleFlush();
      return existed;
    },
    keys() { return [...sessions.keys()]; },
    get size() { return sessions.size; },
    flush,
    close() {
      if (timer) { clearTimeout(timer); timer = null; }
      flush();
    },
  };
}
