/**
 * 适配器反向签名（gateway → adapter）：ts\nnonce\nsha256(body)，头 x-gateway-secret。
 *
 * 与 core/auth.mjs 相同格式；**刻意本地实现**——执行层不允许 import core
 * （静态合规检查钉住），两侧格式一致性由「适配器侧验签互认测试」兜住
 * （executor 测试真起 HTTP 假适配器做服务端验签）。
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

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

/**
 * WS action 帧签名（与 HTTP /v1/actions 同公式，只是载体从 header 变帧字段）：
 *   signature = v1=<hex hmac_sha256(secret, ts + "\n" + nonce + "\n" + sha256(JSON.stringify(envelope)))>
 * 适配器侧用同一公式验签（桥接 gateway-actions.handleFrame）。
 *
 * 帧里额外带 `bodyHash`：验签方**不再重新序列化**信封，直接用摘要验签。
 * 这消除了「签名端与验签端 JSON.stringify 结果必须逐字节一致」的隐性契约
 * （键序、-0/0、大整数、Unicode 转义差异都会导致偶发验签失败）。旧适配器
 * 忽略该字段时仍按原逻辑重算（灰度兼容）。
 */
export function signActionFrame({ secret, envelope }) {
  const timestamp = Date.now();
  const nonce = randomBytes(12).toString('hex');
  const bodyHash = createHash('sha256').update(JSON.stringify(envelope), 'utf8').digest('hex');
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}\n${nonce}\n${bodyHash}`, 'utf8')
    .digest('hex');
  return { ts: timestamp, nonce, signature: `v1=${signature}`, bodyHash };
}
