/**
 * V2 客户端通道：WebSocket 长连接枢纽（core，基于 ws 包）。
 *
 * 为什么要 WS：消费者（V2 词典，原「适配器」）与装饰器/过滤器服务的通讯是
 * 高频双向流（入站、动作回执、service.call），HTTP 逐请求 HMAC 握手浪费大。
 * WS 建连一次、签名验一次，之后帧内走业务；HTTP 端点全部保留为备用。
 *
 * 实现边界（读这里之前先读 docs/design/GATEWAY_V2_REFACTOR.md）：
 *   - 帧编解码/分片/ping-pong/close 交给 ws 包（v0.2 起不再手写 RFC6455，
 *     「零依赖」约束已按 2026-11-06 决定放宽为「协议一律走库」——见 §2）；
 *   - maxPayload 仍钉在 4MB，超限由 ws 以 1009 关闭；
 *   - 鉴权在 upgrade 握手：query 带 adapterId/ts/nonce/sign，签名格式与
 *     auth.mjs 的 v1 完全一致（body 为空串），nonce 防重放共用语义。
 *   - 回环-only 外壳不变：非回环来源在握手时直接拒绝（server.mjs 同口径）。
 *   - 本文件不 import 上层模块；入站消费以注入的 handler 出现（依赖方向不变，
 *     test-layering 钉住）。
 */
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { isLoopbackAddress } from './net.mjs';
import { AuthError, safeEqualHex } from './auth.mjs';
import { ContractError, parseInbound } from './contracts.mjs';

const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/**
 * WS 枢纽。挂在给定的 http server 上（upgrade 事件），管理客户端连接并把
 * 业务帧交给注入的 handler。
 *
 * @param {object} options
 * @param {import('node:http').Server} options.server     已存在的 http server
 * @param {string}   options.path                         upgrade 路径（如 /v1/ws）
 * @param {Map<string,object>} options.clientsById        消费者/服务登记表（config.adapters 建出）
 * @param {ReturnType<import('./auth.mjs').createNonceCache>} options.nonceCache
 * @param {Function} options.onInbound                    (parsed envelope) → {turnId,status,...}
 * @param {Function} [options.logger]
 * @param {object}   [options.metrics]                    createMetrics 实例
 * @param {Function} [options.now]
 * @param {number}   [options.heartbeatMs]
 * @param {number}   [options.replayWindowMs]
 */
