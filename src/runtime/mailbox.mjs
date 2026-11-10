/**
 * 会话状态枢纽（P4）：邮箱游标、唤醒状态、agentToken。
 *
 * 设计文档 §4 状态归属表里「传输状态」与「策略/配置」两类的落点。判据是
 * 「丢了能不能重建」：
 *   - lastReadThroughSeq / lastUnreadSeq / agentToken：不可重建，必须落盘；
 *   - wakeConfig：配置即真相，落盘后重启不丢；
 *   - unread 消息体、recentMessages：留在适配器（可从平台历史重建，且网关
 *     不需要消息内容就能回答「有多少未读」——游标差值足够）。
 *
 * P4 是镜像期：适配器仍在本地 social-v2.json 写全量状态（回滚 = 关开关），
 * 这里持久化的是镜像副本。语义与 bridge.js 对齐的地方都标了出处，两侧漂移
 * 由互认测试钉住。
 */
import { randomBytes } from 'node:crypto';
import { createStateStore } from '../core/state-store.mjs';

/** 与 bridge.js defaultWakeConfigV2 对齐的出厂配置（bridge.js:8362）。 */
export function defaultWakeConfig(now = Date.now) {
  return {
    mode: 'diving',
    infinite: true,
    sleepUntil: null,
    batchWindowMs: 8000,
    triggers: {
      atMention: true,
      nameMention: true,
      speakerIds: [],
      keywords: [],
      question: true,
      poke: true,
      anyMessage: false,
      probability: 0.05,
    },
    lastWakeAt: 0,
    wakeCount: 0,
    noActionCount: 0,
    confirmedAt: now(),
    confirmedBy: 'default',
  };
}

const WAKE_MODES = ['diving', 'active'];
const TRIGGER_KEYS = ['atMention', 'nameMention', 'speakerIds', 'keywords', 'question', 'poke', 'anyMessage', 'probability'];

/** 只保留已知键与已知类型的浅归一化（与 bridge 的 pickWakeTriggersV2 同思路）。 */
function normalizeWakeConfig(input, fallback) {
  const base = fallback ?? defaultWakeConfig();
  const triggersIn = input?.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers)
    ? input.triggers : {};
  const triggers = {};
  for (const key of TRIGGER_KEYS) {
    if (triggersIn[key] === undefined) continue;
    if (key === 'speakerIds' || key === 'keywords') {
      triggers[key] = Array.isArray(triggersIn[key])
        ? triggersIn[key].map((v) => String(v ?? '').slice(0, 100)).filter(Boolean).slice(0, 100)
        : [];
      continue;
    }
    if (typeof triggersIn[key] === 'boolean') { triggers[key] = triggersIn[key]; continue; }
    if (key === 'probability' && typeof triggersIn[key] === 'number' && triggersIn[key] >= 0 && triggersIn[key] <= 1) {
      triggers[key] = triggersIn[key];
    }
  }
  return {
    mode: WAKE_MODES.includes(input?.mode) ? input.mode : base.mode,
    infinite: typeof input?.infinite === 'boolean' ? input.infinite : base.infinite,
    sleepUntil: input?.sleepUntil === null || typeof input?.sleepUntil === 'string' ? input.sleepUntil : null,
    batchWindowMs: Number.isSafeInteger(input?.batchWindowMs) && input.batchWindowMs >= 0
      ? input.batchWindowMs : base.batchWindowMs,
    triggers: { ...base.triggers, ...triggers },
    lastWakeAt: Number.isSafeInteger(input?.lastWakeAt) ? input.lastWakeAt : (base.lastWakeAt ?? 0),
    wakeCount: Number.isSafeInteger(input?.wakeCount) ? input.wakeCount : (base.wakeCount ?? 0),
    noActionCount: Number.isSafeInteger(input?.noActionCount) ? input.noActionCount : (base.noActionCount ?? 0),
    confirmedAt: Number.isSafeInteger(input?.confirmedAt) ? input.confirmedAt : (base.confirmedAt ?? 0),
    confirmedBy: typeof input?.confirmedBy === 'string' ? input.confirmedBy : (base.confirmedBy ?? 'default'),
  };
}

