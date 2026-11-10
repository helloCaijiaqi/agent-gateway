// DSH pending 查看与平台转发（docs/console/dsh-pending/PLAN.md）验收测试。
// 全部离线：事件帧用假 dsh 注入；转发用本地 http 假适配器；路由用注入的 runtime stub。
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { loadConfig } = await import(new URL('../src/core/config.mjs', import.meta.url).href);
const { createGatewayServer } = await import(new URL('../src/core/server.mjs', import.meta.url).href);
const { createDshGateway, PENDING_CAPACITY } = await import(new URL('../src/runtime/dsh-gateway.mjs', import.meta.url).href);
const { createPendingForwarder } = await import(new URL('../src/runtime/pending-forwarder.mjs', import.meta.url).href);
const { deliverAction } = await import(new URL('../src/executors/adapter-tools/common/transport.mjs', import.meta.url).href);

const TOKEN = 'test-operator-token-0123456789';
const ADAPTERS = [{ id: 'qq-main', platform: 'qq', secret: 'adapter-secret-0123456789' }];

/** 假 dsh：允许测试手动推事件帧。 */
function fakeDsh() {
  let frameHandler = null;
  return {
    startStream(onFrame) { frameHandler = onFrame; },
    stopStream() { frameHandler = null; },
    emit(frame) { frameHandler?.(frame); },
  };
}

function makeGateway(dsh, options = {}) {
  return createDshGateway({ dsh, turnTimeoutMs: 1000, logger: () => {}, ...options });
}

// ── dsh-gateway：暂存 / 过滤 / 容量淘汰 / onPending ──────────────────────────

test('dsh-gateway: listPending 快照、kind 过滤与 onPending 回调', () => {
  const dsh = fakeDsh();
  const seen = [];
  const gateway = makeGateway(dsh, { onPending: (entry) => seen.push(entry.eventId), now: () => 1000 });
  gateway.start();

  dsh.emit({ type: 'question/requested', eventId: 'q-1', sessionId: 's-1', clientId: 'cl-q', questions: ['选 A 还是 B？'] });
  dsh.emit({ type: 'approval/requested', eventId: 'a-1', sessionId: 's-1', clientId: 'cl-a', toolName: 'bash', callId: 'c-1', reason: '需要执行 ls' });
  dsh.emit({ type: 'approval/requested', eventId: 'a-2', sessionId: 's-2', toolName: 'write_file', callId: 'c-2' });

  const all = gateway.listPending();
  assert.equal(all.length, 3);
  assert.deepEqual(seen, ['q-1', 'a-1', 'a-2'], '每条新入列都触发 onPending');
  assert.ok(all[0].at === 1000 && all[2].at === 1000);
  assert.equal(all[0].clientId, 'cl-q', 'question 条目带 $events clientId（应答寻址）');
  assert.equal(all[1].clientId, 'cl-a', 'approval 条目带 clientId');
  assert.equal(all[2].clientId, null, '缺 clientId 的帧存 null（应答时 fail-closed）');

  assert.deepEqual(gateway.listPending({ kind: 'approval' }).map((e) => e.eventId), ['a-1', 'a-2']);
  assert.deepEqual(gateway.listPending({ kind: 'question' }).map((e) => e.eventId), ['q-1']);
  assert.equal(gateway.listPending({ kind: 'approval', limit: 1 }).length, 1);
  assert.equal(gateway.listPending({ kind: 'approval' })[0].toolName, 'bash');
});

