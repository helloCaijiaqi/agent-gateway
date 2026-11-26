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

/**
 * 从角色卡 frontmatter 解析 aliases 列表（可选数据约定，2026-11-26 TTS 角色链路）：
 *   ---
 *   aliases:
 *     - 别名一
 *     - 别名二
 *   ---
 * 无 frontmatter / 无 aliases 键 / 解析失败都返回 []（只用卡名匹配）。
 */
export function parseRolecardAliases(content) {
  const text = String(content ?? '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return [];
  const block = match[1];
  // 行表式（- 每行一项）
  const lines = [];
  let inList = false;
  for (const line of block.split(/\r?\n/)) {
    if (/^aliases\s*:/.test(line)) { inList = true; continue; }
    if (inList) {
      const item = /^\s+-\s*(.+?)\s*$/.exec(line);
      if (item) { lines.push(item[1].replace(/^['"]|['"]$/g, '')); continue; }
      if (/\S/.test(line)) break;
    }
  }
  // 流式 [a, b] 写法
  const inline = /^aliases\s*:\s*\[([^\]]*)\]/m.exec(block);
  const source = inline
    ? inline[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    : lines;
  return source.map((s) => String(s ?? '').trim()).filter(Boolean);
}

/**
 * TTS 角色 身份提供者（2026-11-26 链路传递，不写死配置）：
 * gateway tool-host 代理 chat_voice_synthesize 时拉当前角色卡名 + frontmatter aliases
 * 作为 personaKeywords 注入调用链（DSH→gateway→memory），角色身份随 current-role.json
 * 切换自动跟随。60s TTL 缓存；rolecard-mcp 不可用/未设置当前卡时返回 null（静默跳过，
 * 熔断复用 client 既有机制）。
 */
export function createVoicePersonaProvider({
  baseUrl,
  token,
  timeoutMs,
  logger = () => {},
  ttlMs = 60_000,
} = {}) {
  const client = createRolecardClient({ baseUrl, token, timeoutMs, logger });
  let cache = null; // { keywords: string[], fetchedAt }
  return async function fetchVoicePersona() {
    if (cache && Date.now() - cache.fetchedAt < ttlMs) return cache.keywords;
    try {
      const roles = await client.request('/api/roles', { method: 'GET' });
      const current = String(roles?.current ?? '').trim();
      if (!current) { cache = { keywords: [], fetchedAt: Date.now() }; return null; }
      let aliases = [];
      try {
        const detail = await client.request('/api/role/get', { method: 'GET', query: { name: current } });
        aliases = parseRolecardAliases(detail?.content);
      } catch { /* 卡详情拉不到只退化用卡名，不影响注入 */ }
      const keywords = [current, ...aliases].filter(Boolean);
      cache = { keywords, fetchedAt: Date.now() };
      logger(`voice persona resolved: ${JSON.stringify(keywords)}`);
      return keywords.length ? keywords : null;
    } catch (error) {
      client.noteFailure(error);
      return null;
    }
  };
}
