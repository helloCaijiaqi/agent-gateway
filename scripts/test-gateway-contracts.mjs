// 网关 P0 契约回归：schema、HMAC 双向互认、重放、幂等、落盘、健康探测。
//
// 离线运行：不发 QQ 消息、不碰 DSH、不用生产凭据（密钥是测试内生成的随机串，
// state 目录指向系统临时目录）。
//
// 这个测试同时是两侧签名实现的「互认测试」：
//   - 网关侧鉴权：本包 `src/auth.mjs`
//   - 适配器侧客户端：`../qq-bridge/src/gateway/gateway-client.js`（本地签名，不 import 本包）
// 任何一侧单独改动签名格式都会在这里失败——这就是跨包解耦后的契约钉子。
//
// 运行：npm test（agent-gateway 包内）；qq-bridge 的 test:audit 通过包装脚本转发到这里。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {
  ContractError,
  inboundIdempotencyKey,
  parseAction,
  parseInbound,
  parseReceipt,
  sessionKeyOf,
  validateActionPayload,
} = await import(new URL('../src/core/contracts.mjs', import.meta.url).href);
const { AuthError, createNonceCache, signRequest, verifyRequest } = await import(new URL('../src/core/auth.mjs', import.meta.url).href);
const { createIdempotency } = await import(new URL('../src/core/idempotency.mjs', import.meta.url).href);
const { loadConfig } = await import(new URL('../src/core/config.mjs', import.meta.url).href);
const { createGatewayServer } = await import(new URL('../src/core/server.mjs', import.meta.url).href);
const { createGatewayClient } = await import(new URL('../../qq-bridge/src/gateway/gateway-client.js', import.meta.url).href);

const SECRET = 'test-secret-0123456789abcdef';
const NOW = 1_762_300_000_000;

function baseEnvelope(overrides = {}) {
  return {
    v: 1,
    platform: 'qq',
    adapterId: 'qq-test',
    traceId: '01JTESTTRACE',
    receivedAt: NOW,
    conversation: { kind: 'group', id: '123456' },
    message: {
      id: '7412',
      sender: { id: '10001', name: '张三', roles: ['member'] },
      text: '在吗',
      mentions: [],
    },
    ...overrides,
  };
}

function tmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-test-'));
}

// ---------------------------------------------------------------- contracts

test('inbound: 合法信封通过，并派生出会话键与幂等键', () => {
  const envelope = parseInbound(baseEnvelope());
  assert.equal(envelope.message.text, '在吗');
  assert.equal(sessionKeyOf(envelope), 'qq:group:123456');
  assert.equal(inboundIdempotencyKey(envelope), 'qq:group:123456:7412');
});

test('inbound: 未知字段与坏类型被拒绝（strict）', () => {
  assert.throws(() => parseInbound(baseEnvelope({ platform: 'telegram' })), ContractError);
  assert.throws(() => parseInbound(baseEnvelope({ extra: true })), ContractError);
  assert.throws(() => parseInbound(baseEnvelope({
    message: { id: '1', sender: { id: 'a', name: 'b', roles: ['admin'] }, text: '' },
  })), /roles/i);
  assert.throws(() => parseInbound(baseEnvelope({ v: 2 })), ContractError);
});

test('inbound: 合成唤醒事件（kind=event + wake）通过，坏标记被拒绝', () => {
  const event = parseInbound(baseEnvelope({
    kind: 'event',
    wake: {
      kind: 'wait', status: 'arrived', purpose: 'messages',
      registeredAt: NOW - 1000, expiresAt: NOW + 29_000, baselineSeq: 7, satisfiedSeq: 9,
    },
    message: {
      id: 'wait-1',
      sender: { id: '0', name: 'wait-scheduler', roles: ['bot'] },
      text: '(wait satisfied: 2 new message(s))',
    },
    snapshot: [{ at: '12:00', sender: '张三', text: '在吗' }],
  }));
  assert.equal(event.kind, 'event');
  assert.equal(event.wake.kind, 'wait');
  assert.equal(event.wake.baselineSeq, 7);
  // 合成事件不带 prompt.text（prompt 由网关按 wake + snapshot 合成）。
  assert.equal(event.prompt, undefined);
  // 幂等键落到合成消息 id 上：同一条唤醒重投不会开第二个 turn。
  assert.equal(inboundIdempotencyKey(event), 'qq:group:123456:wait-1');
  // 普通入站也可以带 wake（例如「这条消息正好满足了等待」），kind 不必是 event。
  assert.equal(parseInbound(baseEnvelope({ wake: { kind: 'wait' } })).wake.status, undefined);

  assert.throws(() => parseInbound(baseEnvelope({ kind: 'event', wake: { kind: 'timer' } })), ContractError);
  assert.throws(() => parseInbound(baseEnvelope({ wake: { kind: 'wait', extra: 1 } })), ContractError);
  assert.throws(() => parseInbound(baseEnvelope({ kind: 'synthetic' })), ContractError);
  assert.throws(() => parseInbound(baseEnvelope({ wake: { kind: 'wait', baselineSeq: -1 } })), ContractError);
});

