/**
 * DSH pending 平台转发（docs/console/dsh-pending/PLAN.md 第二阶段）。
 *
 * 数据链：dsh-gateway 收到 question/approval 事件帧 → rememberPending 触发
 * onPending 回调 → 本模块把该条目翻译成出站动作（ask / approve）投给该会话
 * 对应的平台会话，让平台用户「看得见」agent 在等输入。
 *
 * 边界（刻意的）：
 *   1. **通知性质，不自动应答**——应答（approve/deny/answers）依赖 dsh-client
 *      的应答 RPC（尚未列入清单），在它落地前任何转发都只做同步展示；
 *   2. **只回投原会话**——sessionId 经 registry 反查 sessionKey，按 platform
 *      前缀选适配器；跨会话转发（把 A 群的审批请求发给 B 群）没有任何路径，
 *      这是 PLAN §7 要求的安全策略；
 *   3. 内容在网关侧截断到清单 payloadSchema 的上限（questions ≤5 条 ×500 字、
 *      reason ≤300 字），不在桥接侧依赖防呆兜底；
 *   4. 出站投递函数由组合根注入（main.mjs 传 deliverAction）——runtime 层不
 *      import executors（test-layering 钉住）。
 */

const QUESTIONS_MAX = 5;
const QUESTION_MAX_CHARS = 500;
const REASON_MAX_CHARS = 300;
const TOOLNAME_MAX_CHARS = 100;

/** sessionKey 前缀即平台（`qq:group:123` → `qq`）；坏格式返回 null，绝不猜。 */
function platformOf(sessionKey) {
  const raw = String(sessionKey ?? '');
  const idx = raw.indexOf(':');
  return idx > 0 ? raw.slice(0, idx) : null;
}

/** 按条目种类翻译成动作名与 payload（字段名与 qq-bridge 清单对齐）。 */
function toAction(entry) {
  if (entry.kind === 'question') {
    const questions = (Array.isArray(entry.questions) ? entry.questions : [])
      .map((q) => String(q ?? '').trim().slice(0, QUESTION_MAX_CHARS))
      .filter(Boolean)
      .slice(0, QUESTIONS_MAX);
    if (!questions.length) return null;
    return {
      action: 'ask',
      payload: {
        questions,
        ...(entry.eventId ? { eventId: String(entry.eventId).slice(0, 128) } : {}),
        ...(entry.sessionId ? { sessionId: String(entry.sessionId).slice(0, 128) } : {}),
      },
    };
  }
  if (entry.kind === 'approval') {
    const toolName = String(entry.toolName ?? '').trim().slice(0, TOOLNAME_MAX_CHARS);
    if (!toolName) return null;
    const reason = String(entry.reason ?? '').trim().slice(0, REASON_MAX_CHARS);
    return {
      action: 'approve',
      payload: {
        toolName,
        ...(reason ? { reason } : {}),
        ...(entry.callId ? { callId: String(entry.callId).slice(0, 128) } : {}),
        ...(entry.eventId ? { eventId: String(entry.eventId).slice(0, 128) } : {}),
        ...(entry.sessionId ? { sessionId: String(entry.sessionId).slice(0, 128) } : {}),
      },
    };
  }
  return null;
}

/**
 * @param {object} options
 * @param {Function} options.deliver 出站投递函数（组合根注入 deliverAction——
 *   runtime 层不 import executors，见 test-layering）：
 *   async ({ adapter, action, entry, ctx, timeoutMs }) => { ok, code?, message? }。
 * @param {Array<{id: string, platform: string, secret: string, callbackBase: string}>} options.adapters
 *   只装 callbackBase 非空的适配器（装配点过滤，本模块不再猜）。
 * @param {{sessionKeyOf: (sessionId: string) => string|null}} options.registry
 * @param {number} [options.timeoutMs]
 * @param {(line: string) => void} [options.logger]
 */
