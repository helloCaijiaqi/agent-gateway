/**
 * 网关自建的最小 DSH 客户端（协议复核基线：DSH 0.1.5-rc.1，与 qq-bridge
 * `src/dsh-client.js` 同源同协议，按 runtime 需要精简，**刻意不跨包 import**）。
 *
 * 覆盖面（也只覆盖这些——多出来的能力都不该在这里）：
 *   - 鉴权：离线铸造浏览器会话 Cookie（主路径）/ launch token 交换（兜底）；
 *   - unary RPC：session.create / prompt / selectModel / projections / updateQueue /
 *     cancel，workspace.create / archiveSession，agentPresets.list，$events/result
 *     （respondEvent：审批/提问应答，docs/console/dsh-pending/PLAN.md 应答阶段）；
 *   - 事件流：/api/remote.mux 一条 WebSocket，按会话开 session/follow 流 +
 *     $events 流（提问/审批），断线自动重连并重放 follow。
 *
 * 与 bridge 版的差异（都是刻意删减，不是遗漏）：
 *   - 不做 onEnvelope 遥测、不做 tokenLedger（那是适配器/网关的账，不是协议层的事）；
 *   - 不做 follow 快照的 records 回填（网关是新会话的权威，不需要历史）；
 *   - mux 用回调而不是 async generator（turn 等待者是常驻的，generator 语义反而别扭）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import YAML from 'js-yaml';
import { WebSocket } from 'ws';
import { createHttpClient } from '../shared/http-client.mjs';

/** 低层原始通道（完整 URL，供鉴权链的 token 交换与 401 重试使用）。 */
const rawHttp = createHttpClient({});

export const MINTED_COOKIE_LIFETIME_MS = 60 * 60 * 1000;
const MINTED_COOKIE_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const BROWSER_SESSION_KEY = 'client-connection/browser-session';
const COOKIE_PAYLOAD_VERSION = 1;
const COOKIE_PREFIX = 'dsh-auth-';
const SECRET_BYTES = 32;
/** session/follow 开场快照携带的历史事件条数（只影响首帧大小）。 */
const FOLLOW_SNAPSHOT_MESSAGES = 50;

export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

const base64url = (buffer) => Buffer.from(buffer).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

export function readBrowserSessionSecret() {
  try {
    const doc = YAML.load(fs.readFileSync(path.join(resolveDshHome(), '.credentials.yaml'), 'utf8'));
    const record = doc?.records?.[BROWSER_SESSION_KEY];
    if (record?.kind !== 'grant' || record?.payload?.version !== 1) return null;
    const secret = record.payload.secret;
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]+$/.test(secret)) return null;
    const decoded = Buffer.from(secret.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
    return decoded.byteLength === SECRET_BYTES ? decoded : null;
  } catch {
    return null;
  }
}

export function mintBrowserSessionCookie(baseUrl, secret, { lifetimeMs = MINTED_COOKIE_LIFETIME_MS } = {}) {
  const authority = new URL(String(baseUrl)).host;
  if (!authority) throw new Error('DSH baseUrl has no authority');
  const issuedAt = Date.now();
  const expiresAt = issuedAt + lifetimeMs;
  const body = base64url(Buffer.from(JSON.stringify({
    version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt,
  }), 'utf8'));
  const signature = base64url(createHmac('sha256', secret).update(body).digest());
  const name = COOKIE_PREFIX + base64url(createHash('sha256').update(authority).digest());
  return `${name}=v1.${body}.${signature}`;
}

export function isLoopbackBase(baseUrl) {
  try {
    const host = new URL(String(baseUrl)).hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host === '::1' || host === '[::1]') return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  } catch {
    return false;
  }
}

