/**
 * rolecard-mcp 人格块渲染客户端（V2 P3）。
 *
 * 来源：原 rolecard-tools.mjs 中的 client/renderer 随内置 chat_role_* 工具面
 * 一并退役——工具面改由服务登记文件声明、经 ToolHost 服务执行器动态路由
 * （docs/design/GATEWAY_V2_REFACTOR.md §3/§4 P3）。persona 内置管线步骤
 * （退役前的回退形态，shadow-cutover 后删除）仍需要这份 renderer，所以单独
 * 保留在此，与 executor 契约（executor-interface）解耦。
 *
 * 分层：只依赖 node: 内置 + shared/http-client（与 memory-tools 时代的口径一致）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpClient } from '../shared/http-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_TIMEOUT_MS = 8000;
const BREAKER_FAILURES = 3;
const BREAKER_COOLDOWN_MS = 60 * 1000;

function readTokenFile(candidates) {
  for (const file of candidates.filter(Boolean)) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch { /* 缺令牌时由服务端决定是否校验 */ }
  }
  return '';
}

/** rolecard-mcp 上游客户端（连接走共享 http-client；熔断内置，调用方按需 noteFailure）。 */
export function createRolecardClient({
  baseUrl,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = () => {},
} = {}) {
  const resolvedBaseUrl = String(baseUrl ?? process.env.ROLECARD_MCP_URL ?? 'http://127.0.0.1:7182').replace(/\/+$/, '');
  const resolvedToken = String(token ?? process.env.ROLECARD_MCP_TOKEN ?? '')
    || readTokenFile([path.resolve(ROOT, '..', 'rolecard-mcp', 'state', 'http-token')]);

  let failures = 0;
  let disabledUntil = 0;
  let openCount = 0;

  function available() {
    return Date.now() >= disabledUntil;
  }

  function noteFailure(error) {
    failures += 1;
    if (failures < BREAKER_FAILURES) return;
    openCount += 1;
    disabledUntil = Date.now() + BREAKER_COOLDOWN_MS * Math.min(openCount, 10);
    failures = 0;
    logger?.(`rolecard-mcp 连续失败，熔断 ${Math.round((disabledUntil - Date.now()) / 1000)}s（${error?.message ?? error}）`);
  }

  const http = createHttpClient({ baseUrl: resolvedBaseUrl, timeoutMs });

  async function request(route, { method = 'POST', query = {}, body = {} } = {}) {
    if (!available()) throw new Error('rolecard-mcp circuit open');
    const pathname = method === 'GET'
      ? `${route}?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString()}`
      : route;
    const res = await http.request(method, pathname, method === 'POST' ? body : undefined, {
      headers: resolvedToken ? { 'x-mcp-token': resolvedToken } : {},
    });
    if (!res.ok) {
      throw new Error(res.status === 0
        ? `rolecard-mcp ${route}: ${res.error}`
        : `rolecard-mcp ${route} -> HTTP ${res.status}${res.body?.error ? `: ${res.body.error}` : ''}`);
    }
    failures = 0;
    disabledUntil = 0;
    return res.body;
  }

  return { request, available, noteFailure };
}

/**
 * persona 渲染器（装配点注入 persona section 用）：拉人格块文本，
 * 空文本返回 null（section 缺席）；失败原样抛出（section 记 degraded）。
 */
export function createRolecardRenderer(options = {}) {
  const client = createRolecardClient(options);
  return async function renderPersona() {
    try {
      const data = await client.request('/api/blocks/render', { body: { mode: 'v1' } });
      const blocks = Array.isArray(data?.blocks) ? data.blocks : [];
      const persona = blocks.find((block) => block?.name === '人格')?.text ?? '';
      return persona.trim() || null;
    } catch (error) {
      client.noteFailure(error);
      throw error;
    }
  };
}