test('dsh-gateway 应答取用: pendingEntry peek / removePending 出列 / 应答成功才移除', async () => {
  const dsh = fakeDsh();
  const calls = [];
  dsh.respondEvent = async ({ clientId, eventId, outcome }) => {
    calls.push({ clientId, eventId, outcome });
    return { ok: true };
  };
  const gateway = makeGateway(dsh, { now: () => 1000 });
  gateway.start();
  dsh.emit({ type: 'approval/requested', eventId: 'a-1', sessionId: 's-1', clientId: 'cl-1', toolName: 'bash', callId: 'c-1' });

  // peek 不移除。
  const entry = gateway.pendingEntry('a-1');
  assert.equal(entry?.clientId, 'cl-1');
  assert.equal(gateway.pendingCount(), 1);
  assert.equal(gateway.pendingEntry('nope'), null);

  // 装配形状同 main.mjs runtime.pending.respond：应答成功才出列，失败保留。
  const respond = async (eventId, outcome) => {
    const pending = gateway.pendingEntry(eventId);
    if (!pending) return null;
    await dsh.respondEvent({ clientId: pending.clientId, eventId, outcome });
    gateway.removePending(eventId);
    return pending;
  };

  await respond('a-1', { kind: 'result', value: 'allowed-once' });
  assert.deepEqual(calls, [{ clientId: 'cl-1', eventId: 'a-1', outcome: { kind: 'result', value: 'allowed-once' } }]);
  assert.equal(gateway.pendingEntry('a-1'), null, '应答成功后条目出列');
  assert.equal(await respond('a-1', {}), null, '重复/未知 eventId 返回 null');

  // 应答失败：条目保留以便重试。
  dsh.emit({ type: 'approval/requested', eventId: 'a-2', sessionId: 's-1', clientId: 'cl-2', toolName: 'bash' });
  dsh.respondEvent = async () => { throw new Error('rejected (X): nope'); };
  const failing = async () => {
    const pending = gateway.pendingEntry('a-2');
    await dsh.respondEvent({ clientId: pending.clientId, eventId: 'a-2', outcome: { kind: 'result', value: 'rejected' } });
    gateway.removePending('a-2');
  };
  await assert.rejects(failing, /rejected/);
  assert.ok(gateway.pendingEntry('a-2'), '失败保留条目');
  assert.equal(gateway.removePending('a-2'), true, '手动清理成功');
  assert.equal(gateway.removePending('a-2'), false, '重复删除返回 false');
});

test('dsh-client.respondEvent: $events/result 形状透传 + result.ok=false 抛错', async () => {
  const { DshClient } = await import(new URL('../src/runtime/dsh-client.mjs', import.meta.url).href);
  const client = new DshClient({ baseUrl: 'http://127.0.0.1:1', authOverride: { secret: Buffer.alloc(32, 7) } });
  const calls = [];
  client.callUnary = async (method, payload) => {
    calls.push({ method, payload });
    return payload.eventId === 'bad'
      ? { result: { ok: false, error: { code: 'E_GONE', message: 'event not pending' } } }
      : { result: { ok: true, value: null } };
  };

  const ok = await client.respondEvent({ clientId: 'cl', eventId: 'e-1', outcome: { kind: 'result', value: { answers: [{ id: 'q1', selected: ['A'] }] } } });
  assert.deepEqual(ok, { ok: true, value: null });
  assert.deepEqual(calls, [{ method: '$events/result', payload: {
    clientId: 'cl', eventId: 'e-1', outcome: { kind: 'result', value: { answers: [{ id: 'q1', selected: ['A'] }] } },
  } }]);

  await assert.rejects(
    () => client.respondEvent({ clientId: 'cl', eventId: 'bad', outcome: { kind: 'result', value: 'rejected' } }),
    /rejected \(E_GONE\): event not pending/,
    'DSH 拒绝时透传 code/message',
  );
});

test('dsh-gateway: 容量淘汰最旧条目（100 上限）', () => {
  const dsh = fakeDsh();
  const gateway = makeGateway(dsh, { now: () => 1000 });
  gateway.start();
  for (let i = 0; i < PENDING_CAPACITY + 3; i += 1) {
    dsh.emit({ type: 'question/requested', eventId: `e-${i}`, sessionId: 's-1', questions: [`问 ${i}`] });
  }
  assert.equal(gateway.pendingCount(), PENDING_CAPACITY);
  const listed = gateway.listPending();
  assert.equal(listed[0].eventId, 'e-3', '最旧三条被淘汰');
  assert.equal(listed.at(-1).eventId, `e-${PENDING_CAPACITY + 2}`);
});

// ── pending-forwarder：动作翻译 + 只回投原会话 ────────────────────────────────