/** session/projections 投影值 → 待处理 inbox 项 id 列表（退役前清队列用）。 */
export function inboxItemIdsOf(values) {
  if (values === null || typeof values !== 'object') return [];
  const inbox = values.inbox;
  if (inbox === undefined) return [];
  if (inbox === null || typeof inbox !== 'object' || Array.isArray(inbox)) {
    throw new Error('invalid session inbox projection');
  }
  const ids = [];
  for (const boundary of ['next-turn', 'next-step']) {
    const list = inbox[boundary];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error('invalid session inbox projection');
    for (const item of list) {
      if (typeof item?.id !== 'string' || !item.id) throw new Error('invalid session inbox item');
      ids.push(item.id);
    }
  }
  return ids;
}

/**
 * 取一条会话事件携带的 provider usage（原始桶，未归一化）。
 * 与 DSH `usageOf(event)` 同义：assistant/message 优先 data.usage，
 * 否则回落到 assistant/attempt / assistant/message 的 stream 尾部采样。
 */
export function usageOfEvent(event) {
  if (!event || typeof event !== 'object') return undefined;
  if (event.type === 'assistant/message' && event.data?.usage !== undefined) return event.data.usage;
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined;
  const stream = event.data?.stream;
  if (!Array.isArray(stream)) return undefined;
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const chunk = stream[i];
    if (chunk && typeof chunk === 'object' && chunk.usage !== undefined) return chunk.usage;
  }
  return undefined;
}

/**
 * 在会话事件流里收集一次 turn 的 assistant 文本与 usage
 * （忽略 assistant/chunk 防文本翻倍）。
 *
 * usage 是网关 token 账本的唯一数据源（桥接不再看 mux）：一轮里可能有多条
 * assistant/message（工具循环），取**最后一条**非空采样——与 DSH 的
 * `lastAssistantStreamChunk(stream,'usage')` 同语义。
 */
export function createTurnCollector() {
  const turns = new Map();
  return {
    feed(event) {
      const type = event?.type;
      if (type === 'turn/start') {
        turns.set(event.data?.turn, { text: '', usage: undefined });
        return null;
      }
      if (type === 'assistant/message') {
        const entry = turns.get(event.data?.turn);
        if (!entry) return null;
        for (const block of event.data?.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') entry.text += block.text;
        }
        const usage = usageOfEvent(event);
        if (usage !== undefined) entry.usage = usage;
        return null;
      }
      if (type === 'turn/end') {
        const entry = turns.get(event.data?.turn);
        turns.delete(event.data?.turn);
        return {
          turn: event.data?.turn,
          reason: event.data?.reason,
          text: entry?.text ?? '',
          usage: usageOfEvent(event) ?? entry?.usage,
        };
      }
      return null;
    },
    get size() { return turns.size; },
  };
}

export class DshApiError extends Error {
  constructor(label, code, message) {
    super(`${label} failed: ${code}: ${message}`);
    this.name = 'DshApiError';
    this.code = code;
  }
}

