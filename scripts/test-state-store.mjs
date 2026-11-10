// P4 会话状态测试：mailbox 领域操作（游标单调/唤醒配置归一/agentToken/持久化
// round-trip）、/v1/state* HTTP 契约（适配器 HMAC + GATEWAY_STATE 门控 + schema）、
// turn-runner 入站游标登记。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { createMailbox, defaultWakeConfig } = await import(new URL('../src/runtime/mailbox.mjs', import.meta.url).href);
const { parseStateUpdate } = await import(new URL('../src/core/contracts.mjs', import.meta.url).href);
const { loadConfig } = await import(new URL('../src/core/config.mjs', import.meta.url).href);
const { createGatewayServer } = await import(new URL('../src/core/server.mjs', import.meta.url).href);
const { signRequest } = await import(new URL('../src/core/auth.mjs', import.meta.url).href);
const { createSessionRegistry } = await import(new URL('../src/runtime/session-registry.mjs', import.meta.url).href);
const { createPromptQueue } = await import(new URL('../src/runtime/prompt-queue.mjs', import.meta.url).href);
const { createDshGateway } = await import(new URL('../src/runtime/dsh-gateway.mjs', import.meta.url).href);
const { createTurnStore } = await import(new URL('../src/core/turn-store.mjs', import.meta.url).href);

const ADAPTER_SECRET = 'adapter-secret-0123456789';

// ---------------------------------------------------------------- mailbox 单元

test('mailbox: 入站游标推进、已读水位单调且不越过未读、legacy 清空', () => {
  const mailbox = createMailbox({ file: null });
  mailbox.recordInbound({ sessionKey: 'qq:group:1', seq: 3, messageId: 'm3', senderId: 'u1' });
  mailbox.recordInbound({ sessionKey: 'qq:group:1', seq: 1, messageId: 'm1' }); // 乱序镜像不回退游标
  let snap = mailbox.snapshot('qq:group:1');
  assert.equal(snap.lastUnreadSeq, 3);
  assert.equal(snap.lastMessageId, 'm3');
  assert.equal(snap.unreadCount, 3);
  assert.equal(snap.preSleepWaitSatisfiedAt, 0, '新消息使沉睡前观察作废');

  // 水位推进：单调 max，且被夹到 lastUnreadSeq 内。
  let ack = mailbox.acknowledge({ sessionKey: 'qq:group:1', throughSeq: 2 });
  assert.equal(ack.data.readThroughSeq, 2);
  assert.equal(ack.data.advanced, true);
  ack = mailbox.acknowledge({ sessionKey: 'qq:group:1', throughSeq: 1 });
  assert.equal(ack.data.readThroughSeq, 2, '水位不许回退');
  assert.equal(ack.data.advanced, false);
  ack = mailbox.acknowledge({ sessionKey: 'qq:group:1', throughSeq: 99 });
  assert.equal(ack.data.readThroughSeq, 3, '不许推到没收到过的消息上');
  assert.equal(mailbox.snapshot('qq:group:1').unreadCount, 0);

  // legacy 无水位 = 清空全部未读（同 bridge requestedReadThroughSeqV2 无水位分支）。
  mailbox.recordInbound({ sessionKey: 'qq:group:1', seq: 7 });
  ack = mailbox.acknowledge({ sessionKey: 'qq:group:1' });
  assert.equal(ack.data.readThroughSeq, 7);
  // 非法 throughSeq 拒绝而不是猜。
  assert.equal(mailbox.acknowledge({ sessionKey: 'qq:group:1', throughSeq: -1 }).ok, false);
});