/** 假适配器：捕获 /v1/actions 信封。 */
async function fakeAdapter(expectedSecret) {
  const captured = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ v: 1, actionId: captured.at(-1).actionId, ok: true, at: Date.now() }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    captured,
    adapter: { id: 'qq-main', platform: 'qq', secret: expectedSecret, callbackBase: base },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('pending-forwarder: question→ask、approval→approve，target 派生自原会话', async () => {
  const fake = await fakeAdapter('adapter-secret-0123456789');
  try {
    const registry = { sessionKeyOf: (id) => (id === 's-1' ? 'qq:group:42' : null) };
    const forwarder = createPendingForwarder({
      deliver: deliverAction,
      adapters: [fake.adapter], registry, timeoutMs: 3000, logger: () => {},
    });
    forwarder.forward({ kind: 'question', eventId: 'q-1', sessionId: 's-1', questions: ['选 A 还是 B？', '  ', '为什么？'] });
    forwarder.forward({
      kind: 'approval', eventId: 'a-1', sessionId: 's-1',
      toolName: 'bash', callId: 'c-1', reason: '需要执行 ls',
    });
    // 未映射 / 空内容：跳过不发。
    forwarder.forward({ kind: 'question', eventId: 'q-2', sessionId: 's-ghost', questions: ['没人认识我'] });
    forwarder.forward({ kind: 'question', eventId: 'q-3', sessionId: 's-1', questions: [] });
    // 同 eventId 重放：只发一次。
    forwarder.forward({ kind: 'question', eventId: 'q-1', sessionId: 's-1', questions: ['重复'] });

    // 固定 150ms 在全量并发跑时会因 CPU 争抢超时：轮询等两个信封（2s 预算）。
    const deadline = Date.now() + 2000;
    while (fake.captured.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.equal(fake.captured.length, 2, '只应发出 ask + approve 两个信封');

    const ask = fake.captured.find((e) => e.type === 'ask');
    assert.ok(ask, 'ask 信封存在');
    assert.deepEqual(ask.payload.questions, ['选 A 还是 B？', '为什么？'], '空串过滤');
    assert.equal(ask.target.platform, 'qq');
    assert.equal(ask.target.kind, 'group');
    assert.equal(ask.target.conversationId, '42');
    assert.equal(ask.idempotencyKey, 'pending:q-1');

    const approve = fake.captured.find((e) => e.type === 'approve');
    assert.ok(approve);
    assert.equal(approve.payload.toolName, 'bash');
    assert.equal(approve.payload.reason, '需要执行 ls');
    assert.equal(approve.target.conversationId, '42');
  } finally {
    await fake.close();
  }
});

test('pending-forwarder: 无 callbackBase 适配器跳过；构造参数防呆', async () => {
  const forwarder = createPendingForwarder({
    deliver: deliverAction,
    adapters: [{ id: 'qq-main', platform: 'qq', secret: 'adapter-secret-0123456789', callbackBase: null }],
    registry: { sessionKeyOf: () => 'qq:group:42' },
    logger: () => {},
  });
  forwarder.forward({ kind: 'question', eventId: 'q-9', sessionId: 's-1', questions: ['没人转发我'] });
  await new Promise((r) => setTimeout(r, 50));
  // 跳过（无 callbackBase）= 明确不投，不计入 forwarded，也不排重试。
  assert.equal(forwarder.stats().forwardedTracked, 0);
  assert.equal(forwarder.stats().retryScheduled, 0);
  assert.throws(() => createPendingForwarder({ deliver: deliverAction, adapters: 'nope', registry: { sessionKeyOf: () => null } }), /adapters/);
  assert.throws(() => createPendingForwarder({ deliver: deliverAction, adapters: [], registry: {} }), /sessionKeyOf/);
  assert.throws(() => createPendingForwarder({ adapters: [], registry: { sessionKeyOf: () => null } }), /deliver/);
});

// ── 路由层：GET /v1/console/pending ──────────────────────────────────────────

async function startServer(runtime) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'gw-pending-console-'));
  const config = loadConfig({
    env: { GATEWAY_MODE: 'shadow', GATEWAY_CONSOLE: 'on', GATEWAY_OPERATOR_TOKEN: TOKEN, GATEWAY_PORT: '0' },
    adapters: ADAPTERS,
    stateDir,
  });
  const gateway = createGatewayServer({ config, logger: () => {}, runtime });
  await gateway.listen();
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  return { gateway, base, auth: { 'x-operator-token': TOKEN } };
}

