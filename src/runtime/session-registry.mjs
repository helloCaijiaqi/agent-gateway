/**
 * 会话注册表：(platform, kind, conversationId) → DSH sessionId 的唯一权威。
 *
 * preset 选择（2026-11-16 起由**适配器登记声明**决定，registration.presets）：
 *   - 适配器声明了该平台的 preset 且 DSH 清单里有 → 用它。
 *   - 声明了但未安装 → 回退 DSH 内置 `minimal`。**绝不回退 `standard`**：
 *     standard 带 bash/文件读写，挂到群聊会话等于把本地工具暴露给群里任何人；
 *     minimal 没有这些能力，最坏情况只是「QQ 里出现一个不认识 QQ 的助手」。
 *   - 未声明（或连 minimal 都没有）→ fail-closed 拒绝建会话，
 *     而不是随便挑一个带本地工具的预设。
 *   - 回退不是静默的：logger 打 `preset fallback:`，会话记录带 `presetFallback`。
 *
 * 另一条 fail-closed 规则：DSH 侧会话已不存在（selectModel 返回 not-found）→
 * 退役本地映射并在本次调用内重建，否则每条消息都会对着幽灵会话重试。
 *
 * 状态持久化到 state/gateway/sessions.json：网关重启不能丢会话映射，
 * 否则每个灰度会话都会被重建一份（token 成本 + GUI 里一排重复会话）。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * preset 探测的重试间隔（毫秒）。
 *
 * 为什么需要：DSH 重启后 3080 端口先监听、RPC 鉴权与路由后熟，这段窗口里
 * `agentPresets.list` 会返回 401/纯文本 `unauthorized`（→ JSON 解析失败）。
 * 实测一条入站消息正好落在窗口里就被 fail-closed 丢掉了（2026-11-16 17:26）。
 * 两次重试 ≈ 1.6s，足够跨过这个窗口，又不会让真下线的 DSH 拖住太久。
 */
export const PRESET_PROBE_RETRY_DELAYS_MS = Object.freeze([400, 1200]);

// 回退目标常量在 contracts（core/server 的回显与这里共用一份）；
// re-export 保持旧导入路径可用（main.mjs 从这里解构）。
import { FALLBACK_PRESET } from '../core/contracts.mjs';
export { FALLBACK_PRESET };

/**
 * 「DSH 还没就绪」类错误：鉴权未就绪、返回非 JSON、连接被拒/挂断、5xx。
 *
 * 这类错误重试几次会自愈；而 schema 不匹配、权限拒绝之类重试多少次都没用，
 * 必须立刻抛，别把一次配置错误拖成 2 秒的等待 + 同样的结论。
 */
export function isTransientProbeError(error) {
  const message = String(error?.message ?? error);
  return /unauthorized|not valid JSON|Unexpected token|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|\b50[234]\b/i
    .test(message);
}

/** 带错误码的 Error：turn-runner 的 classifyError 会原样采用。 */
function codedError(code, message, cause) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

