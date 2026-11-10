/**
 * web-search executor（阶段 3 收编）：把联网搜索暴露成统一的 chat_web_search。
 *
 * 能力来源是**内置清单**（非适配器）：动作 `web_search`、kind `read`，与
 * adapter-tools 的 chat_<platform>_* 并列挂在同一个工具目录里——mcp-bus 的
 * tools/list 从 /v1/tools 拉取，注册即对模型可见。
 *
 * 搜索实现与 qq-bridge/src/mcp/web-search.js 同源（DeepSeek 的 Anthropic 兼容
 * Messages 端点 + `web_search_20250305` 服务端工具，与 DSH 同一路结果），
 * 但**刻意本地重复实现**：执行层只许 import executor-interface 与 node 内置
 * （静态合规检查钉住），不许 import 桥接仓与第三方包（含 js-yaml/safe-fetch）。
 *
 * API key 发现（从桥接迁来的职责，`key` 永不落日志/错误信息/返回结果）：
 *   1. 工厂参数 apiKey（组合根显式注入，优先级最高）
 *   2. GATEWAY_WEB_SEARCH_KEY
 *   3. GATEWAY_WEB_SEARCH_KEY_FILE 指向的文件（与 mcp-bus.secret 同模式）
 *   4. DEEPSEEK_API_KEY
 *   5. DSH 的 `$DSH_HOME/.credentials.yaml` → `refs.DEEPSEEK_API_KEY`
 *      （最小 YAML 解析，不引第三方依赖；只读指定 ref，绝不遍历其它凭据）
 *
 * 安全边界（沿用桥接的口径）：
 *   - 端点必须 https 且解析到**公网**地址（SSRF 防护：回环/内网/链路本地一律
 *     拒绝——key 只发给校验过的地址），禁止跟随重定向；
 *   - 响应体有大小上限、请求有总超时（尊重 ctx.budget，取两者较小值）；
 *   - 上游连续失败触发熔断（与 memory-tools 同参数：3 次 / 60s 起指数退避）。
 *
 * 与桥接版的差异：**不做 Bing 兜底**——网关的失败语义是结构化降级（模型看到
 * 明确错误而不是静默换源），且 Bing 抓取依赖桥接的 safe-fetch/HTML 解析，
 * 不值得为它把那套搬进网关。
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import dns from 'node:dns';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import { registerExecutor } from './executor-interface.mjs';

const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_API_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 35000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 64;
const SEARCH_TOOL_TYPE = 'web_search_20250305';
const MAX_USES = 5;
const MAX_TOKENS = 4096;
const BREAKER_FAILURES = 3;
const BREAKER_COOLDOWN_MS = 60 * 1000;

// ── API key 发现 ────────────────────────────────────────────────────────────

/**
 * DSH 凭据文件里的单个 ref。结构：`refs:\n  <NAME>: <value>`（实测结构，非
 * 记录 id）。这是**最小** YAML 解析：只认顶层 `refs:` 段下的标量键值对，
 * 不支持锚点/多行/嵌套——DSH Models 页写出的就是这种简单形态；解析不了
 * 返回空串（等于该来源没有 key），绝不猜。
 */
export function readDshCredentialRef(ref, env = process.env) {
  const name = String(ref ?? '').trim();
  if (!name) return '';
  const home = String(env.DSH_HOME ?? '').trim() || path.join(os.homedir(), '.dsh');
  let text = '';
  try {
    text = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  } catch {
    return '';
  }
  let inRefs = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inRefs = trimmed === 'refs:' || trimmed.startsWith('refs:');
      continue;
    }
    if (!inRefs) continue;
    const match = /^([\w.-]+)\s*:\s*(.*)$/.exec(trimmed);
    if (!match || match[1] !== name) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return '';
}

/** 解析搜索 key：返回 { key, source }；key 只在这里出现，不落日志。 */
export function resolveSearchApiKey({ apiKey, env = process.env } = {}) {
  const fromParam = String(apiKey ?? '').trim();
  if (fromParam) return { key: fromParam, source: 'param' };
  const gatewayKey = String(env.GATEWAY_WEB_SEARCH_KEY ?? '').trim();
  if (gatewayKey) return { key: gatewayKey, source: 'env' };
  const keyFile = String(env.GATEWAY_WEB_SEARCH_KEY_FILE ?? '').trim();
  if (keyFile) {
    try {
      const value = fs.readFileSync(keyFile, 'utf8').trim();
      if (value) return { key: value, source: 'key-file' };
    } catch { /* 文件不存在 = 该来源没有 key，继续下一级 */ }
  }
  const deepseekEnv = String(env.DEEPSEEK_API_KEY ?? '').trim();
  if (deepseekEnv) return { key: deepseekEnv, source: 'env-deepseek' };
  const fromDsh = readDshCredentialRef('DEEPSEEK_API_KEY', env);
  if (fromDsh) return { key: fromDsh, source: 'dsh-credentials' };
  return { key: '', source: 'none' };
}

