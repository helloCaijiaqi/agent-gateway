// 会话纪元 block 缓存专项（§6.4）：同 epoch 不重发、epoch 变更重发、多 subject
// 各自去重、无 senderId 退化为会话级、LRU 淘汰后重发幂等、join 规则同样去重、
// 无 epoch 的旧服务响应不受影响。全部离线：registry 用假实现。
import assert from 'node:assert/strict';
import test from 'node:test';

const { createPipeline } = await import(new URL('../src/core/pipeline.mjs', import.meta.url).href);

const ENVELOPE_U1 = { message: { id: 'm1', text: 'hi', sender: { id: 'u1', name: '张三' } } };
const ENVELOPE_U2 = { message: { id: 'm2', text: 'hi', sender: { id: 'u2', name: '李四' } } };

const IDENTITY_BLOCKS = [
  { name: '画像', kind: 'identity', text: '【画像】\n- 性格：温和' },
  { name: '关系', kind: 'identity', text: '【关系】\n- 称呼：老王' },
  { name: '长期记忆', kind: 'long', text: '【长期记忆】\n- 喜欢火锅' },
];

/** 假 registry：一个装饰器服务 chat_memory_recall，返回由用例注入的构造结果。 */
function makeRegistry(responder) {
  let n = 0;
  const calls = [];
  return {
    calls,
    resolveService: (name) => (name === 'chat_memory_recall'
      ? { id: 'chat_memory_recall', kind: 'decorator', transport: 'ws' }
      : null),
    resolveToolStep: () => null,
    pipelineFor: () => ['chat_memory_recall'],
    pipelineForReturn: () => (responder?.returnPipeline ? ['chat_memory_recall'] : []),
    async callService(id, request) {
      n += 1;
      calls.push(request);
      return responder.call(request, n);
    },
    pipelineKeys: () => [],
    returnPipelineKeys: () => [],
  };
}

test('block cache：同 epoch 的后续轮次不重发（首轮全注入，之后 sections 为空）', async () => {
  const registry = makeRegistry({ call: () => ({ verdict: 'pass', epoch: 1, sections: IDENTITY_BLOCKS }) });
  const pipeline = createPipeline({ registry, budgetChars: 6000 });
  const input = { consumerId: 'qq-main', sessionKey: 'qq:group:1', text: 'hi', envelope: ENVELOPE_U1 };

  const first = await pipeline.runForward({ ...input });
  assert.equal(first.sections.length, 3, '首轮全量注入');
  const second = await pipeline.runForward({ ...input });
  assert.equal(second.sections.length, 0, '同 epoch 第二轮不重发');
  assert.equal(second.text, 'hi', '消息本体不受影响');
  const third = await pipeline.runForward({ ...input });
  assert.equal(third.sections.length, 0);
  assert.equal(registry.calls.length, 3, '服务端始终被调（幂等返回），去重发生在网关');
});

test('block cache：epoch 推进（静默失活 → 新会话）后全量重发', async () => {
  let epoch = 1;
  const registry = makeRegistry({ call: () => ({ verdict: 'pass', epoch, sections: IDENTITY_BLOCKS }) });
  const pipeline = createPipeline({ registry, budgetChars: 6000 });
  const input = { consumerId: 'qq-main', sessionKey: 'qq:group:1', text: 'hi', envelope: ENVELOPE_U1 };

  await pipeline.runForward({ ...input });
  assert.equal((await pipeline.runForward({ ...input })).sections.length, 0);

  epoch = 2; // 服务端判定新会话
  const woken = await pipeline.runForward({ ...input });
  assert.equal(woken.sections.length, 3, '新 epoch 重新注入（identity + 长期记忆）');
});

test('block cache：多 subject 各自去重（群聊每人的 identity 独立）', async () => {
  const registry = makeRegistry({ call: () => ({ verdict: 'pass', epoch: 1, sections: IDENTITY_BLOCKS }) });
  const pipeline = createPipeline({ registry, budgetChars: 6000 });

  await pipeline.runForward({ consumerId: 'qq-main', sessionKey: 'qq:group:1', text: 'hi', envelope: ENVELOPE_U1 });
  await pipeline.runForward({ consumerId: 'qq-main', sessionKey: 'qq:group:1', text: 'hi', envelope: ENVELOPE_U1 });
  // u2 首次出现：不能因为 u1 已注入就被去重掉。
  const u2First = await pipeline.runForward({ consumerId: 'qq-main', sessionKey: 'qq:group:1', text: 'hi', envelope: ENVELOPE_U2 });
  assert.equal(u2First.sections.length, 3, '新 subject 各自首轮注入');
  // u1 再说：仍去重。
  const u1Again = await pipeline.runForward({ consumerId: 'qq-main', sessionKey: 'qq:group:1', text: 'hi', envelope: ENVELOPE_U1 });
  assert.equal(u1Again.sections.length, 0);
});