test('action: payload 按 type 二次校验', () => {
  const action = (payload, type = 'send_text') => ({
    v: 1, actionId: 'a1', turnId: 't1', type,
    target: { platform: 'qq', conversationId: '123' },
    payload, idempotencyKey: 't1:c1',
  });
  assert.equal(validateActionPayload({ type: 'send_text', payload: { text: 'hi' } }), null);
  assert.match(validateActionPayload({ type: 'send_text', payload: {} }), /text/);
  assert.match(validateActionPayload({ type: 'wait', payload: { timeoutMs: 999999 } }), /timeoutMs/);
  assert.equal(validateActionPayload({ type: 'noop', payload: {} }), null);
  assert.throws(() => parseAction(action({})), /text/);
  assert.throws(() => parseAction(action({}, 'teleport')), ContractError);
});

test('receipt: 失败回执必须带 error', () => {
  assert.doesNotThrow(() => parseReceipt({ v: 1, actionId: 'a', ok: true, at: NOW }));
  assert.throws(() => parseReceipt({ v: 1, actionId: 'a', ok: false, at: NOW }), /error/i);
  assert.doesNotThrow(() => parseReceipt({
    v: 1, actionId: 'a', ok: false, at: NOW,
    error: { code: 'E_PLATFORM', message: 'rate limited' },
  }));
});

// -------------------------------------------------------------------- auth

test('auth: 签名互认 + 重放拒绝 + 平台绑定', () => {
  const nonceCache = createNonceCache({ now: () => NOW });
  const body = JSON.stringify(baseEnvelope());
  const headers = signRequest({ secret: SECRET, adapterId: 'qq-test', body, timestamp: NOW, nonce: 'n1' });

  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const options = {
    secret: SECRET, expectedAdapterId: 'qq-test', expectedPlatform: 'qq',
    headers: lower, body, declaredPlatform: 'qq', now: NOW, nonceCache,
  };
  assert.doesNotThrow(() => verifyRequest(options));

  // 同一 nonce 重放（哪怕签名正确）必须拒绝。
  assert.throws(() => verifyRequest(options), (error) => error instanceof AuthError && error.code === 'E_REPLAY');

  // body 被篡改：签名失败（E_AUTH），且不消费新 nonce。
  assert.throws(() => verifyRequest({
    ...options, body: `${body} `, nonce: 'n2',
  }), (error) => error instanceof AuthError && error.code === 'E_AUTH');

  // 平台绑定：qq 适配器不能声明 wx。
  assert.throws(() => verifyRequest({
    ...options, body, declaredPlatform: 'wx', nonce: 'n4',
  }), AuthError);

  // 时间窗外。
  assert.throws(() => verifyRequest({
    secret: SECRET, expectedAdapterId: 'qq-test', expectedPlatform: 'qq',
    headers: Object.fromEntries(Object.entries(signRequest({ secret: SECRET, adapterId: 'qq-test', body, timestamp: NOW - 10 * 60_000, nonce: 'n5' }))
      .map(([k, v]) => [k.toLowerCase(), v])),
    body, declaredPlatform: 'qq', now: NOW, nonceCache,
  }), (error) => error.code === 'E_REPLAY');
});

// ------------------------------------------------------------ idempotency