export class DshClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl        DSH 基址（默认 http://127.0.0.1:3080）
   * @param {string} [options.authToken]    显式 launch token（为空则离线铸造优先）
   * @param {boolean} [options.allowRemote] 允许把 launch token 发往非回环地址
   * @param {number} [options.timeoutMs]
   * @param {Function} [options.logger]
   * @param {{secret?: Buffer|null}} [options.authOverride] 测试注入：跳过凭据文件
   */
  constructor({
    baseUrl = 'http://127.0.0.1:3080',
    authToken = '',
    allowRemote = false,
    timeoutMs = 30000,
    logger = () => {},
    authOverride,
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.launchToken = authToken;
    this.tokenExplicit = authToken !== '';
    this.allowRemote = allowRemote === true;
    this._secret = authOverride ? (authOverride.secret ?? null) : undefined; // undefined=未探测
    this.cookie = null;
    this.cookiePromise = null;
    this._cookieExpiresAt = 0;
    this._strategy = null;
    this._preferToken = false;
    // mux：期望 follow 的会话集合跨重连保留；onFrame 由上层注入。
    this._desiredFollows = new Set();
    this._onFrame = null;
    this._muxState = 'stopped'; // stopped | connecting | open
    this._muxWanted = false;
    this._muxSocket = null;
    this._muxGeneration = 0;
    this._backoffMs = 3000;
  }

  browserSessionSecret() {
    if (this._secret === undefined) this._secret = readBrowserSessionSecret();
    return this._secret;
  }

  hasAuth() {
    return Boolean(this.launchToken) || this.browserSessionSecret() !== null;
  }

  invalidateAuth() {
    this.cookie = null;
    this.cookiePromise = null;
    this._cookieExpiresAt = 0;
    this._secret = this._secret === undefined ? undefined : this._secret;
    // 凭据文件可能在 DSH 首次启动后才写入：只有「探测过且没有覆写」时才重探。
    if (!this._authOverrideUsed) this._secret = undefined;
    this._strategy = null;
  }

  _mintCookie(secret) {
    this.cookie = mintBrowserSessionCookie(this.baseUrl, secret);
    this._cookieExpiresAt = Date.now() + MINTED_COOKIE_LIFETIME_MS;
    this._strategy = 'minted';
    return this.cookie;
  }

  /** 换取或铸造会话 Cookie（铸造优先，见 bridge 版注释；策略切换只在真 401 时发生）。 */
  async ensureAuth(signal) {
    signal?.throwIfAborted();
    if (this.cookie && this._strategy !== 'minted') return this.cookie;
    if (this.cookie && Date.now() < this._cookieExpiresAt - MINTED_COOKIE_REFRESH_MARGIN_MS) return this.cookie;
    this.cookie = null;
    const secret = this.browserSessionSecret();
    const canMint = secret !== null && isLoopbackBase(this.baseUrl);
    if (canMint && !this._preferToken && !this.tokenExplicit) return this._mintCookie(secret);
    if (!this.launchToken) {
      if (canMint) return this._mintCookie(secret);
      throw new Error(
        'DSH 鉴权不可用：既没有 launch token（GATEWAY_DSH_TOKEN），也读不到 '
        + `${path.join(resolveDshHome(), '.credentials.yaml')} 的 ${BROWSER_SESSION_KEY} 密钥。`,
      );
    }
    if (!this.allowRemote && !isLoopbackBase(this.baseUrl)) {
      throw new Error(`拒绝把 DSH launch token 发往非本机地址（${this.baseUrl}）；确需远程请在配置显式 allowRemote`);
    }
    if (this.cookiePromise) return this.cookiePromise;
    const promise = (async () => {
      const url = new URL(this.baseUrl);
      url.pathname = '/';
      url.search = '';
      url.searchParams.set('token', this.launchToken);
      const res = await rawHttp.requestRaw('GET', url, { maxRedirects: 0, timeoutMs: this.timeoutMs });
      const rawCookie = res.headers?.['set-cookie'];
      const setCookie = Array.isArray(rawCookie) ? rawCookie[0] : rawCookie;
      if (!res.ok || !setCookie) throw new Error(`DSH token exchange failed: HTTP ${res.status}`);
      this.cookie = String(setCookie).split(';')[0];
      this._strategy = 'token';
      return this.cookie;
    })();
    this.cookiePromise = promise;
    promise.then(() => { if (this.cookiePromise === promise) this.cookiePromise = null; },
      () => { if (this.cookiePromise === promise) this.cookiePromise = null; });
    return promise;
  }

  async _doFetchWithAuth(url, init, isRetry = false) {
    const headers = { ...(init?.headers ?? {}) };
    if (this.hasAuth()) {
      try {
        headers.cookie = await this.ensureAuth(init?.signal);
      } catch (error) {
        if (!isRetry && this.launchToken && /token exchange failed|invalidated during token exchange/i.test(error?.message ?? '')) {
          this._preferToken = false;
          this.invalidateAuth();
          return this._doFetchWithAuth(url, init, true);
        }
        throw error;
      }
    }
    init?.signal?.throwIfAborted();
    const response = await rawHttp.requestRaw(init?.method ?? 'GET', url, {
      headers,
      body: init?.body,
      timeoutMs: this.timeoutMs,
      signal: init?.signal,
    });
    if (!response.ok) throw new Error(`DSH request failed: ${response.error}`);
    if (!isRetry && response.status === 401 && this.hasAuth()) {
      if (this._strategy === 'minted' && this.launchToken) this._preferToken = true;
      else if (this._strategy === 'token') this._preferToken = false;
      this.invalidateAuth();
      return this._doFetchWithAuth(url, init, true);
    }
    return response;
  }

  /** unary RPC：POST /api/<endpoint>，信封形状与 DSH 0.1.2+ 协议一致。 */
  async callUnary(method, payload = {}, signal) {
    const endpoint = method.replaceAll('.', '/');
    let body = payload;
    if (endpoint === 'session/prompt' && typeof body.requestId !== 'string') {
      body = { ...body, requestId: randomUUID() };
    }
    const wrapper = endpoint === 'session/list' ? '_request' : (WRAPPERS_NULL.has(endpoint) ? null : 'request');
    const message = {
      type: 'client-request',
      rpcId: randomUUID(),
      method: endpoint,
      payload: wrapper === null ? { args: {} } : { args: { [wrapper]: body } },
    };
    const response = await this._doFetchWithAuth(`${this.baseUrl}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
      signal,
    });
    const full = await response.json();
    if (!full || full.type !== 'server-response' || full.rpcId !== message.rpcId || !full.result) {
      throw new Error(`invalid server-response for ${endpoint}`);
    }
    return { rpcId: full.rpcId, result: full.result };
  }

  unwrap(response, label) {
    if (response.result.ok) return response.result.value;
    const { code, message } = response.result.error;
    throw new DshApiError(label, code, message);
  }

  // ── 业务 RPC（只保留 runtime 用到的）─────────────────────────────────────

  async listPresets(signal) {
    const value = this.unwrap(await this.callUnary('agentPresets.list', {}, signal), 'agentPresets.list');
    const items = value?.presets ?? value?.items ?? value ?? [];
    return items.map((p) => p?.id ?? p?.presetId ?? String(p)).filter(Boolean);
  }

  /**
   * 模型目录（docs/console/dsh-sessions/PLAN.md）：groups[].models[]，每项带
   * reasoning.efforts[]（id/name/description）与 defaultEffort。活 DSH 告知
   * 的白名单优先于内置兜底。
   */
  async modelCatalog(signal) {
    const value = this.unwrap(await this.callUnary('session.modelCatalog', {}, signal), 'session.modelCatalog');
    return value?.catalog ?? value;
  }

  async ensureWorkspace(dir, signal) {
    fs.mkdirSync(dir, { recursive: true });
    const value = this.unwrap(await this.callUnary('workspace.create', { path: dir }, signal), 'workspace.create');
    return value.workspace.workspaceId;
  }

  async createSession({ workspaceId, agentPreset }, signal) {
    const params = { workspaceId };
    if (agentPreset) params.agentPreset = agentPreset;
    const value = this.unwrap(await this.callUnary('session.create', params, signal), 'session.create');
    return value.sessionId;
  }

  async selectModel(sessionId, { provider, model, reasoningEffort }, signal) {
    return this.callUnary('session.selectModel', { sessionId, provider, model, reasoningEffort }, signal);
  }

  async prompt({ sessionId, text, images = [] }, signal) {
    const content = [{ type: 'text', text }];
    for (const image of images) content.push(image);
    return this.callUnary('session.prompt', { sessionId, mode: 'queue', content }, signal);
  }

  /** 退役会话：清 pending inbox → 取消当前 turn → 归档。任一步失败都继续。 */
  async retireSession(sessionId, signal) {
    const sig = signal ?? AbortSignal.timeout(8000);
    try {
      const proj = await this.callUnary('session/projections', { sessionId }, sig);
      if (proj.result?.ok) {
        for (const itemId of [...new Set(inboxItemIdsOf(proj.result.value))]) {
          try {
            await this.callUnary('session/updateQueue', { sessionId, itemId, action: { kind: 'remove' } }, sig);
          } catch { /* 队列项可能已被 agent 取走 */ }
        }
      }
    } catch { /* projections 不可用不影响 cancel/archive */ }
    try {
      await this.callUnary('session/cancel', { sessionId }, sig);
    } catch { /* 会话可能已不存在 */ }
    try {
      await this.callUnary('workspace.archiveSession', { sessionId }, sig);
    } catch { /* 同上 */ }
    this.forget(sessionId);
  }

  /**
   * 应答未决事件（审批/提问）——DSH 0.1.5-rc.1 的 $events/result 通道。
   * 参数形状与 qq-bridge 回滚形态同源实测（快照仓 20261106-171804 的
   * dsh-client.js:622 respond + bridge.js cancelPendingEntry/handlePendingAnswer）：
   *   - 审批：outcome = { kind:'result', value: 'allowed-once' | 'rejected' }；
   *   - 提问：outcome = { kind:'result', value: { answers: [{ id, selected, custom? }] } }。
   * DSH 侧 result.ok=false 时抛错（透传 error.code/message）。
   */
  async respondEvent({ clientId, eventId, outcome }, signal) {
    const response = await this.callUnary('$events/result', { clientId, eventId, outcome }, signal);
    if (!response.result?.ok) {
      const { code, message } = response.result?.error ?? {};
      throw new Error(`$events/result rejected${code ? ` (${code})` : ''}: ${message ?? 'unknown error'}`);
    }
    return response.result;
  }

  // ── 事件流（/api/remote.mux）──────────────────────────────────────────────

  follow(sessionId) {
    this._desiredFollows.add(String(sessionId));
    if (this._muxState === 'open') this._openFollow(String(sessionId));
  }

  forget(sessionId) {
    this._desiredFollows.delete(String(sessionId));
  }

  /**
   * 启动 mux 连接（幂等）。断线按退避重连并重放全部 follow。
   * @param {Function} onFrame - 收到信封 `{payload}` 时的回调
   *   （payload.type：session/event | session/snapshot | approval/requested | question/requested | stream/error）。
   */
  startStream(onFrame) {
    this._onFrame = onFrame;
    if (this._muxWanted) return;
    this._muxWanted = true;
    this._connectLoop();
  }

  stopStream() {
    this._muxWanted = false;
    this._muxGeneration += 1;
    try { this._muxSocket?.close(); } catch { /* already closed */ }
    this._muxSocket = null;
    this._muxState = 'stopped';
  }

  /** 事件流是否处于已连接状态（健康检查用；从未连接/重连中均为 false）。 */
  get connected() { return this._muxState === 'open'; }

  async _connectLoop() {
    const generation = ++this._muxGeneration;
    while (this._muxWanted && generation === this._muxGeneration) {
      try {
        await this._connectOnce(generation);
        this._backoffMs = 3000;
      } catch (error) {
        if (generation !== this._muxGeneration) return;
        this.logger(`mux connection failed: ${error?.message ?? error}; retry in ${this._backoffMs}ms`);
        await new Promise((r) => setTimeout(r, this._backoffMs));
        this._backoffMs = Math.min(this._backoffMs * 2, 60000);
      }
    }
  }

  async _connectOnce(generation) {
    await this.ensureAuth();
    const url = new URL('/api/remote.mux', this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, { headers: { cookie: this.cookie } });
    this._muxSocket = socket;
    const followed = new Set();
    const streamToSession = new Map();
    let eventStreamId = null;
    let eventClientId = null;

    const openFollow = (sessionId) => {
      if (socket.readyState !== 1 || followed.has(sessionId)) return;
      const streamId = randomUUID();
      streamToSession.set(streamId, sessionId);
      followed.add(sessionId);
      socket.send(JSON.stringify({
        type: 'open', streamId, endpoint: 'session/follow',
        payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages: FOLLOW_SNAPSHOT_MESSAGES } } },
      }));
    };
    this._openFollow = openFollow;

    const emit = (payload) => { try { this._onFrame?.(payload); } catch (error) { this.logger(`onFrame handler error: ${error?.message ?? error}`); } };

    await new Promise((resolveConnected, rejectFailed) => {
      const onOpen = () => {
        if (generation !== this._muxGeneration) { try { socket.close(); } catch {} return; }
        this._muxState = 'open';
        // 重放全部期望 follow（跨重连保留）——少了这步，DSH 重启后所有会话静默失联。
        for (const sessionId of this._desiredFollows) openFollow(sessionId);
        const eventsStreamId = randomUUID();
        eventStreamId = eventsStreamId;
        try {
          socket.send(JSON.stringify({ type: 'open', streamId: eventsStreamId, endpoint: '$events', payload: { args: {} } }));
        } catch (error) {
          rejectFailed(error);
          return;
        }
        resolveConnected();
      };
      const onMessage = (event) => {
        let msg;
        try {
          if (typeof event.data !== 'string') throw new Error('binary frame');
          msg = JSON.parse(event.data);
          if (!msg || typeof msg.type !== 'string' || typeof msg.streamId !== 'string') throw new Error('unexpected frame');
        } catch (error) {
          this.logger(`dropping malformed mux frame: ${error?.message ?? error}`);
          return;
        }
        const sessionId = streamToSession.get(msg.streamId);
        const isEventStream = msg.streamId === eventStreamId;
        if (msg.type === 'item') {
          if (isEventStream && msg.value) {
            const value = msg.value;
            if (value.type === 'ready') {
              eventClientId = value.clientId;
            } else if (value.type === 'waterfall' && eventClientId && value.event === 'approval/request') {
              emit({
                type: 'approval/requested',
                sessionId: value.agentId, clientId: eventClientId, eventId: value.eventId,
                toolName: value.request?.toolName, callId: value.request?.callId, reason: value.request?.reason,
              });
            } else if (value.type === 'waterfall' && eventClientId && value.event === 'user-questions/request') {
              emit({
                type: 'question/requested',
                sessionId: value.agentId, clientId: eventClientId, eventId: value.eventId,
                questions: value.request?.questions,
              });
            }
          } else if (sessionId && msg.value?.type === 'event') {
            emit({ type: 'session/event', sessionId, event: msg.value.event });
          } else if (sessionId && msg.value?.type === 'snapshot') {
            emit({ type: 'session/snapshot', sessionId, snapshot: msg.value });
          }
        } else if (msg.type === 'end') {
          if (isEventStream) {
            eventStreamId = null;
            eventClientId = null;
            socket.close(); // 提问/审批通道失联不能静默：整条重连
          } else if (sessionId) {
            streamToSession.delete(msg.streamId);
            followed.delete(sessionId);
            // 服务端回收单会话流（归档/空闲清理）：仍想订阅的会话主动重开。
            if (this._desiredFollows.has(sessionId) && socket.readyState === 1) {
              setTimeout(() => { if (socket.readyState === 1 && this._desiredFollows.has(sessionId)) openFollow(sessionId); }, 2000);
            }
          }
        } else if (msg.type === 'error') {
          if (isEventStream) {
            eventStreamId = null;
            eventClientId = null;
            socket.close();
          } else if (sessionId) {
            streamToSession.delete(msg.streamId);
            followed.delete(sessionId);
            if (msg.error?.code === 'session/not-found') {
              this._desiredFollows.delete(sessionId);
            } else {
              emit({ type: 'stream/error', sessionId, error: msg.error });
            }
          }
        }
      };
      const onDown = () => {
        socket.removeEventListener('message', onMessage);
        this._muxState = 'connecting';
        this.invalidateAuth();
        // resolve 交给 _connectLoop 走下一轮重连；已连接后断开不算失败。
        resolveConnected();
      };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('message', onMessage);
      socket.addEventListener('close', onDown, { once: true });
      socket.addEventListener('error', (event) => {
        if (this._muxState !== 'open') rejectFailed(event?.message ? new Error(String(event.message)) : new Error('websocket error'));
        onDown();
      }, { once: true });
    });
  }
}

const WRAPPERS_NULL = new Set(['agentPresets/list', 'settings/describe']);
