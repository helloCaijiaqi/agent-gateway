/**
 * 地址判定的小工具，单独成文件是为了让 server.mjs 的路由保持可读。
 *
 * Node 在不同平台对回环的表示不一致：Linux 是 `127.0.0.1` / `::1`，
 * Windows 的 IPv4-mapped IPv6 是 `::ffff:127.0.0.1`。三种都必须放行，
 * 否则「本机调用被拒」会随机出现。
 */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  return LOOPBACK_ADDRESSES.has(address);
}