test('block cache：无 senderId 退化为会话级（subject 键为空串）', async () => {
  const registry = makeRegistry({ call: () => ({ verdict: 'pass', epoch: 1, sections: IDENTITY_BLOCKS }) });
  const pipeline = createPipeline({ registry, budgetChars: 6000 });
  const input = { consumerId: 'qq-main', sessionKey: 'qq:friend:1', text: 'hi', envelope: { message: { id: 'm', text: 'hi' } } };

  assert.equal((await pipeline.runForward({ ...input })).sections.length, 3);
  assert.equal((await pipeline.runForward({ ...input })).sections.length, 0);
});

test('block cache：senderId 透传给服务（请求体带 senderId）', async () => {
  const registry = makeRegistry({ call: () => ({ verdict: 'pass', epoch: 1, sections: IDENTITY_BLOCKS }) });
  const pipeline = createPipeline({ registry, budgetChars: 6000 });
  await pipeline.runForward({ consumerId: 'qq-main', sessionKey: 'qq:group:1', text: 'hi', envelope: ENVELOPE_U1 });
  assert.equal(registry.calls[0].senderId, 'u1');

  const noSender = makeRegistry({ call: () => ({ verdict: 'pass', epoch: 1, sections: [] }) });
  const p2 = createPipeline({ registry: noSender, budgetChars: 6000 });
  await p2.runForward({ consumerId: 'qq-main', sessionKey: 'qq:friend:1', text: 'hi', envelope: { message: { id: 'm', text: 'hi' } } });
  assert.equal(noSender.calls[0].senderId, '', '无发送者 = 空串（会话级）');
});

test('block cache：LRU 淘汰后重发幂等（超 256 会话，最旧被重注入）', async () => {
  const registry = makeRegistry({ call: () => ({ verdict: 'pass', epoch: 1, sections: IDENTITY_BLOCKS }) });
  const pipeline = createPipeline({ registry, budgetChars: 6000 });
  // 257 个会话各注入一次 → 第一个会话的缓存条目被淘汰。
  for (let i = 0; i < 257; i += 1) {
    await pipeline.runForward({ consumerId: 'qq-main', sessionKey: `qq:group:${i}`, text: 'hi', envelope: ENVELOPE_U1 });
  }
  // 会话 0 重来：缓存已淘汰 → 重发（服务端幂等返回，多一次注入无害）。
  const again = await pipeline.runForward({ consumerId: 'qq-main', sessionKey: 'qq:group:0', text: 'hi', envelope: ENVELOPE_U1 });
  assert.equal(again.sections.length, 3, 'LRU 淘汰后重发（at-least-once 兜底）');
  // 刚注入过的会话 256 不受影响。
  const recent = await pipeline.runForward({ consumerId: 'qq-main', sessionKey: 'qq:group:256', text: 'hi', envelope: ENVELOPE_U1 });
  assert.equal(recent.sections.length, 0);
});

test('block cache：join 规则路径同样去重；无 epoch 的旧服务响应不受影响', async () => {
  // 供料型（join 规则）memory step：首轮拼接进消息本体，之后不再拼接。
  let epoch = 1;
  const registry = makeRegistry({ call: () => ({ verdict: 'pass', epoch, sections: IDENTITY_BLOCKS }) });
  const pipeline = createPipeline({ registry, budgetChars: 6000 });
  const input = {
    consumerId: 'qq-main',
    sessionKey: 'qq:group:1',
    text: 'hi',
    envelope: ENVELOPE_U1,
  };
  // 供料型规则对象：join 词典是 prefix/suffix/regex/function（entryShape）。
  const joinRegistry = {
    ...makeRegistry({ call: () => ({ verdict: 'pass', epoch, sections: IDENTITY_BLOCKS }) }),
    pipelineFor: () => [{ step: 'chat_memory_recall', join: 'prefix' }],
  };
  const joinPipeline = createPipeline({ registry: joinRegistry, budgetChars: 6000 });
  const joinedFirst = await joinPipeline.runForward({ ...input });
  assert.ok(joinedFirst.text.includes('【画像】'), '首轮 join 注入');
  assert.ok(joinedFirst.text.includes('hi'));
  const joinedSecond = await joinPipeline.runForward({ ...input });
  assert.equal(joinedSecond.text, 'hi', '同 epoch 第二轮 join 不再拼接');

  // 旧服务（无 epoch 字段）：行为与从前完全一致（不去重、每轮都收集）。
  const legacy = makeRegistry({ call: () => ({ verdict: 'pass', sections: [{ name: '记忆', text: '【记忆】\n- 旧格式' }] }) });
  const legacyPipeline = createPipeline({ registry: legacy, budgetChars: 6000 });
  const l1 = await legacyPipeline.runForward({ consumerId: 'qq-main', sessionKey: 's', text: 'hi', envelope: ENVELOPE_U1 });
  const l2 = await legacyPipeline.runForward({ consumerId: 'qq-main', sessionKey: 's', text: 'hi', envelope: ENVELOPE_U1 });
  assert.equal(l1.sections.length, 1);
  assert.equal(l2.sections.length, 1, '无 epoch = 无去重（兼容旧服务）');
});