test('idempotency: 命中、TTL 过期与跨进程恢复', () => {
  const dir = tmpStateDir();
  const file = path.join(dir, 'idem.json');
  let tick = NOW;
  const now = () => tick;
  const store = createIdempotency({ file, now, ttlMs: 1000 });
  store.put('k1', { turnId: 't1' });
  assert.deepEqual(store.get('k1'), { turnId: 't1' });
  store.flush();

  // TTL 过期后不再命中。
  tick = NOW + 2000;
  const reloaded = createIdempotency({ file, now, ttlMs: 1000 });
  assert.equal(reloaded.get('k1'), null);

  // 未过期则跨实例恢复。
  tick = NOW;
  const store2 = createIdempotency({ file, now, ttlMs: 1000 });
  store2.put('k2', { turnId: 't2' });
  store2.flush();
  const store3 = createIdempotency({ file, now, ttlMs: 1000 });
  assert.deepEqual(store3.get('k2'), { turnId: 't2' });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ----------------------------------------------------------------- server

async function startServer({ mode = 'shadow', stateDir = tmpStateDir(), adapters, runtime } = {}) {
  const config = loadConfig({
    env: { GATEWAY_MODE: mode, GATEWAY_PORT: '0', GATEWAY_HOST: '127.0.0.1' },
    stateDir,
    adapters: adapters ?? [{ id: 'qq-test', platform: 'qq', secret: SECRET }],
  });
  const gateway = createGatewayServer({ config, logger: () => {}, ...(runtime ? { runtime } : {}) });
  await gateway.listen();
  const { port } = gateway.server.address();
  return { gateway, port, stateDir };
}

async function postInbound(port, envelope, { adapterId = 'qq-test', secret = SECRET, platform } = {}) {
  const body = JSON.stringify(envelope);
  const headers = signRequest({ secret, adapterId, body });
  const response = await fetch(`http://127.0.0.1:${port}/v1/inbound`, {
    method: 'POST', headers, body,
  });
  return { status: response.status, body: await response.json() };
}

async function getWithAuth(port, pathname, secret = SECRET) {
  const headers = signRequest({ secret, adapterId: 'qq-test', body: '' });
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers });
  return { status: response.status, body: await response.json() };
}

test('server: health 免鉴权、inbound 落盘且幂等', async () => {
  const { gateway, port, stateDir } = await startServer();
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/v1/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.mode, 'shadow');
    // 详细面（适配器能力/回投地址）需要凭据：公开面只回存活事实。
    const detail = await getWithAuth(port, '/v1/health?detail=1');
    assert.equal(detail.status, 200);
    // P5 起 health 带上能力与回投地址（未声明 capabilities 的旧适配器显示 "all"）。
    // V2 消费者抽象：kind/transport 缺省值（platform / auto）对旧配置透明。
    assert.deepEqual(detail.body.adapters, [{
      id: 'qq-test', kind: 'platform', transport: 'auto', platform: 'qq', capabilities: 'all', actionsEndpoint: null,
    }]);

    const first = await postInbound(port, baseEnvelope());
    assert.equal(first.status, 202);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.deduped, false);
    assert.equal(first.body.status, 'shadow');

    // 同一条消息（同 message id）重发：幂等命中。
    const second = await postInbound(port, baseEnvelope());
    assert.equal(second.body.deduped, true);
    assert.equal(second.body.turnId, first.body.turnId);

    // 落盘可读。
    const turn = await getWithAuth(port, `/v1/turns/${first.body.turnId}`);
    assert.equal(turn.status, 200);
    assert.equal(turn.body.record.sessionKey, 'qq:group:123456');

    // 未知 turn → 404。
    const missing = await getWithAuth(port, '/v1/turns/turn_nope');
    assert.equal(missing.status, 404);

    // 指标可读且计数正确。
    const metrics = await getWithAuth(port, '/v1/metrics');
    assert.equal(metrics.status, 200);
    assert.ok(metrics.body.metrics.counters['gateway_inbound_total{platform=qq,result=ok}'] >= 1);
    assert.ok(metrics.body.metrics.counters['gateway_inbound_total{platform=qq,result=deduped}'] >= 1);

    // 关闭时落盘文件存在。
    await gateway.close();
    assert.ok(fs.existsSync(path.join(stateDir, 'turns.jsonl')));
    fs.rmSync(stateDir, { recursive: true, force: true });
  } catch (error) {
    await gateway.close().catch(() => {});
    throw error;
  }
});

