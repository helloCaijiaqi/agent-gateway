// V2 客户端通道测试：ws-hub 的握手鉴权、inbound 帧契约与生命周期。
// 帧编解码自 v0.2 起由 ws 包承担（服务端）；这里保留一个客户端侧的最小解析器，
// 用于断言服务端出站帧（不掩码的 RFC6455 文本/close 帧）。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { loadConfig } = await import(new URL('../src/core/config.mjs', import.meta.url).href);
const { createGatewayServer } = await import(new URL('../src/core/server.mjs', import.meta.url).href);

const SECRET = 'adapter-secret-0123456789';

/** 客户端侧最小帧解析：只解析服务端出站帧（不掩码），返回 {fin, opcode, payload, next}。 */
function decodeFrame(buffer, offset = 0) {
  if (buffer.length - offset < 2) return null;
  const first = buffer[offset];
  const second = buffer[offset + 1];
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  let len = second & 0x7f;
  let pos = offset + 2;
  if (len === 126) {
    if (buffer.length - pos < 2) return null;
    len = buffer.readUInt16BE(pos);
    pos += 2;
  } else if (len === 127) {
    if (buffer.length - pos < 8) return null;
    len = Number(buffer.readBigUInt64BE(pos));
    pos += 8;
  }
  if (buffer.length - pos < len) return null;
  return { fin, opcode, masked: (second & 0x80) !== 0, payload: buffer.subarray(pos, pos + len), next: pos + len };
}

/** 客户端出站 close 帧（必须掩码）。 */
function clientCloseFrame(code = 1000) {
  const body = Buffer.alloc(2);
  body.writeUInt16BE(code);
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  return Buffer.concat([Buffer.from([0x88, 0x80 | 2]), mask, masked]);
}

// ---------------------------------------------------------------- 测试用 WS 客户端

function clientTextFrame(text) {
  const data = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(data);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  const header = data.length < 126
    ? Buffer.from([0x81, 0x80 | data.length])
    : Buffer.from([0x81, 0x80 | 126, data.length >> 8, data.length & 0xff]);
  return Buffer.concat([header, mask, masked]);
}

function handshakeQuery(secret, id, { ts = Date.now(), nonce = crypto.randomBytes(12).toString('hex'), sign } = {}) {
  const bodyHash = crypto.createHash('sha256').update('').digest('hex');
  const signature = sign ?? 'v1=' + crypto.createHmac('sha256', secret).update(`${ts}\n${nonce}\n${bodyHash}`, 'utf8').digest('hex');
  return `adapterId=${id}&ts=${ts}&nonce=${nonce}&sign=${encodeURIComponent(signature)}`;
}

function connectWs(port, pathWithQuery) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1', port, path: pathWithQuery,
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': key, 'sec-websocket-version': '13' },
    });
    req.on('upgrade', (res, socket, head) => {
      const conn = { socket, buffer: head && head.length > 0 ? head : Buffer.alloc(0), frames: [], cursor: {}, closed: false };
      socket.on('data', (chunk) => {
        conn.buffer = Buffer.concat([conn.buffer, chunk]);
        let offset = 0;
        while (offset < conn.buffer.length) {
          const frame = decodeFrame(conn.buffer, offset);
          if (!frame) break;
          offset = frame.next;
          if (frame.opcode === 8) { conn.closed = true; continue; }
          if (frame.opcode === 1) conn.frames.push(JSON.parse(frame.payload.toString('utf8')));
        }
        conn.buffer = conn.buffer.subarray(offset);
      });
      // 不挂 error 处理器的话，RST 会以 uncaughtException 的形式炸掉测试进程。
      socket.on('error', (e) => { conn.error = e; });
      // 服务端 terminate() 是直接断 TCP（不发 close 帧），判活测试要靠这个事件。
      socket.on('close', () => { conn.closed = true; });
      resolve(conn);
    });
    req.on('response', (res) => {
      res.resume();
      reject(new Error(`handshake rejected: ${res.statusCode}`));
    });
    req.on('error', reject);
    req.end();
  });
}

function send(conn, obj) {
  conn.socket.write(clientTextFrame(JSON.stringify(obj)));
}

