/**
 * 适配器 ↔ 网关的双向 HMAC 鉴权。
 *
 * 为什么不是「回环就当可信」：
 *   DSH 的沙箱进程、任何本机用户、任何被注入的 MCP 子进程都能访问 127.0.0.1。
 *   回环只说明「来自本机」，不说明「来自某个适配器」。签名是唯一能把
 *   「谁在调用」钉死的东西。
 *
 * 签名格式（固定，便于将来用别的语言实现适配器）：
 *
 *   X-Adapter-Id: qq-main
 *   X-Timestamp:  1762300000000
 *   X-Nonce:      8f3c1a...
 *   X-Signature:  v1=<hex hmac_sha256(secret, ts + "\n" + nonce + "\n" + sha256(body))>
 *
 * 先对 body 做 sha256 再进 HMAC，是为了让签名计算与 body 大小无关：
 * 大 payload 不会因为 HMAC 本身变成性能问题，也避免把正文直接喂进 HMAC 的
 * 实现差异（不同语言对 UTF-8 归一化的处理不一致）。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
export const DEFAULT_NONCE_CAPACITY = 100_000;

export class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

function sha256Hex(body) {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function hmacHex(secret, payload) {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function signRequest({ secret, adapterId, body = '', timestamp = Date.now(), nonce }) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new TypeError('secret must be a string of at least 16 characters');
  }
  const nonceValue = nonce ?? randomBytes(12).toString('hex');
  const signature = hmacHex(secret, `${timestamp}\n${nonceValue}\n${sha256Hex(body)}`);
  return {
    'x-adapter-id': String(adapterId),
    'x-timestamp': String(timestamp),
    'x-nonce': nonceValue,
    'x-signature': `v1=${signature}`,
  };
}

/**
 * 有界 nonce 缓存。
 *
 * 用 Map 的插入顺序做 LRU：签名请求的时间窗只有 5 分钟，过期项在每次
 * `check` 时从头部清掉即可。容量上限是防御性的——被投毒的适配器不能靠
 * 无限 nonce 把网关内存吃光。
 */
export function createNonceCache({ windowMs = DEFAULT_WINDOW_MS, capacity = DEFAULT_NONCE_CAPACITY, now = Date.now } = {}) {
  const seen = new Map();

  function prune(at) {
    for (const [nonce, expiresAt] of seen) {
      if (expiresAt > at) break;
      seen.delete(nonce);
    }
    while (seen.size > capacity) {
      const oldest = seen.keys().next().value;
      seen.delete(oldest);
    }
  }

  return {
    /** 返回 true 表示首次出现（可用），false 表示重放。 */
    check(nonce, at) {
      prune(at);
      if (seen.has(nonce)) return false;
      seen.set(nonce, at + windowMs);
      return true;
    },
    get size() { return seen.size; },
    clear() { seen.clear(); },
  };
}

/**
 * 校验一次请求。
 *
 * @param {object} options
 * @param {string} options.secret        该适配器的共享密钥
 * @param {string} options.expectedAdapterId  配置中登记的 id
 * @param {string} options.expectedPlatform   该适配器被允许声明的平台
 * @param {object} options.headers       小写化的请求头
 * @param {string} options.body          原始 body 字符串（不能是重新序列化的对象）
 * @param {string} options.declaredPlatform  body 里声明的 platform
 * @param {number} options.now
 * @param {number} options.windowMs
 * @param {ReturnType<typeof createNonceCache>} options.nonceCache
 */
