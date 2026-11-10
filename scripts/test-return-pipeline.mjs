/**
 * P5 回路链执行端到端：
 *  - engine 级：runReturn 语义（filter drop / decorator 改写 / direction 透传 /
 *    once / 静态供料 / default 回退 / forward 不受影响）；
 *  - transport 级：deliverAction 拦截点（drop 不发请求且回执成功 / 改写生效 /
 *    无钩子或无 text 或钩子异常 = 原样透传）。
 * 运行：node scripts/test-return-pipeline.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPipeline, protocolTokenLine } from '../src/core/pipeline.mjs';
import { deliverAction } from '../src/executors/adapter-tools/common/transport.mjs';

const BUILTINS = {
  protocol: { name: 'protocol', priority: 100, build: ({ deps }) => (deps?.turnToken ? { text: protocolTokenLine(deps.turnToken) } : null) },
};

function fakeServiceRegistry({ services = {}, pipelines = {}, returnPipelines = {}, results = {}, requests = [] } = {}) {
  return {
    resolveService: (id) => services[id] ?? null,
    resolveToolStep: () => null,
    async callService(id, request) {
      requests.push({ id, request });
      return { v: 1, callId: request.callId, ...(results[id] ?? {}) };
    },
    pipelineFor: (consumerId) => pipelines[consumerId] ?? pipelines.default ?? [],
    pipelineKeys: () => Object.keys(pipelines),
    pipelineForReturn: (consumerId) => returnPipelines[consumerId] ?? returnPipelines.default ?? [],
    returnPipelineKeys: () => Object.keys(returnPipelines),
    services: () => [],
  };
}

// ---------------------------------------------------------------- engine 级

test('runReturn: filter drop 拦截 + decorator 改写 + direction=return 透传契约', async () => {
  const requests = [];
  const registry = fakeServiceRegistry({
    services: {
      guard: { id: 'guard', kind: 'filter' },
      rewriter: { id: 'rewriter', kind: 'decorator' },
    },
    returnPipelines: { 'qq-main': ['guard', 'rewriter'] },
    results: {
      guard: { verdict: 'pass' },
      rewriter: { verdict: 'pass', message: '改写后的回复' },
    },
    requests,
  });
  const pipeline = createPipeline({ registry, builtinSteps: BUILTINS, budgetChars: 6000 });

  const out = await pipeline.runReturn({
    consumerId: 'qq-main', sessionKey: 'qq:group:1', turnId: 't1', text: '原始回复',
  });
  assert.equal(out.ok, true);
  assert.equal(out.verdict, 'pass');
  assert.equal(out.text, '改写后的回复', 'decorator 改写外发文本');
  assert.equal(out.degraded, false);
  // direction 字段进契约（服务可感知方向）；firstTurn 未传不带。
  assert.equal(requests[0].request.direction, 'return');
  assert.equal(requests[0].request.text, '原始回复');
  assert.equal(requests[1].request.direction, 'return');

  // drop：verdict=drop 短路（调用方拦截投递）。
  const dropRegistry = fakeServiceRegistry({
    services: { guard: { id: 'guard', kind: 'filter' } },
    returnPipelines: { 'qq-main': ['guard'] },
    results: { guard: { verdict: 'drop', reason: 'sensitive' } },
  });
  const dropped = await createPipeline({ registry: dropRegistry, builtinSteps: BUILTINS })
    .runReturn({ consumerId: 'qq-main', sessionKey: 's', text: 'x' });
  assert.equal(dropped.verdict, 'drop');
  assert.equal(dropped.reason, 'sensitive');
});

test('runReturn: forward 面不受影响（direction=forward + protocol 殿后）', async () => {
  const requests = [];
  const registry = fakeServiceRegistry({
    services: { persona: { id: 'persona', kind: 'decorator' } },
    pipelines: { 'qq-main': ['persona'] },
    results: { persona: { verdict: 'pass', message: 'PERSONA' } },
    requests,
  });
  const pipeline = createPipeline({ registry, builtinSteps: BUILTINS, budgetChars: 6000 });
  const out = await pipeline.runForward({
    consumerId: 'qq-main', sessionKey: 's', turnToken: 'tk', text: 'msg',
  });
  assert.equal(out.text, `PERSONA\n\n${protocolTokenLine('tk')}`, 'decorator 整段改写 + protocol 殿后');
  assert.equal(requests[0].request.direction, 'forward', '契约缺省/显式 forward');
  // runReturn 与 forward 编排隔离：同一 consumer 无 return 编排 = 透传。
  const ret = await pipeline.runReturn({ consumerId: 'qq-main', sessionKey: 's', text: 'out' });
  assert.equal(ret.text, 'out');
  assert.deepEqual(ret.steps, []);
});

test('runReturn: once 首轮跳过 + 本地静态供料 + default 键回退', async () => {
  const requests = [];
  const registry = fakeServiceRegistry({
    services: { feed: { id: 'feed', kind: 'decorator' } },
    returnPipelines: {
      default: [{ step: 'feed', once: true, join: 'prefix' }, { step: 'sign', text: '—— 网关' }],
    },
    results: { feed: { verdict: 'pass', message: '首轮摘要' } },
    requests,
  });
  const pipeline = createPipeline({ registry, builtinSteps: BUILTINS, budgetChars: 6000 });

  const first = await pipeline.runReturn({
    consumerId: 'wx-main', sessionKey: 's', text: '回复', isFirstTurnOfSession: true,
  });
  assert.equal(first.text, '首轮摘要\n\n回复\n\n—— 网关', 'default 回退 + once 首轮注入 + 静态供料');

  const second = await pipeline.runReturn({
    consumerId: 'wx-main', sessionKey: 's', text: '回复2', isFirstTurnOfSession: false,
  });
  assert.equal(second.text, '回复2\n\n—— 网关', '非首轮 once 步骤跳过（不调服务）');
  assert.equal(requests.length, 1, '只有首轮调了服务');
});

// ---------------------------------------------------------------- transport 级

/** 假适配器：记录收到的 /v1/actions 信封，回标准回执。 */
async function fakeAdapter() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ v: 1, actionId: JSON.parse(body).actionId, ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    received,
    adapter: { id: 'qq-main', platform: 'qq', callbackBase: `http://127.0.0.1:${port}`, secret: 's'.repeat(32) },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const BASE_CTX = {
  sessionKey: 'qq:group:1',
  turnId: 't1',
  payload: { text: '原始外发文本' },
};

