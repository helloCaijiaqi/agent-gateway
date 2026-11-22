/**
 * V2 统一改造 §6：会话缓冲管理器（runtime）——「会话缓冲上移网关」的唯一实现。
 *
 * 取代旧的逐条 raw 沉淀调度器（service.call step=ingest 已随 tool.call 统一
 * 下线）。新模型（设计不得偏离）：
 *  - 缓冲在网关：sessionKey → 消息记录数组，逐条追加持久化到
 *    `state/gateway/session-buffer/<encodedKey>.jsonl`（首行 meta 写明 sessionKey）。
 *    网关崩溃后重启加载残留缓冲并恢复空闲定时器——兜底由网关完成，记忆侧不做 TTL。
 *  - 落地时机完全由网关裁决：空闲超时（idleMs，默认 1h）/ 触顶分段
 *    （maxMessages/maxChars，partial:true）/ 进程关停补发（flushAll）。
 *    落地 = tool.call `chat_memory_save`（整段缓冲 payload，args 由 main.mjs 注入
 *    的 deliver 构造——本层不知道 memory-mcp 存在）。
 *  - 失败退避重试：save 失败缓冲保留（内存 + 磁盘都不清），指数退避封顶 10min，
 *    无限重试（落库是旁路，宁重试不丢；真正的幂等裁决在服务端 raw UNIQUE 约束）。
 *  - 双向观察：入站（server.handleInbound）+ 出站（tool-host 发送成功点）。
 *    observe* 永不抛错、永不 await 主链路。
 *
 * 消息记录（save args 的 messages 条目）：
 *   { msgId, senderId?, name?, nickname?, card?, text, createdAt?, kind? }
 * 入站来自 envelope.message.sender（names = {nickname, card}，桥接契约 V2 新增；
 * name 保留兼容 = card||nickname）；出站为机器人自己发的文本（无 senderId）。
 *
 * 文件即缓冲事实源：appendFileSync 逐条追加（O(1)/条，crash-safe 到行粒度——
 * 崩溃撕裂的最后一行在恢复时跳过并计数）；save 成功后用仍在缓冲的记录整文件
 * 重写（临时文件 + rename 原子替换，触顶分段期间新观察的追加不丢）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const RETRY_BACKOFF_CAP_MS = 10 * 60_000;

/** sessionKey（如 `qq:group:123`）→ 文件安全名：非 [A-Za-z0-9._-] 字符转 `_xx`。 */
export function encodeSessionKey(sessionKey) {
  return String(sessionKey).replace(/[^A-Za-z0-9._-]/g, (ch) => `_${ch.charCodeAt(0).toString(16)}`);
}