export function verifyRequest({
  secret,
  expectedAdapterId,
  expectedPlatform,
  headers,
  body = '',
  declaredPlatform,
  now = Date.now(),
  windowMs = DEFAULT_WINDOW_MS,
  nonceCache,
}) {
  const adapterId = headers['x-adapter-id'];
  const timestampRaw = headers['x-timestamp'];
  const nonce = headers['x-nonce'];
  const signatureRaw = headers['x-signature'];

  // 失败原因不细分：对外只回 E_AUTH，避免枚举「哪个适配器存在」。
  if (!adapterId || !timestampRaw || !nonce || !signatureRaw) {
    throw new AuthError('E_AUTH', 'missing authentication headers');
  }
  if (adapterId !== expectedAdapterId) {
    throw new AuthError('E_AUTH', 'unknown adapter');
  }
  if (declaredPlatform && expectedPlatform && declaredPlatform !== expectedPlatform) {
    throw new AuthError('E_AUTH', 'adapter is not bound to the declared platform');
  }

  const timestamp = Number(timestampRaw);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > windowMs) {
    throw new AuthError('E_REPLAY', 'timestamp outside the replay window');
  }

  // 先验签名、再消费 nonce：签名错的请求不应该把 nonce 烧掉，
  // 否则任何人都能靠伪造请求让合法请求被判为重放。
  const expected = hmacHex(secret, `${timestamp}\n${nonce}\n${sha256Hex(body)}`);
  if (!signatureRaw.startsWith('v1=') || !safeEqualHex(signatureRaw.slice(3), expected)) {
    throw new AuthError('E_AUTH', 'bad signature');
  }

  if (!nonceCache.check(`${adapterId}:${nonce}`, now)) {
    throw new AuthError('E_REPLAY', 'nonce already used');
  }

  return { adapterId, timestamp, nonce };
}

/**
 * 密钥轮换用的双密钥校验：新密钥先上线、旧密钥保留一个窗口。
 * 返回命中的密钥标识，便于日志里区分「还在用旧密钥」。
 */
export function verifyWithKeyring(options, keys) {
  let lastError = null;
  for (const { id, secret } of keys) {
    try {
      verifyRequest({ ...options, secret });
      return { keyId: id };
    } catch (error) {
      lastError = error;
      // 只对签名失败继续尝试；重放/时间窗失败重试没有意义，且会消耗 nonce。
      if (error.code !== 'E_AUTH' || error.message !== 'bad signature') throw error;
    }
  }
  throw lastError ?? new AuthError('E_AUTH', 'no usable key');
}

// ── operator（控制台）认证通道 ─────────────────────────────────────────────
// 与适配器 HMAC 并存、互不共用密钥：operator token 是给 CLI/脚本/未来 UI 的
// 长期凭据；浏览器用登录换发的短期签名 Cookie（无状态 + 内存吊销集合）。

export const OPERATOR_COOKIE = 'console_session';
export const OPERATOR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** 定长无关的时延安全比较（先哈希定长化，避免长度差本身泄露信息）。 */
export function safeEqualString(a, b) {
  const left = createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const right = createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return timingSafeEqual(left, right);
}

function base64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

/** 签发签名会话 Cookie 值：`base64url({v,exp}).<hmac>`，密钥即 operator token。 */
export function issueOperatorSession({ secret, ttlMs = 12 * 60 * 60 * 1000, now = Date.now } = {}) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new TypeError('operator secret must be a string of at least 16 characters');
  }
  const expiresAt = now() + ttlMs;
  const payload = base64urlJson({ v: 1, exp: expiresAt });
  return { value: `${payload}.${hmacHex(secret, payload)}`, expiresAt };
}

/**
 * 校验签名 Cookie。返回 `{ok:true, expiresAt}` 或
 * `{ok:false, reason:'malformed'|'invalid'|'expired', expiresAt?}`——reason
 * 供 metrics 区分 invalid/expired，不进对外错误信息。
 */
export function verifyOperatorSession({ secret, value, now = Date.now } = {}) {
  if (typeof value !== 'string' || !value.includes('.')) return { ok: false, reason: 'malformed' };
  const dot = value.lastIndexOf('.');
  const payload = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !safeEqualHex(mac, hmacHex(secret, payload))) {
    return { ok: false, reason: 'invalid' };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (parsed?.v !== 1 || !Number.isSafeInteger(parsed.exp)) return { ok: false, reason: 'invalid' };
  if (parsed.exp <= now()) return { ok: false, reason: 'expired', expiresAt: parsed.exp };
  return { ok: true, expiresAt: parsed.exp };
}

/** Set-Cookie 头（HttpOnly + SameSite=Strict；Path=/ 限定同站作用域）。 */
export function operatorCookieHeader(value, expiresAt) {
  return `${OPERATOR_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Expires=${new Date(expiresAt).toUTCString()}`;
}
