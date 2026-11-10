/**
 * 每会话串行的 prompt 队列。
 *
 * 为什么必须串行：DSH 会话内并发 prompt 会把两条消息塞进同一个 turn，
 * 模型看到的上下文变成交错的半句话。QQ 侧的唤醒合批发生在适配器（上游），
 * 这里只保证「同一会话同时只有一个 turn 在跑」。
 *
 * 合并语义：同一会话的**排队中**（未开始执行）任务会被后到的替换——
 * 桥接的合批窗口可能漏发补投，两条排队任务几乎总是该合并成一次 turn。
 * 正在执行的任务不受影响（那要靠 DSH 侧 cancel，属于 reset 语义）。
 */
export function createPromptQueue({ maxPerKey = 50, logger = () => {} } = {}) {
  /** @type {Map<string, {running: boolean, pending: Array}>} */
  const lanes = new Map();

  function laneOf(key) {
    let lane = lanes.get(key);
    if (!lane) {
      lane = { running: false, pending: [] };
      lanes.set(key, lane);
    }
    return lane;
  }

  function drain(key, lane) {
    if (lane.running || lane.pending.length === 0) return;
    const job = lane.pending.shift();
    lane.running = true;
    Promise.resolve()
      .then(job.run)
      .then(
        (value) => job.resolve(value),
        (error) => job.reject(error),
      )
      .finally(() => {
        lane.running = false;
        drain(key, lane);
      });
  }

  return {
    /**
     * @returns {Promise<{coalesced?: boolean}>} job 的完成信号
     */
    enqueue(key, run, { coalesce = true } = {}) {
      const lane = laneOf(key);
      // 后到替换先到：只对还没开始的排队任务生效。
      if (coalesce && lane.pending.length > 0) {
        const superseded = lane.pending[lane.pending.length - 1];
        superseded.resolve({ coalesced: true });
        lane.pending.length = 0;
      }
      if (lane.pending.length >= maxPerKey) {
        const dropped = lane.pending.shift();
        dropped.resolve({ coalesced: false, dropped: true });
        logger(`prompt queue overflow for ${key}: dropped oldest`);
      }
      return new Promise((resolve, reject) => {
        lane.pending.push({ run, resolve, reject });
        drain(key, lane);
      });
    },

    get pendingCount() {
      let total = 0;
      for (const lane of lanes.values()) total += lane.pending.length;
      return total;
    },

    get runningCount() {
      let total = 0;
      for (const lane of lanes.values()) if (lane.running) total += 1;
      return total;
    },
  };
}
