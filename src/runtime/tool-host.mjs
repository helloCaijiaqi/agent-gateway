/**
 * ToolHost（P3）：统一工具面的运行时枢纽。
 *
 * 链路：DSH agent → dsh-mcp-client(stdio) → mcp-bus（MCP 薄壳）
 *       → HTTP POST /v1/tools/call → core 路由 → 本组件 → executor registry。
 *
 * 安全模型（与设计文档 §9 一致，「来自回环」不是信任凭据）：
 *   1. HTTP 层：mcp-bus 与网关的 HMAC 共享密钥（config.tools.busSecret）；
 *   2. 会话层：**turnToken 是唯一凭据**——turn-runner 每轮铸造、经 P2 on 模式的
 *      protocol section 下发给模型，模型把它作为工具参数带回。ToolHost 用
 *      令牌反查活跃 turn 得到 sessionKey/turnId，模型不需要（也不应该）
 *      复述会话标识。令牌随 turn 结束即焚，旧令牌一律 E_FORBIDDEN——与
 *      bridge 的 agentToken 同一思路，但生命周期收紧到单 turn。
 *   3. 频控：每 turn 工具调用次数上限（maxCallsPerTurn），超限 E_RATE_LIMITED；
 *   4. 预算：单次调用超时（callTimeoutMs），超时返回 E_TIMEOUT（底层请求可能
 *      仍在飞行，executor 的 HTTP 客户端有自己的 AbortSignal 兜底）。
 *
 * 结果形状（设计文档 §8.5 统一形状）：成功 `{ ok:true, data }`，
 * 失败 `{ ok:false, error:{ code, message } }`——不返回裸字符串。
 */
import { createHash, timingSafeEqual } from 'node:crypto';

