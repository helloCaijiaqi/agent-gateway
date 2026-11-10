/**
 * 共享出站 HTTP 客户端（axios 薄封装）——仓库内一切出站 HTTP/RPC 请求的唯一通道。
 *
 * 背景（2026-11-06 决定）：「不要手动构建请求」——所有出站 HTTP 调用统一走本库，
 * 代理 gateway 与 qq-bridge 各持一份**API 形状完全一致**的副本（两仓库 package.json
 * 依赖版本对齐，不引入共享 npm 包/monorepo）。
 *
 * 能力：
 *   - axios 承载传输（连接复用、超时、transitional 语义），本层不手写请求；
 *   - `sign` 插槽：请求拦截器形态的签名注入（HMAC 等线缆契约由调用方提供）；
 *   - 重试：仅对幂等方法（GET/HEAD）且错误为网络错/超时/5xx，默认 0 次；
 *   - 结果契约：永不 throw——`{ok, status, code, error, body}`，网络错统一
 *     `E_NETWORK`（与既有 gateway-client 语义一致，调用方拿 `{ok:false}` 走降级）；
 *   - `transport` 注入口：测试用假传输层替换 axios（生产代码一律走默认 axios）。
 */
import axios from 'axios';

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createHttpClient({
  baseUrl = '',
  timeoutMs = 5000,
  retries = 0,
  retryDelayMs = 150,
  logger = () => {},
  /** ({method, pathname, body}) => headers 对象；body 为已序列化的字符串（GET 为空串）。 */
  sign = null,
  /** 测试注入：async ({method, url, headers, body, timeoutMs}) => {status, text}。 */
  transport = null,
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const instance = axios.create({ validateStatus: () => true, responseType: 'text' });

  /** axios 传输：非 2xx 不抛错（validateStatus 恒真），交由本层统一翻译。 */
  async function axiosTransport({ method, url, headers, body, timeoutMs: perCall, signal }) {
    try {
      const response = await instance.request({
        method: method.toLowerCase(),
        url,
        data: body === undefined ? undefined : body,
        headers,
        timeout: perCall,
        // 透传取消信号：不传的话调用方（turn 超时/关停）的 AbortSignal 是摆设，
        // 请求会一直跑到 timeout 才返回，关停时还会继续占着连接。
        ...(signal ? { signal } : {}),
        transitional: { clarifyTimeoutError: true },
      });
      const data = response.data;
      const text = typeof data === 'string' ? data : data == null ? '' : JSON.stringify(data);
      return { status: response.status, text };
    } catch (error) {
      const timedOut = error?.code === 'ECONNABORTED'
        || /timeout/i.test(String(error?.message));
      return {
        status: 0,
        error: timedOut ? `timeout after ${perCall}ms` : String(error?.message ?? error),
      };
    }
  }

  const doTransport = transport ?? axiosTransport;

  function parse(raw) {
    if (raw.status === 0) {
      return { ok: false, status: 0, code: 'E_NETWORK', error: raw.error ?? 'network error' };
    }
    let parsed = null;
    try { parsed = raw.text ? JSON.parse(raw.text) : null; } catch { parsed = null; }
    if (raw.status < 200 || raw.status >= 300) {
      return {
        ok: false,
        status: raw.status,
        code: parsed?.error?.code ?? 'E_INTERNAL',
        error: parsed?.error?.message ?? `HTTP ${raw.status}`,
      };
    }
    return { ok: true, status: raw.status, body: parsed };
  }

  async function attempt(method, pathname, bodyObj, opts) {
    const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
    const url = `${base}${pathname}`;
    const perCallTimeout = opts.timeoutMs ?? timeoutMs;
    const headers = { ...(opts.headers ?? {}) };
    const signer = opts.sign ?? sign;
    if (signer) Object.assign(headers, signer({ method, pathname, body: body ?? '' }));
    const raw = await doTransport({
      method, url, headers, body,
      timeoutMs: perCallTimeout,
      signal: opts.signal,
    });
    const result = parse(raw);
    if (!result.ok) logger(`http-client ${method} ${pathname} -> ${result.code}: ${result.error}`);
    return result;
  }

  return {
    /**
     * 主入口。`opts`: { headers?, timeoutMs?, retries?, sign?, signal? }。
     * 重试只发生在幂等方法且错误为 E_NETWORK/5xx 时（backoff = retryDelayMs * 次数）。
     */
    async request(method, pathname, bodyObj, opts = {}) {
      const upper = String(method).toUpperCase();
      const defaultRetries = IDEMPOTENT_METHODS.has(upper) ? retries : 0;
      const maxRetries = opts.retries ?? defaultRetries;
      let result = await attempt(upper, pathname, bodyObj, opts);
      for (let attemptNo = 1; attemptNo <= maxRetries && result.ok === false
        && (result.code === 'E_NETWORK' || result.status >= 500); attemptNo += 1) {
        await sleep(retryDelayMs * attemptNo);
        result = await attempt(upper, pathname, bodyObj, opts);
      }
      return result;
    },

    get(pathname, opts) {
      return this.request('GET', pathname, undefined, opts);
    },

    post(pathname, bodyObj, opts) {
      return this.request('POST', pathname, bodyObj, opts);
    },

    /**
     * 低层原始请求：完整 URL、不走 baseUrl/重试/签名插槽；保留响应头与文本，
     * 供协议客户端（如 DSH 鉴权链的 token 交换 / 401 重试）使用。永不 throw。
     */
    async requestRaw(method, url, { headers = {}, body, timeoutMs: perCallMs, maxRedirects = 5, signal } = {}) {
      const perCall = perCallMs ?? timeoutMs;
      try {
        const response = await instance.request({
          method: String(method).toLowerCase(),
          url,
          data: body === undefined ? undefined : body,
          headers,
          timeout: perCall,
          maxRedirects,
          transitional: { clarifyTimeoutError: true },
          signal,
        });
        const data = response.data;
        const text = typeof data === 'string' ? data : data == null ? '' : JSON.stringify(data);
        return {
          ok: true,
          status: response.status,
          text,
          headers: response.headers ?? {},
          json() { return text ? JSON.parse(text) : null; },
        };
      } catch (error) {
        const timedOut = error?.code === 'ECONNABORTED'
          || /timeout/i.test(String(error?.message));
        return {
          ok: false,
          status: 0,
          code: 'E_NETWORK',
          error: timedOut ? `timeout after ${perCall}ms` : String(error?.message ?? error),
        };
      }
    },
  };
}
