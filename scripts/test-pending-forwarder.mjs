// 平台 pending 转发：失败必须可重试（旧实现先标记后投递，失败即永久丢失）。
import test from 'node:test';
import assert from 'node:assert/strict';

const { createPendingForwarder } = await import(
  new URL('../src/runtime/pending-forwarder.mjs', import.meta.url).href
);

const adapters = [{ id: 'qq-main', platform: 'qq', secret: 'x', callbackBase: 'http://127.0.0.1:1' }];
const registry = { sessionKeyOf: (sessionId) => (sessionId ? 'qq:group:123' : null) };

function entry(eventId) {
  return { kind: 'question', eventId, sessionId: 'sess-1', questions: ['继续吗？'] };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('pending-forwarder: 投递失败会退避重试，成功后停止', async () => {
  let attempts = 0;
  const forwarder = createPendingForwarder({
    deliver: async () => {
      attempts += 1;
      return attempts < 3 ? { ok: false, code: 'E_PLATFORM', message: 'down' } : { ok: true };
    },
    adapters,
    registry,
    retryBaseMs: 5,
    maxAttempts: 3,
    logger: () => {},
  });
  try {
    forwarder.forward(entry('evt-1'));
    const deadline = Date.now() + 1000;
    while (attempts < 3 && Date.now() < deadline) await sleep(10);
    assert.equal(attempts, 3, '前两次失败应重试，第三次成功');
    const stats = forwarder.stats();
    assert.equal(stats.forwardedTracked, 1);
    assert.equal(stats.inflight, 0);
    assert.equal(stats.retryScheduled, 0);
  } finally {
    forwarder.close();
  }
});

test('pending-forwarder: 重试次数用尽后放弃；成功过的事件不再重投', async () => {
  let attempts = 0;
  const forwarder = createPendingForwarder({
    deliver: async () => {
      attempts += 1;
      return { ok: false, code: 'E_PLATFORM', message: 'down' };
    },
    adapters,
    registry,
    retryBaseMs: 5,
    maxAttempts: 2,
    logger: () => {},
  });
  try {
    forwarder.forward(entry('evt-2'));
    const deadline = Date.now() + 1000;
    while (attempts < 3 && Date.now() < deadline) await sleep(10);
    await sleep(80);
    // 首次 + 2 次重试 = 3 次投递，之后不再排重试。
    assert.equal(attempts, 3);
    assert.equal(forwarder.stats().retryScheduled, 0);
  } finally {
    forwarder.close();
  }
});

test('pending-forwarder: 成功只投一次（在途去重 + 成功去重）', async () => {
  let attempts = 0;
  const forwarder = createPendingForwarder({
    deliver: async () => {
      attempts += 1;
      await sleep(20);
      return { ok: true };
    },
    adapters,
    registry,
    retryBaseMs: 5,
    maxAttempts: 2,
    logger: () => {},
  });
  try {
    const one = entry('evt-3');
    forwarder.forward(one);
    forwarder.forward(one); // 在途重复：应被 inflight 挡住
    await sleep(60);
    forwarder.forward(one); // 已成功：应被 forwarded 挡住
    await sleep(30);
    assert.equal(attempts, 1);
  } finally {
    forwarder.close();
  }
});

test('pending-forwarder: close() 清掉待重试定时器', async () => {
  let attempts = 0;
  const forwarder = createPendingForwarder({
    deliver: async () => {
      attempts += 1;
      return { ok: false, code: 'E_PLATFORM', message: 'down' };
    },
    adapters,
    registry,
    retryBaseMs: 50,
    maxAttempts: 5,
    logger: () => {},
  });
  forwarder.forward(entry('evt-4'));
  await sleep(10);
  assert.equal(forwarder.stats().retryScheduled, 1);
  forwarder.close();
  await sleep(80);
  assert.equal(attempts, 1, 'close 后不得再投递');
});