async function waitFor(conn, type, timeoutMs = 2000) {
  // 按类型维护游标：find() 会永远命中第一帧，导致「第二次 ack」的断言
  // 实际比较的是第一次的帧（deduped=false），测试自身产生假失败。
  conn.cursor[type] ??= 0;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const idx = conn.frames.findIndex((f, i) => i >= conn.cursor[type] && f.type === type);
    if (idx >= 0) {
      conn.cursor[type] = idx + 1;
      return conn.frames[idx];
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for frame type=${type}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function makeEnvelope(platform, adapterId, messageId) {
  return {
    v: 1, platform, adapterId, traceId: `t-${messageId}`, receivedAt: Date.now(),
    conversation: { kind: 'group', id: '1' },
    message: { id: messageId, sender: { id: 'u1', name: 'U', roles: ['member'] }, text: 'hi' },
    prompt: { text: 'p' },
  };
}

async function startServer(mode, adapters, extraEnv = {}) {
  // 临时 stateDir：幂等账本/turn 落盘默认在仓库 state/ 下且跨进程持久，
  // 不隔离的话上一次运行的幂等键会让「首次提交」直接 deduped=true。
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'gw-ws-test-'));
  const config = loadConfig({
    env: { GATEWAY_MODE: mode, GATEWAY_WS: 'on', GATEWAY_WS_HEARTBEAT_MS: '5000', ...extraEnv },
    adapters,
    stateDir,
  });
  const gateway = createGatewayServer({ config, logger: () => {} });
  await gateway.listen();
  return { gateway, port: gateway.server.address().port };
}

const ADAPTERS = [
  { id: 'qq-main', platform: 'qq', secret: SECRET },
  { id: 'route-main', kind: 'route', secret: SECRET },
];

// ---------------------------------------------------------------- 端到端

test('ws hub: 握手 + inbound ack + 幂等去重 + ping/pong + 未知帧 + 主动关闭', async () => {
  const { gateway, port } = await startServer('shadow', ADAPTERS);
  try {
    const conn = await connectWs(port, `/v1/ws?${handshakeQuery(SECRET, 'qq-main')}`);

    send(conn, { v: 1, type: 'inbound', envelope: makeEnvelope('qq', 'qq-main', 'm1') });
    const ack = await waitFor(conn, 'inbound/ack');
    assert.equal(ack.ok, true);
    assert.equal(ack.status, 'shadow');
    assert.equal(ack.deduped, false);

    // 同一信封重发：幂等去重（WS 与 HTTP 共用 handleInbound 的幂等键）。
    send(conn, { v: 1, type: 'inbound', envelope: makeEnvelope('qq', 'qq-main', 'm1') });
    const dup = await waitFor(conn, 'inbound/ack');
    assert.equal(dup.turnId, ack.turnId);
    assert.equal(dup.deduped, true);

    send(conn, { v: 1, type: 'ping' });
    assert.equal((await waitFor(conn, 'pong')).type, 'pong');

    send(conn, { v: 1, type: 'nonsense' });
    assert.equal((await waitFor(conn, 'error')).error.code, 'E_SCHEMA');

    conn.socket.write(clientCloseFrame(1000));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(conn.closed, true, '服务端回应 close');
    conn.socket.destroy();

    const health = await fetch(`http://127.0.0.1:${port}/v1/health`).then((r) => r.json());
    assert.equal(health.ws.path, '/v1/ws');
    assert.equal(health.ws.clients, 0, '关闭后连接数归零');
  } finally {
    await gateway.close();
  }
});

test('ws hub: route 消费者不受平台绑定；platform 客户端跨平台声明帧级被拒', async () => {
  const { gateway, port } = await startServer('shadow', ADAPTERS);
  try {
    // route 消费者没有平台，可提交任意平台的信封。
    const route = await connectWs(port, `/v1/ws?${handshakeQuery(SECRET, 'route-main')}`);
    send(route, { v: 1, type: 'inbound', envelope: makeEnvelope('qq', 'route-main', 'r1') });
    assert.equal((await waitFor(route, 'inbound/ack')).ok, true);

    // platform 客户端提交别的平台：ack 带回 E_AUTH（不断连接，帧级拒绝）。
    const bound = await connectWs(port, `/v1/ws?${handshakeQuery(SECRET, 'qq-main')}`);
    send(bound, { v: 1, type: 'inbound', envelope: makeEnvelope('wx', 'qq-main', 'w1') });
    const refused = await waitFor(bound, 'inbound/ack');
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'E_AUTH');
    for (const conn of [route, bound]) conn.socket.destroy();
  } finally {
    await gateway.close();
  }
});