function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function tokensMatch(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * 「发送类」动作：成功的这些调用才计入 sent。
 * 与桥接清单的发送动作保持一致（清单新增发送类时同步这里，测试会钉住几个核心名字）。
 */
const SEND_ACTIONS = new Set([
  'send_text', 'reply', 'send_message', 'send_burst',
  'send_sticker', 'send_voice', 'send_group_message', 'send_private_message', 'poke',
]);

/**
 * 超时竞速（带定时器清理）。
 *
 * 旧写法 `Promise.race([call, new Promise(r => setTimeout(...))])` 每次调用都留一个
 * 到点才触发的定时器：高频工具调用下会堆积成无界定时器队列（且 unref 都没做，
 * 拖住进程退出）。这里在竞速结束（成功或超时）后统一 clearTimeout。
 */
function withDeadline(promise, ms, message) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      ok: false, degraded: true, code: 'E_TIMEOUT', message,
    }), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createToolHost({
  executorRegistry,
  // V2 P3 服务执行器（动态路由）：{ resolveTool(name), listTools(), call(serviceId, request) }。
  // 由 main.mjs 从 service-registry 注入；null = 无登记工具面（纯内置 executors）。
  serviceTools = null,
  // §6 记忆落库调度器：出站观察点（发送成功的文本沉淀进记忆）。null = 不落库。
  memoryIngest = null,
  logger = () => {},
  metrics = null,
  now = Date.now,
  maxCallsPerTurn = 30,
  callTimeoutMs = 20000,
} = {}) {
  /** turnId → { turnToken, sessionKey, startedAt, calls, sent } */
  const byTurn = new Map();
  /** sha256(turnToken) → 同上。查找用哈希做 key，比对仍走 timingSafeEqual。 */
  const byToken = new Map();

  function registerTurn({ turnId, turnToken, sessionKey }) {
    if (!turnId || !turnToken || !sessionKey) {
      throw new TypeError('registerTurn: turnId/turnToken/sessionKey are required');
    }
    const entry = { turnId, turnToken, sessionKey, startedAt: now(), calls: 0, sent: 0 };
    byTurn.set(turnId, entry);
    byToken.set(sha256Hex(turnToken), entry);
  }

  /**
   * 注销 turn 并返回本轮工具快照。
   *
   * 返回值是增量语义：调用方原有用例不依赖它。`sent` 只统计「成功的发送类动作」，
   * 因为删除回合文本自动投递后，这个数字就是「模型这一轮到底有没有说话」的唯一证据。
   */
  function releaseTurn(turnId) {
    const entry = byTurn.get(turnId);
    if (!entry) return null;
    byToken.delete(sha256Hex(entry.turnToken));
    byTurn.delete(turnId);
    return { calls: entry.calls, sent: entry.sent };
  }

  async function handle({ callId, tool, args, turnToken, sessionKey, turnId }) {
    const token = String(turnToken ?? '');
    const entry = token ? byToken.get(sha256Hex(token)) : null;
    if (!entry || !tokensMatch(entry.turnToken, token)) {
      metrics?.inc('gateway_tool_total', { tool, result: 'forbidden' });
      return {
        ok: false,
        error: {
          code: 'E_FORBIDDEN',
          message: 'unknown or expired turn token (use the 【会话令牌】 from the latest prompt)',
        },
      };
    }
    // 显式带上 sessionKey/turnId 时必须与令牌对应的 turn 一致（防串会话）。
    if ((sessionKey && sessionKey !== entry.sessionKey) || (turnId && !byTurn.has(turnId))) {
      metrics?.inc('gateway_tool_total', { tool, result: 'forbidden' });
      return { ok: false, error: { code: 'E_FORBIDDEN', message: 'identity does not match the live turn' } };
    }
    // 未知工具先于频控判定：调不存在的东西是编程错误，不该消耗频控额度，
    // 也不该被频控掩盖（否则排查「工具名打错」时要先绕过限流）。
    // V2 P3：内置清单查不到时再查登记工具面——内置优先，登记工具不遮蔽内置
    // executor（模型工具面的既有词汇不会被一个登记文件悄悄改掉）。
    const action = executorRegistry.actionForTool(tool);
    const registeredTool = action ? null : (serviceTools?.resolveTool?.(tool) ?? null);
    if (!action && !registeredTool) {
      metrics?.inc('gateway_tool_total', { tool, result: 'unsupported' });
      return { ok: false, error: { code: 'E_UNSUPPORTED', message: `unknown tool: ${tool}` } };
    }
    if (entry.calls >= maxCallsPerTurn) {
      metrics?.inc('gateway_tool_total', { tool, result: 'rate_limited' });
      return { ok: false, error: { code: 'E_RATE_LIMITED', message: `tool call limit (${maxCallsPerTurn}) reached for this turn` } };
    }

    entry.calls += 1;
    const started = now();
    let outcome;
    try {
      if (registeredTool) {
        // 服务执行器：经 service-registry 出站（WS tool.call / HTTP 备用）。
        // 安全链不下放：turnToken 留在本层校验（上面已完成），下发的只有会话标识。
        // 结果映射回统一 outcome 形状（receipt 即 data），业务失败是正常结果，
        // 传输/契约失败（callServiceTool 抛 ContractError）按内部错误降级。
        outcome = await withDeadline(
          serviceTools.call(registeredTool.serviceId, {
            tool,
            args: args ?? {},
            sessionKey: entry.sessionKey,
            turnId: entry.turnId,
          }).then((result) => (result.ok
            ? {
              ok: true,
              receipt: result.data ?? null,
              // 回路链 drop：业务上「成功」但**没有真的发出去**，不能计入 sent
              // 也不能沉淀进记忆（否则记忆里会出现一条从未发出的发言）。
              suppressed: result.suppressed === true,
            }
            : {
              ok: false,
              code: result.error?.code ?? 'E_INTERNAL',
              message: result.error?.message ?? 'service tool call failed',
            })),
          callTimeoutMs,
          `tool call exceeded ${callTimeoutMs}ms`,
        );
      } else {
        outcome = await withDeadline(
          executorRegistry.call(action, {
            sessionKey: entry.sessionKey,
            turnId: entry.turnId,
            turnToken: entry.turnToken,
            // 工具名随 ctx 下发：adapter-tools 据此前缀选适配器（模型调 chat_wx_*
            // 就该进 wx 适配器，与当前会话平台无关）。
            tool,
            payload: args ?? {},
            budget: { timeoutMs: callTimeoutMs },
            idempotencyKey: `tool:${callId}`,
            actionId: `tool:${callId}`,
          }),
          callTimeoutMs,
          `tool call exceeded ${callTimeoutMs}ms`,
        );
      }
    } catch (error) {
      // registry 只在 ctx 缺失/动作未注册时抛错；走到这里说明 runtime 自身有 bug，
      // 按内部错误降级，绝不把异常抛回 HTTP 层炸掉连接。
      outcome = { ok: false, degraded: true, code: 'E_INTERNAL', message: String(error?.message ?? error) };
    }
    if (outcome.ok && !outcome.suppressed && SEND_ACTIONS.has(action)) {
      entry.sent += 1;
      // §6 记忆落库（双向拦截的出站侧）：只沉淀「真正发出去」的文本（发送动作
      // 成功回执后）；入站消息经 server.handleInbound 观察，两条路同一调度器。
      // msgId 用合成 id out:<turnId>:<callId>：同一 callId 重放命中 raw 唯一键。
      memoryIngest?.observeOutbound({
        sessionKey: entry.sessionKey,
        tool,
        args,
        msgId: `out:${entry.turnId}:${callId}`,
      });
    } else if (outcome.ok && outcome.suppressed) {
      // drop 策略命中：对模型是成功（不必自我纠正），但不算发出去。
      logger(`tool "${tool}" suppressed by return pipeline; not counted as sent`);
    }
    metrics?.inc('gateway_tool_total', { tool, result: outcome.ok ? 'ok' : 'error' });
    metrics?.observe('gateway_tool_ms', now() - started, { tool });
    if (outcome.ok) {
      return { ok: true, data: outcome.receipt ?? null };
    }
    if (outcome.degraded) logger(`tool "${tool}" degraded (${outcome.code}): ${outcome.message}`);
    return {
      ok: false,
      error: { code: outcome.code ?? 'E_INTERNAL', message: outcome.message ?? 'tool call failed' },
    };
  }

  /** 完整工具面 = 内置 executors ∪ 登记工具（内置优先，登记不遮蔽内置）。 */
  function mergedTools() {
    const builtin = executorRegistry.listTools();
    const registered = serviceTools?.listTools?.() ?? [];
    const seen = new Set(builtin.map((tool) => tool.name));
    return [...builtin, ...registered.filter((tool) => !seen.has(tool.name))];
  }

  function status() {
    return {
      liveTurns: byTurn.size,
      tools: mergedTools().map((tool) => tool.name),
    };
  }

  return { registerTurn, releaseTurn, handle, listTools: mergedTools, status };
}