test('server: 合成唤醒事件可入站，wake 标记随信封落库', async () => {
  const { gateway, port } = await startServer();
  try {
    const event = baseEnvelope({
      kind: 'event',
      wake: { kind: 'wait', status: 'arrived', registeredAt: NOW - 5000, expiresAt: NOW + 25_000 },
      message: {
        id: 'wait-1',
        sender: { id: '0', name: 'wait-scheduler', roles: ['bot'] },
        text: '(wait satisfied: 1 new message(s))',
      },
      snapshot: [{ at: '12:00', sender: '张三', text: '在吗' }],
    });
    const res = await postInbound(port, event);
    assert.equal(res.status, 202);
    assert.equal(res.body.ok, true);

    const turn = await getWithAuth(port, `/v1/turns/${res.body.turnId}`);
    assert.equal(turn.body.record.envelope.kind, 'event');
    assert.equal(turn.body.record.envelope.wake.kind, 'wait');
    assert.equal(turn.body.record.envelope.snapshot[0].text, '在吗');

    // 同一条合成事件重投：幂等命中，不开第二个 turn。
    const replay = await postInbound(port, event);
    assert.equal(replay.body.deduped, true);
    assert.equal(replay.body.turnId, res.body.turnId);
  } finally {
    await gateway.close();
  }
});

test('server: 鉴权失败、schema 失败与 off 模式', async () => {
  const { gateway, port } = await startServer();
  try {
    // 未知适配器。
    const unknown = await postInbound(port, baseEnvelope(), { adapterId: 'nope' });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error.code, 'E_AUTH');

    // 签名不匹配。
    const badSig = await postInbound(port, baseEnvelope(), { secret: 'another-secret-0123456789' });
    assert.equal(badSig.status, 401);

    // 平台绑定：qq 适配器声明 wx。
    const crossPlatform = await postInbound(port, baseEnvelope({ platform: 'wx' }));
    assert.equal(crossPlatform.status, 401);

    // schema 失败。
    const badSchema = await postInbound(port, baseEnvelope({ conversation: { kind: 'galaxy', id: '1' } }));
    assert.equal(badSchema.status, 400);
    assert.equal(badSchema.body.error.code, 'E_SCHEMA');

    // 非 JSON body。
    const headers = signRequest({ secret: SECRET, adapterId: 'qq-test', body: 'not-json' });
    const notJson = await fetch(`http://127.0.0.1:${port}/v1/inbound`, { method: 'POST', headers, body: 'not-json' });
    assert.equal(notJson.status, 400);

    // 超大 body → 413。
    const hugeEnvelope = baseEnvelope({ message: { id: 'big', sender: { id: '1', name: 'n', roles: [] }, text: 'x'.repeat(300 * 1024) } });
    const huge = signRequest({ secret: SECRET, adapterId: 'qq-test', body: JSON.stringify(hugeEnvelope) });
    const tooBig = await fetch(`http://127.0.0.1:${port}/v1/inbound`, {
      method: 'POST', headers: huge, body: JSON.stringify(hugeEnvelope),
    });
    assert.equal(tooBig.status, 413);

    // 未知路由 → 404。
    const missing = await getWithAuth(port, '/v1/nope');
    assert.equal(missing.status, 404);
    await gateway.close();

    // mode=off：进程可以被拉起，但入站明确拒绝。
    const off = await startServer({ mode: 'off' });
    try {
      const rejected = await postInbound(off.port, baseEnvelope());
      assert.equal(rejected.status, 503);
      assert.equal(rejected.body.error.code, 'E_DISABLED');
    } finally {
      await off.gateway.close();
      fs.rmSync(off.stateDir, { recursive: true, force: true });
    }
  } catch (error) {
    await gateway.close().catch(() => {});
    throw error;
  }
});

