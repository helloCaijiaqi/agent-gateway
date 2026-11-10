// P1 runtime 集成测试：会话注册表、prompt 队列、turn 等待、turn-runner 编排、
// 灰度路由、platform-actions 回投。
//
// 全部离线：DSH 用假客户端（协议形状与 runtime/dsh-client.mjs 的消费面一致），
// 适配器回调是本机临时 HTTP 服务。不发 QQ 消息、不连真 DSH。
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import test from 'node:test';

const { createSessionRegistry } = await import(new URL('../src/runtime/session-registry.mjs', import.meta.url).href);
const { createPromptQueue } = await import(new URL('../src/runtime/prompt-queue.mjs', import.meta.url).href);
const { createDshGateway } = await import(new URL('../src/runtime/dsh-gateway.mjs', import.meta.url).href);
const { createTurnRunner } = await import(new URL('../src/runtime/turn-runner.mjs', import.meta.url).href);
const { createExecutorRegistry } = await import(new URL('../src/executors/executor-interface.mjs', import.meta.url).href);
const { createTurnStore } = await import(new URL('../src/core/turn-store.mjs', import.meta.url).href);
const { createGatewayServer } = await import(new URL('../src/core/server.mjs', import.meta.url).href);
const { loadConfig, isConversationAllowed } = await import(new URL('../src/core/config.mjs', import.meta.url).href);
const { signRequest } = await import(new URL('../src/core/auth.mjs', import.meta.url).href);

const CHAT = {
  preset: 'qq-chat-v2',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: 'max',
  workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-agents-')),
  turnTimeoutMs: 2000,
};

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-p1-')), name);
}

