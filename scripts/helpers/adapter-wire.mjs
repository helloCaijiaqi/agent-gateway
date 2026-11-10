/**
 * 测试用线缆客户端：直接构造 `{v:1, actionId, ok}` 契约请求/回执校验。
 *
 * 为什么需要它：`platform-actions` 执行器已删除（回合文本不再自动投递），但
 * 适配器契约（签名、信封形状、回执自检）仍必须被测试钉住。这份 helper 只做
 * 「客户端该做的事」——签名、组装、校验回执——不引入任何生产代码依赖，也
 * 不会变成第二个执行器实现。
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

export function signAdapterRequest({ secret, body }) {
  const timestamp = Date.now();
  const nonce = randomBytes(12).toString('hex');
  const digest = createHash('sha256').update(body, 'utf8').digest('hex');
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}\n${nonce}\n${digest}`, 'utf8')
    .digest('hex');
  return {
    'content-type': 'application/json; charset=utf-8',
    'x-timestamp': String(timestamp),
    'x-nonce': nonce,
    'x-gateway-secret': `v1=${signature}`,
  };
}

export function buildEnvelope({
  type, turnId = 'turn_wire', platform, conversationId, kind,
  payload = {}, actionId = randomUUID(), idempotencyKey,
}) {
  return {
    v: 1,
    actionId,
    turnId,
    type,
    target: { platform, conversationId, kind },
    payload,
    idempotencyKey: idempotencyKey ?? `${turnId}:${type}`,
  };
}

/**
 * 投递一个动作并做回执自检（与生产 transport 同口径）：
 * 缺 v/actionId/ok 或 actionId 不一致都算 E_PLATFORM，绝不把 `{}` 当成功。
 */
export async function postAdapterAction({ callbackBase, secret, envelope, timeoutMs = 2000 }) {
  const body = JSON.stringify(envelope);
  let response;
  try {
    response = await fetch(`${callbackBase}/v1/actions`, {
      method: 'POST',
      headers: signAdapterRequest({ secret, body }),
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, degraded: true, code: 'E_PLATFORM', message: `adapter unreachable: ${error?.message ?? error}` };
  }
  const data = await response.json().catch(() => null);
  if (!data || data.v !== 1 || data.actionId !== envelope.actionId || typeof data.ok !== 'boolean') {
    return { ok: false, degraded: true, code: 'E_PLATFORM', message: 'adapter returned a non-conforming receipt (expect {v:1, actionId, ok})' };
  }
  if (!response.ok) {
    return { ok: false, degraded: true, code: data.error?.code ?? 'E_PLATFORM', message: data.error?.message ?? `adapter returned HTTP ${response.status}` };
  }
  if (data.ok === false) {
    return { ok: false, degraded: true, code: data.error?.code ?? 'E_PLATFORM', message: data.error?.message ?? 'adapter reported failure' };
  }
  return { ok: true, receipt: data };
}