export function createMailbox({
  file,
  logger = () => {},
  now = Date.now,
} = {}) {
  const store = createStateStore({ file, logger });

  function ensure(sessionKey) {
    let state = store.get(sessionKey);
    if (!state) {
      state = {
        agentToken: randomBytes(16).toString('hex'),
        lastUnreadSeq: 0,
        readThroughSeq: 0,
        wakeConfig: defaultWakeConfig(now),
        lastWakeReason: '',
        lastAiReplyAt: 0,
        lastInboundAt: 0,
        lastMessageId: null,
        lastSenderId: null,
        // 沉睡前观察三字段：新消息/收尾会重置（语义同 bridge.js:10077）。
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,
        preSleepWaitAccumMs: 0,
        updatedAt: now(),
      };
      store.put(sessionKey, state);
    }
    return state;
  }

  return {
    /** 入站游标：seq 单调推进；新消息使「沉睡前已等待/已观察」作废。 */
    recordInbound({ sessionKey, seq, messageId = null, senderId = null }) {
      const state = ensure(sessionKey);
      // 乱序镜像（重试、并发）不回退游标，也不覆盖「最新一条」的记忆——
      // lastMessageId/lastSenderId 只随游标推进更新，否则会指向旧消息。
      const advanced = Number.isSafeInteger(seq) && seq > state.lastUnreadSeq;
      if (advanced) {
        state.lastUnreadSeq = seq;
        if (messageId != null) state.lastMessageId = String(messageId);
        if (senderId != null) state.lastSenderId = String(senderId);
      }
      state.lastInboundAt = now();
      state.preSleepWaitSatisfiedAt = 0;
      state.preSleepWaitObservedAt = 0;
      state.preSleepWaitAccumMs = 0;
      state.updatedAt = now();
      store.put(sessionKey, state);
      return this.snapshot(sessionKey);
    },

    /**
     * 已读水位：单调 max，并夹到 lastUnreadSeq 内（防止镜像乱序把水位推到
     * 没收到过的消息上——本地 bridge 依赖内存 modelSeenSeqs 兜底，网关这份
     * 必须自己守住不变量 unreadCount >= 0）。throughSeq 缺省 = 清空全部未读
     * （legacy/console 语义，同 bridge requestedReadThroughSeqV2 的无水位分支）。
     */
    acknowledge({ sessionKey, throughSeq = null, source = 'adapter', reason = '' }) {
      const state = ensure(sessionKey);
      const requested = throughSeq === null || throughSeq === undefined
        ? state.lastUnreadSeq
        : Math.min(Number(throughSeq), state.lastUnreadSeq);
      if (!Number.isSafeInteger(requested) || requested < 0) {
        return { ok: false, error: { code: 'E_SCHEMA', message: 'throughSeq must be a non-negative integer' } };
      }
      const previous = state.readThroughSeq;
      state.readThroughSeq = Math.max(previous, requested);
      state.updatedAt = now();
      store.put(sessionKey, state);
      return {
        ok: true,
        data: {
          sessionKey,
          readThroughSeq: state.readThroughSeq,
          lastUnreadSeq: state.lastUnreadSeq,
          markedCount: Math.max(0, state.readThroughSeq - Math.max(previous, 0)),
          advanced: state.readThroughSeq > previous,
          source,
          reason,
        },
      };
    },

    /** 唤醒配置：适配器归一化后镜像全量；confirmedBy/At 随写更新。 */
    setWakeConfig({ sessionKey, wakeConfig, confirmedBy, throughSeq = null, source = 'adapter' }) {
      const state = ensure(sessionKey);
      state.wakeConfig = normalizeWakeConfig(wakeConfig, state.wakeConfig);
      if (confirmedBy) state.wakeConfig.confirmedBy = confirmedBy;
      // 适配器镜像的是完整配置（含它自己的 confirmedAt）：能带就保真。否则每次
      // 镜像都会把「最后一次确认时间」刷成「最后一次同步时间」，P5 接管后读不到真实值。
      state.wakeConfig.confirmedAt = Number.isSafeInteger(wakeConfig?.confirmedAt)
        ? wakeConfig.confirmedAt
        : now();
      // 成功收尾会重置沉睡前观察（语义同 bridge wake-config 成功路径）。
      state.preSleepWaitSatisfiedAt = 0;
      state.preSleepWaitObservedAt = 0;
      state.preSleepWaitAccumMs = 0;
      store.put(sessionKey, state);
      if (throughSeq !== null && throughSeq !== undefined) {
        return this.acknowledge({ sessionKey, throughSeq, source, reason: 'set_wake_config' });
      }
      return { ok: true, data: this.snapshot(sessionKey) };
    },

    setAgentToken({ sessionKey, agentToken }) {
      const state = ensure(sessionKey);
      state.agentToken = String(agentToken);
      state.updatedAt = now();
      store.put(sessionKey, state);
      return { ok: true, data: this.snapshot(sessionKey) };
    },

    /**
     * 删除一个会话的全部镜像状态（控制台重置 / 会话退役）。
     *
     * 必须有这条路：适配器清空本地会话后，网关若留着旧水位与旧 agentToken，
     * 控制台的 state 端点会把**已重建的新会话**覆盖成「未读 7 条」的假象，
     * 后续接管也会拿到已作废的令牌。返回 data.removed 让适配器日志可核对。
     */
    reset({ sessionKey }) {
      const removed = store.delete(sessionKey);
      return { ok: true, data: { sessionKey, removed } };
    },

    /** 只读快照（控制台/运维）。unreadCount = 游标差值，不是消息条数缓存。 */
    snapshot(sessionKey) {
      const state = store.get(sessionKey);
      if (!state) {
        return { sessionKey, exists: false, unreadCount: 0, readThroughSeq: 0, lastUnreadSeq: 0 };
      }
      return {
        sessionKey,
        exists: true,
        unreadCount: Math.max(0, state.lastUnreadSeq - state.readThroughSeq),
        readThroughSeq: state.readThroughSeq,
        lastUnreadSeq: state.lastUnreadSeq,
        agentToken: state.agentToken,
        wakeConfig: state.wakeConfig,
        lastWakeReason: state.lastWakeReason,
        lastAiReplyAt: state.lastAiReplyAt,
        lastInboundAt: state.lastInboundAt,
        lastMessageId: state.lastMessageId,
        lastSenderId: state.lastSenderId,
        preSleepWaitSatisfiedAt: state.preSleepWaitSatisfiedAt,
        preSleepWaitObservedAt: state.preSleepWaitObservedAt,
        preSleepWaitAccumMs: state.preSleepWaitAccumMs,
        updatedAt: state.updatedAt,
      };
    },

    /** 控制台会话列表：只给展示需要的投影。 */
    list() {
      return store.keys().sort().map((sessionKey) => {
        const snap = this.snapshot(sessionKey);
        return {
          sessionKey,
          unreadCount: snap.unreadCount,
          readThroughSeq: snap.readThroughSeq,
          lastUnreadSeq: snap.lastUnreadSeq,
          wakeMode: snap.wakeConfig?.mode ?? null,
          infinite: snap.wakeConfig?.infinite ?? null,
          sleepUntil: snap.wakeConfig?.sleepUntil ?? null,
          confirmedBy: snap.wakeConfig?.confirmedBy ?? null,
          confirmedAt: snap.wakeConfig?.confirmedAt ?? 0,
          lastInboundAt: snap.lastInboundAt,
          lastAiReplyAt: snap.lastAiReplyAt,
          updatedAt: snap.updatedAt,
        };
      });
    },

    /** P4 state/update 的统一入口（server 路由转发到这里）。 */
    update(parsed) {
      switch (parsed.action) {
        case 'inbound':
          return { ok: true, data: this.recordInbound(parsed) };
        case 'mark_read':
          return this.acknowledge({ sessionKey: parsed.sessionKey, throughSeq: parsed.throughSeq, source: parsed.source, reason: parsed.reason });
        case 'set_wake_config':
          return this.setWakeConfig({
            sessionKey: parsed.sessionKey,
            wakeConfig: parsed.wakeConfig,
            confirmedBy: parsed.confirmedBy,
            throughSeq: parsed.throughSeq ?? null,
            source: parsed.source,
          });
        case 'agent_token':
          return this.setAgentToken({ sessionKey: parsed.sessionKey, agentToken: parsed.agentToken });
        case 'reset':
          return this.reset({ sessionKey: parsed.sessionKey });
        default:
          return { ok: false, error: { code: 'E_UNSUPPORTED', message: `unknown action: ${parsed.action}` } };
      }
    },

    stats() { return { sessions: store.size }; },
    flush() { store.flush(); },
    close() { store.close(); },
  };
}