test('console pending: 快照行、过滤、unmapped 标记与鉴权', async () => {
  const entries = [
    { kind: 'approval', eventId: 'a-1', sessionId: 's-1', toolName: 'bash', callId: 'c-1', reason: 'ls', at: 900 },
    { kind: 'question', eventId: 'q-1', sessionId: 's-2', questions: ['在吗？'], at: 950 },
    { kind: 'question', eventId: 'q-2', sessionId: 's-ghost', questions: ['幽灵'], at: 990 },
  ];
  const runtime = {
    pending: {
      list: ({ kind } = {}) => (kind ? entries.filter((e) => e.kind === kind) : entries),
      capacity: 100,
      forward: { mode: 'off' },
    },
    consoleDsh: {
      registry: { sessionKeyOf: (id) => (id === 's-1' ? 'qq:group:42' : id === 's-2' ? 'qq:private:7' : null) },
    },
  };
  const { gateway, base, auth } = await startServer(runtime);
  try {
    // 未认证 → 401。
    assert.equal((await fetch(`${base}/v1/console/pending`)).status, 401);

    const all = await fetch(`${base}/v1/console/pending`, { headers: auth });
    assert.equal(all.status, 200);
    const allBody = await all.json();
    assert.equal(allBody.ok, true);
    assert.equal(allBody.total, 3);
    assert.equal(allBody.capacity, 100);
    assert.deepEqual(allBody.forward, { mode: 'off' });
    const approvalRow = allBody.pending.find((r) => r.eventId === 'a-1');
    assert.equal(approvalRow.sessionKey, 'qq:group:42');
    assert.equal(approvalRow.mapped, true);
    assert.equal(approvalRow.toolName, 'bash');
    assert.ok(approvalRow.ageMs >= 0 && Number.isSafeInteger(approvalRow.ageMs), 'ageMs = now - at');
    assert.equal('toolName' in allBody.pending.find((r) => r.eventId === 'q-1'), false, 'question 行不带 approval 字段');
    assert.deepEqual(allBody.pending.find((r) => r.eventId === 'q-1').questions, ['在吗？']);
    const ghost = allBody.pending.find((r) => r.eventId === 'q-2');
    assert.equal(ghost.mapped, false);
    assert.equal(ghost.sessionKey, null);

    // kind 过滤。
    const approvals = await (await fetch(`${base}/v1/console/pending?kind=approval`, { headers: auth })).json();
    assert.equal(approvals.total, 1);
    assert.equal(approvals.pending[0].eventId, 'a-1');

    // sessionKey 过滤 + limit。
    const filtered = await (await fetch(`${base}/v1/console/pending?sessionKey=qq:private:7`, { headers: auth })).json();
    assert.equal(filtered.total, 1);
    assert.equal(filtered.pending[0].eventId, 'q-1');
    const limited = await (await fetch(`${base}/v1/console/pending?limit=1`, { headers: auth })).json();
    assert.equal(limited.pending.length, 1);
    assert.equal(limited.total, 3, 'total 是过滤后的全量，limit 只截断列表');

    // 非法 kind → 400。
    assert.equal((await fetch(`${base}/v1/console/pending?kind=weird`, { headers: auth })).status, 400);

    // runtime 未装配 → 503。
    const { gateway: bare, base: bareBase } = await startServer({});
    try {
      const bareRes = await fetch(`${bareBase}/v1/console/pending`, { headers: auth });
      assert.equal(bareRes.status, 503);
      assert.equal((await bareRes.json()).error.code, 'E_DISABLED');
    } finally {
      await bare.close();
    }
  } finally {
    await gateway.close();
  }
});

// ── 路由层：POST /v1/console/pending/{eventId}/respond（应答阶段）──────────────

function makeRespondRuntime(entries = [], { fail } = {}) {
  const map = new Map(entries.map((e) => [e.eventId, e]));
  const calls = [];
  return {
    calls,
    runtime: {
      pending: {
        list: () => [...map.values()],
        capacity: 100,
        forward: { mode: 'off' },
        entry: (id) => map.get(id) ?? null,
        respond: async (eventId, outcome) => {
          const entry = map.get(eventId);
          if (!entry) return null;
          if (fail) throw new Error('rejected (E_GONE): event not pending');
          calls.push({ eventId, outcome });
          map.delete(eventId);
          return entry;
        },
      },
      consoleDsh: { registry: { sessionKeyOf: () => null } },
    },
  };
}

const post = async (base, eventId, body, headers) => fetch(`${base}/v1/console/pending/${eventId}/respond`, {
  method: 'POST',
  headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body),
  connection: 'close',
});

