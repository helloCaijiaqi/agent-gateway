/**
 * 默认透传（装配机器）：信封组装 → 反向 HMAC 签名 → 投递 → 回执校验。
 *
 * 传输双栈：
 *   - HTTP：POST <callbackBase>/v1/actions（现状，永久保留为兜底）；
 *   - WS：ws-hub callAction(id, {callId, envelope, sign})（帧级签名，见 crypto.mjs）。
 * 两条路径共用 prepareAction（会话定位 + 回路链拦截 + 信封构造）与同一份回执自检，
 * 差异只有「怎么发出去」；调用方（组合根）决定 WS 优先还是 HTTP 兜底。
 */
import { randomUUID } from 'node:crypto';
import { signAdapterRequest, signActionFrame } from './crypto.mjs';
import { resolveTarget } from './session.mjs';
import { resolveTimeoutMs } from './catalog.mjs';
import { createHttpClient } from '../../../shared/http-client.mjs';

/**
 * 组装动作信封（HTTP 与 WS 两条投递路径的唯一构造点）。
 *
 * @returns {Promise<
 *   {ok:true, envelope:object, actionId:string, timeoutMs:number}
 *   | {ok:true, suppressed:true, actionId:string, receipt:null}   // 回路链 drop
 *   | {ok:false, degraded:true, code:string, message:string}>}
 */
export async function prepareAction({ adapter, action, entry, ctx, timeoutMs, returnPipeline = null }) {
  const platform = adapter.platform;
  // 会话定位：payload.key（`group:456`，跨会话操作用）优先，否则从 sessionKey 派生。
  const target = resolveTarget({ platform, sessionKey: ctx.sessionKey, payload: ctx.payload });
  if (!target) {
    return {
      ok: false, degraded: true, code: 'E_UNSUPPORTED',
      message: `cannot derive a ${platform} conversation from session "${ctx.sessionKey}"`,
    };
  }
  const actionId = ctx.actionId ?? randomUUID();

  // ── P5 回路链拦截点（DSH 产出 → 消费者，投递之前）───────────────────────
  // 只作用于 payload.text 为非空 string 的动作；verdict=drop = 拦截投递（动作
  // 不发、按成功回执——模型侧视为已发送，宁放行不误杀的出站镜像）；改写 =
  // 替换 payload.text；链失败/钩子异常 = 保留原文照常投递。钩子永不抛错。
  // 注意：本钩子只覆盖默认透传路径；平台宿主自带的 capability.handle 出站
  // 行为不受回路编排约束（它们不走本函数）。
  let payload = { ...(ctx.payload ?? {}) };
  if (returnPipeline && typeof payload.text === 'string' && payload.text.length > 0) {
    try {
      const chain = await returnPipeline({
        consumerId: adapter.id,
        sessionKey: ctx.sessionKey,
        turnId: ctx.turnId,
        text: payload.text,
      });
      if (chain?.verdict === 'drop') {
        return { ok: true, suppressed: true, actionId, receipt: null };
      }
      if (typeof chain?.text === 'string' && chain.text !== payload.text) {
        payload = { ...payload, text: chain.text };
      }
    } catch {
      // 回路链不可用：原文照发（fail-safe，与管线 degraded 同向）。
    }
  }

  const envelope = {
    v: 1,
    actionId,
    turnId: ctx.turnId,
    type: action,
    target,
    payload,
    idempotencyKey: ctx.idempotencyKey ?? `${ctx.turnId}:${action}`,
  };
  const timeout = resolveTimeoutMs({ kind: entry?.kind, budget: ctx.budget, timeoutMs });
  return { ok: true, envelope, actionId, timeoutMs: timeout };
}

/** 回执自检（HTTP 与 WS 同款线缆契约）：`{v:1, actionId, ok}` 且 actionId 一致。 */
function checkReceipt(receipt, actionId) {
  if (!receipt || receipt.v !== 1 || receipt.actionId !== actionId || typeof receipt.ok !== 'boolean') {
    return {
      ok: false, degraded: true, code: 'E_PLATFORM',
      message: 'adapter returned a non-conforming receipt (expect {v:1, actionId, ok})',
    };
  }
  if (receipt.ok === false) {
    return {
      ok: false, degraded: true,
      code: receipt.error?.code ?? 'E_PLATFORM',
      message: receipt.error?.message ?? 'adapter reported failure',
    };
  }
  return { ok: true, receipt };
}

/**
 * 默认透传的 HTTP 载体（现状路径，永不 throw）。
 * `prepared` 可由调用方传入已组装的结果（WS 失败回落 HTTP 时复用，避免
 * returnPipeline 被执行两次）。
 */
export async function deliverAction({ adapter, action, entry, ctx, timeoutMs, returnPipeline = null, prepared = null }) {
  const ready = prepared ?? await prepareAction({ adapter, action, entry, ctx, timeoutMs, returnPipeline });
  if (ready.ok !== true) return ready;
  if (ready.suppressed) return ready;
  const { envelope, actionId, timeoutMs: timeout } = ready;
  const http = createHttpClient({
    baseUrl: adapter.callbackBase,
    timeoutMs: timeout,
    sign: ({ body: rawBody }) => signAdapterRequest({ secret: adapter.secret, body: rawBody }),
  });
  const result = await http.post('/v1/actions', envelope, { timeoutMs: timeout });
  if (result.status === 0) {
    return {
      ok: false, degraded: true, code: 'E_PLATFORM',
      message: `adapter unreachable: ${result.error}`,
    };
  }
  if (!result.ok) {
    return {
      ok: false, degraded: true,
      code: result.body?.error?.code ?? 'E_PLATFORM',
      message: result.body?.error?.message ?? `adapter returned HTTP ${result.status}`,
    };
  }
  return checkReceipt(result.body, actionId);
}

/**
 * WS 载体：经 ws-hub callAction 下发同一信封（帧级签名 + callId 关联）。
 * 无连接/超时/断开/回执不符一律返回 degraded 结果，由调用方决定是否回落 HTTP。
 *
 * @param {object} options
 * @param {{callAction: Function}} options.wsHub
 * @param {object} options.adapter
 * @param {object} options.envelope    prepareAction 的产物
 * @param {number} options.timeoutMs
 */
export async function deliverActionViaWs({ wsHub, adapter, envelope, timeoutMs }) {
  const sign = signActionFrame({ secret: adapter.secret, envelope });
  let receipt;
  try {
    receipt = await wsHub.callAction(adapter.id, { callId: envelope.actionId, envelope, sign }, timeoutMs);
  } catch (error) {
    return {
      ok: false, degraded: true,
      code: error?.code ?? 'E_PLATFORM',
      message: String(error?.message ?? error),
    };
  }
  return checkReceipt(receipt, envelope.actionId);
}
