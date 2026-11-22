/**
 * P5 回路链执行端到端（tool.call 统一改造后语义）：
 *  - engine 级：runReturn 语义（filter 改写/空串丢弃 / decorator 纯注入 /
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
    resolveToolStep: (name) => {
      const svc = services[name];
      if (!svc || svc.kind === 'consumer' || !svc.role) return null;
      return { service: svc, kind: svc.kind, tool: { name, role: svc.role } };
    },
    async callServiceTool(id, request) {
      requests.push({ id, request });
      // tool.call 契约：decorator {sections,epoch} / filter {text,reason} 装 data。
      return { ok: true, data: results[id] ?? {} };
    },
    pipelineFor: (consumerId) => pipelines[consumerId] ?? pipelines.default ?? [],
    pipelineKeys: () => Object.keys(pipelines),
    pipelineForReturn: (consumerId) => returnPipelines[consumerId] ?? returnPipelines.default ?? [],
    returnPipelineKeys: () => Object.keys(returnPipelines),
    services: () => [],
  };
}

// ---------------------------------------------------------------- engine 级

test('runReturn: filter 改写外发文本 + drop 空串拦截 + context.text 契约', async () => {
  const requests = [];
  const registry = fakeServiceRegistry({
    services: {
      guard: { id: 'guard', kind: 'resource', role: 'filter' },
      // decorator 在回路面只做注入（改写职责归 filter）。
      enrich: { id: 'enrich', kind: 'resource', role: 'decorator' },
    },
    returnPipelines: { 'qq-main': ['guard', 'enrich'] },
    results: {
      guard: { text: '改写后的回复' },
      enrich: { sections: [{ name: '附言', text: '【附言】记得查收' }] },
    },
    requests,
  });
  const pipeline = createPipeline({ registry, builtinSteps: BUILTINS, budgetChars: 6000 });

  const out = await pipeline.runReturn({
    consumerId: 'qq-main', sessionKey: 'qq:group:1', turnId: 't1', text: '原始回复',
  });
  assert.equal(out.ok, true);
  assert.equal(out.verdict, 'pass');
  assert.equal(out.text, '改写后的回复\n\n【附言】记得查收', 'filter 改写外发文本 + decorator 追加');
  assert.equal(out.degraded, false);
  // tool.call 契约：filter 的 context.text = 当前工作文本；decorator 不带 text。
  assert.equal(requests[0].request.context.text, '原始回复');
  assert.equal('text' in requests[1].request.context, false, 'decorator 调用不带 context.text');
  assert.equal('firstTurn' in requests[0].request, false, '信封无 firstTurn 字段');
  assert.equal('direction' in requests[0].request, false, '信封无 direction 字段');

  // drop：filter text 空串 = 短路（调用方拦截投递）。
  const dropRegistry = fakeServiceRegistry({
    services: { guard: { id: 'guard', kind: 'resource', role: 'filter' } },
    returnPipelines: { 'qq-main': ['guard'] },
    results: { guard: { text: '', reason: 'sensitive' } },
  });
  const dropped = await createPipeline({ registry: dropRegistry, builtinSteps: BUILTINS })
    .runReturn({ consumerId: 'qq-main', sessionKey: 's', text: 'x' });
  assert.equal(dropped.verdict, 'drop');
  assert.equal(dropped.reason, 'sensitive');
});

test('runReturn: forward 面不受影响（filter 改写 + protocol 殿后）', async () => {
  const requests = [];
  const registry = fakeServiceRegistry({
    services: { guard: { id: 'guard', kind: 'resource', role: 'filter' } },
    pipelines: { 'qq-main': ['guard'] },
    results: { guard: { text: 'PERSONA' } },
    requests,
  });
  const pipeline = createPipeline({ registry, builtinSteps: BUILTINS, budgetChars: 6000 });
  const out = await pipeline.runForward({
    consumerId: 'qq-main', sessionKey: 's', turnToken: 'tk', text: 'msg',
  });
  assert.equal(out.text, `PERSONA\n\n${protocolTokenLine('tk')}`, 'filter 改写消息本体 + protocol 殿后');
  // runReturn 与 forward 编排隔离：同一 consumer 无 return 编排 = 透传。
  const ret = await pipeline.runReturn({ consumerId: 'qq-main', sessionKey: 's', text: 'out' });
  assert.equal(ret.text, 'out');
  assert.deepEqual(ret.steps, []);
});

test('runReturn: once 首轮跳过 + 本地静态供料 + default 键回退', async () => {
  const requests = [];
  const registry = fakeServiceRegistry({
    services: { feed: { id: 'feed', kind: 'resource', role: 'decorator' } },
    returnPipelines: {
      default: [{ step: 'feed', once: true, join: 'prefix' }, { step: 'sign', text: '—— 网关' }],
    },
    results: { feed: { sections: [{ name: '摘要', text: '首轮摘要' }] } },
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