test('mailbox: 唤醒配置归一化（未知字段丢弃/已知字段类型守卫）与 confirmedBy', () => {
  const mailbox = createMailbox({ file: null });
  const result = mailbox.setWakeConfig({
    sessionKey: 'qq:group:2',
    wakeConfig: {
      mode: 'active', infinite: false, evil: 'x',
      triggers: { atMention: true, probability: 0.2, speakerIds: ['111'], keywords: ['梗', ''], bogus: 1 },
    },
    confirmedBy: 'set_wake_config',
  });
  assert.equal(result.ok, true);
  const snap = mailbox.snapshot('qq:group:2');
  assert.equal(snap.wakeConfig.mode, 'active');
  assert.equal(snap.wakeConfig.infinite, false);
  assert.equal(snap.wakeConfig.confirmedBy, 'set_wake_config');
  assert.equal(snap.wakeConfig.triggers.probability, 0.2);
  assert.deepEqual(snap.wakeConfig.triggers.speakerIds, ['111']);
  assert.deepEqual(snap.wakeConfig.triggers.keywords, ['梗'], '空关键词被过滤');
  assert.equal(snap.wakeConfig.evil, undefined, '未知顶层字段丢弃');
  assert.equal(snap.wakeConfig.triggers.bogus, undefined, '未知触发器字段丢弃');
  // 非法枚举回落默认而不是抛异常（镜像写是 best-effort，坏值不能炸网关）。
  mailbox.setWakeConfig({ sessionKey: 'qq:group:2', wakeConfig: { mode: 'yolo' } });
  assert.equal(mailbox.snapshot('qq:group:2').wakeConfig.mode, 'active');
  // 附带 throughSeq 时同步推进水位。
  mailbox.recordInbound({ sessionKey: 'qq:group:2', seq: 5 });
  const acked = mailbox.setWakeConfig({ sessionKey: 'qq:group:2', wakeConfig: { mode: 'diving' }, throughSeq: 4 });
  assert.equal(acked.data.readThroughSeq, 4);

  // confirmedAt 由适配器提供时保真（镜像不是「同步时间」）。
  mailbox.setWakeConfig({ sessionKey: 'qq:group:2', wakeConfig: { mode: 'active', confirmedAt: 1700000000000 } });
  assert.equal(mailbox.snapshot('qq:group:2').wakeConfig.confirmedAt, 1700000000000);
  // 没提供时用网关时钟。
  mailbox.setWakeConfig({ sessionKey: 'qq:group:2', wakeConfig: { mode: 'diving' } });
  assert.ok(mailbox.snapshot('qq:group:2').wakeConfig.confirmedAt > 1700000000000);
});

test('mailbox: agentToken 持久化 round-trip；快照不存在时 exists:false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-state-'));
  const file = path.join(dir, 'session-state.json');
  const mailbox = createMailbox({ file });
  mailbox.setAgentToken({ sessionKey: 'qq:private:9', agentToken: 'a'.repeat(32) });
  mailbox.recordInbound({ sessionKey: 'qq:private:9', seq: 2 });
  mailbox.flush();
  const reopened = createMailbox({ file });
  const snap = reopened.snapshot('qq:private:9');
  assert.equal(snap.exists, true);
  assert.equal(snap.agentToken, 'a'.repeat(32), '重启后 agentToken 不丢');
  assert.equal(snap.lastUnreadSeq, 2);
  assert.equal(reopened.snapshot('qq:private:404').exists, false);
  assert.equal(reopened.snapshot('qq:private:404').unreadCount, 0);
  assert.equal(typeof defaultWakeConfig().confirmedBy, 'default' ? 'string' : 'string');
});

test('mailbox: close() 落盘未到期的去抖写（进程退出路径）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-state-close-'));
  const file = path.join(dir, 'session-state.json');
  const mailbox = createMailbox({ file });
  mailbox.recordInbound({ sessionKey: 'qq:group:7', seq: 2 });
  // 不调 flush：模拟 gateway.close() → runtime.stop() 直接退出的时刻。
  mailbox.close();
  assert.equal(createMailbox({ file }).snapshot('qq:group:7').lastUnreadSeq, 2);
});