async function waitFor(predicate, { timeoutMs = 2000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/**
 * 假 DSH：协议形状与 runtime 的消费面一致（见 runtime/dsh-client.mjs）。
 * finishTurn 按真实 mux 帧序（turn/start → assistant/message → turn/end）发帧。
 */
function createFakeDsh() {
  let seq = 0;
  const state = { sessions: new Map(), follows: new Set(), prompts: [], cancels: [], failNotFound: new Set() };
  let onFrame = null;
  const client = {
    state,
    emit(payload) { onFrame?.(payload); },
    finishTurn(sessionId, text, kind = 'completed', usage) {
      const session = state.sessions.get(sessionId);
      if (!session) throw new Error(`fake dsh: unknown session ${sessionId}`);
      const turn = `turn-${++session.turns}`;
      client.emit({ type: 'session/event', sessionId, event: { type: 'turn/start', data: { turn } } });
      client.emit({
        type: 'session/event', sessionId,
        event: {
          type: 'assistant/message',
          data: { turn, message: { content: [{ type: 'text', text }] }, ...(usage ? { usage } : {}) },
        },
      });
      client.emit({ type: 'session/event', sessionId, event: { type: 'turn/end', data: { turn, reason: { kind } } } });
    },
    async listPresets() { return state.presetList ?? ['qq-chat-v2']; },
    async ensureWorkspace() { return 'ws-1'; },
    async createSession() {
      const sessionId = `sess-${++seq}`;
      state.sessions.set(sessionId, { turns: 0 });
      return sessionId;
    },
    async selectModel(sessionId) {
      if (state.failNotFound.has(sessionId)) {
        const error = new Error('session/not-found: gone');
        error.code = 'session/not-found';
        throw error;
      }
      return {};
    },
    async prompt({ sessionId, text }) {
      state.prompts.push({ sessionId, text });
      return { result: state.promptFailure ? { ok: false, error: state.promptFailure } : { ok: true, value: {} } };
    },
    async callUnary(method, payload) {
      if (method === 'session/cancel') state.cancels.push(payload.sessionId);
      return { result: { ok: true, value: {} } };
    },
    follow(sessionId) { state.follows.add(sessionId); },
    forget(sessionId) { state.follows.delete(sessionId); },
    startStream(cb) { onFrame = cb; },
    stopStream() { onFrame = null; },
    get connected() { return true; },
  };
  return client;
}

function baseRecord(overrides = {}) {
  return {
    turnId: 'turn_test1',
    sessionKey: 'qq:group:123456',
    envelope: {
      platform: 'qq',
      conversation: { kind: 'group', id: '123456' },
      prompt: { text: '【平台消息】群 123456\n内容：在吗' },
      message: { id: 'm1', sender: { id: '10001', name: '张三', roles: ['member'] }, text: '在吗' },
    },
    degraded: [],
    ...overrides,
  };
}

// --------------------------------------------------------- session-registry

test('registry: 创建、复用、fail-closed、not-found 重建', async () => {
  const dsh = createFakeDsh();
  const registry = createSessionRegistry({ dsh, chat: CHAT, file: tmpFile('sessions.json') });

  const first = await registry.getOrCreate('qq:group:1');
  assert.match(first, /^sess-/);
  // 复用：不再新建。
  assert.equal(await registry.getOrCreate('qq:group:1'), first);

  // fail-closed：preset 不在 DSH 清单时拒绝建会话（用新 registry 避开清单缓存）。
  dsh.state.presetList = ['standard'];
  const strict = createSessionRegistry({ dsh, chat: CHAT, file: null });
  await assert.rejects(() => strict.getOrCreate('qq:group:2'), /preset/);
  dsh.state.presetList = null;

  // not-found：DSH 侧会话消失 → 本地映射退役并重建。
  dsh.state.failNotFound.add(first);
  const second = await registry.getOrCreate('qq:group:1');
  assert.notEqual(second, first);
  assert.equal(dsh.state.follows.has(second), true);
});

// ------------------------------------------------------------- prompt-queue

test('prompt-queue: 同会话串行、排队任务合并、跨会话并行', async () => {
  const queue = createPromptQueue({});
  const order = [];
  const release = [];
  const gate = () => new Promise((resolve) => release.push(resolve));

  const a = queue.enqueue('k1', async () => { order.push('a-start'); await gate(); order.push('a-end'); return {}; });
  const b = queue.enqueue('k1', async () => { order.push('b'); return {}; });
  const c = queue.enqueue('k1', async () => { order.push('c'); return {}; });
  const other = queue.enqueue('k2', async () => { order.push('k2'); return {}; });

  // b 被 c 取代（合并），c 在 a 之后执行；k2 与 a 并行。
  assert.deepEqual(await b, { coalesced: true });
  release[0]();
  await Promise.all([a, c, other]);
  assert.equal(order.includes('k2'), true);
  assert.ok(order.indexOf('a-end') < order.indexOf('c'));
  assert.ok(order.indexOf('k2') < order.indexOf('a-end'));
});

// -------------------------------------------------- turn-runner end-to-end

test('turn-runner: 完整 turn（先注册等待者 → prompt → 收集文本 → 落盘）', async () => {
  const dsh = createFakeDsh();
  const registry = createSessionRegistry({ dsh, chat: CHAT, file: null });
  const gateway = createDshGateway({ dsh, turnTimeoutMs: CHAT.turnTimeoutMs });
  const queue = createPromptQueue({});
  const turns = createTurnStore({ file: null });
  const runner = createTurnRunner({ config: { chat: CHAT }, dsh, registry, gateway, queue, turns, logger: () => {} });
  gateway.start();

  const record = baseRecord();
  const done = runner.submit(record);
  await waitFor(() => dsh.state.prompts.length === 1);
  assert.match(dsh.state.prompts[0].text, /在吗/);
  assert.equal(dsh.state.prompts[0].sessionId, registry.get('qq:group:123456').sessionId);

  dsh.finishTurn(dsh.state.prompts[0].sessionId, '在的，怎么了？');
  const result = await done;
  assert.equal(result.status, 'completed');
  assert.equal(result.text, '在的，怎么了？');
  assert.equal(turns.get(record.turnId).status, 'completed');
  gateway.stop();
});

test('turn-runner: 超时 → 显式 session/cancel（否则下一轮与上一轮并发）', async () => {
  const dsh = createFakeDsh();
  const chat = { ...CHAT, turnTimeoutMs: 80 };
  const registry = createSessionRegistry({ dsh, chat, file: null });
  const gateway = createDshGateway({ dsh, turnTimeoutMs: chat.turnTimeoutMs });
  const queue = createPromptQueue({});
  const turns = createTurnStore({ file: null });
  const runner = createTurnRunner({ config: { chat }, dsh, registry, gateway, queue, turns, logger: () => {} });
  gateway.start();

  const result = await runner.submit(baseRecord({ turnId: 'turn_timeout' }));
  assert.equal(result.status, 'timeout');
  const sessionId = dsh.state.prompts[0].sessionId;
  assert.deepEqual(dsh.state.cancels, [sessionId], '超时后必须对同一 DSH 会话发 session/cancel');
  assert.equal(turns.get('turn_timeout').status, 'timeout');
  gateway.stop();
});

test('turn-runner: prompt 被拒 → error 落盘，不炸进程', async () => {
  const dsh = createFakeDsh();
  dsh.state.promptFailure = { code: 'session/busy', message: 'busy' };
  const registry = createSessionRegistry({ dsh, chat: CHAT, file: null });
  const gateway = createDshGateway({ dsh, turnTimeoutMs: 500 });
  const queue = createPromptQueue({});
  const turns = createTurnStore({ file: null });
  const runner = createTurnRunner({ config: { chat: CHAT }, dsh, registry, gateway, queue, turns, logger: () => {} });
  gateway.start();

  const result = await runner.submit(baseRecord({ turnId: 'turn_err' }));
  assert.equal(result.status, 'error');
  assert.match(result.error.message, /session\.prompt rejected/);
  assert.equal(turns.get('turn_err').status, 'error');
  gateway.stop();
});

test('turn-runner: 同会话连发三帧 → 排队中的中间帧被合并，末帧正常执行', async () => {
  const dsh = createFakeDsh();
  const registry = createSessionRegistry({ dsh, chat: CHAT, file: null });
  const gateway = createDshGateway({ dsh, turnTimeoutMs: CHAT.turnTimeoutMs });
  const queue = createPromptQueue({});
  const turns = createTurnStore({ file: null });
  const runner = createTurnRunner({ config: { chat: CHAT }, dsh, registry, gateway, queue, turns, logger: () => {} });
  gateway.start();

  const mk = (id, mid, text) => {
    const record = baseRecord({ turnId: id, sessionKey: 'qq:group:123456' });
    record.envelope = { ...record.envelope, message: { ...record.envelope.message, id: mid }, prompt: { text } };
    return record;
  };
  const doneA = runner.submit(mk('turn_a', 'm1', '第一条'));
  const doneB = runner.submit(mk('turn_b', 'm2', '第二条'));
  const doneC = runner.submit(mk('turn_c', 'm3', '第三条'));

  await waitFor(() => dsh.state.prompts.filter((p) => p.text === '第一条').length === 1);
  dsh.finishTurn(dsh.state.prompts[0].sessionId, '回复一');
  const resultA = await doneA;
  assert.equal(resultA.status, 'completed');

  // b 在排队中被 c 取代。
  assert.deepEqual(await doneB, { coalesced: true });
  assert.equal(turns.get('turn_b').status, 'coalesced');

  // c 接着执行。
  await waitFor(() => dsh.state.prompts.length === 2);
  dsh.finishTurn(dsh.state.prompts[1].sessionId, '回复三');
  const resultC = await doneC;
  assert.equal(resultC.status, 'completed');
  assert.equal(turns.get('turn_c').status, 'completed');
  gateway.stop();
});

test('turn-runner: 合成唤醒事件（kind=event、无 prompt）由网关合成 prompt', async () => {
  const dsh = createFakeDsh();
  const registry = createSessionRegistry({ dsh, chat: CHAT, file: null });
  const gateway = createDshGateway({ dsh, turnTimeoutMs: CHAT.turnTimeoutMs });
  const queue = createPromptQueue({});
  const turns = createTurnStore({ file: null });
  const counters = [];
  const runner = createTurnRunner({
    config: { chat: CHAT }, dsh, registry, gateway, queue, turns, logger: () => {},
    metrics: { inc: (name, tags) => counters.push({ name, ...tags }), observe: () => {} },
  });
  gateway.start();

  const record = baseRecord({
    turnId: 'turn_wait1',
    envelope: {
      platform: 'qq',
      kind: 'event',
      conversation: { kind: 'group', id: '123456' },
      wake: { kind: 'wait', status: 'arrived', purpose: 'messages', baselineSeq: 7, satisfiedSeq: 9 },
      message: {
        id: 'wait-1',
        sender: { id: '0', name: 'wait-scheduler', roles: ['bot'] },
        text: '(wait satisfied: 2 new message(s))',
      },
      snapshot: [
        { at: '12:00', sender: '张三', text: '在吗' },
        { at: '12:01', sender: '李四', text: '来了' },
      ],
    },
  });
  const done = runner.submit(record);
  await waitFor(() => dsh.state.prompts.length === 1);
  const prompt = dsh.state.prompts[0].text;
  assert.match(prompt, /【唤醒事件】等待唤醒（群 123456）/);
  assert.match(prompt, /你此前登记等待的新消息已经到达/);
  assert.match(prompt, /张三：在吗/);
  assert.match(prompt, /李四：来了/);

  dsh.finishTurn(dsh.state.prompts[0].sessionId, '好');
  const result = await done;
  assert.equal(result.status, 'completed');
  // 唤醒来源落库 + 计数：运维能回答「这轮是谁叫醒的」。
  assert.equal(turns.get('turn_wait1').result.wake.kind, 'wait');
  assert.deepEqual(
    counters.filter((entry) => entry.name === 'gateway_wake_total')
      .map((entry) => `${entry.kind}:${entry.status}`),
    ['wait:arrived'],
  );
  gateway.stop();
});

test('turn-runner: proactive 合成事件（wake.kind=proactive）合成主动唤醒 prompt', async () => {
  const dsh = createFakeDsh();
  const registry = createSessionRegistry({ dsh, chat: CHAT, file: null });
  const gateway = createDshGateway({ dsh, turnTimeoutMs: CHAT.turnTimeoutMs });
  const queue = createPromptQueue({});
  const turns = createTurnStore({ file: null });
  const runner = createTurnRunner({
    config: { chat: CHAT }, dsh, registry, gateway, queue, turns, logger: () => {},
  });
  gateway.start();

  const record = baseRecord({
    turnId: 'turn_proactive1',
    envelope: {
      platform: 'qq',
      kind: 'event',
      conversation: { kind: 'group', id: '123456' },
      wake: { kind: 'proactive', status: 'arrived' },
      message: {
        id: 'wake-abc-1',
        sender: { id: '0', name: 'wake-scheduler', roles: ['bot'] },
        text: '（主动唤醒：主动机会，正文由网关按快照合成）',
      },
      snapshot: [{ at: '12:00', sender: '张三', text: '今天好安静' }],
    },
  });
  const done = runner.submit(record);
  await waitFor(() => dsh.state.prompts.length === 1);
  const prompt = dsh.state.prompts[0].text;
  assert.match(prompt, /【唤醒事件】主动唤醒（群 123456）/);
  assert.match(prompt, /这不是有人点名你/);
  assert.match(prompt, /【最近的消息】/);
  assert.match(prompt, /张三：今天好安静/);
  assert.doesNotMatch(prompt, /等待期间的消息/);

  const usage = { inputTokens: 11, outputTokens: 3 };
  dsh.finishTurn(dsh.state.prompts[0].sessionId, '嗯', 'completed', usage);
  const result = await done;
  assert.equal(result.status, 'completed');
  assert.equal(turns.get('turn_proactive1').result.wake.kind, 'proactive');
  // usage 随 turn record 落盘：/v1/usage 与桥接 token 账本的唯一数据源。
  assert.deepEqual(turns.get('turn_proactive1').result.usage, usage);
  gateway.stop();
});

// ----------------------------------------------------------- 灰度路由

test('server: mode=on + 白名单 → 交给 runtime；未命中 → unrouted', async () => {
  const config = loadConfig({
    env: { GATEWAY_MODE: 'on', GATEWAY_PORT: '0', GATEWAY_CONVERSATIONS: 'qq:group:123456' },
    stateDir: tmpFile('state'),
    adapters: [{ id: 'qq-test', platform: 'qq', secret: 'test-secret-0123456789abcdef' }],
  });
  assert.equal(isConversationAllowed(config, 'qq:group:123456'), true);
  assert.equal(isConversationAllowed(config, 'qq:group:999'), false);
  assert.equal(isConversationAllowed(config, 'qq:group:1'), false);

  const submitted = [];
  const runtime = {
    submit: (record) => { submitted.push(record); },
    stop: async () => {},
    status: () => ({ queued: 0, running: 0 }),
    connected: false,
  };
  const gw = createGatewayServer({ config, runtime, logger: () => {} });

  const hit = gw.handleInbound(baseRecord().envelope);
  assert.equal(hit.routed, true);
  assert.equal(hit.status, 'accepted');
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].sessionKey, 'qq:group:123456');

  const miss = gw.handleInbound(baseRecord({
    sessionKey: 'qq:group:999',
    envelope: { ...baseRecord().envelope, conversation: { kind: 'group', id: '999' }, message: { ...baseRecord().envelope.message, id: 'm9' } },
  }).envelope);
  assert.equal(miss.routed, false);
  assert.equal(miss.status, 'unrouted');
  assert.equal(submitted.length, 1);
  await gw.close();
});