// ── SSRF 防护 ───────────────────────────────────────────────────────────────

/** 回环/内网/链路本地/CGNAT/唯一本地地址：key 一个字节都不发给它们。 */
export function isPrivateAddress(address) {
  const raw = String(address ?? '');
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  const lower = raw.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped) return isPrivateAddress(mapped[1]);
  if (lower === '::' || lower === '::1') return true;
  if (/^f[cd]/.test(lower)) return true;    // fc00::/7 unique local
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link local
  return false;
}

async function resolveEndpointAddresses(hostname) {
  if (net.isIP(hostname)) return [hostname];
  const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
}

/** 校验搜索端点：https + 无凭据 + 全部解析地址都是公网。返回 { url, addresses }。 */
export async function validateSearchEndpoint(baseURL) {
  let url;
  try {
    url = new URL(String(baseURL ?? '').trim());
  } catch {
    throw new Error('web-search: baseURL is invalid');
  }
  if (url.protocol !== 'https:') throw new Error('web-search: baseURL must be https (the API key must only be sent to encrypted endpoints)');
  if (url.username || url.password) throw new Error('web-search: baseURL must not contain credentials');
  const all = await resolveEndpointAddresses(url.hostname);
  const addresses = all.filter((address) => !isPrivateAddress(address));
  if (addresses.length === 0) {
    throw new Error(`web-search: baseURL resolves to no public address (${all.length} private), refusing to send the API key`);
  }
  return { url, addresses };
}

// ── 上游客户端（node:https，禁重定向，固定公网地址）────────────────────────

function postJsonOnce(url, address, { headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    let response;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(`web-search upstream timeout (${Math.round(timeoutMs / 1000)}s)`);
      finish(error);
      request?.destroy(error);
      response?.destroy();
    }, timeoutMs);
    try {
      // 传输层跟随端点协议：生产路径（validateEndpoint=true）强制 https；
      // http 只在测试逃生口（validateEndpoint=false 指向本地假上游）出现。
      const transport = url.protocol === 'http:' ? http : https;
      request = transport.request({
        hostname: address,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          ...headers,
          host: url.host,
          'content-length': Buffer.byteLength(body),
        },
        // 证书校验用真实域名（SNI/Host 与站点一致），连接目标才是固定 IP。
        servername: url.hostname,
        rejectUnauthorized: true,
        timeout: timeoutMs,
      }, (res) => {
        response = res;
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) {
          finish(new Error(`web-search upstream returned a redirect (HTTP ${status}), refusing to follow`));
          res.destroy();
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            finish(new Error('web-search upstream response too large, aborted'));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', (error) => finish(error));
        res.on('aborted', () => finish(new Error('web-search upstream response aborted')));
        res.on('close', () => { if (!res.complete) finish(new Error('web-search upstream response aborted')); });
        res.on('end', () => {
          if (settled) return;
          finish(null, { status, text: Buffer.concat(chunks).toString('utf8') });
        });
      });
      request.on('timeout', () => {
        const error = new Error(`web-search upstream timeout (${Math.round(timeoutMs / 1000)}s)`);
        finish(error);
        request.destroy(error);
        response?.destroy();
      });
      request.on('error', (error) => finish(error));
      request.end(body);
    } catch (error) {
      finish(error);
      request?.destroy();
    }
  });
}

/** 依次尝试前两个已校验地址（同一失败形态：DNS 先给 IPv6、本机没有 IPv6 出口）。 */
async function postJson(url, addresses, options) {
  const list = (Array.isArray(addresses) ? addresses : [addresses]).filter(Boolean);
  if (list.length === 0) throw new Error('web-search: no usable endpoint address');
  const deadline = Date.now() + options.timeoutMs;
  const attempts = Math.min(list.length, 2);
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 500) break;
    const budget = attempts === 1 ? options.timeoutMs : Math.min(remaining, Math.ceil(options.timeoutMs / 2));
    try {
      return await postJsonOnce(url, list[i], { ...options, timeoutMs: budget });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('web-search upstream request failed');
}

