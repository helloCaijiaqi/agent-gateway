/**
 * turn 编排器：一条入站消息 → 一次 DSH turn → TurnResult。
 *
 * 顺序敏感点（都来自真实事故形态）：
 *   1. **先注册 turn 等待者，再发 prompt**——反过来会漏掉先到的 turn/start，
 *      等待者干等到超时，群里表现为「已读不回且无报错」；
 *   2. **prompt 失败要取消等待者**（通过 turn-store 之外的 waiter 超时兜底，
 *      但显式失败路径必须让本轮立刻结束并记录，不能挂着）；
 *   3. **回合文本不产生任何出站动作**：模型要发言必须显式调用发送工具
 *      （chat_qq_send_message 等）→ adapter-tools → 适配器 `/v1/actions`。
 *      因此提示词里「文本只是思考、不会自动发送」是事实，而不是靠开关维持的约定。
 */
import { randomUUID } from 'node:crypto';

/**
 * 超时取消：turn 超时**不等于 DSH 已停止**。不发 session/cancel 的话，上一轮
 * 继续在 DSH 里跑，队列中的下一个 job 会与它并发写同一会话（lane 在 turn
 * 返回前保持 busy，取消确认后才释放）。
 *
 * 取消失败只记日志：把超时结果改写成 error 对调用方没有任何价值。
 */
async function cancelTimedOutTurn({ dsh, sessionId, turnId, logger }) {
  try {
    await dsh.callUnary('session/cancel', { sessionId }, AbortSignal.timeout(5000));
    logger(`turn ${turnId} timed out; session/cancel sent for ${sessionId}`);
  } catch (error) {
    logger(`turn ${turnId} timed out; session/cancel failed for ${sessionId}: ${error?.message ?? error}`);
  }
}

function classifyError(error) {
  const message = String(error?.message ?? error);
  if (/preset|fail-closed/i.test(message)) return 'E_POLICY';
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|timeout|abort|DSH 鉴权不可用/i.test(message)) return 'E_DSH_DOWN';
  return 'E_INTERNAL';
}

/**
 * 合成事件（kind=event）的 prompt 合成：适配器只送 wake 标记 + 快照，不送终稿。
 * 这样「等待回推 / 冒泡唤醒」的语义由网关统一表达，适配器不需要各自拼文案。
 */
function syntheticEventPrompt(envelope) {
  const wake = envelope.wake ?? {};
  const conversation = envelope.conversation ?? {};
  const where = conversation.kind === 'group' ? `群 ${conversation.id}` : `会话 ${conversation.id ?? '?'}`;
  const proactive = wake.kind !== 'wait';
  const label = proactive ? '主动唤醒' : '等待唤醒';
  const lines = [`【唤醒事件】${label}（${where}）`];
  if (wake.status === 'timeout') {
    lines.push('等待已超时：这段时间没有满足条件的新消息。');
  } else if (proactive) {
    // 适配器侧定时器（冒泡/主动机会）触发的唤醒：不是有人点名，可以主动开
    // 话题或接续气氛，也可以判断此刻不需要说话（不调用任何发送动作）。
    lines.push('适配器的定时器触发了这次唤醒——这不是有人点名你：可以主动开话题或接续气氛；判断此刻不需要说话，就不调用任何发送动作。');
  } else {
    lines.push('你此前登记等待的新消息已经到达。');
  }
  const snapshot = Array.isArray(envelope.snapshot) ? envelope.snapshot.slice(-20) : [];
  if (snapshot.length > 0) {
    lines.push('', proactive ? '【最近的消息】' : '【等待期间的消息】');
    for (const entry of snapshot) {
      const at = typeof entry?.at === 'string' && entry.at ? `${entry.at} ` : '';
      lines.push(`- ${at}${entry?.sender ?? ''}：${entry?.text ?? ''}`);
    }
  }
  lines.push('', '请基于以上内容继续处理；如果不需要接话，可以保持沉默。');
  return lines.join('\n');
}