test('deliverAction: 回路 drop 不发请求且按成功回执', async () => {
  const { adapter, received, close } = await fakeAdapter();
  try {
    const result = await deliverAction({
      adapter,
      action: 'send_text',
      entry: { kind: 'send_text' },
      ctx: BASE_CTX,
      timeoutMs: 2000,
      returnPipeline: async () => ({ verdict: 'drop', reason: 'sensitive' }),
    });
    assert.equal(result.ok, true, '拦截 = 模型侧视为已发送');
    assert.equal(result.suppressed, true);
    assert.deepEqual(received, [], '请求未到达适配器');
  } finally {
    await close();
  }
});

test('deliverAction: 回路改写替换 payload.text（其余字段保留）', async () => {
  const { adapter, received, close } = await fakeAdapter();
  try {
    const result = await deliverAction({
      adapter,
      action: 'send_text',
      entry: { kind: 'send_text' },
      ctx: { ...BASE_CTX, payload: { text: '原始外发文本', key: 'group:456' } },
      timeoutMs: 2000,
      returnPipeline: async () => ({ verdict: 'pass', text: '改写后的外发文本' }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.suppressed, undefined);
    assert.equal(received.length, 1);
    assert.equal(received[0].payload.text, '改写后的外发文本');
    assert.equal(received[0].payload.key, 'group:456', '非 text 字段不动');
  } finally {
    await close();
  }
});

test('deliverAction: 无钩子 / 无 text / 钩子异常 = 原样透传', async () => {
  const { adapter, received, close } = await fakeAdapter();
  try {
    // 无钩子：透传。
    await deliverAction({
      adapter, action: 'send_text', entry: { kind: 'send_text' }, ctx: BASE_CTX, timeoutMs: 2000,
    });
    assert.equal(received[0].payload.text, '原始外发文本');
    // text 缺失（如 get_unread 类动作）：钩子不触发。
    await deliverAction({
      adapter, action: 'send_text', entry: { kind: 'send_text' },
      ctx: { ...BASE_CTX, payload: {} }, timeoutMs: 2000,
      returnPipeline: async () => { throw new Error('should not be called'); },
    });
    assert.equal(received.length, 2);
    // 钩子异常：原文照发（fail-safe）。
    await deliverAction({
      adapter, action: 'send_text', entry: { kind: 'send_text' }, ctx: BASE_CTX, timeoutMs: 2000,
      returnPipeline: async () => { throw new Error('boom'); },
    });
    assert.equal(received.length, 3);
    assert.equal(received[2].payload.text, '原始外发文本');
  } finally {
    await close();
  }
});