/** 可中断的等待（signal abort 时立即返回，避免超时后又白等）。 */
function sleepFor(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (typeof timer?.unref === 'function') timer.unref();
    signal?.addEventListener?.('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * @param {object} options
 * @param {(consumerId: string|null) => (Record<string,string>|null)} [options.presetsFor]
 *        适配器声明的「平台→preset」查询器（来自登记文件 `presets` 字段）。
 *        没声明就不建会话——网关不猜平台该用哪个人设。
 */
export function createSessionRegistry({
  dsh, chat, file, logger = () => {}, now = Date.now, presetsFor = null,
} = {}) {
  /** @type {Map<string, {sessionId: string, generation: number, preset: string, createdAt: number}>} */
  const sessions = new Map();
  /** @type {Map<string, Promise<string>>} 进行中的创建，防并发重复建 */
  const creating = new Map();
  let presetIds = null; // null = 未探测
  let presetProbedAt = 0;
  // 清单缓存 TTL：在 DSH 侧装/换 preset 后，网关一分钟内即可感知，
  // 又不至于每个 turn 都打一次 agentPresets.list。
  const PRESET_CACHE_TTL_MS = 60_000;
  let generation = 0;

  if (file) load();

  // ---- tombstones（2026-11-23）：DSH 侧孤儿会话的最终清理队列 ----
  // 本地映射退役 ≠ DSH 侧会话消失：retireSession（清 inbox→cancel→archive）
  // 失败、手动编辑 sessions.json、历史 retireAll 都会留孤儿（follow 还挂着、
  // 坏格式历史还在）。墓碑文件（sessions.json.tombstones.json）记下待清的
  // sessionId，drainTombstones() 逐个退役，成功才移除——最终一致，不靠人工。

  const tombstoneFile = file ? `${file}.tombstones.json` : null;
  /** @type {Map<string, {sessionId: string, reason: string, at: number}>} */
  const tombstones = new Map();
  if (tombstoneFile) loadTombstones();

  function loadTombstones() {
    try {
      if (!fs.existsSync(tombstoneFile)) return;
      const parsed = JSON.parse(fs.readFileSync(tombstoneFile, 'utf8'));
      for (const item of parsed?.tombstones ?? []) {
        if (item && typeof item.sessionId === 'string') tombstones.set(item.sessionId, item);
      }
    } catch (error) {
      logger(`session-registry: tombstones 加载失败（按空队列启动）：${error?.message ?? error}`);
    }
  }

  function persistTombstones() {
    if (!tombstoneFile) return;
    const payload = { version: 1, tombstones: [...tombstones.values()] };
    const tmp = `${tombstoneFile}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(tombstoneFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmp, tombstoneFile);
    } catch (error) {
      logger(`session-registry: tombstones 落盘失败：${error?.message ?? error}`);
    }
  }

  function markTombstone(sessionId, reason = '') {
    if (!sessionId) return;
    tombstones.set(sessionId, { sessionId, reason: String(reason).slice(0, 120), at: now() });
    persistTombstones();
  }

  async function drainTombstones() {
    let drained = 0;
    for (const [sessionId] of tombstones) {
      try {
        await dsh.retireSession(sessionId);
        tombstones.delete(sessionId);
        persistTombstones();
        drained += 1;
        logger(`session-registry: tombstone drained — DSH 侧会话 ${sessionId} 已退役`);
      } catch (error) {
        logger(`session-registry: tombstone ${sessionId} 退役失败（保留重试）：${error?.message ?? error}`);
      }
    }
    return { drained, remaining: tombstones.size };
  }

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
    let lastError = null;
    for (let attempt = 0; attempt <= PRESET_PROBE_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        presetIds = await dsh.listPresets(signal);
        presetProbedAt = now();
        return presetIds;
      } catch (error) {
        lastError = error;
        // 不可自愈的错误立刻抛：重试只会把一次配置错误拖成两秒的等待。
        if (!isTransientProbeError(error)) {
          presetIds = null;
          throw codedError('E_PRESET_UNKNOWN',
            `无法确认 DSH preset 清单（fail-closed）：${error?.message ?? error}`, error);
        }
        const delay = PRESET_PROBE_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) break;
        logger(`preset probe retry ${attempt + 1}/${PRESET_PROBE_RETRY_DELAYS_MS.length}`
          + ` in ${delay}ms: ${error?.message ?? error}`);
        await sleepFor(delay, signal);
      }
    }
    // 重试用尽仍是「未就绪」类错误：探测失败 ≠ preset 不存在，置回 null 让下一个 turn 再试，
    // 但这一条要给出可操作的信息（重发即可），而不是一句笼统的 fail-closed。
    presetIds = null;
    throw codedError('E_DSH_NOT_READY',
      `DSH 未就绪，无法确认 preset 清单（已重试 ${PRESET_PROBE_RETRY_DELAYS_MS.length} 次）：`
      + `${lastError?.message ?? lastError}。请稍后重发这条消息。`, lastError);
  }

  async function applyModel(sessionId, signal) {
    // not-found 是终态信号：DSH 侧会话已不存在，本地映射必须退役重建。
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        // dsh-client.selectModel 不 unwrap（返回原始 RPC 信封）：result.ok=false
        // （如 session/model-unavailable——模型不在 DSH 清单）必须显式识别，
        // 否则会被误判为 'applied'，会话继续留在旧模型上无声跑空（2026-11-24 实测）。
        // reasoningEffort 空串 = 省略：部分模型（实测 wb2api/cn:hy4flash）不支持任何
        // 强度参数，传了直接 session/model-unavailable。
        const selectArgs = { provider: chat.provider, model: chat.model };
        if (chat.reasoningEffort) selectArgs.reasoningEffort = chat.reasoningEffort;
        const response = await dsh.selectModel(sessionId, selectArgs, signal);
        if (response?.result?.ok === false) {
          const { code, message, details } = response.result.error ?? {};
          logger(`applyModel rejected by DSH: session=${sessionId} provider=${chat.provider}`
            + ` model=${chat.model} code=${code ?? '?'} details=${JSON.stringify(details ?? {})} ${message ?? ''}；`
            + '本轮继续用 DSH 会话现有模型，请检查模型是否在 DSH 清单（cordis.patch.yml providers.models）');
          return 'failed';
        }
        return 'applied';
      } catch (error) {
        if (/not[- ]?found/i.test(String(error?.code ?? '')) || /not[- ]?found/i.test(String(error?.message ?? ''))) {
          return 'not-found';
        }
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1000));
        else {
          // 2026-11-24 根因修复：曾因 provider 名不在 DSH 目录（deepseek-official vs
          // deepseek-account）连续 selectModel 失败被无声吞掉，会话悄悄留在 DSH 默认
          // 模型上跑（zhipu-chat 429 却查不到原因）。重试耗尽必须显式告警留痕。
          logger(`applyModel failed: session=${sessionId} provider=${chat.provider} model=${chat.model}`
            + `（重试 2 次）error=${error?.code ?? ''} ${error?.message ?? error}；`
            + '本轮继续用 DSH 会话现有模型，请检查 provider/model 是否在 DSH modelCatalog 内');
        }
      }
    }
    return 'failed';
  }

  /** 会话键的结构知识：`<platform>:<consumerId?>:<kind>:<id>`——只是键格式，不是平台映射表。 */
  function keyParts(sessionKey) {
    const parts = String(sessionKey ?? '').split(':');
    return { platform: parts[0] || null, consumerId: parts.length === 4 ? parts[1] : null };
  }

  /**
   * 从适配器声明里取 preset（唯一来源，2026-11-16 起）。
   * @returns {{platform: string|null, preset: string|null, declared: boolean}}
   */
  function declaredPreset(sessionKey) {
    const { platform, consumerId } = keyParts(sessionKey);
    const table = typeof presetsFor === 'function' ? presetsFor({ platform, consumerId }) : null;
    const preset = table && typeof table[platform] === 'string' ? table[platform] : null;
    return { platform, preset, declared: Boolean(preset) };
  }

  async function create(sessionKey, signal) {
    const { platform, preset: declared, declared: hasDeclaration } = declaredPreset(sessionKey);
    // 未声明也照建（2026-11-17 拍板）：「没有预设就用 DSH 默认的最小预设」。
    // minimal 无人格、无本地工具，最坏情况只是「群里出现一个不认识 QQ 的助手」，
    // 比拒聊（旧 E_PRESET_UNDECLARED）友好；想换人设随时在控制台补声明。
    const ids = await ensurePresetAllowed(signal);
    // minimal 是一切回退的底座：它都不在清单里说明 DSH 环境坏了，照建只会
    // 在 createSession 时炸出更难懂的报错。
    if (!ids.includes(FALLBACK_PRESET)) {
      throw codedError('E_PRESET_MISSING',
        `回退 preset "${FALLBACK_PRESET}" 不在 DSH 清单（${ids.join(', ') || '未知'}）；`
        + '请先在 DSH 侧装好内置预设后重启 DSH');
    }
    let preset;
    let fallback = false;
    let reason;
    if (hasDeclaration) {
      preset = declared;
      reason = 'declared';
      if (!ids.includes(declared)) {
        preset = FALLBACK_PRESET;
        fallback = true;
        reason = 'not-installed';
        logger(`preset fallback: ${sessionKey} platform=${platform} reason=not-installed`
          + ` 期望=${declared} 实际=${preset}（该预设无人格/无本地工具；装好预设或重启 DSH 后自动恢复）`);
      }
    } else {
      preset = FALLBACK_PRESET;
      reason = 'default';
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
      sessionId, generation, preset, presetDeclared: hasDeclaration ? declared : null,
      presetFallback: fallback, presetReason: reason, createdAt: now(),
    });
    persist();
    logger(`session created: ${sessionKey} -> ${sessionId}`
      + ` (preset=${preset}${fallback ? ', fallback' : ''}, model=${chat.provider}/${chat.model})`);
    return sessionId;
  }

  return {
    async getOrCreate(sessionKey, signal) {
      const existing = sessions.get(sessionKey);
      if (existing) {
        // 声明变更（控制台改了该消费端的 preset）→ 旧会话绑着旧人设，直接退役
        // 重建。比较的是「声明值」而非最终绑定：声明 qq-chat 但未安装时的回退
        // 会话（preset=minimal）不能每轮都重建，否则限流会被重建风暴吃光。
        const { preset: declaredNow, declared: hasDeclaration } = declaredPreset(sessionKey);
        const declaredNowValue = hasDeclaration ? declaredNow : null;
        if ((existing.presetDeclared ?? null) !== declaredNowValue) {
          logger(`session ${sessionKey} 的 preset 声明已变更`
            + `（${existing.presetDeclared ?? '(未声明)'} -> ${declaredNowValue ?? '(未声明)'}），退役重建`);
          void this.retire(sessionKey, "preset-decl-changed");
          return this.getOrCreate(sessionKey, signal);
        }
        // 预设被移除/改名时（qq-chat-v2 → qq-chat 就是这种情况），DSH 侧旧会话仍绑着
        // 已不存在的 preset，resume 会直接失败（实测报 Unknown agent preset）。
        // 这里先比对清单：绑定的 preset 不在清单里就退役重建，而不是每轮都失败。
        if (existing.preset) {
          const ids = await ensurePresetAllowed(signal);
          if (!ids.includes(existing.preset)) {
            logger(`session ${sessionKey} 绑定的 preset "${existing.preset}" 已不在 DSH 清单，退役重建`);
            void this.retire(sessionKey, "preset-removed-from-dsh");
            return this.getOrCreate(sessionKey, signal);
          }
        }
        const applied = await applyModel(existing.sessionId, signal);
        if (applied === 'not-found') {
          logger(`session ${sessionKey} 已在 DSH 侧消失，退役重建`);
          sessions.delete(sessionKey);
          persist();
        } else {
          // 必须重新 follow：进程重启后 registry 从磁盘恢复会话映射，但 mux 的
          // 事件订阅是进程内的（_desiredFollows 为空）。不复follow 就没有
          // session/follow 流 → 回合在 DSH 里跑完也发不出结束帧 →
          // awaitTurn 静默等到超时（实测：DSH 会话文件已写入，网关日志一片空白）。
          // follow 幂等：已在 _desiredFollows 里时不会重复开流。
          dsh.follow(existing.sessionId);
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

    /**
     * 退役单个会话（2026-11-23 升级）：除删本地映射外，同步清理 DSH 侧——
     * retireSession（清 pending inbox + cancel + archiveSession + forget）。
     * 不清理的话旧 DSH 会话成孤儿（follow 还挂着、坏格式历史还在），污染
     * 自愈场景下尤其必须（format v4 校验失败的会话要整体废弃）。
     * DSH 侧清理失败不阻断退役（孤儿可容忍，日志留痕）。
     * @returns {Promise<{sessionId: string|null, dshRetired: boolean}>}
     */
    async retire(sessionKey, reason = '') {
      const record = sessions.get(sessionKey);
      if (!record) return { sessionId: null, dshRetired: false };
      sessions.delete(sessionKey);
      persist();
      let dshRetired = false;
      if (record.sessionId) {
        try {
          await dsh.retireSession(record.sessionId);
          dshRetired = true;
        } catch (error) {
          logger(`session-registry: ${sessionKey} 的 DSH 侧会话 ${record.sessionId} 归档失败（入墓碑重试）：${error?.message ?? error}`);
        }
      }
      if (dshRetired) {
        tombstones.delete(record.sessionId);
        persistTombstones();
      } else {
        markTombstone(record.sessionId, reason || 'retire 失败重试');
      }
      logger(`session-registry: retired ${sessionKey} (${record.sessionId})${reason ? ` — ${reason}` : ''}${dshRetired ? ' + DSH 侧已清理' : ' + DSH 侧入墓碑待清'}`);
      return { sessionId: record.sessionId, dshRetired };
    },

    /**
     * 全部退役（2026-11-20 角色卡切换联动）：清空整张会话映射并落盘——
     * 下一个回合每个 sessionKey 都会开全新 DSH 会话。切角色时 system 内容
     * 突变，旧会话历史与新人格矛盾（精神分裂），必须整体重建。
     * @returns {number} 退役的会话数（0 = 本来就没有活跃映射）。
     */
    retireAll() {
      const count = sessions.size;
      if (count > 0) {
        for (const [key, record] of sessions) {
          // DSH 侧逐个清理（fire-and-forget；失败入墓碑，启动 drain 兜底）
          markTombstone(record.sessionId, `retireAll(${key})`);
          dsh.retireSession(record.sessionId)
            .then(() => { tombstones.delete(record.sessionId); persistTombstones(); })
            .catch((error) => logger(`session-registry: retireAll 的 DSH 清理 ${record.sessionId} 失败（墓碑保留）：${error?.message ?? error}`));
        }
        sessions.clear();
        persist();
        logger(`session-registry: retired all ${count} session(s) + DSH 侧墓碑待清`);
      }
      return count;
    },

    /**
     * 退役未知映射关系的孤儿会话（2026-11-23）：直接按 sessionId 入墓碑并
     * 立即 drain——供控制台/运维清理 DSH 侧没有本地映射的会话（手动编辑
     * sessions.json、历史版本遗留的孤儿）。
     */
    async retireOrphan(sessionId, reason = 'orphan') {
      if (!sessionId || typeof sessionId !== 'string') {
        return { drained: 0, remaining: tombstones.size };
      }
      markTombstone(sessionId, reason);
      return drainTombstones();
    },

    async drainTombstones() {
      return drainTombstones();
    },

    tombstoneCount() { return tombstones.size; },

    get(sessionKey) { return sessions.get(sessionKey) ?? null; },
    get size() { return sessions.size; },
    get sessionIdSet() { return new Set([...sessions.values()].map((r) => r.sessionId)); },

    /** 控制台会话列表（docs/console/dsh-sessions/PLAN.md）：快照，不含活跃度。 */
    list() {
      return [...sessions.entries()].map(([key, record]) => ({
        sessionKey: key,
        sessionId: record.sessionId,
        preset: record.preset,
        // 回退标记：控制台一眼能看出「这条会话没跑人设」，排障不用翻日志。
        presetFallback: record.presetFallback === true,
        presetReason: record.presetReason ?? null,
        // 声明值（null=消费端没声明，走 minimal 默认）；控制台排障用。
        presetDeclared: record.presetDeclared ?? null,
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
