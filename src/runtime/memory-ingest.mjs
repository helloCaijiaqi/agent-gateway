/**
 * V2 P3 §6 记忆落库调度器（runtime）：入站消息与出站发送文本的「自动沉淀」。
 *
 * 规格（docs/design/GATEWAY_V2_REFACTOR.md §6.3/§6.4 + 会话纪元模型，实现不得偏离）：
 *  - 双向拦截：入站（server.mjs handleInbound，HTTP /v1/inbound 与 WS inbound 帧
 *    的唯一汇聚点，覆盖 shadow/unrouted/queued 等不触发 turn 的消息）+ 出站
 *    （tool-host SEND_ACTIONS 成功点，模型经发送工具真正发出去的文本）；
 *  - 防抖成批落地：不逐条即时写入——按会话缓冲，时间窗（windowMs）到期或单会话
 *    攒满（maxBatch）才冲刷；进程退出前 flushAll 排空；
 *  - raw 全量落地：冲刷时逐条 POST memory-mcp 的 /api/memory/ingest（原文层），
 *    幂等完全由服务端裁决（raw 表 UNIQUE(session_id, msg_id)）——网关不介入判定；
 *  - msgId 维度去重：入站用平台消息 id，出站用合成 id out:<turnId>:<callId>；
 *    本地去重键 = 会话 + msgId（与服务端唯一键同构，缓冲内与重试队列共用）；
 *  - 在途上限：并发投递不超过 maxConcurrent（默认 4），其余 FIFO 排队——窗口
 *    到期一次性吐 50 条时不会把记忆服务打出尖峰；失败项仍进重试队列（指数退避），
 *    超过 maxAttempts 丢弃并记日志（宁丢不阻塞消息主链路——落库是旁路）。
 *
 * 调度器是纯缓冲 + 投递，不知道 memory-mcp 的存在：deliver 由 main.mjs 注入
 * （runtime 层不做 HTTP 细节），observe* 永不抛错、永不 await 主链路。
 */
import { createHash } from 'node:crypto';

