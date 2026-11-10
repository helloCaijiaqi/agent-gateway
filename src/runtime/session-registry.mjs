/**
 * 会话注册表：(platform, kind, conversationId) → DSH sessionId 的唯一权威。
 *
 * fail-closed 规则（从 bridge 的教训继承，见 RULES「无本地工具」）：
 *   - preset 不在 DSH 可用清单时**拒绝建会话**，绝不回退 DSH 默认 preset——
 *     默认 preset（standard）带 bash/文件读写，挂到群聊会话等于把本地工具
 *     暴露给群里任何人。
 *   - DSH 侧会话已不存在（selectModel 返回 not-found）→ 退役本地映射并在
 *     本次调用内重建，否则每条消息都会对着幽灵会话重试。
 *
 * 状态持久化到 state/gateway/sessions.json：网关重启不能丢会话映射，
 * 否则每个灰度会话都会被重建一份（token 成本 + GUI 里一排重复会话）。
 */
import fs from 'node:fs';
import path from 'node:path';

export function createSessionRegistry({ dsh, chat, file, logger = () => {}, now = Date.now } = {}) {
  /** @type {Map<string, {sessionId: string, generation: number, preset: string, createdAt: number}>} */
  const sessions = new Map();
  /** @type {Map<string, Promise<string>>} 进行中的创建，防并发重复建 */
  const creating = new Map();
  let presetIds = null; // null = 未探测
  let presetProbedAt = 0;
  // 清单缓存 TTL：setup-dsh.mjs 装完 preset 后，网关一分钟内即可感知，
  // 又不至于每个 turn 都打一次 agentPresets.list。
  const PRESET_CACHE_TTL_MS = 60_000;
  let generation = 0;

  if (file) load();

  function load() {
    try {
      if (!fs.existsSync(file)) return;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [key, record] of Object.entries(parsed?.sessions ?? {})) {
        if (record && typeof record.sessionId === 'string') sessions.set(key, record);
      }
      generation = Number(parsed?.generation ?? 0);
    } catch (error) {
      logger(`session-registry: failed to load ${file}: ${error?.message ?? error}`);
    }
  }

  function persist() {
    if (!file) return;
    const payload = {
      version: 1,
      generation,
      sessions: Object.fromEntries(sessions),
    };
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) {
      logger(`session-registry: failed to persist ${file}: ${error?.message ?? error}`);
    }
  }

  async function ensurePresetAllowed(signal) {
    if (presetIds !== null && now() - presetProbedAt < PRESET_CACHE_TTL_MS) return presetIds;
    try {
      presetIds = await dsh.listPresets(signal);
      presetProbedAt = now();
    } catch (error) {
      // 探测失败 ≠ preset 不存在：DSH 暂时不可用时不该永久拒绝，
      // 置回 null 让下一次 turn 再试。
      presetIds = null;
      throw new Error(`无法确认 DSH preset 清单（fail-closed）：${error?.message ?? error}`);
    }
    return presetIds;
  }

  async function applyModel(sessionId, signal) {
    // not-found 是终态信号：DSH 侧会话已不存在，本地映射必须退役重建。
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await dsh.selectModel(sessionId, {
          provider: chat.provider, model: chat.model, reasoningEffort: chat.reasoningEffort,
        }, signal);
        return 'applied';
      } catch (error) {
        if (/not[- ]?found/i.test(String(error?.code ?? '')) || /not[- ]?found/i.test(String(error?.message ?? ''))) {
          return 'not-found';
        }
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1000));
      }
    }
    return 'failed';
  }

  async function create(sessionKey, signal) {
    const preset = chat.preset;
    const ids = await ensurePresetAllowed(signal);
    if (!ids.includes(preset)) {
      throw new Error(
        `拒绝为 ${sessionKey} 创建会话：preset "${preset}" 不在 DSH 可用清单（${ids.join(', ') || '未知'}）。`
        + '回退默认 preset 会把本地工具暴露给群聊；请先运行 qq-bridge 的 node scripts/setup-dsh.mjs。',
      );
    }
    const workspaceId = await dsh.ensureWorkspace(chat.workspaceDir, signal);
    const sessionId = await dsh.createSession({ workspaceId, agentPreset: preset }, signal);
    dsh.follow(sessionId);
    const applied = await applyModel(sessionId, signal);
    if (applied === 'not-found') {
      // 竞态：刚建好就被外部归档。当作失败抛出，调用方决定是否重试。
      dsh.forget(sessionId);
      throw new Error(`新会话 ${sessionId} 在 DSH 侧立即失联（not-found）`);
    }
    generation += 1;
    sessions.set(sessionKey, {
      sessionId, generation, preset, createdAt: now(),
    });
    persist();
    logger(`session created: ${sessionKey} -> ${sessionId} (preset=${preset}, model=${chat.provider}/${chat.model})`);
    return sessionId;
  }

  return {
    async getOrCreate(sessionKey, signal) {
      const existing = sessions.get(sessionKey);
      if (existing) {
        const applied = await applyModel(existing.sessionId, signal);
        if (applied === 'not-found') {
          logger(`session ${sessionKey} 已在 DSH 侧消失，退役重建`);
          sessions.delete(sessionKey);
          persist();
        } else {
          return existing.sessionId;
        }
      }
      const pending = creating.get(sessionKey);
      if (pending) return pending;
      const promise = create(sessionKey, signal).finally(() => {
        if (creating.get(sessionKey) === promise) creating.delete(sessionKey);
      });
      creating.set(sessionKey, promise);
      return promise;
    },

    retire(sessionKey) {
      const record = sessions.get(sessionKey);
      if (!record) return null;
      sessions.delete(sessionKey);
      persist();
      return record.sessionId;
    },

    get(sessionKey) { return sessions.get(sessionKey) ?? null; },
    get size() { return sessions.size; },
    get sessionIdSet() { return new Set([...sessions.values()].map((r) => r.sessionId)); },

    /** 控制台会话列表（docs/console/dsh-sessions/PLAN.md）：快照，不含活跃度。 */
    list() {
      return [...sessions.entries()].map(([key, record]) => ({
        sessionKey: key,
        sessionId: record.sessionId,
        preset: record.preset,
        createdAt: record.createdAt,
        generation: record.generation,
      }));
    },

    /**
     * sessionId → sessionKey 反查（控制台 pending 查看用，docs/console/dsh-pending）。
     * 每次线性扫描即可：条目量 = 注册会话数（几十量级），不值得维护反向索引。
     * 无映射返回 null（调用方标 unmapped，绝不猜）。
     */
    sessionKeyOf(sessionId) {
      if (typeof sessionId !== 'string' || !sessionId) return null;
      for (const [key, record] of sessions) {
        if (record.sessionId === sessionId) return key;
      }
      return null;
    },
  };
}