test('mailbox: reset 删除会话镜像且幂等（适配器重置/清空工作区）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-state-reset-'));
  const file = path.join(dir, 'session-state.json');
  const mailbox = createMailbox({ file });
  mailbox.setAgentToken({ sessionKey: 'qq:group:9', agentToken: 'c'.repeat(32) });
  mailbox.recordInbound({ sessionKey: 'qq:group:9', seq: 4 });
  mailbox.setAgentToken({ sessionKey: 'qq:private:9', agentToken: 'd'.repeat(32) });
  assert.equal(mailbox.list().length, 2);

  const result = mailbox.reset({ sessionKey: 'qq:group:9' });
  assert.equal(result.ok, true);
  assert.equal(result.data.removed, true);
  assert.equal(mailbox.snapshot('qq:group:9').exists, false, '删除后快照回到 exists:false');
  assert.deepEqual(mailbox.list().map((row) => row.sessionKey), ['qq:private:9'], '只删指定会话');
  // 重复删除是幂等的（适配器镜像重试/并发不会炸）。
  assert.equal(mailbox.reset({ sessionKey: 'qq:group:9' }).data.removed, false);

  // 删除要落盘：重开 store 后不能「复活」。
  mailbox.flush();
  const reopened = createMailbox({ file });
  assert.equal(reopened.snapshot('qq:group:9').exists, false);
  assert.equal(reopened.snapshot('qq:private:9').exists, true);
});

// ---------------------------------------------------------------- 契约 schema

test('contracts: stateUpdate 按 action 校验必填字段', () => {
  assert.equal(parseStateUpdate({ v: 1, action: 'inbound', sessionKey: 'qq:group:1', seq: 4, source: 'model' }).seq, 4);
  assert.throws(() => parseStateUpdate({ v: 1, action: 'inbound', sessionKey: 'k' }), /requires seq/);
  assert.throws(() => parseStateUpdate({ v: 1, action: 'mark_read', sessionKey: 'k' }), /requires throughSeq/);
  assert.throws(() => parseStateUpdate({ v: 1, action: 'set_wake_config', sessionKey: 'k' }), /requires wakeConfig/);
  assert.throws(() => parseStateUpdate({ v: 1, action: 'agent_token', sessionKey: 'k' }), /requires agentToken/);
  assert.throws(() => parseStateUpdate({ v: 1, action: 'nope', sessionKey: 'k' }), /stateUpdate invalid/);
  assert.throws(() => parseStateUpdate({ v: 1, action: 'inbound', sessionKey: 'k', seq: 1, extra: true }), /stateUpdate invalid/);
  // reset 只要求 sessionKey（会话被适配器清空后同步删掉镜像）。
  assert.equal(parseStateUpdate({ v: 1, action: 'reset', sessionKey: 'k', source: 'system' }).action, 'reset');
  // 默认 source=adapter。
  assert.equal(parseStateUpdate({ v: 1, action: 'inbound', sessionKey: 'k', seq: 1 }).source, 'adapter');
});

// ---------------------------------------------------------------- HTTP 契约路由

async function startServer(env, runtime) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-state-'));
  const config = loadConfig({
    env,
    stateDir,
    adapters: [{ id: 'qq-main', platform: 'qq', secret: ADAPTER_SECRET }],
  });
  const gateway = createGatewayServer({ config, logger: () => {}, runtime });
  await gateway.listen();
  return { gateway, port: gateway.server.address().port };
}