function fallbackPrompt(record) {
  // P1 占位：P2 的 ContextAssembler（persona/memory/snapshot/时间）会整体替换。
  // 保留信封关键字段，保证灰度会话在 P2 上线前也能产出可用的 turn。
  const { conversation, message } = record.envelope ?? {};
  const where = conversation?.kind === 'group' ? `群 ${conversation.id}` : `会话 ${conversation?.id ?? '?'}`;
  return [
    `【平台消息】${where}`,
    `发送者：${message?.sender?.name ?? '未知'}（${message?.sender?.id ?? '?'}）`,
    `内容：${message?.text ?? ''}`,
  ].join('\n');
}

export function createTurnRunner({
  config, dsh, registry, gateway, queue, turns, executorRegistry = null,
  pipeline = null, toolHost = null, mailbox = null, ledger = null,
  logger = () => {}, metrics = null, now = Date.now,
}) {
  const chat = config.chat ?? {};

  // P4.x 会话首轮判定：发过 prompt 的 sessionKey 集合（启动按内存 turn store
  // 播种 + 运行期增量）。判定归网关——供料型 once 规则与外部步骤 firstTurn
  // ctx 的共同数据源。已知局限：turn store 内存有上限轮转，重启后旧会话历史
  // 不可见 → 可能再次判为首轮（once 重复注入，代价有限，按尽力而为语义记录）。
  const promptedSessions = new Set();
  for (const { record } of turns.recent(Math.min(turns.size, 2000))) {
    if (record?.sessionKey) promptedSessions.add(record.sessionKey);
  }

  async function runTurn(record) {
    const started = now();
    const { turnId, sessionKey } = record;
    const envelope = record.envelope ?? {};
    const ctx = {
      sessionKey,
      turnId,
      turnToken: randomUUID(),
      platform: envelope.platform,
      // kind 一起下发：适配器要用它拼本地会话 key（`group:456` / `room:789`），
      // 只给 conversationId 时群号与私聊号无法区分。
      target: { platform: envelope.platform, conversationId: envelope.conversation?.id, kind: envelope.conversation?.kind },
      budget: { timeoutMs: 15000 },
    };
    // 唤醒观测：等待回推 / 冒泡各记一笔，运维要看得出「这一轮是谁叫醒的」。
    if (envelope.wake) {
      metrics?.inc('gateway_wake_total', {
        kind: envelope.wake.kind ?? 'unknown',
        status: envelope.wake.status ?? 'arrived',
      });
    }
    let turnResult;
    // 工具统计：文本不再自动投递，/v1/turns 里的 tools 是「模型到底发没发」的唯一证据。
    let toolStats = null;
    let promptTextOverride = null;
    let assembledInfo = null; // try 块外也要读（turns.put 记录 context 信息），故声明在外层
    let droppedByPipeline = false;
    // 提到 try 外：catch 里要用它清理等待者（sessionId 在 try 内声明会取不到）。
    let sessionId = null;
    try {
      sessionId = await registry.getOrCreate(sessionKey);

      // P3：把本 turn 登记进 ToolHost（工具调用凭 turnId+turnToken 找到活跃
      // turn）。成功与失败路径都要注销（Map.delete 幂等，见 catch 分支）。
      if (toolHost) toolHost.registerTurn({ turnId, turnToken: ctx.turnToken, sessionKey });

      // P4：入站游标登记进 mailbox（GATEWAY_STATE=on 时）。seq 由适配器在
      // envelope.message 里带上（契约里的可选字段）；没有 seq 的入站（旧适配器、
      // 合成事件）不推进游标——宁可漏记也不猜。镜像乱序由 mailbox 的单调 max 兜底。
      if (mailbox && Number.isSafeInteger(envelope.message?.seq)) {
        mailbox.recordInbound({
          sessionKey,
          seq: envelope.message.seq,
          messageId: envelope.message?.id ?? null,
          senderId: envelope.message?.sender?.id ?? null,
        });
      }

      // ── V2 P2 管线（默认接管拼装）─────────────────────────────────────────
      // 在登记 DSH 等待者**之前**执行：管线只做消息加工，不碰 DSH 会话；
      // drop 短路时本轮不进 DSH、不等待（见下），先行执行避免白挂一个
      // turn 超时窗口。入口 text 与旧路径同源：适配器终稿 → 合成事件文案 → 兜底。
      if (pipeline) {
        const baseText = envelope.prompt?.text
          ?? (envelope.kind === 'event' ? syntheticEventPrompt(envelope) : fallbackPrompt(record));
        const isFirstTurnOfSession = !promptedSessions.has(sessionKey);
        const forwarded = await pipeline.runForward({
          consumerId: envelope.adapterId,
          sessionKey,
          turnId,
          turnToken: ctx.turnToken,
          envelope,
          text: baseText,
          isFirstTurnOfSession,
          now: started,
        });
        assembledInfo = {
          engine: 'pipeline',
          verdict: forwarded.verdict ?? 'pass',
          chars: forwarded.chars ?? 0,
          degraded: forwarded.degraded === true,
          dropped: forwarded.dropped ?? [],
          steps: forwarded.steps ?? [],
          fallback: false,
        };
        if (!forwarded.ok) {
          // 引擎失败（配置错误等）：回退适配器 prompt——fail-safe，与旧 fallback 同语义。
          assembledInfo.fallback = true;
          logger(`pipeline failed turn=${turnId}, fallback to adapter prompt`);
        } else if (forwarded.verdict === 'drop') {
          // drop 短路：turn 按「无消息」处理。幂等键已在 inbound 阶段落盘
          //（不变量 §5.3），本轮不发 prompt、不留 DSH 痕迹；凭据即时注销。
          droppedByPipeline = true;
          if (toolHost) toolStats = toolHost.releaseTurn(turnId);
          metrics?.inc('gateway_turn_total', { result: 'dropped' });
          logger(`turn ${turnId} dropped by pipeline${forwarded.reason ? `: ${forwarded.reason}` : ''}`);
        } else if (forwarded.text) {
          promptTextOverride = forwarded.text;
        }
      }

      if (droppedByPipeline) {
        turnResult = { v: 1, turnId, status: 'completed', actions: [], degraded: ['pipeline:dropped'] };
      } else {
        // 顺序敏感：先注册等待者（见文件头第 1 条）。
        const awaited = gateway.awaitTurn(sessionId, { timeoutMs: config.chat.turnTimeoutMs });

        // P3 转正：拼装只有管线一条路（pipeline off 时 promptTextOverride 恒空 =
        // 透传）。合成事件没有 prompt.text（适配器只送 wake + 快照）→ 网关合成。
        const promptText = promptTextOverride ?? envelope.prompt?.text
        ?? (envelope.kind === 'event' ? syntheticEventPrompt(envelope) : fallbackPrompt(record));
      const response = await dsh.prompt({ sessionId, text: promptText });
      if (!response.result?.ok) {
        const { code, message } = response.result?.error ?? {};
        throw new Error(`session.prompt rejected: ${code}: ${message ?? 'unknown'}`);
      }
      // prompt 已送达 DSH：once 注入（若有）从此进入会话历史，本会话不再是首轮。
      // drop/发送失败不标记——内容没进历史，下一 turn 仍按首轮判定。
      promptedSessions.add(sessionKey);
      const ended = await awaited;
      if (ended.status === 'timeout') {
        // 超时不等于 DSH 已停：必须显式取消，否则上一 turn 继续跑，下一 job 与它并发。
        await cancelTimedOutTurn({ dsh, sessionId, turnId, logger });
      }
      turnResult = {
        v: 1,
        turnId,
        status: ended.status,
        text: ended.text,
        // provider usage 原样落盘（桥接 token 账本从 /v1/usage 读，不再看 mux）。
        usage: ended.usage ?? null,
        degraded: [
          ...gateway.pendingFor(sessionId).map((entry) => entry.kind),
          ...(assembledInfo?.fallback ? ['context:fallback'] : []),
        ],
      };
      metrics?.inc('gateway_turn_total', { result: turnResult.status });
      metrics?.observe('gateway_turn_ms', now() - started, { result: turnResult.status });
      if (toolHost) toolStats = toolHost.releaseTurn(turnId);
      }
    } catch (error) {
      if (toolHost) toolStats = toolHost.releaseTurn(turnId);
      // prompt 抛错时等待者没人消费：不清理会挂到 timeoutMs，lane.waiters 无界增长。
      if (sessionId) gateway.dropWaiters?.(sessionId);
      const code = classifyError(error);
      turnResult = { v: 1, turnId, status: 'error', error: { code, message: String(error?.message ?? error) } };
      metrics?.inc('gateway_turn_total', { result: 'error' });
      logger(`turn ${turnId} failed (${code}): ${error?.message ?? error}`);
    }

    turns.put(turnId, {
      ...record,
      status: turnResult.status === 'completed' ? 'completed' : turnResult.status,
      result: {
        status: turnResult.status,
        textLength: turnResult.text?.length ?? 0,
        degraded: turnResult.degraded ?? [],
        error: turnResult.error ?? null,
        context: assembledInfo,
        // 这一轮由谁唤醒（正常入站为 null）——排查「AI 怎么突然说话了」的第一现场。
        wake: envelope.wake ?? null,
        // token 用量（provider 原始桶）：GET /v1/usage 的唯一数据源。
        usage: turnResult.usage ?? null,
        // 工具调用账：calls=本轮工具调用数，sent=成功的发送类动作数。
        // 删除自动投递后，「模型忘了发」只能靠这两个数字 + 下面这行日志定位。
        tools: toolStats ?? { calls: 0, sent: 0 },
      },
      finishedAt: now(),
    });
    // usage-billing：turn 到达终态即入账（进程内直调，无 HTTP 轮询、无回看窗口）。
    // turnId 幂等由账本负责；model/provider 从网关自己的会话配置取。
    ledger?.ingestTurn({
      sessionKey: record.sessionKey,
      turnId,
      at: now(),
      usage: turnResult.usage ?? null,
      model: chat?.model,
      provider: chat?.provider,
      adapterId: record.envelope?.adapterId ?? null,
      // P4.x 平台维度：多平台统筹要能回答「QQ vs WX 各消费多少」。
      platform: record.envelope?.platform ?? null,
    });
    if (typeof turnResult.text === 'string' && turnResult.text.length > 0 && !(toolStats?.sent > 0)) {
      logger(`turn ${turnId} no-send: 回合文本 ${turnResult.text.length} 字，但没有任何成功的发送工具调用（文本不会自动发到平台）`);
    }
    return turnResult;
  }

  return {
    /** 由 core/server 在 mode=on 且会话命中灰度白名单时调用。 */
    submit(record) {
      const promise = queue.enqueue(record.sessionKey, () => runTurn(record));
      // 合并（同会话排队中被替换）或队列溢出丢弃时，落一条终态，避免 /v1/turns 永远查不到结果。
      promise
        .then((outcome) => {
          if (outcome?.coalesced || outcome?.dropped) {
            turns.put(record.turnId, {
              ...record,
              status: 'coalesced',
              note: outcome.dropped ? 'queue overflow, dropped' : 'superseded by newer inbound for the same session',
              finishedAt: now(),
            });
          }
        })
        .catch((error) => {
          // runTurn 内部已兜底；到这里说明队列基础设施本身坏了。
          logger(`turn ${record.turnId} infra failure: ${error?.message ?? error}`);
          turns.put(record.turnId, {
            ...record, status: 'error',
            error: { code: 'E_INTERNAL', message: String(error?.message ?? error) },
            finishedAt: now(),
          });
        });
      return promise;
    },

    status() {
      return {
        queued: queue.pendingCount,
        running: queue.runningCount,
        sessions: registry.size,
        pendingQuestions: gateway.pendingCount(),
      };
    },

    async stop() {
      gateway.stop();
    },
  };
}