export function createMemoryIngest({
  /** async (record) => void：逐条投递（POST /api/memory/ingest）。抛错 = 本条失败进重试。 */
  deliver,
  windowMs = 30_000,
  maxBatch = 50,
  maxBuffer = 2000,
  maxChars = 2000,
  maxAttempts = 8,
  maxConcurrent = 4,
  logger = () => {},
  now = Date.now,
} = {}) {
  if (typeof deliver !== 'function') throw new Error('createMemoryIngest 需要 deliver（注入投递函数）');
  if (!Number.isSafeInteger(windowMs) || windowMs < 1000) throw new Error('windowMs must be an integer >= 1000');
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('maxConcurrent must be an integer >= 1');

  /** 会话缓冲：sessionKey → { items: [], timer }。 */
  const sessions = new Map();
  /** 重试队列：dedupKey → { record, attempts, nextAt }。 */
  const retrying = new Map();
  /** 投递流水线：FIFO 队列 + 在途计数（窗口到期最多 50 条 → 最多 4 个同时在途）。 */
  const pendingQueue = [];
  const drainWaiters = [];
  let inflight = 0;
  let dropped = 0;
  let flushed = 0;
  let sweepTimer = null;

  function recordKey(record) {
    // 与 memory-mcp raw 表唯一键同构（会话 + msgId）——本地去重只是缓冲层
    // 优化，真正的幂等裁决在服务端（UNIQUE 约束）。
    return createHash('sha256').update(`${record.sessionId}\u0000${record.msgId}`).digest('hex');
  }

  function buffer(sessionKey) {
    let entry = sessions.get(sessionKey);
    if (!entry) {
      entry = { items: [], timer: null };
      sessions.set(sessionKey, entry);
    }
    return entry;
  }

  function scheduleFlush(sessionKey, entry) {
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      flushSession(sessionKey);
    }, windowMs);
    entry.timer.unref?.();
  }

  /** 观察一条候选（双向通用）。同步入缓冲，永不抛错。msgId 必填：缺失只记日志。 */
  function observe({ sessionKey, msgId, text, senderId = '', kind = 'episodic', createdAt = now() }) {
    if (!sessionKey || typeof msgId !== 'string' || !msgId) {
      logger(`memory ingest skipped: missing msgId (sessionKey=${sessionKey ?? ''})`);
      return;
    }
    if (typeof text !== 'string') return;
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    const record = {
      sessionId: sessionKey,
      msgId,
      kind,
      senderId: String(senderId ?? '').slice(0, 120),
      text: normalized.length > maxChars ? `${normalized.slice(0, maxChars)}…` : normalized,
      createdAt,
    };
    const key = recordKey(record);
    // 同 msgId 已在缓冲或重试队列 = 重复观察（重放/多拦截点），跳过。
    if (sessions.get(sessionKey)?.items.some((item) => item.key === key)) return;
    if (retrying.has(key)) return;
    const entry = buffer(sessionKey);
    entry.items.push({ key, record });
    // 全局缓冲上限：丢最旧（落库是旁路，绝不挤占主链路内存）。
    let overflow = totalBuffered() - maxBuffer;
    while (overflow > 0) {
      const oldest = sessions.keys().next().value;
      const bucket = sessions.get(oldest);
      bucket.items.shift();
      dropped += 1;
      if (bucket.items.length === 0 && !bucket.timer) sessions.delete(oldest);
      overflow -= 1;
    }
    if (entry.items.length >= maxBatch) {
      flushSession(sessionKey);
    } else {
      scheduleFlush(sessionKey, entry);
    }
  }

  function totalBuffered() {
    let total = 0;
    for (const entry of sessions.values()) total += entry.items.length;
    return total;
  }

  function enqueue(key, record) {
    pendingQueue.push({ key, record });
    pump();
  }

  /** 在途上限内的投递泵：一条失败只进重试，绝不打断后续条目。 */
  function pump() {
    while (inflight < maxConcurrent && pendingQueue.length > 0) {
      const { key, record } = pendingQueue.shift();
      inflight += 1;
      // deliver 可能是同步抛错的实现（测试/降级注入）：直接调会在 observe 的
      // 调用栈里抛出去，把入站主链路一起打断。统一收敛成 rejected promise。
      let task;
      try {
        task = deliver(record);
      } catch (error) {
        task = Promise.reject(error);
      }
      Promise.resolve(task)
        .then(() => { flushed += 1; })
        .catch((error) => handleFailure(key, record, error))
        .finally(() => {
          inflight -= 1;
          pump();
          if (inflight === 0 && pendingQueue.length === 0) {
            const waiters = drainWaiters.splice(0, drainWaiters.length);
            for (const waiter of waiters) waiter();
          }
        });
    }
  }

  /** 等待全部在途与排队条目投递完毕（flushAll/关停排空用）。 */
  function drained() {
    if (inflight === 0 && pendingQueue.length === 0) return Promise.resolve();
    return new Promise((resolve) => drainWaiters.push(resolve));
  }

  function handleFailure(key, record, error) {
    const existing = retrying.get(key);
    const attempts = (existing?.attempts ?? 0) + 1;
    if (attempts > maxAttempts) {
      retrying.delete(key);
      dropped += 1;
      logger(`memory ingest dropped after ${maxAttempts} attempts: ${error?.message ?? error}`);
      return;
    }
    retrying.set(key, {
      record,
      attempts,
      nextAt: now() + Math.min(windowMs * 2 ** (attempts - 1), 10 * 60_000),
    });
  }

  /** 冲刷一个会话：缓冲条目全部进投递队列（受在途上限约束）。永不抛错。 */
  function flushSession(sessionKey) {
    const entry = sessions.get(sessionKey);
    if (!entry || entry.items.length === 0) return;
    const items = entry.items.splice(0, entry.items.length);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (sessions.get(sessionKey)?.items.length === 0) sessions.delete(sessionKey);
    for (const { key, record } of items) enqueue(key, record);
  }

  /** 兜底冲刷：所有会话缓冲立即入队 + 重试到期的重试 + 等待排空。 */
  async function flushAll() {
    for (const sessionKey of [...sessions.keys()]) flushSession(sessionKey);
    await retryDue(true);
    await drained();
  }

  async function retryDue(force = false) {
    const at = now();
    const due = [...retrying.entries()].filter(([, item]) => force || item.nextAt <= at);
    for (const [key, item] of due) {
      try {
        await deliver(item.record);
        retrying.delete(key);
        flushed += 1;
      } catch (error) {
        const attempts = item.attempts + 1;
        retrying.delete(key);
        if (attempts > maxAttempts) {
          dropped += 1;
          logger(`memory ingest dropped after ${maxAttempts} attempts: ${error?.message ?? error}`);
        } else {
          retrying.set(key, { record: item.record, attempts, nextAt: now() + Math.min(windowMs * 2 ** (attempts - 1), 10 * 60_000) });
        }
      }
    }
  }

  // 周期兜底：冲刷到期的重试（定时器只做重试；会话缓冲由各自的窗口 timer 冲）。
  // sweeping 防重入：retryDue 内部 await 投递，间隔短于投递耗时时会并发跑，
  // 同一批 due 条目被投两次（记忆重复）。
  let sweeping = false;
  function start() {
    if (sweepTimer) return;
    sweepTimer = setInterval(() => {
      if (sweeping) return;
      sweeping = true;
      Promise.resolve(retryDue())
        .catch((error) => logger(`memory ingest sweep failed: ${error?.message ?? error}`))
        .finally(() => { sweeping = false; });
    }, Math.max(windowMs, 1000));
    sweepTimer.unref?.();
  }

  function stop() {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    // 会话窗口定时器也要清：残留 timer 会拖住进程退出，并在 stop 后再投一次。
    // （缓冲里未投递的条目由关停链路的 flushAll 负责排空，这里不清缓冲。）
    for (const entry of sessions.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
    }
  }

  /** 健康视图（/v1/health / 运维）。 */
  function stats() {
    return {
      buffered: totalBuffered(),
      retrying: retrying.size,
      flushed,
      dropped,
      sessions: sessions.size,
      inflight,
      queued: pendingQueue.length,
    };
  }

  return {
    /** 入站观察：server.handleInbound 注入点（envelope 即契约信封）。 */
    observeInbound({ sessionKey, envelope }) {
      const message = envelope?.message;
      if (!message?.text) return; // 合成事件/纯 wake 没有消息本体
      observe({
        sessionKey,
        msgId: message.id,
        text: message.text,
        senderId: message.sender?.id ?? '',
        kind: 'episodic',
        createdAt: message.createdAt,
      });
    },
    /** 出站观察：tool-host SEND_ACTIONS 成功点（真正发出去的文本才算）。
     *  msgId 必须由调用方给（合成 id out:<turnId>:<callId>），缺失则跳过。 */
    observeOutbound({ sessionKey, tool, args, msgId }) {
      const text = args?.content ?? args?.text ?? args?.message;
      if (typeof text !== 'string' || !text.trim()) return;
      observe({
        sessionKey,
        msgId,
        text,
        senderId: 'assistant',
        kind: 'episodic',
      });
    },
    flushAll,
    start,
    stop,
    stats,
  };
}