test('server: /v1/state* 适配器 HMAC 鉴权 + runtime 注入 + off 门控', async () => {
  const updates = [];
  const { gateway, port } = await startServer(
    { GATEWAY_MODE: 'on', GATEWAY_STATE: 'on', GATEWAY_PORT: '0' },
    {
      stateUpdate: async (parsed) => {
        updates.push(parsed);
        return { ok: true, data: { sessionKey: parsed.sessionKey, unreadCount: 0, readThroughSeq: 4, lastUnreadSeq: 4 } };
      },
      stateGet: (key) => (key === 'qq:group:1'
        ? { sessionKey: key, exists: true, unreadCount: 1, readThroughSeq: 2, lastUnreadSeq: 3 }
        : { sessionKey: key, exists: false, unreadCount: 0, readThroughSeq: 0, lastUnreadSeq: 0 }),
      stateList: () => [{ sessionKey: 'qq:group:1', unreadCount: 1 }],
      stateStats: () => ({ sessions: 1 }),
      submit() {}, stop() {}, status() { return {}; },
    },
  );
  const base = `http://127.0.0.1:${port}`;
  try {
    // 写路径：适配器签名（bridge 就是适配器），body 按契约校验后进 runtime。
    const body = JSON.stringify({ v: 1, action: 'mark_read', sessionKey: 'qq:group:1', throughSeq: 4, source: 'model' });
    const writeRes = await fetch(`${base}/v1/state/update`, {
      method: 'POST', headers: signRequest({ secret: ADAPTER_SECRET, adapterId: 'qq-main', body }), body,
    });
    assert.equal(writeRes.status, 200);
    assert.equal((await writeRes.json()).state.readThroughSeq, 4);
    assert.equal(updates[0].source, 'model');

    // reset：适配器重置会话时的镜像删除（同样走 HMAC + schema）。
    const resetBody = JSON.stringify({ v: 1, action: 'reset', sessionKey: 'qq:group:1', source: 'system' });
    const resetRes = await fetch(`${base}/v1/state/update`, {
      method: 'POST', headers: signRequest({ secret: ADAPTER_SECRET, adapterId: 'qq-main', body: resetBody }), body: resetBody,
    });
    assert.equal(resetRes.status, 200);
    assert.equal(updates.at(-1).action, 'reset');

    // 读路径：列表与单键快照。
    const listRes = await fetch(`${base}/v1/state`, { headers: signRequest({ secret: ADAPTER_SECRET, adapterId: 'qq-main', body: '' }) });
    assert.equal((await listRes.json()).sessions.length, 1);
    const snapRes = await fetch(`${base}/v1/state/${encodeURIComponent('qq:group:1')}`, { headers: signRequest({ secret: ADAPTER_SECRET, adapterId: 'qq-main', body: '' }) });
    assert.equal((await snapRes.json()).state.exists, true);

    // 错误密钥 → 401；缺字段 → 400；未知键快照 → 200 exists:false。
    const badRes = await fetch(`${base}/v1/state`, { headers: signRequest({ secret: 'wrong-wrong-wrong-wrong', adapterId: 'qq-main', body: '' }) });
    assert.equal(badRes.status, 401);
    const badBody = JSON.stringify({ v: 1, action: 'mark_read', sessionKey: 'k' });
    const schemaRes = await fetch(`${base}/v1/state/update`, {
      method: 'POST', headers: signRequest({ secret: ADAPTER_SECRET, adapterId: 'qq-main', body: badBody }), body: badBody,
    });
    assert.equal(schemaRes.status, 400);
    const unknownRes = await fetch(`${base}/v1/state/${encodeURIComponent('qq:group:404')}`, { headers: signRequest({ secret: ADAPTER_SECRET, adapterId: 'qq-main', body: '' }) });
    assert.equal((await unknownRes.json()).state.exists, false);

    // runtime 拒绝 → 422 带 code。
    const rejecting = await startServer(
      { GATEWAY_MODE: 'on', GATEWAY_STATE: 'on', GATEWAY_PORT: '0' },
      { stateUpdate: async () => ({ ok: false, error: { code: 'E_POLICY', message: 'nope' } }), submit() {}, stop() {}, status() { return {}; } },
    );
    try {
      const rejectRes = await fetch(`http://127.0.0.1:${rejecting.port}/v1/state/update`, {
        method: 'POST', headers: signRequest({ secret: ADAPTER_SECRET, adapterId: 'qq-main', body }), body,
      });
      assert.equal(rejectRes.status, 422);
      assert.equal((await rejectRes.json()).error.code, 'E_POLICY');
    } finally {
      await rejecting.gateway.close();
    }
  } finally {
    await gateway.close();
  }

  // GATEWAY_STATE=off → 503 E_DISABLED（写路径与读路径都关）。
  const off = await startServer({ GATEWAY_MODE: 'on', GATEWAY_STATE: 'off', GATEWAY_PORT: '0' }, { submit() {}, stop() {}, status() { return {}; } });
  try {
    const body = JSON.stringify({ v: 1, action: 'mark_read', sessionKey: 'k', throughSeq: 1 });
    const offWrite = await fetch(`http://127.0.0.1:${off.port}/v1/state/update`, {
      method: 'POST', headers: signRequest({ secret: ADAPTER_SECRET, adapterId: 'qq-main', body }), body,
    });
    assert.equal(offWrite.status, 503);
    assert.equal((await offWrite.json()).error.code, 'E_DISABLED');
    const offRead = await fetch(`http://127.0.0.1:${off.port}/v1/state`, { headers: signRequest({ secret: ADAPTER_SECRET, adapterId: 'qq-main', body: '' }) });
    assert.equal(offRead.status, 503);
  } finally {
    await off.gateway.close();
  }
});

