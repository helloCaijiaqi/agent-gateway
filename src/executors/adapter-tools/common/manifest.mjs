/**
 * 清单拉取（装配机器）：GET /v1/actions/manifest，同一套 HMAC 头（body 为空串）。
 * 失败一律抛 Error——装配点决定降级（记日志、该平台无工具面），executor 不猜。
 *
 * @param {{adapter: {id: string, platform: string, secret: string, callbackBase: string}, timeoutMs?: number, logger?: Function}} options
 * @returns {Promise<{v: number, platform: string, actions: object[]}>}
 */
import { signAdapterRequest } from './crypto.mjs';
import { createHttpClient } from '../../../shared/http-client.mjs';

export async function fetchAdapterManifest({ adapter, timeoutMs = 5000, logger = () => {} } = {}) {
  if (!adapter?.callbackBase) throw new Error('adapter has no callbackBase (cannot fetch actions manifest)');
  const url = `${adapter.callbackBase}/v1/actions/manifest`;
  const http = createHttpClient({
    baseUrl: adapter.callbackBase,
    timeoutMs,
    sign: ({ body }) => signAdapterRequest({ secret: adapter.secret, body }),
  });
  const result = await http.get('/v1/actions/manifest');
  if (result.status === 0) {
    throw new Error(`manifest unreachable at ${url}: ${result.error}`);
  }
  const data = result.body;
  if (!result.ok) {
    throw new Error(`manifest fetch failed: HTTP ${result.status} ${data?.error?.code ?? ''} ${data?.error?.message ?? ''}`.trim());
  }
  if (!data || data.v !== 1 || !Array.isArray(data.actions)) {
    throw new Error('adapter returned a non-conforming manifest (expect {v:1, platform, actions})');
  }
  if (data.platform !== adapter.platform) {
    // 平台不匹配 = 装错了适配器/清单：宁可没有工具，也不能把 A 平台的能力挂到 B 平台名下。
    throw new Error(`manifest platform "${data.platform}" does not match adapter platform "${adapter.platform}"`);
  }
  logger(`manifest loaded from ${adapter.id}: ${data.actions.length} actions`);
  return data;
}