export function createSessionSave({
  /** async (payload) => void：{sessionKey, messages, partial} → tool.call chat_memory_save。抛错 = 本次 save 失败进退避重试。 */
  deliver,
  /** 缓冲目录（config.memorySave.bufferDir，通常 <stateDir>/session-buffer）。 */
  bufferDir,
  idleMs = 3_600_000,
  maxMessages = 200,
  maxChars = 20_000,
  /** 单条文本截断阈值（独立于总量触顶阈值；缺省随 maxChars）。 */
  maxMessageChars,
  logger = () => {},
  now = Date.now,
} = {}) {
  if (typeof deliver !== 'function') throw new Error('createSessionSave 需要 deliver（注入 save 函数）');
  if (!bufferDir || typeof bufferDir !== 'string') throw new Error('createSessionSave 需要 bufferDir');
  if (!Number.isSafeInteger(idleMs) || idleMs < 200) throw new Error('idleMs must be an integer >= 200');
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1) throw new Error('maxMessages must be an integer >= 1');
  if (!Number.isSafeInteger(maxChars) || maxChars < 100) throw new Error('maxChars must be an integer >= 100');
  const perMessageCap = maxMessageChars ?? maxChars;
  if (!Number.isSafeInteger(perMessageCap) || perMessageCap < 20) throw new Error('maxMessageChars must be an integer >= 20');

  /** sessionKey → { messages: [], bytes, timer, saving, attempts, nextRetryAt, file }。 */
  const sessions = new Map();
  let saved = 0;        // 成功 save 的条数（含分段）
  let failed = 0;       // save 失败次数（进退避）
  let corruptLines = 0; // 恢复时跳过的撕裂/坏行
  let stopped = false;

  function entryOf(sessionKey, create = false) {
    let entry = sessions.get(sessionKey);
    if (!entry && create) {
      entry = {
        messages: [],
        bytes: 0,
        timer: null,
        saving: false,
        attempts: 0,
        nextRetryAt: 0,
        file: path.join(bufferDir, `${encodeSessionKey(sessionKey)}.jsonl`),
      };
      sessions.set(sessionKey, entry);
    }
    return entry;
  }

  /** 缓冲文件追加一条（首条先写 meta 行声明 sessionKey）。同步小写入：崩到行粒度。 */
  function appendRecord(entry, sessionKey, record) {
    try {
      fs.mkdirSync(bufferDir, { recursive: true });
      if (entry.messages.length === 1 && !fs.existsSync(entry.file)) {
        fs.appendFileSync(entry.file, `${JSON.stringify({ type: 'meta', v: 1, sessionKey })}\n`, 'utf8');
      }
      fs.appendFileSync(entry.file, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      // 磁盘故障不阻断消息主链路：内存缓冲仍在，只是崩溃恢复可能缺尾部。
      logger(`session-save append failed (${sessionKey}): ${error?.message ?? error}`);
    }
  }

  /** save 成功后整文件重写为仍在缓冲的记录（无剩余 = 删文件）。 */
  function rewriteBuffer(entry, sessionKey) {
    try {
      if (entry.messages.length === 0) {
        if (fs.existsSync(entry.file)) fs.rmSync(entry.file, { force: true });
        return;
      }
      const lines = [
        JSON.stringify({ type: 'meta', v: 1, sessionKey }),
        ...entry.messages.map((record) => JSON.stringify(record)),
      ];
      fs.mkdirSync(bufferDir, { recursive: true });
      const tmp = `${entry.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${lines.join('\n')}\n`, 'utf8');
      fs.renameSync(tmp, entry.file);
    } catch (error) {
      logger(`session-save rewrite failed (${sessionKey}): ${error?.message ?? error}`);
    }
  }

  function scheduleIdleTimer(entry, sessionKey) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      // 空闲到期 = 会话收尾：整段 save（partial 缺省 false）。
      void saveSession(sessionKey, { partial: false });
    }, idleMs);
    entry.timer.unref?.();
  }

  /** 观察一条候选（双向通用）。同步入缓冲 + 落盘，永不抛错。msgId 必填。 */
  function observe({ sessionKey, msgId, text, senderId, name, nickname, card, kind = 'episodic', createdAt }) {
    if (!sessionKey || typeof msgId !== 'string' || !msgId) {
      logger(`session-save skipped: missing msgId (sessionKey=${sessionKey ?? ''})`);
      return;
    }
    if (typeof text !== 'string') return;
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    const entry = entryOf(sessionKey, true);
    if (entry.messages.some((item) => item.msgId === msgId)) return; // 缓冲内去重（重放/多拦截点）
    const record = {
      msgId,
      ...(senderId ? { senderId: String(senderId).slice(0, 128) } : {}),
      ...(name ? { name: String(name).slice(0, 64) } : {}),
      ...(nickname ? { nickname: String(nickname).slice(0, 64) } : {}),
      ...(card ? { card: String(card).slice(0, 64) } : {}),
      text: normalized.length > perMessageCap ? `${normalized.slice(0, perMessageCap)}…` : normalized,
      ...(Number.isFinite(createdAt) ? { createdAt } : {}),
      kind,
    };
    entry.messages.push(record);
    entry.bytes += record.text.length;
    if (!stopped) appendRecord(entry, sessionKey, record);
    if (!entry.saving) scheduleIdleTimer(entry, sessionKey);

    // 触顶 = 提前分段 save（partial:true），缓冲清空继续累积（空闲定时器随新观察重排）。
    if (entry.messages.length >= maxMessages || entry.bytes >= maxChars) {
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
      void saveSession(sessionKey, { partial: true });
    }
  }

  /**
   * save 一个会话的当前整段缓冲。成功：清缓冲（内存）+ 重写文件；失败：一切保留，
   * 指数退避重试（attempts 无上限——旁路通道宁重试不丢）。
   * saving 标记防重入（定时器/触顶/关停三方同时触发时只跑一个 save）。
   */
  async function saveSession(sessionKey, { partial = false } = {}) {
    const entry = entryOf(sessionKey);
    if (!entry || entry.messages.length === 0 || entry.saving) return;
    // 快照拷贝：save 在途期间的新观察只留在内存/磁盘，不进本次 payload——
    // 成功后按 msgId 精确移除已保存记录，绝不清空整个缓冲（否则会把 save
    // 期间到达的消息从内存抹掉，甚至随 rewriteBuffer 连磁盘记录一起丢）。
    const payload = { sessionKey, messages: [...entry.messages], partial };
    entry.saving = true;
    try {
      await deliver(payload);
      saved += payload.messages.length;
      entry.attempts = 0;
      entry.nextRetryAt = 0;
      const savedIds = new Set(payload.messages.map((item) => item.msgId));
      const remaining = entry.messages.filter((item) => !savedIds.has(item.msgId));
      entry.messages = remaining;
      entry.bytes = remaining.reduce((sum, item) => sum + String(item.text ?? '').length, 0);
      rewriteBuffer(entry, sessionKey);
    } catch (error) {
      failed += 1;
      entry.attempts += 1;
      entry.nextRetryAt = now() + Math.min(idleMs * 2 ** Math.min(entry.attempts - 1, 10), RETRY_BACKOFF_CAP_MS);
      logger(`session-save failed (${sessionKey}, attempt ${entry.attempts}, retry at ${new Date(entry.nextRetryAt).toISOString()}): ${error?.message ?? error}`);
      // 缓冲保留（内存 + 磁盘原样）；兜底重试在 retryDue 定时器里。
    } finally {
      entry.saving = false;
    }
  }

  /** 退避到期的重试兜底（周期扫描；saving 防重入已在 saveSession 内挡）。 */
  function retryDue() {
    const at = now();
    for (const [sessionKey, entry] of sessions) {
      if (entry.messages.length > 0 && !entry.saving
        && entry.attempts > 0 && entry.nextRetryAt <= at) {
        void saveSession(sessionKey, { partial: false });
      }
    }
  }

  // ── 崩溃恢复：启动扫描缓冲目录，残留缓冲加载进内存并恢复定时器 ─────────────
  function recoverFromDisk() {
    if (!fs.existsSync(bufferDir)) return;
    let recovered = 0;
    for (const name of fs.readdirSync(bufferDir)) {
      if (!name.toLowerCase().endsWith('.jsonl')) continue;
      const file = path.join(bufferDir, name);
      let lines;
      try {
        lines = fs.readFileSync(file, 'utf8').split('\n');
      } catch (error) {
        logger(`session-save recovery read failed (${name}): ${error?.message ?? error}`);
        continue;
      }
      let sessionKey = null;
      const messages = [];
      for (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          corruptLines += 1; // 崩溃撕裂的最后一行：跳过（行粒度持久化的代价面）
          continue;
        }
        if (parsed?.type === 'meta' && typeof parsed.sessionKey === 'string') {
          sessionKey = parsed.sessionKey;
          continue;
        }
        if (parsed?.msgId && typeof parsed.text === 'string') messages.push(parsed);
      }
      if (!sessionKey || messages.length === 0) {
        // 无主/空缓冲：空内容 = 上次 save 成功但未删净的残壳，清掉。
        if (sessionKey && messages.length === 0) {
          try { fs.rmSync(file, { force: true }); } catch { /* 下轮再看 */ }
        }
        continue;
      }
      const entry = entryOf(sessionKey, true);
      if (entry.messages.length > 0) continue; // 已在内存（不会发生，防御）
      entry.messages = messages;
      entry.bytes = messages.reduce((sum, item) => sum + String(item.text ?? '').length, 0);
      recovered += messages.length;
      if (!stopped) scheduleIdleTimer(entry, sessionKey);
      logger(`session-save recovered ${messages.length} message(s) for ${sessionKey}`);
    }
    if (recovered > 0) logger(`session-save recovery done: ${recovered} message(s), corruptLines=${corruptLines}`);
  }

  /** 显式会话收尾（调用方感知「会话关闭」时调）：立即 save（partial:false）。 */
  async function closeSession(sessionKey) {
    await saveSession(sessionKey, { partial: false });
  }

  /** 兜底补发：所有会话立即 save 并等待在途 save 完成（关停链路用）。
   *  在途 save 期间到达的消息由下一轮补齐（有限轮数，防 deliver 挂死拖住关停）。 */
  async function flushAll() {
    for (let round = 0; round < 10; round += 1) {
      const pending = [...sessions.keys()].filter((key) => {
        const entry = sessions.get(key);
        return entry.messages.length > 0 && !entry.saving;
      });
      const saving = [...sessions.values()].some((entry) => entry.saving);
      if (pending.length === 0 && !saving) break;
      for (const key of pending) {
        await saveSession(key, { partial: false });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  let retryTimer = null;

  function start() {
    stopped = false;
    recoverFromDisk();
    // 退避重试兜底轮询（30s 粒度；saveSession 内部 saving/attempts 防重入）。
    if (!retryTimer) {
      retryTimer = setInterval(() => {
        try { retryDue(); } catch (error) { logger(`session-save retry sweep failed: ${error?.message ?? error}`); }
      }, 30_000);
      retryTimer.unref?.();
    }
  }

  function stop() {
    stopped = true;
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
    // 定时器全清：残留 timer 拖住进程退出。缓冲与磁盘文件原样保留，
    // 关停补发由调用方显式 flushAll（或重启后 recoverFromDisk 恢复）。
    for (const entry of sessions.values()) {
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    }
  }

  /** 健康视图（/v1/health / 运维）。 */
  function stats() {
    let buffered = 0;
    for (const entry of sessions.values()) buffered += entry.messages.length;
    return {
      sessions: sessions.size,
      buffered,
      saved,
      failed,
      corruptLines,
      retrying: [...sessions.values()].filter((entry) => entry.attempts > 0).length,
      dir: bufferDir,
      idleMs,
      maxMessages,
      maxChars,
    };
  }

  return {
    /**
     * 入站观察：server.handleInbound 注入点（envelope 即契约信封，含 sender.names）。
     *
     * 两类信封（2026-11-19 修复「用户消息没进缓冲」）：
     *  - 普通 message 信封：观察 envelope.message（真实文本 + 真实 senderId）。
     *  - wake/event 合成信封：message 是桥接合成的占位（sender.id='0'，id 为
     *    wake-/wait- 前缀）——不再观察占位（此前污染 raw：sender=0、参与者名
     *    「0」、每次唤醒一条线性累积）；真实对话在 envelope.snapshot（桥接
     *    buildWakeSnapshotV2 随信封走），逐条补录：
     *      · isSelf===true 跳过（自己发的由 tool-host 出站观察 out: 覆盖，防重复）；
     *      · msgId = messageId（QQ 原生 id，重复唤醒稳定去重）或内容哈希
     *        snap:sha1(at|senderId|text)（拍一拍类无 messageId 的兜底，同样稳定）；
     *      · sender 字段容错：快照条目 loose 演进（无 userId/at 时缺省不写）。
     */
    observeInbound({ sessionKey, envelope }) {
      const message = envelope?.message;
      const isSyntheticEvent = envelope?.wake != null
        || /^(wake|wait)-/.test(String(message?.id ?? ''));
      if (isSyntheticEvent) {
        // 快照补录：真实对话逐条观察（占位 message 本体不再入缓冲）。
        const snapshot = Array.isArray(envelope?.snapshot) ? envelope.snapshot : [];
        for (const item of snapshot) {
          if (!item || typeof item !== 'object' || item.isSelf === true) continue;
          const text = String(item.text ?? item.plain ?? '').trim();
          if (!text) continue;
          const senderId = item.userId != null ? String(item.userId) : undefined;
          const msgId = item.messageId
            ? `qq:${item.messageId}`
            : `snap:${createHash('sha1').update(`${item.at ?? ''}|${senderId ?? ''}|${text}`).digest('hex').slice(0, 16)}`;
          const parsedAt = Date.parse(item.at ?? '');
          observe({
            sessionKey,
            msgId,
            text,
            senderId,
            name: typeof item.sender === 'string' ? item.sender : item.sender?.name,
            kind: 'episodic',
            createdAt: Number.isFinite(parsedAt) ? parsedAt : undefined,
          });
        }
        return;
      }
      if (!message?.text) return; // 无消息本体的普通信封
      const sender = message.sender ?? {};
      observe({
        sessionKey,
        msgId: message.id,
        text: message.text,
        senderId: sender.id ?? '',
        name: sender.name,
        nickname: sender.names?.nickname,
        card: sender.names?.card,
        kind: 'episodic',
        createdAt: Number.isFinite(message.createdAt) ? message.createdAt : envelope?.receivedAt,
      });
    },
    /** 出站观察：tool-host 发送成功点（真正发出去的文本才算）。
     *  msgId 必须由调用方给（合成 id out:<turnId>:<callId>），缺失则跳过。
     *  出站是机器人自己发的：无 senderId（契约可选），name 标注 assistant。 */
    observeOutbound({ sessionKey, tool, args, msgId }) {
      // 2026-11-22 修复：补 args.messages 分支——chat_qq_send_message 的参数名是
      // messages（string|array，见 actions-manifest），旧实现只认 content/text/
      // message，导致 send_message 路径的回复全部漏出站观察（outbound 不落库）。
      // array 视为一次调用的多条分句，合并为单条（msgId 粒度 = 一次调用）。
      let text = args?.content ?? args?.text ?? args?.message;
      if (text === undefined && args?.messages !== undefined) {
        text = Array.isArray(args.messages) ? args.messages.join('\n') : args.messages;
      }
      if (typeof text !== 'string' || !text.trim()) return;
      observe({
        sessionKey,
        msgId,
        text,
        name: 'assistant',
        kind: 'assistant',
      });
    },
    closeSession,
    flushAll,
    retryDue,
    start,
    stop,
    stats,
  };
}
