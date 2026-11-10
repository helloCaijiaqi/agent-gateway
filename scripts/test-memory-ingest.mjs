// §6 记忆落库调度器测试（raw-only 会话纪元模型）：双向观察、msgId 去重、
// 防抖聚合（窗口/批量冲刷）、在途上限 FIFO、失败重试本地缓冲、放弃上限。
// 全离线：deliver 用假注入，无真 memory-mcp。
import assert from 'node:assert/strict';
import test from 'node:test';

const { createMemoryIngest } = await import(new URL('../src/runtime/memory-ingest.mjs', import.meta.url).href);

test('ingest: 入站/出站观察归一为 raw 记录（msgId + senderId + 文本折叠）；无文本跳过', async () => {
  const sent = [];
  const ingest = createMemoryIngest({ deliver: async (record) => { sent.push(record); }, windowMs: 60_000 });
  ingest.observeInbound({
    sessionKey: 'qq:group:123',
    envelope: { message: { id: 'm-1', text: '  今天\n天气不错 ', sender: { id: '10001', name: '张三' }, createdAt: 1234 } },
  });
  ingest.observeInbound({ sessionKey: 'qq:group:123', envelope: { wake: { kind: 'cron' } } }); // 合成事件无文本 → 跳过
  ingest.observeOutbound({
    sessionKey: 'qq:group:123', tool: 'chat_qq_send_text', args: { content: '好的，明天见' },
    msgId: 'out:turn-1:call-1',
  });
  ingest.observeOutbound({ sessionKey: 'qq:group:123', tool: 'chat_qq_send_text', args: {}, msgId: 'out:turn-1:call-2' }); // 无文本 → 跳过
  assert.equal(ingest.stats().buffered, 2, '空文本不进缓冲');
  await ingest.flushAll();
  assert.deepEqual(sent.map((r) => [r.sessionId, r.msgId, r.text, r.kind, r.senderId]), [
    ['qq:group:123', 'm-1', '今天 天气不错', 'episodic', '10001'], // 空白折叠
    ['qq:group:123', 'out:turn-1:call-1', '好的，明天见', 'episodic', 'assistant'], // 出站合成 id
  ]);
});

test('ingest: 缺 msgId 只记日志不投递（raw 唯一键必须有 msgId）', async () => {
  const logs = [];
  const sent = [];
  const ingest = createMemoryIngest({
    deliver: async (record) => { sent.push(record); },
    windowMs: 60_000,
    logger: (msg) => logs.push(msg),
  });
  ingest.observeInbound({ sessionKey: 's1', envelope: { message: { text: '没有 id', sender: { id: 'u' } } } });
  ingest.observeOutbound({ sessionKey: 's1', tool: 't', args: { content: '没有合成 id' } });
  await ingest.flushAll();
  assert.equal(sent.length, 0);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /missing msgId/);
});

test('ingest: 攒满 maxBatch 提前冲刷；同 msgId 重复观察去重（重放/多拦截点）', async () => {
  const sent = [];
  const ingest = createMemoryIngest({ deliver: async (record) => { sent.push(record); }, windowMs: 60_000, maxBatch: 3 });
  const msg = (id, text) => ({ message: { id, text, sender: { id: 'u' } } });
  for (const [id, text] of [['m1', 'a'], ['m2', 'b'], ['m2', 'b'], ['m3', 'c']]) {
    ingest.observeInbound({ sessionKey: 's1', envelope: msg(id, text) });
  }
  assert.equal(ingest.stats().buffered, 0, '第 3 条（m3）触发批量冲刷；m2 重放被去重');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent.map((r) => r.msgId), ['m1', 'm2', 'm3']);
  assert.equal(ingest.stats().flushed, 3);
});

test('ingest: 同 msgId 但内容不同 = 去重命中（幂等键是会话+msgId，不是内容）', async () => {
  const sent = [];
  const ingest = createMemoryIngest({ deliver: async (record) => { sent.push(record); }, windowMs: 60_000 });
  ingest.observeInbound({ sessionKey: 's1', envelope: { message: { id: 'm1', text: '第一次', sender: { id: 'u' } } } });
  ingest.observeInbound({ sessionKey: 's1', envelope: { message: { id: 'm1', text: '适配器重试时内容重渲染', sender: { id: 'u' } } } });
  await ingest.flushAll();
  assert.equal(sent.length, 1, '同 msgId 只落一次，服务端 UNIQUE 兜底');
});