export function createWsHub({
  server, path, clientsById, nonceCache, onInbound,
  logger = () => {}, metrics = null, now = Date.now,
  heartbeatMs = 30000, replayWindowMs = 5 * 60 * 1000,
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  /** @type {Map<string, Set<object>>} adapterId → 连接集合（同客户端允许并发重连） */
  const byId = new Map();
  /** V2 P2：service.call 在途请求（callId → pending）。连接断开/超时都要清理。 */
  const pendingCalls = new Map();
  /** 进入过 handleUpgrade 的 socket 台账：upgrade 请求的 socket 会被 Node 摘出
   *  HTTP 连接追踪，server.closeAllConnections() 管不到它们；close() 必须自己清。 */
  const sockets = new Set();
  const openedAt = now();

  function inc(event) {
    metrics?.inc('gateway_ws_total', { event });
  }

  /** 握手鉴权：签名格式与 auth.mjs v1 一致（body 为空串）。失败不细分原因。 */
  function verifyHandshake(url) {
    const id = url.searchParams.get('adapterId');
    const tsRaw = url.searchParams.get('ts');
    const nonce = url.searchParams.get('nonce');
    const sign = url.searchParams.get('sign');
    if (!id || !tsRaw || !nonce || !sign) throw new AuthError('E_AUTH', 'missing handshake params');
    const client = clientsById.get(id);
    if (!client) throw new AuthError('E_AUTH', 'unknown client');
    const ts = Number(tsRaw);
    if (!Number.isSafeInteger(ts) || Math.abs(now() - ts) > replayWindowMs) {
      throw new AuthError('E_REPLAY', 'handshake timestamp outside the replay window');
    }
    const bodyHash = crypto.createHash('sha256').update('').digest('hex');
    const expected = crypto.createHmac('sha256', client.secret)
      .update(`${ts}\n${nonce}\n${bodyHash}`, 'utf8').digest('hex');
    // 常数时间比较：与 HTTP 侧 verifyRequest 同口径。`!==` 会按字节提前返回，
    // 让本机进程可以通过握手耗时逐字节猜签名。
    if (!sign.startsWith('v1=') || !safeEqualHex(sign.slice(3), expected)) {
      throw new AuthError('E_AUTH', 'bad handshake signature');
    }
    if (!nonceCache.check(`ws:${id}:${nonce}`, now())) {
      throw new AuthError('E_REPLAY', 'handshake nonce already used');
    }
    return client;
  }

  function sendJson(entry, payload) {
    if (entry.ws.readyState !== 1 /* WebSocket.OPEN */) return;
    entry.ws.send(JSON.stringify(payload));
  }

  /** 连接断开时拒掉该连接上的全部在途请求（service.call / action；调用方走 degraded 放行）。 */
  function rejectPendingFor(entry, error) {
    for (const [callId, pending] of pendingCalls) {
      if (pending.entry !== entry) continue;
      clearTimeout(pending.timer);
      pendingCalls.delete(callId);
      pending.reject(error);
    }
  }

  function detach(entry) {
    const set = byId.get(entry.id);
    if (set) {
      set.delete(entry);
      if (set.size === 0) byId.delete(entry.id);
    }
    clearTimeout(entry.heartbeat);
    rejectPendingFor(entry, new ContractError('E_DISABLED', 'ws connection closed while a call was pending'));
    inc('disconnect');
  }

  function armHeartbeat(entry) {
    clearTimeout(entry.heartbeat);
    entry.heartbeat = setTimeout(() => {
      if (entry.ws.readyState !== 1) return;
      // 无帧超时：客户端必须对应用层 ping 回 pong（或发任意帧）。连续两个心跳
      // 周期没有任何入站帧 = 半开连接（掉电/NAT 超时/进程挂死），此时「连接
      // 存在」是假象——auto 选路会一直选它，每条调用都要等满超时。
      const silentMs = now() - (entry.lastFrameAt ?? 0);
      if (silentMs > heartbeatMs * 2) {
        inc('stale');
        logger(`ws client silent for ${silentMs}ms, terminating: ${entry.id}`);
        try { entry.ws.terminate(); } catch { /* 已断开 */ }
        return;
      }
      sendJson(entry, { v: 1, type: 'ping', at: now() });
      armHeartbeat(entry);
    }, heartbeatMs);
    entry.heartbeat.unref?.();
  }

  function handleUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== path) return; // 其他路径的 upgrade：没有监听者，客户端会自己失败
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const fail = (code, reason) => {
      // 用 end() 而不是 write()+destroy()：destroy 会丢弃未刷出的写缓冲，
      // 客户端收不到拒绝响应就会一直等在握手上（实测 Windows 必现）。
      socket.end(`HTTP/1.1 ${code} ${reason}\r\nconnection: close\r\n\r\n`);
    };
    try {
      // 回环-only 外壳与 HTTP 路由同口径。
      if (!isLoopbackAddress(socket.remoteAddress)) {
        inc('reject');
        fail(403, 'Forbidden');
        return;
      }
      const client = verifyHandshake(url);
      if (typeof req.headers['sec-websocket-key'] !== 'string'
        || !String(req.headers.upgrade ?? '').toLowerCase().includes('websocket')) {
        fail(400, 'Bad Request');
        return;
      }
      // 鉴权通过才把连接交给 ws 包完成 RFC6455 升级（accept 头等由它负责）。
      wss.handleUpgrade(req, socket, head, (ws) => {
        const entry = {
          id: client.id,
          kind: client.kind,
          platform: client.platform,
          ws,
          heartbeat: null,
          // 应用层心跳判活：任何入站帧（含 pong）都会刷新它。
          lastFrameAt: now(),
        };
        if (!byId.has(client.id)) byId.set(client.id, new Set());
        byId.get(client.id).add(entry);
        inc('connect');
        logger(`ws client connected: ${client.id} (kind=${client.kind}, transport=ws)`);
        ws.on('message', (data) => dispatch(entry, Buffer.from(data)));
        ws.on('error', () => detach(entry));
        ws.on('close', () => detach(entry));
        armHeartbeat(entry);
      });
    } catch (error) {
      inc('reject');
      logger(`ws handshake rejected: ${error?.message ?? error}`);
      fail(401, 'Unauthorized');
    }
  }

  function dispatch(entry, payload) {
    entry.lastFrameAt = now();
    let message;
    try {
      message = JSON.parse(payload.toString('utf8'));
    } catch {
      inc('error');
      sendJson(entry, { v: 1, type: 'error', ok: false, error: { code: 'E_SCHEMA', message: 'frame is not valid JSON' } });
      return;
    }
    if (message?.type === 'ping') {
      sendJson(entry, { v: 1, type: 'pong', at: now() });
      return;
    }
    if (message?.type === 'service.call/result' || message?.type === 'tool.call/result') {
      const kind = message.type === 'tool.call/result' ? 'tool.call' : 'service.call';
      const pending = typeof message.callId === 'string' ? pendingCalls.get(message.callId) : null;
      // 未知/过期/连接不符的回执：只计数不打断——伪造帧不该影响别的调用。
      if (!pending || pending.entry !== entry || (pending.kind && pending.kind !== kind)) {
        inc('error');
        return;
      }
      clearTimeout(pending.timer);
      pendingCalls.delete(message.callId);
      if (kind === 'tool.call') {
        // tool.call 的业务失败（ok:false + error）是正常结果而非传输错误——
        // 原样回传（与 toolResultSchema 同形状），callId 核对在 registry 做。
        pending.resolve({
          callId: message.callId,
          ok: message.ok === true,
          data: message.data,
          error: message.error,
        });
      } else if (message.ok) {
        pending.resolve(message.result ?? null);
      } else {
        pending.reject(new ContractError(
          message.error?.code ?? 'E_INTERNAL',
          String(message.error?.message ?? 'service.call failed'),
        ));
      }
      return;
    }
    if (message?.type === 'action/result') {
      const pending = typeof message.callId === 'string' ? pendingCalls.get(message.callId) : null;
      // 与 service.call 同口径：未知/过期/连接不符的回执只计数（伪造帧不影响别的调用）。
      if (!pending || pending.entry !== entry || pending.kind !== 'action') {
        inc('error');
        return;
      }
      clearTimeout(pending.timer);
      pendingCalls.delete(message.callId);
      // 原样回传：actionId 一致性自检由调用方（executor 侧 WS 投递包装）做。
      pending.resolve(message);
      return;
    }
    if (message?.type === 'inbound') {
      inc('inbound');
      // 请求关联 id：客户端生成并通过帧带回；旧客户端没有 callId 时 ack 也不带，
      // 由客户端退回 FIFO。网关只做原样回带，不参与生成。
      const callId = typeof message.callId === 'string' && message.callId.length > 0
        ? message.callId : null;
      const ackBase = {
        v: 1,
        type: 'inbound/ack',
        ...(callId ? { callId } : {}),
        // 归属回带：客户端可据此发现「ack 来自别的连接」（同 id 多连接时）。
        adapterId: entry.id,
      };
      try {
        const parsed = parseInbound(message.envelope);
        // 平台绑定：握手验过身份，这里再钉一次 platform 声明（route 消费者无平台，不限）。
        if (entry.platform && parsed.platform !== entry.platform) {
          throw new AuthError('E_AUTH', 'client is not bound to the declared platform');
        }
        // 消费者归属：信封里的 adapterId 必须与握手身份一致。旧信封可能不带该
        // 字段（此时以握手身份为准）；带上却不一致的，是伪造或串号。
        if (parsed.adapterId && parsed.adapterId !== entry.id) {
          throw new AuthError('E_AUTH', 'envelope adapterId does not match the handshake identity');
        }
        // 第二参把归属传给 core：幂等键按消费者隔离（同平台多适配器不互相吞消息）。
        const result = onInbound(parsed, entry);
        sendJson(entry, { ...ackBase, ok: true, ...result });
      } catch (error) {
        inc('error');
        const code = error instanceof AuthError || error instanceof ContractError
          ? error.code : 'E_INTERNAL';
        sendJson(entry, {
          ...ackBase, ok: false,
          error: { code, message: String(error?.message ?? error) },
        });
      }
      return;
    }
    sendJson(entry, { v: 1, type: 'error', ok: false, error: { code: 'E_SCHEMA', message: `unknown frame type: ${String(message?.type)}` } });
  }

  server.on('upgrade', handleUpgrade);

  return {
    path,
    /** 网关主动向某客户端推帧（P2 起用于 action / service.call；无连接返回 false）。 */
    sendTo(id, payload) {
      const set = byId.get(id);
      if (!set || set.size === 0) return false;
      let sent = false;
      for (const entry of set) {
        if (entry.ws.readyState === 1) {
          entry.ws.send(JSON.stringify(payload));
          sent = true;
        }
      }
      return sent;
    },

    /** 该客户端当前是否有可用（OPEN）连接——service-registry 的 auto 判定用。 */
    isConnected(id) {
      const set = byId.get(id);
      return Boolean(set && [...set].some((entry) => entry.ws.readyState === 1));
    },

    /**
     * V2 P2：向客户端发起一次 service.call 并等待回执（请求-响应关联）。
     * 帧形态：出 `{ v:1, type:'service.call', ...request }`，
     * 回 `{ v:1, type:'service.call/result', callId, ok, result?|error? }`。
     * 超时/连接断开/重复 callId 都以 ContractError 拒绝，由调用方（service-registry）
     * 统一翻译成 degraded。响应体的契约校验在 registry 做（本层只管传输）。
     *
     * @param {string} id         客户端（服务）id
     * @param {object} request    必须含 callId（调用方生成）
     * @param {number} timeoutMs
     * @param {'service.call'|'tool.call'} [kind] 帧类型（V2 P3 加 tool.call：
     *        出 `{v:1, type:'tool.call', ...}`，回 `{v:1, type:'tool.call/result', callId, ok, data?|error?}`，
     *        失败回执作为结果原样回传）
     */
    callService(id, request, timeoutMs = 8000, kind = 'service.call') {
      return new Promise((resolve, reject) => {
        const set = byId.get(id);
        const entry = set ? [...set].find((e) => e.ws.readyState === 1) : null;
        if (!entry) {
          reject(new ContractError('E_DISABLED', `no open ws connection for "${id}"`));
          return;
        }
        const callId = request?.callId;
        if (typeof callId !== 'string' || !callId) {
          reject(new ContractError('E_SCHEMA', 'service.call request requires callId'));
          return;
        }
        if (pendingCalls.has(callId)) {
          reject(new ContractError('E_DUP', `duplicate service.call id: ${callId}`));
          return;
        }
        const timer = setTimeout(() => {
          pendingCalls.delete(callId);
          reject(new ContractError('E_TIMEOUT', `${kind} "${callId}" to "${id}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
        pendingCalls.set(callId, { entry, resolve, reject, timer, kind });
        sendJson(entry, { v: 1, type: kind, ...request });
      });
    },

    /**
     * 动作下行（网关 → 消费者，与 service.call 同构的请求-响应关联）：
     * 出 `{ v:1, type:'action', callId, envelope, sign }`，
     * 回 `{ v:1, type:'action/result', callId, ...receipt }`。
     *
     * 为什么帧里还要带 `sign`：动作会真实外发消息（高风险），不能只靠握手身份
     * ——帧级签名 + nonce 防重放（与 HTTP /v1/actions 同公式），消费者侧用
     * 同一 verify 实现校验（gateway-actions.handleFrame）。
     *
     * 超时/断开/重复 callId 都以 ContractError 拒绝，调用方（组合根的
     * deliverActionWithWs）据此回落 HTTP。
     */
    callAction(id, { callId, envelope, sign }, timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        const set = byId.get(id);
        const entry = set ? [...set].find((e) => e.ws.readyState === 1) : null;
        if (!entry) {
          reject(new ContractError('E_DISABLED', `no open ws connection for "${id}"`));
          return;
        }
        if (typeof callId !== 'string' || !callId) {
          reject(new ContractError('E_SCHEMA', 'action request requires callId'));
          return;
        }
        if (pendingCalls.has(callId)) {
          reject(new ContractError('E_DUP', `duplicate action id: ${callId}`));
          return;
        }
        const timer = setTimeout(() => {
          pendingCalls.delete(callId);
          reject(new ContractError('E_TIMEOUT', `action "${callId}" to "${id}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
        pendingCalls.set(callId, { entry, resolve, reject, timer, kind: 'action' });
        sendJson(entry, { v: 1, type: 'action', callId, envelope, sign });
      });
    },
    status() {
      return {
        path,
        clients: [...byId.values()].reduce((sum, set) => sum + set.size, 0),
        consumerIds: [...byId.keys()],
        uptimeMs: now() - openedAt,
      };
    },
    close() {
      // 先拒掉在途请求再拆连接，调用方不等 close 回调就能收到失败。
      for (const pending of pendingCalls.values()) {
        clearTimeout(pending.timer);
        pending.reject(new ContractError('E_DISABLED', 'ws hub closed while service.call pending'));
      }
      pendingCalls.clear();
      for (const set of byId.values()) {
        for (const entry of set) {
          entry.ws.close(1001);
          clearTimeout(entry.heartbeat);
        }
      }
      byId.clear();
      // 含被拒握手的半开 socket：一律销毁，server 'close' 事件才能触发。
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.off('upgrade', handleUpgrade);
      wss.close();
    },
  };
}