test('ws hub: 坏签名与重放 nonce 在握手层被拒（无 upgrade）', async () => {
  const { gateway, port } = await startServer('shadow', ADAPTERS);
  try {
    const badSign = 'v1=' + '0'.repeat(64);
    await assert.rejects(
      () => connectWs(port, `/v1/ws?${handshakeQuery(SECRET, 'qq-main', { sign: badSign })}`),
      /handshake rejected: 401/,
    );
    // 同一 nonce 第二次握手：重放拒绝。
    const sharedNonce = crypto.randomBytes(12).toString('hex');
    const query = () => handshakeQuery(SECRET, 'qq-main', { nonce: sharedNonce });
    const conn = await connectWs(port, `/v1/ws?${query()}`);
    conn.socket.destroy();
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(
      () => connectWs(port, `/v1/ws?${query()}`),
      /handshake rejected: 401/,
    );
    // 未登记的客户端：同样 401（不泄露「谁存在」）。
    await assert.rejects(
      () => connectWs(port, `/v1/ws?${handshakeQuery(SECRET, 'ghost')}`),
      /handshake rejected: 401/,
    );
  } finally {
    await gateway.close();
  }
});

test('ws hub: mode=off 时入站帧回 E_DISABLED；hub 不影响 HTTP 兼容', async () => {
  const { gateway, port } = await startServer('off', ADAPTERS);
  try {
    const conn = await connectWs(port, `/v1/ws?${handshakeQuery(SECRET, 'qq-main')}`);
    send(conn, { v: 1, type: 'inbound', envelope: makeEnvelope('qq', 'qq-main', 'm2') });
    const refused = await waitFor(conn, 'inbound/ack');
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'E_DISABLED');
    conn.socket.destroy();

    // HTTP 备用通道不受影响（off 模式下 /v1/inbound 503 的语义不变）。
    const res = await fetch(`http://127.0.0.1:${port}/v1/health`).then((r) => r.json());
    assert.equal(res.ok, true);
    assert.equal(res.ws.mode, 'on');
  } finally {
    await gateway.close();
  }
});

test('ws hub: action 下行帧 + action/result 关联（错 kind / 超时拒绝）', async () => {
  const { gateway, port } = await startServer('shadow', ADAPTERS);
  try {
    const conn = await connectWs(port, `/v1/ws?${handshakeQuery(SECRET, 'qq-main')}`);
    const envelope = { v: 1, actionId: 'act-1', type: 'send_text' };
    const sign = { ts: Date.now(), nonce: 'n-1', signature: 'v1=deadbeef' };

    // 1) 正常关联：出 action 帧 → 回 action/result → callAction resolve 回执原文。
    const pending = gateway.ws.callAction('qq-main', { callId: 'act-1', envelope, sign }, 1000);
    const frame = await waitFor(conn, 'action');
    assert.equal(frame.callId, 'act-1');
    assert.deepEqual(frame.envelope, envelope);
    assert.deepEqual(frame.sign, sign);
    send(conn, { v: 1, type: 'action/result', callId: 'act-1', actionId: 'act-1', ok: true });
    const receipt = await pending;
    assert.equal(receipt.v, 1);
    assert.equal(receipt.actionId, 'act-1');
    assert.equal(receipt.ok, true);

    // 2) 错 kind 的回执不能解决 action 调用（service.call/result 携带同 callId 应被忽略）。
    const wrongKind = gateway.ws.callAction('qq-main', { callId: 'act-2', envelope: { v: 1, actionId: 'act-2' }, sign }, 150);
    await waitFor(conn, 'action');
    send(conn, { v: 1, type: 'service.call/result', callId: 'act-2', ok: true, result: {} });
    await assert.rejects(() => wrongKind, /timed out/);

    // 3) 无回执 → E_TIMEOUT（调用方据此回落 HTTP）。
    await assert.rejects(
      () => gateway.ws.callAction('qq-main', { callId: 'act-3', envelope: { v: 1, actionId: 'act-3' }, sign }, 80),
      /timed out/,
    );

    // 4) 无连接 → E_DISABLED（auto 回落判定同源）。
    await assert.rejects(
      () => gateway.ws.callAction('not-connected', { callId: 'act-4', envelope: {}, sign }, 80),
      /no open ws connection/,
    );
    conn.socket.destroy();
  } finally {
    await gateway.close();
  }
});