// ------------------------------------------------- turn-runner 入站游标集成

function createFakeDsh() {
  let seq = 0;
  const state = { sessions: new Map(), prompts: [] };
  let onFrame = null;
  return {
    state,
    emit(payload) { onFrame?.(payload); },
    finishTurn(sessionId, text) {
      const s = state.sessions.get(sessionId);
      const turn = `t${++s.turns}`;
      this.emit({ type: 'session/event', sessionId, event: { type: 'turn/start', data: { turn } } });
      this.emit({ type: 'session/event', sessionId, event: { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } } });
      this.emit({ type: 'session/event', sessionId, event: { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } } });
    },
    async listPresets() { return ['qq-chat-v2']; },
    async ensureWorkspace() { return 'ws'; },
    async createSession() { const id = `s${++seq}`; state.sessions.set(id, { turns: 0 }); return id; },
    async selectModel() { return {}; },
    async prompt({ sessionId, text }) { state.prompts.push({ sessionId, text }); return { result: { ok: true, value: {} } }; },
    follow() {}, forget() {},
    startStream(cb) { onFrame = cb; },
    stopStream() { onFrame = null; },
    get connected() { return true; },
  };
}

async function waitFor(predicate, { timeoutMs = 2000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

test('turn-runner: 带 seq 的入站登记进 mailbox，不带 seq 的不猜', async () => {
  const dsh = createFakeDsh();
  const chat = { preset: 'qq-chat-v2', provider: 'p', model: 'm', reasoningEffort: 'max', workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gw-mb-')), turnTimeoutMs: 2000 };
  const registry = createSessionRegistry({ dsh, chat, file: null });
  const gateway = createDshGateway({ dsh, turnTimeoutMs: 2000 });
  const mailbox = createMailbox({ file: null });
  const { createTurnRunner } = await import(new URL('../src/runtime/turn-runner.mjs', import.meta.url).href);
  const runner = createTurnRunner({
    config: { chat, context: { mode: 'off' } },
    dsh, registry, gateway, queue: createPromptQueue({}), turns: createTurnStore({ file: null }), mailbox, logger: () => {},
  });
  gateway.start();
  const envelopeBase = {
    platform: 'qq', conversation: { kind: 'group', id: '8' },
    message: { id: 'm9', seq: 9, sender: { id: '1', name: 'a', roles: ['member'] }, text: 'hi' },
  };
  const done = runner.submit({ turnId: 'turn_mb1', sessionKey: 'qq:group:8', envelope: envelopeBase, degraded: [] });
  await waitFor(() => dsh.state.prompts.length === 1);
  dsh.finishTurn(dsh.state.prompts[0].sessionId, 'ok');
  await done;
  let snap = mailbox.snapshot('qq:group:8');
  assert.equal(snap.lastUnreadSeq, 9, 'envelope.message.seq 推进游标');
  assert.equal(snap.lastMessageId, 'm9');

  const done2 = runner.submit({
    turnId: 'turn_mb2', sessionKey: 'qq:group:8',
    envelope: { ...envelopeBase, message: { ...envelopeBase.message, seq: undefined } },
    degraded: [],
  });
  await waitFor(() => dsh.state.prompts.length === 2);
  dsh.finishTurn(dsh.state.prompts[1].sessionId, 'ok');
  await done2;
  snap = mailbox.snapshot('qq:group:8');
  assert.equal(snap.lastUnreadSeq, 9, '无 seq 的入站不猜游标');
  gateway.stop();
});