test('ingest: 窗口到期自动冲刷（windowMs 兜底）', async () => {
  const sent = [];
  const ingest = createMemoryIngest({ deliver: async (record) => { sent.push(record); }, windowMs: 1000 });
  ingest.observeInbound({ sessionKey: 's1', envelope: { message: { id: 'm1', text: '窗口冲刷', sender: { id: 'u' } } } });
  assert.equal(sent.length, 0);
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(sent.length, 1);
  assert.equal(ingest.stats().buffered, 0);
});

test('ingest: 在途上限 maxConcurrent——窗口吐 50 条时最多 4 个并发（防尖峰）', async () => {
  let active = 0;
  let peak = 0;
  const ingest = createMemoryIngest({
    deliver: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    },
    windowMs: 60_000,
    maxConcurrent: 4,
  });
  for (let i = 0; i < 30; i += 1) {
    ingest.observeInbound({ sessionKey: 's1', envelope: { message: { id: `m${i}`, text: `t${i}`, sender: { id: 'u' } } } });
  }
  await ingest.flushAll();
  assert.equal(peak, 4, `并发峰值应恰为上限，实际 ${peak}`);
  assert.equal(ingest.stats().flushed, 30);
  assert.equal(ingest.stats().inflight, 0);
  assert.equal(ingest.stats().queued, 0);
});

test('ingest: deliver 失败进重试缓冲（指数退避），flushAll(force) 立即重试成功', async () => {
  let fail = true;
  const attempts = [];
  const ingest = createMemoryIngest({
    deliver: async (record) => {
      attempts.push(record.msgId);
      if (fail) throw new Error('memory-mcp unreachable');
    },
    windowMs: 60_000,
  });
  ingest.observeInbound({ sessionKey: 's1', envelope: { message: { id: 'm1', text: '会失败的一条', sender: { id: 'u' } } } });
  await ingest.flushAll();
  assert.equal(ingest.stats().retrying, 1);
  assert.equal(ingest.stats().flushed, 0);
  fail = false;
  await ingest.flushAll(true);
  assert.equal(ingest.stats().retrying, 0);
  assert.equal(ingest.stats().flushed, 1);
  assert.equal(attempts.length, 2, '第一次失败 + 强制重试成功');
});

test('ingest: 超过 maxAttempts 丢弃并计数（宁丢不阻塞主链路）', async () => {
  const ingest = createMemoryIngest({
    deliver: async () => { throw new Error('down'); },
    windowMs: 60_000,
    maxAttempts: 2,
  });
  ingest.observeInbound({ sessionKey: 's1', envelope: { message: { id: 'm1', text: '注定丢失', sender: { id: 'u' } } } });
  await ingest.flushAll(true); // attempt 1
  await ingest.flushAll(true); // attempt 2 → 保留
  assert.equal(ingest.stats().retrying, 1);
  await ingest.flushAll(true); // attempt 3 > maxAttempts → 丢弃
  assert.equal(ingest.stats().retrying, 0);
  assert.equal(ingest.stats().dropped, 1);
});

test('ingest: 超长文本截断；全局缓冲溢出丢最旧', async () => {
  const sent = [];
  const ingest = createMemoryIngest({
    deliver: async (record) => { sent.push(record); },
    windowMs: 60_000,
    maxChars: 10,
    maxBuffer: 3,
  });
  for (let i = 0; i < 5; i += 1) {
    ingest.observeInbound({ sessionKey: `s${i}`, envelope: { message: { id: `m${i}`, text: `m${i}`, sender: { id: 'u' } } } });
  }
  assert.ok(ingest.stats().dropped >= 2, '溢出丢弃');
  ingest.observeInbound({ sessionKey: 'long', envelope: { message: { id: 'mx', text: 'x'.repeat(50), sender: { id: 'u' } } } });
  await ingest.flushAll(true);
  const truncated = sent.find((r) => r.text.startsWith('x'));
  assert.equal(truncated.text.length, 11, '截断到 maxChars + 省略号');
});

test('ingest: deliver 同步抛错不打断主链路（收敛为 rejected promise 后进重试）', async () => {
  const ingest = createMemoryIngest({
    // 同步抛错的实现（旧代码直接在 observe 的调用栈里抛出，会把入站处理一起打断）。
    deliver: () => { throw new Error('sync boom'); },
    windowMs: 60_000,
    maxAttempts: 1,
  });
  assert.doesNotThrow(() => {
    ingest.observeInbound({ sessionKey: 's1', envelope: { message: { id: 'm1', text: '同步炸', sender: { id: 'u' } } } });
  });
  await assert.doesNotReject(() => ingest.flushAll(true));
  assert.equal(ingest.stats().retrying, 1, '第一次失败进重试队列');
  await ingest.flushAll(true);
  assert.equal(ingest.stats().retrying, 0, '超过 maxAttempts 后丢弃');
  assert.equal(ingest.stats().dropped, 1);
});