test('ws hub: inbound ack 回带 callId/adapterId，幂等键按消费者隔离', async () => {
  const { gateway, port } = await startServer('shadow', ADAPTERS);
  try {
    const a = await connectWs(port, `/v1/ws?${handshakeQuery(SECRET, 'qq-main')}`);
    // route 消费者（platform=null）：与 qq-main 同一条消息，用于验证幂等键隔离
    // （config 不允许同平台两个消息适配器，route 是唯一可共存身份）。
    const b = await connectWs(port, `/v1/ws?${handshakeQuery(SECRET, 'route-main')}`);

    // 1) ack 原样回带 callId 与握手身份（客户端据此精确关联 + 发现串号）。
    send(a, { v: 1, type: 'inbound', callId: 'c-1', envelope: makeEnvelope('qq', 'qq-main', 'm-1') });
    const ack = await waitFor(a, 'inbound/ack');
    assert.equal(ack.callId, 'c-1');
    assert.equal(ack.adapterId, 'qq-main');
    assert.equal(ack.ok, true);
    assert.equal(ack.deduped, false);

    // 2) 另一个消费者上报同一条消息：不能被 A 的幂等键吞掉。
    send(b, { v: 1, type: 'inbound', callId: 'c-2', envelope: makeEnvelope('qq', 'route-main', 'm-1') });
    const ackAlt = await waitFor(b, 'inbound/ack');
    assert.equal(ackAlt.callId, 'c-2');
    assert.equal(ackAlt.adapterId, 'route-main');
    assert.equal(ackAlt.deduped, false, '不同消费者同名消息不得互相去重');

    // 3) 同一消费者重发：仍然 deduped（幂等语义未被放宽）。
    send(a, { v: 1, type: 'inbound', callId: 'c-3', envelope: makeEnvelope('qq', 'qq-main', 'm-1') });
    const ackAgain = await waitFor(a, 'inbound/ack');
    assert.equal(ackAgain.deduped, true);

    // 4) 信封 adapterId 与握手身份不一致：帧级拒绝，且 ack 仍回带 callId。
    send(a, { v: 1, type: 'inbound', callId: 'c-4', envelope: makeEnvelope('qq', 'route-main', 'm-9') });
    const mismatch = await waitFor(a, 'inbound/ack');
    assert.equal(mismatch.callId, 'c-4');
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.error.code, 'E_AUTH');

    // 5) 旧客户端不带 callId：ack 也不带（FIFO 兜底路径），行为与升级前一致。
    send(a, { v: 1, type: 'inbound', envelope: makeEnvelope('qq', 'qq-main', 'm-10') });
    const legacyAck = await waitFor(a, 'inbound/ack');
    assert.equal(legacyAck.callId, undefined);
    assert.equal(legacyAck.ok, true);

    a.socket.destroy();
    b.socket.destroy();
  } finally {
    await gateway.close();
  }
});

test('ws hub: 连续两个心跳周期无入站帧 → terminate 半开连接', async () => {
  const { createWsHub } = await import(new URL('../src/core/ws-hub.mjs', import.meta.url).href);
  const { createNonceCache } = await import(new URL('../src/core/auth.mjs', import.meta.url).href);
  const server = http.createServer((req, res) => res.end('ok'));
  // 直连 hub：heartbeatMs 走默认下限之外的小值（配置层限 [5000,300000]，
  // 这里为了测试压缩到 40ms，验证的是 hub 自身的判活逻辑）。
  const hub = createWsHub({
    server,
    path: '/v1/ws',
    clientsById: new Map([['qq-main', { id: 'qq-main', platform: 'qq', secret: SECRET }]]),
    nonceCache: createNonceCache({ capacity: 100 }),
    onInbound: () => ({ turnId: 't', status: 'shadow' }),
    heartbeatMs: 40,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const conn = await connectWs(server.address().port, `/v1/ws?${handshakeQuery(SECRET, 'qq-main')}`);
    // 不回 pong、不发任何帧：两个周期（80ms）后应被 terminate。
    const deadline = Date.now() + 1500;
    while (!conn.closed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(conn.closed, true, '静默连接应在两个心跳周期后被关闭');
  } finally {
    hub.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('signActionFrame: 帧签名附带 bodyHash，验签方无需重新序列化', async () => {
  const { signActionFrame } = await import(
    new URL('../src/executors/adapter-tools/common/crypto.mjs', import.meta.url).href
  );
  const envelope = {
    v: 1, actionId: 'a-1', type: 'send_text',
    target: { platform: 'qq', kind: 'group', conversationId: '1' },
    payload: { text: 'hi' }, idempotencyKey: 'i-1',
  };
  const sign = signActionFrame({ secret: SECRET, envelope });
  assert.match(sign.bodyHash, /^[0-9a-f]{64}$/);
  assert.equal(
    sign.bodyHash,
    crypto.createHash('sha256').update(JSON.stringify(envelope), 'utf8').digest('hex'),
    'bodyHash 必须是信封序列化文本的摘要',
  );
  const expected = crypto.createHmac('sha256', SECRET)
    .update(`${sign.ts}\n${sign.nonce}\n${sign.bodyHash}`, 'utf8')
    .digest('hex');
  assert.equal(sign.signature, `v1=${expected}`);
});