test('server: mode=on 在 P0 明确标注 DSH 管线未实现', async () => {
  const { gateway, port, stateDir } = await startServer({ mode: 'on' });
  try {
    const result = await postInbound(port, baseEnvelope());
    assert.equal(result.status, 202);
    assert.equal(result.body.status, 'queued');
    const turn = await getWithAuth(port, `/v1/turns/${result.body.turnId}`);
    assert.match(turn.body.record.note ?? '', /P1/);
  } finally {
    await gateway.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ client

test('client: 与网关签名互认，健康探测与降级结果', async () => {
  const { gateway, port } = await startServer();
  try {
    const client = createGatewayClient({
      baseUrl: `http://127.0.0.1:${port}`,
      adapterId: 'qq-test',
      platform: 'qq',
      secret: SECRET,
      logger: () => {},
    });
    const health = await client.health();
    assert.equal(health.ok, true);
    assert.equal(health.detail.mode, 'shadow');

    const inbound = await client.inbound(baseEnvelope());
    assert.equal(inbound.ok, true);
    assert.equal(inbound.body.status, 'shadow');

    const again = await client.inbound(baseEnvelope());
    assert.equal(again.body.deduped, true);

    const turn = await client.turn(inbound.body.turnId);
    assert.equal(turn.ok, true);
    assert.equal(turn.body.record.envelope.message.id, '7412');

    // 网关不可达：返回结构化失败，不抛异常（适配器据此走旧路径）。
    const dead = createGatewayClient({
      baseUrl: 'http://127.0.0.1:1',
      adapterId: 'qq-test', platform: 'qq', secret: SECRET,
      timeoutMs: 200, logger: () => {},
    });
    const failed = await dead.health();
    assert.equal(failed.ok, false);
    assert.ok(failed.error);
    assert.equal(typeof failed.detail, 'string');
  } finally {
    await gateway.close();
  }
});

test('server: /v1/turns 列表与 /v1/usage（适配器 HMAC、正文不落盘、usage 透传）', async () => {
  const { gateway, port } = await startServer();
  try {
    const record = (turnId, sessionKey, finishedAt, usage) => ({
      v: 1,
      turnId,
      sessionKey,
      status: 'completed',
      envelope: {
        platform: 'qq',
        conversation: { kind: 'group', id: sessionKey.split(':').pop() },
        message: { id: `m-${turnId}` },
      },
      at: finishedAt - 100,
      finishedAt,
      result: { status: 'completed', textLength: 7, degraded: [], usage, wake: null },
    });
    gateway.turns.put('turn_usage1', record('turn_usage1', 'qq:group:123456', 2000, { inputTokens: 10, outputTokens: 5 }));
    gateway.turns.put('turn_usage2', record('turn_usage2', 'qq:group:9', 3000, { inputTokens: 1, outputTokens: 1 }));

    const list = await getWithAuth(port, '/v1/turns?limit=10');
    assert.equal(list.status, 200);
    assert.equal(list.body.ok, true);
    assert.deepEqual(list.body.turns.map((t) => t.turnId).sort(), ['turn_usage1', 'turn_usage2']);
    // 正文从不落盘：列表只暴露长度。
    assert.equal(list.body.turns[0].result.text, undefined);
    assert.equal(typeof list.body.turns[0].result.textLength, 'number');

    const filtered = await getWithAuth(port, `/v1/turns?sessionKey=${encodeURIComponent('qq:group:9')}`);
    assert.deepEqual(filtered.body.turns.map((t) => t.turnId), ['turn_usage2']);

    const usage = await getWithAuth(port, '/v1/usage?since=2500');
    assert.equal(usage.status, 200);
    assert.deepEqual(usage.body.usage.map((row) => row.turnId), ['turn_usage2']);
    assert.deepEqual(usage.body.usage[0].usage, { inputTokens: 1, outputTokens: 1 });
    assert.equal(usage.body.usage[0].sessionKey, 'qq:group:9');

    // 无凭据 → 401（控制台经桥接代理读取，不能匿名）。
    const anonymous = await fetch(`http://127.0.0.1:${port}/v1/usage`);
    assert.equal(anonymous.status, 401);
    const anonymousList = await fetch(`http://127.0.0.1:${port}/v1/turns`);
    assert.equal(anonymousList.status, 401);
  } finally {
    await gateway.close();
  }
});

test('health: 公开面只回最小事实，detail=1 需要凭据', async () => {
  const { gateway, port } = await startServer();
  try {
    const publicRes = await fetch(`http://127.0.0.1:${port}/v1/health`);
    assert.equal(publicRes.status, 200);
    const publicBody = await publicRes.json();
    assert.equal(publicBody.ok, true);
    assert.equal(publicBody.mode, 'shadow');
    assert.equal(publicBody.service, 'agent-gateway');
    // 本机任意进程都能读这个端点：pid/uptime/适配器回调地址/工具与管线统计都不该出现。
    assert.equal(publicBody.pid, undefined);
    assert.equal(publicBody.uptimeMs, undefined);
    assert.equal(publicBody.adapters, undefined);
    // 开关状态可公开（探针要能区分「没开」与「没连上」），细节不行。
    assert.equal(typeof publicBody.tools.mode, 'string');
    assert.equal(typeof publicBody.pipeline.mode, 'string');
    assert.equal(publicBody.tools.services, undefined);
    assert.equal(publicBody.pipeline.consumers, undefined);

    const anonDetail = await fetch(`http://127.0.0.1:${port}/v1/health?detail=1`);
    assert.equal(anonDetail.status, 401, 'detail=1 不带凭据必须 401');
  } finally {
    await gateway.close();
  }
});