test('console pending respond: 审批/提问矩阵 + fail-closed + 鉴权/CSRF', async () => {
  const { calls, runtime } = makeRespondRuntime([
    { kind: 'approval', eventId: 'a-1', sessionId: 's-1', clientId: 'cl-1', toolName: 'bash', callId: 'c-1', at: 900 },
    { kind: 'approval', eventId: 'a-2', sessionId: 's-1', clientId: 'cl-1', toolName: 'bash', callId: 'c-2', at: 910 },
    { kind: 'question', eventId: 'q-1', sessionId: 's-2', clientId: 'cl-2', at: 950,
      questions: [{ id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }] },
  ]);
  const { gateway, base, auth } = await startServer(runtime);
  try {
    // 未认证 → 401。
    assert.equal((await post(base, 'a-1', { decision: 'approve' }, {})).status, 401);

    // CSRF：非 JSON content-type → E_FORBIDDEN。
    const csrf = await fetch(`${base}/v1/console/pending/a-1/respond`, {
      method: 'POST', headers: { ...auth, 'content-type': 'text/plain' },
      body: JSON.stringify({ decision: 'approve' }), connection: 'close',
    });
    assert.equal(csrf.status, 403);
    assert.equal((await csrf.json()).error.code, 'E_FORBIDDEN');

    // 审批：approve → allowed-once。
    const approve = await post(base, 'a-1', { decision: 'approve' }, auth);
    assert.equal(approve.status, 200);
    assert.deepEqual(await approve.json(), { ok: true, eventId: 'a-1', kind: 'approval' });
    assert.deepEqual(calls.at(-1), { eventId: 'a-1', outcome: { kind: 'result', value: 'allowed-once' } });

    // 审批：deny → rejected。
    assert.equal((await post(base, 'a-2', { decision: 'deny' }, auth)).status, 200);
    assert.deepEqual(calls.at(-1), { eventId: 'a-2', outcome: { kind: 'result', value: 'rejected' } });

    // 审批：缺/坏 decision → 400（fail-closed，不打 DSH；a-1 已出列，重挂临时条目）。
    runtime.pending.entry = (id) => (id === 'a-1'
      ? { kind: 'approval', eventId: 'a-1', clientId: 'cl-1' } : null);
    for (const bad of [{}, { decision: 'yes' }, { answers: [{ id: 'q1' }] }]) {
      const res = await post(base, 'a-1', bad, auth);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal((await res.json()).error.code, 'E_SCHEMA');
    }

    // 提问：answers 合法 → 透传（形状与桥接回滚形态一致）。
    runtime.pending.entry = (id) => (id === 'q-1'
      ? { kind: 'question', eventId: 'q-1', clientId: 'cl-2' } : null);
    const ok = await post(base, 'q-1', { answers: [{ id: 'q1', selected: ['A'] }] }, auth);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, eventId: 'q-1', kind: 'question' });
    assert.deepEqual(calls.at(-1).outcome, { kind: 'result', value: { answers: [{ id: 'q1', selected: ['A'] }] } });
    const custom = await post(base, 'q-1', { answers: [{ id: 'q1', selected: [], custom: '自定义' }] }, auth);
    assert.equal(custom.status, 200);

    // 提问：坏 answers → 400（空/缺 id/selected 非数组/超量）。
    for (const bad of [
      {}, { answers: [] }, { answers: 'nope' },
      { answers: [{ selected: ['A'] }] }, { answers: [{ id: 'q1', selected: 'A' }] },
      { answers: [{ id: 'q1', custom: 3 }] },
      { answers: Array.from({ length: 21 }, (_, i) => ({ id: `q${i}` })) },
    ]) {
      const res = await post(base, 'q-1', bad, auth);
      assert.equal(res.status, 400, JSON.stringify(bad).slice(0, 60));
      assert.equal((await res.json()).error.code, 'E_SCHEMA');
    }

    // 未知/已淘汰 eventId → 404 E_SCHEMA（不抛 500）。
    const missing = await post(base, 'ghost', { decision: 'approve' }, auth);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'E_SCHEMA');

    // 非 POST → 404；body 非 JSON → 400。
    assert.equal((await fetch(`${base}/v1/console/pending/a-1/respond`, { headers: auth })).status, 404);
    const badJson = await fetch(`${base}/v1/console/pending/a-1/respond`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: 'not-json', connection: 'close',
    });
    assert.equal(badJson.status, 400);
  } finally {
    await gateway.close();
  }

  // DSH 拒绝应答 → 502 E_DSH_DOWN，且条目保留（可重试）。
  const failing = makeRespondRuntime([
    { kind: 'approval', eventId: 'a-1', sessionId: 's-1', clientId: 'cl-1', toolName: 'bash', at: 900 },
  ], { fail: true });
  const server2 = await startServer(failing.runtime);
  try {
    const res = await post(server2.base, 'a-1', { decision: 'approve' }, server2.auth);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'E_DSH_DOWN');
    assert.match(body.error.message, /rejected/);
  } finally {
    await server2.gateway.close();
  }
});