// ── 响应映射（参照 DSH 的 dsh-web-search-deepseek 实现口径）────────────────

function normalizeSearchUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  // DeepSeek 的结果 URL 会带 `#1` 这类「第几条」锚点（不是页面真实片段），去掉；
  // 真实的 `#section` 可能有意义，所以只去纯数字锚点。
  const cleaned = s.replace(/#\d+$/, '');
  try {
    const url = new URL(cleaned);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

/** 把 Anthropic Messages 响应映射成统一结果。没有结果块 = 显式报错（不静默）。 */
export function mapDeepSeekResponse(response, maxResults) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  const resultBlocks = blocks.filter((block) => block?.type === 'web_search_tool_result');
  if (resultBlocks.length === 0) {
    throw new Error('web-search upstream returned no web_search_tool_result (search may not have been triggered)');
  }
  const snippets = new Map();
  for (const block of blocks) {
    if (block?.type !== 'text') continue;
    for (const cite of block.citations ?? []) {
      const url = normalizeSearchUrl(cite?.url);
      if (!url || snippets.has(url)) continue;
      const text = String(cite?.cited_text ?? '').trim();
      if (text) snippets.set(url, text);
    }
  }
  const seen = new Set();
  const results = [];
  for (const block of resultBlocks) {
    for (const item of block?.content ?? []) {
      if (item?.type !== 'web_search_result') continue;
      const url = normalizeSearchUrl(item.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const title = String(item.title ?? '').trim().slice(0, 200);
      const snippet = String(snippets.get(url) ?? '').trim().slice(0, 500);
      results.push({
        title,
        url,
        ...(snippet ? { snippet } : {}),
        ...(item.page_age ? { publishedAt: String(item.page_age).slice(0, 40) } : {}),
      });
      if (results.length >= maxResults) return results;
    }
  }
  return results;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * @param {object} options
 * @param {string} [options.apiKey] 显式注入的 DeepSeek key（组合根注入时优先）
 * @param {string} [options.baseUrl] 覆盖端点（默认 DeepSeek 官方；测试注入假上游）
 * @param {string} [options.model]
 * @param {number} [options.maxResults] 默认返回条数（1..20，默认 8）
 * @param {number} [options.timeoutMs] 单次请求缺省超时（ctx.budget 优先取小）
 * @param {boolean} [options.validateEndpoint] SSRF 防护开关（仅测试注入假上游时关闭）
 * @param {(line: string) => void} [options.logger]
 */
export function createWebSearchExecutor({
  apiKey,
  baseUrl,
  model,
  maxResults = 8,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  validateEndpoint = true,
  env = process.env,
  logger = () => {},
} = {}) {
  const resolved = resolveSearchApiKey({ apiKey, env });
  if (!resolved.key) {
    // 没凭据 = 装配错误而不是运行时降级：调用方（main.mjs）据此跳过注册——
    // 模型工具面宁可缺 chat_web_search，也不放一个必然失败的占位工具。
    throw new TypeError('createWebSearchExecutor: no web-search API key resolved (set GATEWAY_WEB_SEARCH_KEY / GATEWAY_WEB_SEARCH_KEY_FILE / DEEPSEEK_API_KEY)');
  }
  const resolvedBase = String(baseUrl ?? env.GATEWAY_WEB_SEARCH_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const resolvedModel = String(model ?? env.GATEWAY_WEB_SEARCH_MODEL ?? DEFAULT_MODEL);

  let failures = 0;
  let disabledUntil = 0;
  let openCount = 0;
  const cache = new Map(); // `${maxResults}|${query}` -> { at, value }

  function available() {
    return Date.now() >= disabledUntil;
  }

  function noteFailure(error) {
    failures += 1;
    if (failures < BREAKER_FAILURES) return;
    openCount += 1;
    disabledUntil = Date.now() + BREAKER_COOLDOWN_MS * Math.min(openCount, 10);
    failures = 0;
    logger(`web-search upstream failing repeatedly, circuit open ${Math.round((disabledUntil - Date.now()) / 1000)}s (${error?.message ?? error})`);
  }

  async function searchDeepSeek(query, budgetMs) {
    let endpoint;
    if (validateEndpoint) {
      endpoint = await validateSearchEndpoint(resolvedBase);
    } else {
      // 测试逃生口：假上游跑在 http://127.0.0.1 上，跳过 SSRF 校验。
      endpoint = { url: new URL(resolvedBase), addresses: [new URL(resolvedBase).hostname] };
    }
    const target = new URL(`${endpoint.url.toString().replace(/\/+$/, '')}/messages`);
    const body = JSON.stringify({
      model: resolvedModel,
      max_tokens: MAX_TOKENS,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }],
      }],
      tools: [{ type: SEARCH_TOOL_TYPE, name: 'web_search', max_uses: MAX_USES }],
    });
    const response = await postJson(target, endpoint.addresses, {
      headers: {
        // key 只进这两个头；错误信息只回显 HTTP 状态与主体里的简短描述，
        // 绝不拼接请求头（里面是 key）。
        'x-api-key': resolved.key,
        authorization: `Bearer ${resolved.key}`,
        'anthropic-version': DEFAULT_API_VERSION,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'agent-gateway-web-search/0.1.0',
      },
      body,
      timeoutMs: budgetMs,
    });
    if (response.status < 200 || response.status >= 300) {
      let detail = '';
      try {
        const parsed = JSON.parse(response.text);
        const message = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message ?? parsed?.message;
        if (typeof message === 'string') detail = message.slice(0, 200);
      } catch { /* 主体不是 JSON 就只回状态码 */ }
      throw new Error(`web-search upstream HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      throw new Error('web-search upstream returned an unparseable response');
    }
    return mapDeepSeekResponse(parsed, maxResults);
  }

  async function searchCached(query, resultLimit, budgetMs) {
    const cacheKey = `${resultLimit}|${query}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    const value = { query, provider: 'deepseek', results: await searchDeepSeek(query, budgetMs) };
    // 空结果必须显式说明：模型分不清「真没搜到」和「搜索接口静默失效」，
    // 不给 note 它会一直换词重试。注意先加 note 再进缓存（缓存存引用）。
    if (value.results.length === 0) {
      value.note = '没有搜到结果（可换个说法/加限定词；仍为空就不要再重复搜索）';
    }
    cache.set(cacheKey, { at: Date.now(), value });
    if (cache.size > CACHE_MAX_ENTRIES) {
      for (const key of [...cache.keys()].slice(0, cache.size - CACHE_MAX_ENTRIES)) cache.delete(key);
    }
    return value;
  }

  return registerExecutor({
    name: 'web-search',
    actions: ['web_search'],
    tools: [{
      name: 'chat_web_search',
      description: '[读] 联网搜索：DeepSeek 联网搜索（与 DSH 同源），返回 {title,url,snippet} 列表；适合时效性问题与事实核查，群聊内容不需要传进来',
      action: 'web_search',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 200, description: '搜索词' },
          maxResults: { type: 'integer', minimum: 1, maximum: 20, description: '返回条数上限，默认 8' },
        },
      },
    }],
    call: async ({ action, ctx }) => {
      if (action !== 'web_search') {
        return { ok: false, degraded: true, code: 'E_UNSUPPORTED', message: `web-search does not own action "${action}"` };
      }
      const query = String(ctx.payload?.query ?? '').trim();
      if (!query) return { ok: false, degraded: true, code: 'E_ACTION', message: 'query is required' };
      if (query.length > 200) return { ok: false, degraded: true, code: 'E_ACTION', message: 'query exceeds 200 characters' };
      const resultLimit = clampInt(ctx.payload?.maxResults, 1, 20, maxResults);
      // 请求超时取「配置上限」与「tool-host 预算」的较小者：预算是硬约束。
      const granted = Number(ctx.budget?.timeoutMs);
      const budgetMs = Number.isFinite(granted) && granted > 0 ? Math.min(granted, timeoutMs) : timeoutMs;
      if (!available()) {
        return {
          ok: false, degraded: true, code: 'E_PLATFORM',
          message: `web-search circuit open, retry in ${Math.ceil((disabledUntil - Date.now()) / 1000)}s`,
        };
      }
      try {
        const value = await searchCached(query, resultLimit, budgetMs);
        failures = 0;
        disabledUntil = 0;
        return { ok: true, receipt: value };
      } catch (error) {
        noteFailure(error);
        return {
          ok: false, degraded: true, code: 'E_PLATFORM',
          message: String(error?.message ?? 'web search failed'),
        };
      }
    },
  });
}
