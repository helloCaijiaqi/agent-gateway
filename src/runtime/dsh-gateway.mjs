/**
 * DSH 事件流的 turn 等待层：把 mux 帧流变成「等某个会话的 turn 结束」。
 *
 * 职责边界：这里**只做等待与收集**——不建会话、不发 prompt（那是 turn-runner
 * 的编排）、不决定文本发到哪个平台（那是 executor 的事）。mux 连接本身由
 * dsh-client 的重连循环负责；这里对断线透明（等待者靠自己的超时兜底）。
 *
 * 提问/审批（question/requested、approval/requested）做记录与容量受限的
 * 暂存，供 TurnResult 的 degraded 字段、/v1/turns 与控制台 /v1/console/pending
 * 查询感知。转发到平台走 onPending 出口（pending-forwarder，通知性质）；
 * 应答走 pendingEntry + removePending（main.mjs runtime.pending.respond 装配，
 * docs/console/dsh-pending/PLAN.md 应答阶段）——只有操作者在控制台显式处置
 * 才触发 $events/result 调用，不存在任何自动应答路径。
 */
import { createTurnCollector } from './dsh-client.mjs';

export const PENDING_CAPACITY = 100;

export function createDshGateway({ dsh, turnTimeoutMs = 300000, logger = () => {}, now = Date.now, onPending = null } = {}) {
  /** @type {Map<string, {collector: ReturnType<typeof createTurnCollector>, waiters: Set<object>}>} */
  const watching = new Map();
  /** @type {Map<string, object>} eventId → pending question/approval */
  const pending = new Map();

  function laneOf(sessionId) {
    let lane = watching.get(sessionId);
    if (!lane) {
      lane = { collector: createTurnCollector(), waiters: new Set() };
      watching.set(sessionId, lane);
    }
    return lane;
  }

  function rememberPending(entry) {
    if (pending.size >= PENDING_CAPACITY) {
      const oldest = pending.keys().next().value;
      pending.delete(oldest);
    }
    pending.set(entry.eventId, entry);
    // 平台转发出口（GATEWAY_PENDING_FORWARD=on 时装配，off 时为 null）：
    // 只递「新入列」条目，淘汰不回放。回调内部自捕获异常，这里不 await——
    // 事件帧处理不能被出站 HTTP 阻塞。
    try {
      onPending?.(entry);
    } catch (error) {
      logger(`pending forward dispatch failed: ${error?.message ?? error}`);
    }
  }

  function onFrame(payload) {
    switch (payload?.type) {
      case 'session/event': {
        const lane = watching.get(payload.sessionId);
        if (!lane) break;
        const ended = lane.collector.feed(payload.event);
        if (ended) {
          const status = ended.reason?.kind === 'error' ? 'error'
            : ended.reason?.kind === 'aborted' ? 'aborted' : 'completed';
          for (const waiter of lane.waiters) {
            if (waiter.turn && ended.turn && waiter.turn !== ended.turn) continue;
            clearTimeout(waiter.timer);
            lane.waiters.delete(waiter);
            waiter.resolve({
              status, text: ended.text, turn: ended.turn, timedOut: false,
              // provider usage 原样带出：turn-runner 落进 turn record，桥接的
              // token 账本改从 /v1/usage 取（桥接不再连 DSH mux）。
              usage: ended.usage,
            });
          }
        }
        break;
      }
      case 'question/requested':
        rememberPending({
          kind: 'question', eventId: payload.eventId, sessionId: payload.sessionId,
          // clientId：$events/result 应答 RPC 的必填寻址（事件流的 $events 客户端 id）。
          clientId: payload.clientId ?? null,
          questions: payload.questions, at: now(),
        });
        logger(`question/requested from ${payload.sessionId} (${payload.eventId})`);
        break;
      case 'approval/requested':
        rememberPending({
          kind: 'approval', eventId: payload.eventId, sessionId: payload.sessionId,
          clientId: payload.clientId ?? null,
          toolName: payload.toolName, callId: payload.callId, reason: payload.reason, at: now(),
        });
        logger(`approval/requested from ${payload.sessionId}: ${payload.toolName ?? 'unknown'} (${payload.eventId})`);
        break;
      case 'stream/error':
        logger(`stream error for ${payload.sessionId}: ${payload.error?.code ?? 'unknown'}`);
        break;
      default:
        break; // session/snapshot 等帧与等待无关
    }
  }

  function start() {
    dsh.startStream(onFrame);
  }

  function stop() {
    dsh.stopStream();
  }

  return {
    start,
    stop,
    /**
     * 等待指定会话的下一个 turn 结束。**必须在发出 prompt 之前调用**，
     * 否则 turn/start 可能先于注册到达（网络抖动下的丢回复形态）。
     * @param {string} sessionId
     * @param {{timeoutMs?: number}} [options]
     * @returns {Promise<{status: 'completed'|'aborted'|'error'|'timeout', text: string, turn?: string, timedOut: boolean}>}
     */
    awaitTurn(sessionId, { timeoutMs = turnTimeoutMs } = {}) {
      const lane = laneOf(sessionId);
      return new Promise((resolve) => {
        const waiter = {
          turn: null,
          timer: setTimeout(() => {
            lane.waiters.delete(waiter);
            resolve({ status: 'timeout', text: '', timedOut: true });
          }, timeoutMs),
          resolve: (value) => resolve(value),
        };
        if (waiter.timer.unref) waiter.timer.unref();
        lane.waiters.add(waiter);
      });
    },

    /**
     * 丢弃某会话的全部等待者（prompt 失败 / turn 超时后被取消时用）。
     *
     * 不清理的话 waiter 会挂到 timeoutMs 才释放：`lane.waiters` 无界增长，
     * 且迟到的 turn/end 会 resolve 一个已无人消费的 promise。
     * @returns {number} 丢弃的等待者数量
     */
    dropWaiters(sessionId) {
      const lane = watching.get(sessionId);
      if (!lane) return 0;
      let dropped = 0;
      for (const waiter of [...lane.waiters]) {
        clearTimeout(waiter.timer);
        lane.waiters.delete(waiter);
        waiter.resolve({ status: 'aborted', text: '', timedOut: true, dropped: true });
        dropped += 1;
      }
      return dropped;
    },

    /** 按会话列出未决提问/审批（degraded 感知用；控制台走 listPending）。 */
    pendingFor(sessionId) {
      return [...pending.values()].filter((entry) => entry.sessionId === sessionId);
    },

    /**
     * 按 eventId 取未决条目（不移除）。应答流程先 peek 再在 $events/result
     * 成功后 removePending——失败保留条目以便重试（与桥接回滚形态一致）。
     */
    pendingEntry(eventId) {
      return pending.get(String(eventId)) ?? null;
    },

    /** 应答成功后移除条目；返回是否确有该条目（重复处置返回 false）。 */
    removePending(eventId) {
      return pending.delete(String(eventId));
    },

    /**
     * 控制台 pending 查看（docs/console/dsh-pending/PLAN.md §3）：按 kind 过滤、
     * 旧→新（插入序）返回快照。sessionKey 反查在调用方（server）做——本层不依赖
     * session-registry。limit 缺省不限（容量上限 100 兜底）。
     */
    listPending({ kind, limit } = {}) {
      let rows = [...pending.values()];
      if (kind) rows = rows.filter((entry) => entry.kind === kind);
      if (Number.isSafeInteger(limit) && limit > 0) rows = rows.slice(0, limit);
      return rows;
    },

    pendingCount() { return pending.size; },
    watchingCount() { return watching.size; },
  };
}