test('server: submit 同步抛错 → 幂等回滚，重试不被判 deduped', async () => {
  const config = loadConfig({
    env: { GATEWAY_MODE: 'on', GATEWAY_PORT: '0', GATEWAY_CONVERSATIONS: 'qq:group:123456' },
    stateDir: tmpFile('state'),
    adapters: [{ id: 'qq-test', platform: 'qq', secret: 'test-secret-0123456789abcdef' }],
  });
  let submits = 0;
  const runtime = {
    submit: () => {
      submits += 1;
      throw new Error('queue closed');
    },
    stop: async () => {},
    status: () => ({ queued: 0, running: 0 }),
    connected: false,
  };
  const gw = createGatewayServer({ config, runtime, logger: () => {} });
  try {
    const envelope = baseRecord().envelope;
    assert.throws(() => gw.handleInbound(envelope), /queue closed/);
    // 同一条消息重发：幂等记录已回滚，必须再次尝试提交（否则这一轮永久丢失）。
    assert.throws(() => gw.handleInbound(envelope), /queue closed/);
    assert.equal(submits, 2);
  } finally {
    await gw.close();
  }
});

// ------------------------------------------------- 回合文本不再自动投递

test('turn-runner: 回合文本不产生出站动作，turns.result.tools 记录工具统计并留 no-send 日志', async () => {
  const dsh = createFakeDsh();
  const registry = createSessionRegistry({ dsh, chat: CHAT, file: null });
  const gateway = createDshGateway({ dsh, turnTimeoutMs: CHAT.turnTimeoutMs });
  const queue = createPromptQueue({});
  const turns = createTurnStore({ file: null });
  const logs = [];
  const runner = createTurnRunner({
    config: { chat: CHAT }, dsh, registry, gateway, queue, turns,
    toolHost: {
      registerTurn: () => {},
      // 这一轮调了 2 次工具，但都不是发送类：文本不会被自动发出去。
      releaseTurn: () => ({ calls: 2, sent: 0 }),
    },
    logger: (line) => logs.push(line),
  });
  gateway.start();

  const record = baseRecord({ turnId: 'turn_nosend' });
  const done = runner.submit(record);
  await waitFor(() => dsh.state.prompts.length === 1);
  dsh.finishTurn(dsh.state.prompts[0].sessionId, '我在想事情');
  const result = await done;

  assert.equal(result.status, 'completed');
  const stored = turns.get('turn_nosend');
  assert.deepEqual(stored.result.tools, { calls: 2, sent: 0 });
  assert.ok(logs.some((line) => line.includes('no-send')), 'no-send 必须留日志');
  gateway.stop();
});