export function createPendingForwarder({
  deliver,
  adapters,
  registry,
  timeoutMs = 8000,
  // 投递失败的重试：1s/2s/4s（上限 30s），默认 3 次后放弃。测试可压缩到毫秒级。
  retryBaseMs = 1000,
  maxAttempts = 3,
  logger = () => {},
} = {}) {
  if (typeof deliver !== 'function') throw new TypeError('createPendingForwarder: deliver is required');
  if (!Array.isArray(adapters)) throw new TypeError('createPendingForwarder: adapters must be an array');
  if (typeof registry?.sessionKeyOf !== 'function') {
    throw new TypeError('createPendingForwarder: registry.sessionKeyOf is required');
  }
  /** eventId 去重：**成功投递后**才记入，失败要能重试（旧实现先标记，失败永不重试）。 */
  const forwarded = new Set();
  /** 在途集合：防止 dsh 事件帧重放时同一 eventId 并发投递两次。 */
  const inflight = new Set();
  /** eventId → 已重试次数（成功后删除；超上限放弃）。 */
  const attempts = new Map();
  /** eventId → 重试定时器（close 时统一清理）。 */
  const retryTimers = new Map();
  let closed = false;

  function scheduleRetry(entry) {
    if (closed) return;
    const tried = (attempts.get(entry.eventId) ?? 0) + 1;
    if (tried > maxAttempts) {
      attempts.delete(entry.eventId);
      logger(`pending forward gave up ${entry.eventId} after ${maxAttempts} retries`);
      return;
    }
    attempts.set(entry.eventId, tried);
    const delay = Math.min(retryBaseMs * 2 ** (tried - 1), 30_000);
    const timer = setTimeout(() => {
      retryTimers.delete(entry.eventId);
      forward(entry);
    }, delay);
    timer.unref?.();
    retryTimers.set(entry.eventId, timer);
    logger(`pending forward retry ${entry.eventId} in ${delay}ms (attempt ${tried}/${maxAttempts})`);
  }

  async function forward(entry) {
    if (closed) return;
    if (!entry || typeof entry.eventId !== 'string' || !entry.eventId) return;
    if (forwarded.has(entry.eventId) || inflight.has(entry.eventId)) return;
    inflight.add(entry.eventId);
    let delivered = false;
    let retryable = false;
    try {
      const sessionKey = registry.sessionKeyOf(entry.sessionId);
      if (!sessionKey) {
        logger(`pending forward skipped ${entry.eventId}: sessionId ${entry.sessionId} 未映射到 sessionKey`);
        return;
      }
      const platform = platformOf(sessionKey);
      const adapter = platform
        ? adapters.find((item) => item.platform === platform && item.callbackBase)
        : null;
      if (!adapter) {
        logger(`pending forward skipped ${entry.eventId}: 无 callbackBase 的 ${platform ?? '未知'} 适配器`);
        return;
      }
      const translated = toAction(entry);
      if (!translated) {
        logger(`pending forward skipped ${entry.eventId}: 条目缺少可转发内容（kind=${entry.kind}）`);
        return;
      }
      const result = await deliver({
        adapter,
        action: translated.action,
        entry: { kind: 'write' },
        ctx: {
          sessionKey,
          payload: translated.payload,
          idempotencyKey: `pending:${entry.eventId}`,
        },
        timeoutMs,
      });
      if (result.ok) {
        delivered = true;
        logger(`pending forwarded ${translated.action} ${entry.eventId} -> ${sessionKey}`);
      } else {
        retryable = true;
        logger(`pending forward failed ${translated.action} ${entry.eventId}: ${result.code} ${result.message ?? ''}`);
      }
    } catch (error) {
      retryable = true;
      logger(`pending forward error ${entry?.eventId ?? 'unknown'}: ${error?.message ?? error}`);
    } finally {
      inflight.delete(entry.eventId);
    }
    if (delivered) {
      forwarded.add(entry.eventId);
      while (forwarded.size > 500) forwarded.delete(forwarded.keys().next().value);
      attempts.delete(entry.eventId);
    } else if (retryable) {
      scheduleRetry(entry);
    }
  }

  return {
    /** dsh-gateway onPending 出口：异步触发、绝不抛（事件帧处理不被阻塞）。 */
    forward(entry) { void forward(entry); },
    /** 关停：清掉重试定时器（否则进程退出前还会再发一次）。 */
    close() {
      closed = true;
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
      inflight.clear();
    },
    stats() {
      return {
        mode: 'on',
        forwardedTracked: forwarded.size,
        inflight: inflight.size,
        retryScheduled: retryTimers.size,
      };
    },
  };
}
