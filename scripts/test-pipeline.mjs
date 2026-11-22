// V2 P2 管线引擎测试：service-registry（pipelines.json 加载校验 + 登记目录服务）、
// pipeline 引擎（内置/外部步骤、drop 短路、fail-safe、预算裁剪、protocol 殿后）、
// ws-hub callService 端到端（真实 WS 服务 + 模拟服务客户端）、turn-runner 的管线
// 接管与 GATEWAY_PIPELINE=off 兼容路径。全部离线：DSH 用假客户端、外部服务用假注册表。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { createServiceRegistry } = await import(new URL('../src/core/service-registry.mjs', import.meta.url).href);
const { createPipeline } = await import(new URL('../src/core/pipeline.mjs', import.meta.url).href);
const { loadConfig } = await import(new URL('../src/core/config.mjs', import.meta.url).href);
const { createGatewayServer } = await import(new URL('../src/core/server.mjs', import.meta.url).href);
const { createTurnRunner } = await import(new URL('../src/runtime/turn-runner.mjs', import.meta.url).href);
const { createSessionRegistry } = await import(new URL('../src/runtime/session-registry.mjs', import.meta.url).href);
// 建会话需要适配器声明「平台→preset」：测试里用一个最小的声明表顶替登记文件。
const PRESETS_FOR = () => ({ qq: 'qq-chat', wx: 'wx-chat' });
const { createPromptQueue } = await import(new URL('../src/runtime/prompt-queue.mjs', import.meta.url).href);
const { createDshGateway } = await import(new URL('../src/runtime/dsh-gateway.mjs', import.meta.url).href);
const { createTurnStore } = await import(new URL('../src/core/turn-store.mjs', import.meta.url).href);
// P3 转正：protocolTokenLine 归属管线核心（旧 sections/ 目录已删除）。
const { protocolTokenLine } = await import(new URL('../src/core/pipeline.mjs', import.meta.url).href);

const CHAT = {
  preset: 'qq-chat', provider: 'p', model: 'm', reasoningEffort: 'max',
  workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-pipeline-')),
  turnTimeoutMs: 2000,
};

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 编排硬切后的测试装置：`services[]` 内联条目自动迁移为登记目录文件（保留旧
 * 签名是为了让既有用例少改——语义从「写 services.json」变成「写 pipelines.json
 * + 登记 fixtures」）。raw 字符串/带 services 键的对象仍直接落到 pipelines.json，
 * 用于形状/迁移报错断言。
 */
function writeServices(dir, obj) {
  const file = path.join(dir, 'pipelines.json');
  if (typeof obj === 'string') {
    fs.writeFileSync(file, obj);
    return file;
  }
  const doc = { pipelines: obj.pipelines ?? {}, returnPipelines: obj.returnPipelines ?? {} };
  fs.writeFileSync(file, JSON.stringify(obj.raw === undefined ? doc : obj.raw));
  const regDir = path.join(dir, 'services');
  for (const entry of obj.services ?? []) {
    fs.mkdirSync(regDir, { recursive: true });
    fs.writeFileSync(path.join(regDir, `${entry.id}.json`), JSON.stringify({
      v: 1,
      id: entry.id,
      name: entry.name ?? entry.id,
      kind: entry.kind,
      transport: entry.transport ?? 'auto',
      ...(entry.platform ? { platform: entry.platform } : {}),
      ...(entry.memoryService ? { memoryService: entry.memoryService } : {}),
      ...(entry.url ? { url: entry.url } : {}),
      ...(entry.timeoutMs ? { timeoutMs: entry.timeoutMs } : {}),
      ...(entry.secret ? { secret: entry.secret } : {}),
      ...(entry.secretFile ? { secretFile: entry.secretFile } : {}),
      ...(entry.secretEnv ? { secretEnv: entry.secretEnv } : {}),
      ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }),
    }));
  }
  return file;
}

function makeRegistry(file, overrides = {}) {
  // writeServices 会把内联条目迁到 <dir>/services/；默认把登记目录接上，
  // 未写条目的用例等价于空登记（与旧行为一致）。
  const dir = path.dirname(file);
  return createServiceRegistry({
    pipelinesFile: file,
    stateDir: overrides.stateDir ?? dir,
    registrations: overrides.registrations ?? {
      dir: path.join(dir, 'services'),
      ledgerFile: path.join(dir, 'ledger.jsonl'),
      reloadMs: 0,
    },
    defaultTimeoutMs: overrides.defaultTimeoutMs ?? 8000,
    logger: () => {},
  });
}

function fakeServiceRegistry({ services = {}, pipelines = {}, returnPipelines = {}, failWith = null, results = {}, requests = null } = {}) {
  return {
    resolveService: (id) => services[id] ?? null,
    // 两级解析（tool.call 统一改造）：步骤名 → decorator/filter 角色的登记工具。
    // 假实现按条目 role 推（服务 kind=resource，管线角色由 role 声明）。
    resolveToolStep: (name) => {
      const svc = services[name];
      if (!svc || svc.kind === 'consumer' || !svc.role) return null;
      return { service: svc, kind: svc.kind, tool: { name, role: svc.role } };
    },
    async callServiceTool(id, request) {
      requests?.push({ id, request });
      if (failWith) throw failWith;
      // tool.call 契约：业务结果装在 data 里（decorator {sections,epoch} / filter {text,reason}）。
      return { ok: true, data: results[id] ?? {} };
    },
    pipelineFor: (consumerId) => pipelines[consumerId] ?? pipelines.default ?? [],
    pipelineKeys: () => Object.keys(pipelines),
    pipelineForReturn: (consumerId) => returnPipelines[consumerId] ?? returnPipelines.default ?? [],
    returnPipelineKeys: () => Object.keys(returnPipelines),
    services: () => [],
  };
}

// ---------------------------------------------------------------- service-registry

test('registry: pipelines.json 缺失 = 无编排（管线只剩内置步骤，不算错误）', () => {
  const registry = makeRegistry(path.join(tmpDir('gw-reg-'), 'nope.json'));
  assert.deepEqual(registry.services(), []);
  assert.deepEqual(registry.pipelineFor('qq-main'), []);
  assert.equal(registry.resolveService('x'), null);
  assert.deepEqual(registry.consumers(), []);
});

test('registry: 文件损坏 / services 残留键 → 启动失败（fail-closed + 迁移三步）', () => {
  assert.throws(() => makeRegistry(writeServices(tmpDir('gw-reg-'), '{not json')), /failed to read/);
  // 硬切后 {} = 无编排（合法）；只有残留 services 键才是错误，文案必须带迁移步骤。
  const empty = makeRegistry(writeServices(tmpDir('gw-reg-'), { raw: {} }));
  assert.deepEqual(empty.pipelineFor('qq-main'), []);
  const legacy = writeServices(tmpDir('gw-reg-'), { raw: { services: [], pipelines: { 'qq-main': ['dec'] } } });
  assert.throws(
    () => makeRegistry(legacy),
    (error) => /contains a "services" key/.test(error.message) && /registration dir/.test(error.message) && /delete the old services\.json/.test(error.message),
  );
});

test('registry: 登记条目校验——kind/transport/url/timeout/secret 逐项挡下（按份 fail-safe + 台账）', () => {
  const base = { id: 'svc', kind: 'resource', transport: 'http', url: 'http://127.0.0.1:7300', secret: 'x'.repeat(20) };
  // 登记目录按份 fail-safe：坏文件不进服务面，reject 理由落台账（与内联装载
  // 的 fail-closed 不同——一个坏服务不能拖死整个网关启动）。
  const assertRejected = (entry, pattern) => {
    const d = tmpDir('gw-reg-');
    const file = writeServices(d, { services: [entry] });
    const registry = makeRegistry(file);
    assert.deepEqual(registry.services(), [], '坏文件不得进入服务面');
    const ledger = fs.readFileSync(path.join(d, 'ledger.jsonl'), 'utf8');
    assert.match(ledger, pattern);
  };
  assertRejected({ ...base, kind: 'magic' }, /serviceRegistration invalid[\s\S]*kind/i);
  // 传输非对称：resource 配 ws fail-closed 拒载并给迁移文案（consumer 不受限）。
  // 台账是 JSONL 原文（引号带转义），正则用惰性通配跨过转义引号。
  assertRejected({ ...base, transport: 'ws' }, /with transport .+?ws.+? is not supported/);
  assertRejected({ ...base, transport: 'ws' }, /migrate .+?transport.+?ws.+? → .+?transport.+?http/);
  assertRejected({ ...base, transport: 'http', url: undefined }, /requires url/);
  assertRejected({ ...base, url: 'http://10.0.0.1:7000' }, /loopback/i);
  assertRejected({ ...base, timeoutMs: 10 }, /timeoutMs/);
  assertRejected({ ...base, secret: 'short' }, /at least 16/i);
});

test('registry: 登记 consumer 直接生效（消费端身份唯一来源 = 登记目录）', () => {
  const d = tmpDir('gw-reg-');
  const file = writeServices(d, { services: [{ id: 'qq-main', name: 'qq-bridge', kind: 'consumer', transport: 'http', url: 'http://127.0.0.1:3100', platform: 'qq', secret: 'x'.repeat(20) }] });
  const registry = makeRegistry(file);
  assert.equal(registry.services().length, 1);
  assert.equal(registry.consumers().length, 1);
  assert.equal(registry.consumers()[0].source, 'registry');
  const ledger = fs.readFileSync(path.join(d, 'ledger.jsonl'), 'utf8');
  assert.match(ledger, /"register"/);
});

test('registry: 合法条目解析出同构客户端身份；pipelines 形状校验与 default 回退', () => {
  // 传输非对称：consumers()（HTTP 入站验签 / WS 握手身份表共用视图）只含消费端——
  // resource 不出现；消费端身份形状不变（id/platform/secret）。
  const ok = writeServices(tmpDir('gw-reg-'), { services: [{ id: 'svc', kind: 'resource', transport: 'http', secret: 'y'.repeat(20), url: 'http://127.0.0.1:7300' }] });
  const registry = makeRegistry(ok);
  assert.equal(registry.consumers().some((c) => c.id === 'svc'), false, 'resource 不进消费端视图');
  assert.equal(registry.services()[0].connected, false);
  const okConsumer = writeServices(tmpDir('gw-reg-'), { services: [{ id: 'qq-main', name: 'qq-bridge', kind: 'consumer', transport: 'http', url: 'http://127.0.0.1:3100', platform: 'qq', secret: 'z'.repeat(20) }] });
  const consumerRegistry = makeRegistry(okConsumer);
  const client = consumerRegistry.consumers().find((c) => c.id === 'qq-main');
  assert.equal(client.platform, 'qq');
  assert.equal(client.secret, 'z'.repeat(20));
  assert.equal(consumerRegistry.services()[0].connected, false);

  const dir = tmpDir('gw-reg-');
  assert.throws(() => makeRegistry(writeServices(dir, { services: [], pipelines: { 'qq-main': [] } })), /non-empty array/);
  assert.throws(() => makeRegistry(writeServices(dir, { services: [], pipelines: { 'bad key!': ['a'] } })), /pipelines key/);
  assert.throws(() => makeRegistry(writeServices(dir, { services: [], pipelines: { 'qq-main': ['a', 1] } })), /step name invalid/);
  assert.throws(
    () => makeRegistry(writeServices(dir, { services: [], pipelines: { 'qq-main': Array.from({ length: 17 }, (_, i) => `s${i}`) } })),
    /exceeds 16/,
  );
  // 编排权限只认登记消费端：把 qq-main / other 落成 services/<id>.json。
  const file = writeServices(tmpDir('gw-reg-'), {
    services: [
      { id: 'qq-main', name: 'qq-bridge', kind: 'consumer', platform: 'qq', secret: 'q'.repeat(20) },
      { id: 'other', name: 'other-bridge', kind: 'consumer', platform: 'wx', secret: 'o'.repeat(20) },
    ],
    pipelines: { 'qq-main': ['a', 'b'], default: ['c'] },
  });
  const withPipelines = makeRegistry(file);
  assert.deepEqual(withPipelines.pipelineFor('qq-main'), ['a', 'b']);
  // 无精确键但有身份的消费端：default 回退；无身份者连 default 都不享受。
  assert.deepEqual(withPipelines.pipelineFor('other'), ['c']);
  assert.deepEqual(withPipelines.pipelineKeys().sort(), ['default', 'qq-main']);

  // 编排权限（P3）：未登记消费端（无身份）不享受编排——精确键与 default 都不生效。
  const gated = makeRegistry(writeServices(tmpDir('gw-reg-'), {
    services: [], pipelines: { 'qq-main': ['a', 'b'], default: ['c'] },
  }));
  assert.deepEqual(gated.pipelineFor('qq-main'), []);
  assert.deepEqual(gated.pipelineFor('other'), []);
  assert.throws(() => gated.assertPipelinePermissions(), /no consumer behind it/);
  // 启动期权限校验：登记消费端的键通过。
  withPipelines.assertPipelinePermissions();
});

test('registry: 编排权限——登记的消费端即拥有编排，非消费端服务不行（P3 门禁）', () => {
  const dir = tmpDir('gw-regcons-');
  const regDir = path.join(dir, 'services');
  fs.mkdirSync(regDir, { recursive: true });
  // 一个 consumer 登记 + 一个 decorator 登记（同名管线键用于反证）。
  // id = 随机 hash（对象唯一性），文件名 = <hash>.json；name 是展示名。
  // 登记必须带 secret：消费端/服务与网关的 WS 握手靠 HMAC（不变量 4）。
  const consumerId = crypto.randomUUID().replaceAll('-', '');
  const decoratorId = crypto.randomUUID().replaceAll('-', '');
  fs.writeFileSync(path.join(regDir, `${consumerId}.json`), JSON.stringify({
    v: 1, id: consumerId, name: 'bridge-x', kind: 'consumer', transport: 'ws', platform: 'qq', secret: 'x'.repeat(20), enabled: true,
  }));
  fs.writeFileSync(path.join(regDir, `${decoratorId}.json`), JSON.stringify({
    v: 1, id: decoratorId, name: 'memory-d', kind: 'resource', transport: 'http', url: 'http://127.0.0.1:7390', secret: 'y'.repeat(20), enabled: true,
  }));
  const file = writeServices(dir, { services: [], pipelines: { [consumerId]: ['d1'], default: ['d2'] } });
  const registry = makeRegistry(file, {
    registrations: { dir: regDir, ledgerFile: path.join(dir, 'ledger.jsonl'), reloadMs: 0 },
  });
  // 登记的消费端：编排生效（hash 精确键），default 也只对它生效。
  assert.deepEqual(registry.pipelineFor(consumerId), ['d1']);
  registry.assertPipelinePermissions();
  // decorator 服务的 hash 不是消费端身份：即使管线键撞上它也不享受编排。
  assert.deepEqual(registry.pipelineFor(decoratorId), []);
  // 给非消费端配的编排 = 启动期配置错误（fail-closed）。
  const bad = writeServices(tmpDir('gw-regcons-'), { services: [], pipelines: { [decoratorId]: ['d1'] } });
  assert.throws(() => makeRegistry(bad, {
    registrations: { dir: regDir, ledgerFile: path.join(dir, 'ledger.jsonl'), reloadMs: 0 },
  }).assertPipelinePermissions(), /no consumer behind it/);
});

test('registry: callServiceTool 未知服务 → E_SCHEMA', async () => {
  const registry = makeRegistry(path.join(tmpDir('gw-reg-'), 'nope.json'));
  await assert.rejects(
    () => registry.callServiceTool('ghost', { tool: 'chat_x' }),
    (error) => error.code === 'E_SCHEMA',
  );
});

// ---------------------------------------------------------------- pipeline 引擎

const BUILTINS = {
  protocol: {
    name: 'protocol', priority: 100,
    build: ({ deps }) => (deps?.turnToken ? { text: protocolTokenLine(deps.turnToken) } : null),
  },
  persona: { name: 'persona', priority: 80, build: () => ({ text: 'PERSONA' }) },
  time: { name: 'time', priority: 50, build: () => ({ text: 'TIME' }) },
};

test('pipeline: 空编排 = 透传，但 protocol 令牌仍强制注入', async () => {
  const pipeline = createPipeline({ registry: fakeServiceRegistry(), builtinSteps: BUILTINS, budgetChars: 6000 });
  const out = await pipeline.runForward({ consumerId: 'anyone', sessionKey: 'qq:group:1', turnToken: 'tok-1', text: 'hello' });
  assert.equal(out.ok, true);
  assert.equal(out.verdict, 'pass');
  assert.equal(out.text, `hello\n\n${protocolTokenLine('tok-1')}`);
  assert.equal(out.degraded, false);
});

test('pipeline: decorator 纯注入（改写职责归 filter）——sections 追加、消息本体不动', async () => {
  const registry = fakeServiceRegistry({
    services: { dec: { id: 'dec', kind: 'resource', role: 'decorator' } },
    pipelines: { 'qq-main': ['dec', 'persona'] },
    results: {
      dec: { sections: [{ name: 'mem', text: 'MEMORY', priority: 70 }] },
    },
  });
  const pipeline = createPipeline({ registry, builtinSteps: BUILTINS, budgetChars: 6000 });
  const out = await pipeline.runForward({ consumerId: 'qq-main', sessionKey: 's', turnToken: 't', text: 'original' });
  assert.equal(out.steps.find((s) => s.name === 'dec').outcome, 'injected');
  // 拼接顺序：消息本体（不动）→ sections 按 priority 降序（protocol 100 > persona 80 > mem 70）。
  assert.equal(out.text, `original\n\n${protocolTokenLine('t')}\n\nPERSONA\n\nMEMORY`);
});

test('pipeline: filter 改写与 drop 短路——text 替换消息本体；空串 = drop（reason 透传，后续步骤不执行）', async () => {
  const calls = [];
  const registry = fakeServiceRegistry({
    services: {
      guard: { id: 'guard', kind: 'resource', role: 'filter' },
      dec: { id: 'dec', kind: 'resource', role: 'decorator' },
    },
    pipelines: { 'qq-main': ['guard', 'dec'] },
  });
  registry.callServiceTool = async (id, request) => {
    calls.push({ id, request });
    if (id === 'guard') return { ok: true, data: { text: request.context.text === 'drop-me' ? '' : 'clean', reason: 'spam' } };
    return { ok: true, data: {} };
  };
  const pipeline = createPipeline({ registry, builtinSteps: BUILTINS, budgetChars: 6000 });
  // 改写：非空 text 替换消息本体（后续 decorator 正常执行）。
  const rewritten = await pipeline.runForward({ consumerId: 'qq-main', sessionKey: 's', turnToken: 't', text: 'drop-me-no' });
  assert.equal(rewritten.steps.find((s) => s.name === 'guard').outcome, 'rewritten');
  assert.ok(rewritten.text.startsWith('clean'), 'filter 输出替换消息本体');
  assert.equal(calls[0].request.context.text, 'drop-me-no', 'context.text = 当前工作文本随 filter 下发');

  // drop：text 空串 → 短路，后续步骤不执行。
  calls.length = 0;
  const dropped = await pipeline.runForward({ consumerId: 'qq-main', sessionKey: 's', turnToken: 't', text: 'drop-me' });
  assert.equal(dropped.verdict, 'drop');
  assert.equal(dropped.reason, 'spam');
  assert.deepEqual(calls.map((c) => c.id), ['guard'], 'drop 后不得继续执行后续步骤');
});

test('pipeline: 外部步骤失败 fail-safe——超时/抛错记 degraded 继续放行', async () => {
  const registry = fakeServiceRegistry({
    services: { bad: { id: 'bad', kind: 'resource', role: 'decorator' } },
    pipelines: { 'qq-main': ['bad', 'persona'] },
    failWith: Object.assign(new Error('timed out'), { code: 'E_TIMEOUT' }),
  });
  const pipeline = createPipeline({ registry, builtinSteps: BUILTINS, budgetChars: 6000 });
  const out = await pipeline.runForward({ consumerId: 'qq-main', sessionKey: 's', turnToken: 't', text: 'keep' });
  assert.equal(out.verdict, 'pass', '宁放行不误杀');
  assert.equal(out.degraded, true);
  assert.equal(out.text, `keep\n\n${protocolTokenLine('t')}\n\nPERSONA`);
  assert.equal(out.steps.find((s) => s.name === 'bad').outcome, 'degraded');
});

test('pipeline: 非法响应（契约层抛错）→ degraded 放行', async () => {
  const registry = fakeServiceRegistry({
    services: { liar: { id: 'liar', kind: 'resource', role: 'decorator' } },
    pipelines: { 'qq-main': ['liar'] },
  });
  registry.callServiceTool = async () => {
    throw Object.assign(new Error('invalid result'), { code: 'E_SCHEMA' });
  };
  const pipeline = createPipeline({ registry, builtinSteps: BUILTINS, budgetChars: 6000 });
  const out = await pipeline.runForward({ consumerId: 'qq-main', sessionKey: 's', turnToken: 't', text: 'x' });
  assert.equal(out.degraded, true);
  assert.equal(out.verdict, 'pass');
});

test('pipeline: 业务失败（ok:false）与非法 data 同口径 degraded 放行；服务 id 当步骤报迁移错', async () => {
  // 业务失败（ok:false + error）也是失效步骤：degraded 继续，绝不误杀。
  const registry = fakeServiceRegistry({
    services: { bad: { id: 'bad', kind: 'resource', role: 'decorator' } },
    pipelines: { 'qq-main': ['bad'] },
  });
  registry.callServiceTool = async () => ({ ok: false, error: { code: 'E_ACTION', message: 'boom' } });
  const pipeline = createPipeline({ registry, builtinSteps: BUILTINS, budgetChars: 6000 });
  const out = await pipeline.runForward({ consumerId: 'qq-main', sessionKey: 's', text: 'x' });
  assert.equal(out.degraded, true);
  assert.equal(out.verdict, 'pass');

  // 服务 id 直接当步骤不再合法（两级解析硬切）：无 role 工具的服务 id 解析
  // 落空 → 命中 resolveService → 报迁移错。
  const shadowRegistry = fakeServiceRegistry({
    services: { ghostsvc: { id: 'ghostsvc', kind: 'resource' } },
    pipelines: { 'qq-main': ['ghostsvc'] },
  });
  const byServiceId = createPipeline({ registry: shadowRegistry, builtinSteps: BUILTINS, budgetChars: 6000 });
  assert.throws(() => byServiceId.validate(['qq-main', 'ghostsvc']), /no longer valid steps/);
});

test('pipeline: 非法 data（不合 decorator 契约）→ degraded 放行', async () => {
  const registry = fakeServiceRegistry({
    services: { liar: { id: 'liar', kind: 'resource', role: 'decorator' } },
    pipelines: { 'qq-main': ['liar'] },
    results: { liar: { verdict: 'pass', message: 'old-shape' } }, // 旧 service.call 形状 → schema 拒收
  });
  const pipeline = createPipeline({ registry, builtinSteps: BUILTINS, budgetChars: 6000 });
  const out = await pipeline.runForward({ consumerId: 'qq-main', sessionKey: 's', turnToken: 't', text: 'x' });
  assert.equal(out.degraded, true);
  assert.equal(out.verdict, 'pass');
});

test('pipeline: 预算超限整段丢弃最低优先级 section，消息本体永不裁剪', async () => {
  const registry = fakeServiceRegistry({
    services: { dec: { id: 'dec', kind: 'resource', role: 'decorator' } },
    pipelines: { 'qq-main': ['dec', 'persona', 'time'] },
    results: { dec: { sections: [{ name: 'big', text: 'B'.repeat(50), priority: 90 }, { name: 'small', text: 'S', priority: 10 }] } },
  });
  const pipeline = createPipeline({ registry, builtinSteps: BUILTINS, budgetChars: 60 });
  // 不传 turnToken → protocol 缺席，纯 section 裁剪场景。
  const out = await pipeline.runForward({ consumerId: 'qq-main', sessionKey: 's', text: 'KEEP-ME' });
  assert.equal(out.text, 'KEEP-ME\n\n' + 'B'.repeat(50), '消息本体不裁，最低优先级整段丢弃');
  assert.deepEqual(out.dropped, ['small', 'time', 'persona'], '最低优先级先丢，不做段内截断');
});

test('pipeline: protocol 强制执行且不可被编排移除（写在中间也照常注入令牌）', async () => {
  const pipeline = createPipeline({
    registry: fakeServiceRegistry({ pipelines: { 'qq-main': ['protocol', 'persona'] } }),
    builtinSteps: BUILTINS,
    budgetChars: 6000,
  });
  const out = await pipeline.runForward({ consumerId: 'qq-main', sessionKey: 's', turnToken: 't', text: 'msg' });
  assert.deepEqual(out.steps.map((s) => s.name), ['persona', 'protocol'], 'protocol 被摘出编排位、强制执行');
  // 输出位置按 priority（100 → 紧随消息本体），与旧 assembler 的 protocol 段一致。
  assert.equal(out.text, `msg\n\n${protocolTokenLine('t')}\n\nPERSONA`);
});

test('pipeline: validate 把未知步骤挡在启动阶段（含回路方向的内置步骤拒绝）', async () => {
  const pipeline = createPipeline({ registry: fakeServiceRegistry({ pipelines: { 'qq-main': ['nope'] } }), builtinSteps: BUILTINS });
  assert.throws(() => pipeline.validate(['qq-main']), /unknown pipeline step "nope"/);

  // 回路方向：内置步骤拒绝（protocol 已在 registry 层拒，这里兜底其余内置名）。
  const ret = createPipeline({
    registry: fakeServiceRegistry({ returnPipelines: { 'qq-main': ['protocol'] }, pipelines: {} }),
    builtinSteps: BUILTINS,
  });
  assert.throws(() => ret.validate(['qq-main']), /forward-only and must not appear in a return pipeline/);
  // 静态供料步骤在回路方向合法（零服务调用，不做三级解析）。
  const ok = createPipeline({
    registry: fakeServiceRegistry({ returnPipelines: { 'qq-main': [{ step: 'tag', text: '[署名]' }] } }),
    builtinSteps: BUILTINS,
  });
  assert.doesNotThrow(() => ok.validate(['qq-main']));
});

test('runReturn: 无回路编排 = 透传（形状对齐 runForward，text 原样返回）', async () => {
  const ok = createPipeline({ registry: fakeServiceRegistry(), builtinSteps: BUILTINS });
  const result = await ok.runReturn({ consumerId: 'qq-main', sessionKey: 's', text: 'outbound' });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.text, 'outbound');
  assert.deepEqual(result.steps, []);
  assert.equal(result.degraded, false);
  assert.deepEqual(result.dropped, []);
});

// ---------------------------------------------------------------- ws-hub callService 端到端

// 以下客户端辅助与 test-ws-hub.mjs 同源（脚本式测试不跨文件 import）。
function decodeFrame(buffer, offset = 0) {
  if (buffer.length - offset < 2) return null;
  const first = buffer[offset];
  const second = buffer[offset + 1];
  const opcode = first & 0x0f;
  let len = second & 0x7f;
  let pos = offset + 2;
  if (len === 126) { len = buffer.readUInt16BE(pos); pos += 2; } else if (len === 127) { len = Number(buffer.readBigUInt64BE(pos)); pos += 8; }
  if (buffer.length - pos < len) return null;
  return { opcode, payload: buffer.subarray(pos, pos + len), next: pos + len };
}

function handshakeQuery(secret, id) {
  const ts = Date.now();
  const nonce = crypto.randomBytes(12).toString('hex');
  const bodyHash = crypto.createHash('sha256').update('').digest('hex');
  const sign = 'v1=' + crypto.createHmac('sha256', secret).update(`${ts}\n${nonce}\n${bodyHash}`, 'utf8').digest('hex');
  return `adapterId=${id}&ts=${ts}&nonce=${nonce}&sign=${encodeURIComponent(sign)}`;
}

function connectWs(port, pathWithQuery) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathWithQuery,
      headers: {
        connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
        'sec-websocket-version': '13',
      },
    });
    req.on('upgrade', (res, socket, head) => {
      const conn = { socket, buffer: head && head.length > 0 ? head : Buffer.alloc(0), frames: [], cursor: {} };
      socket.on('data', (chunk) => {
        conn.buffer = Buffer.concat([conn.buffer, chunk]);
        let offset = 0;
        while (offset < conn.buffer.length) {
          const frame = decodeFrame(conn.buffer, offset);
          if (!frame) break;
          offset = frame.next;
          if (frame.opcode === 1) conn.frames.push(JSON.parse(frame.payload.toString('utf8')));
        }
        conn.buffer = conn.buffer.subarray(offset);
      });
      socket.on('error', (e) => { conn.error = e; });
      resolve(conn);
    });
    req.on('response', (res) => { res.resume(); reject(new Error(`handshake rejected: ${res.statusCode}`)); });
    req.on('error', reject);
    req.end();
  });
}

const SERVICE_SECRET = 'service-secret-0123456789';
const ADAPTER_SECRET = 'adapter-secret-0123456789';

async function startPipelineServer({ dir }) {
  // stateDir 与 pipelines.json/secretFile 同目录（secretFile 相对 stateDir 解析）。
  fs.writeFileSync(path.join(dir, 'svc.secret'), SERVICE_SECRET);
  const pipelinesFile = writeServices(dir, {
    // 传输非对称：resource 服务强制 http + url（url 指向无监听端口，供
    // callServiceTool 的 E_NETWORK 断言用）。
    services: [
      { id: 'svc-dec', kind: 'resource', transport: 'http', url: 'http://127.0.0.1:7399', secretFile: 'svc.secret', timeoutMs: 1500 },
      // 消费端身份只认登记目录（WS 握手 / 动作下行都走这一份视图）。
      { id: 'qq-main', name: 'qq-bridge', kind: 'consumer', platform: 'qq', secret: ADAPTER_SECRET },
    ],
  });
  const config = loadConfig({
    // GATEWAY_PORT=0：node --test 并发跑多个文件，别的测试文件也可能监听默认端口。
    env: { GATEWAY_DATA_PLANE: 'shadow', GATEWAY_PORT: '0' },
    stateDir: dir,
  });
  const services = createServiceRegistry({
    pipelinesFile, stateDir: dir, defaultTimeoutMs: 8000, logger: () => {},
    registrations: { dir: path.join(dir, 'services'), ledgerFile: path.join(dir, 'ledger.jsonl'), reloadMs: 0 },
  });
  const gateway = createGatewayServer({ config, logger: () => {}, services });
  await gateway.listen();
  services.attachWs(gateway.ws);
  return { gateway, services, port: gateway.server.address().port };
}

test('ws 通道非对称：resource 握手被拒 + callServiceTool HTTP-only + health 状态', async () => {
  const dir = tmpDir('gw-pipe-');
  const { gateway, services, port } = await startPipelineServer({ dir });
  try {
    // WS 是消费端专属：resource id 不进 ws-hub 身份表（clients 只放行
    // kind=consumer），握手即 401（不泄露「谁存在」）。
    await assert.rejects(
      () => connectWs(port, `/v1/ws?${handshakeQuery(SERVICE_SECRET, 'svc-dec')}`),
      /handshake rejected: 401/,
    );
    assert.equal(services.services()[0].connected, false, 'resource 无 WS 连接状态');

    // callServiceTool 恒走 HTTP（transport 强制 http）：url 指向无监听端口 → E_NETWORK。
    await assert.rejects(
      () => services.callServiceTool('svc-dec', { tool: 'chat_x', args: {} }),
      (error) => error.code === 'E_NETWORK',
    );

    // health：pipeline 块可见（mode=on）。
    const health = await fetch(`http://127.0.0.1:${port}/v1/health`).then((r) => r.json());
    assert.equal(health.pipeline.mode, 'on');
  } finally {
    await gateway.close();
  }
});

// ---------------------------------------------------------------- turn-runner 集成

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
    async listPresets() { return ['qq-chat', 'minimal']; },
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

function baseEnvelope(overrides = {}) {
  return {
    platform: 'qq',
    adapterId: 'qq-main',
    conversation: { kind: 'group', id: '123456' },
    message: { id: 'm1', sender: { id: '10001', name: '张三', roles: ['member'] }, text: '在吗' },
    prompt: { text: 'adapter-assembled-prompt' },
    receivedAt: 1760000000000,
    ...overrides,
  };
}

function makeRecord(envelope) {
  return { turnId: `turn_${crypto.randomUUID()}`, sessionKey: 'qq:group:123456', envelope, degraded: [] };
}

/** 提交 turn 并在 prompt 发出后驱动假 DSH 结束回合（假客户端不会自动 finish）。 */
async function submitAndFinish(runner, dsh, record) {
  const pending = runner.submit(record);
  const deadline = Date.now() + 2000;
  while (dsh.state.prompts.length === 0) {
    if (Date.now() > deadline) throw new Error('prompt never sent');
    await new Promise((r) => setTimeout(r, 10));
  }
  dsh.finishTurn([...dsh.state.sessions.keys()][0], 'reply');
  return pending;
}

function buildBuiltinSteps() {
  // P3 转正：内置步骤只剩 protocol（persona/快照/时间由登记的装饰器服务承载）。
  return {
    protocol: {
      name: 'protocol', priority: 100,
      build: ({ deps }) => (deps?.turnToken ? { text: protocolTokenLine(deps.turnToken) } : null),
    },
  };
}

async function buildRunnerHarness({ pipeline = null, config, notifyTurnEnded = null }) {
  const dsh = createFakeDsh();
  const registry = createSessionRegistry({ presetsFor: PRESETS_FOR, dsh, chat: CHAT, file: null });
  const gateway = createDshGateway({ dsh, turnTimeoutMs: 2000 });
  const turns = createTurnStore({ file: null });
  const runner = createTurnRunner({
    config: { chat: CHAT, pipeline: config?.pipeline ?? { mode: 'off' } },
    dsh, registry, gateway, queue: createPromptQueue({}), turns,
    pipeline, logger: () => {}, notifyTurnEnded,
  });
  gateway.start();
  return { runner, dsh, turns };
}

test('runner: 管线接管拼装——filter 改写生效、令牌注入', async () => {
  const registry = fakeServiceRegistry({
    services: { guard: { id: 'guard', kind: 'resource', role: 'filter' } },
    pipelines: { 'qq-main': ['guard'] },
    results: { guard: { text: 'pipelined' } },
  });
  const pipeline = createPipeline({ registry, builtinSteps: buildBuiltinSteps(), budgetChars: 6000 });
  const { runner, dsh } = await buildRunnerHarness({ pipeline, config: { pipeline: { mode: 'on' } } });
  const result = await submitAndFinish(runner, dsh, makeRecord(baseEnvelope()));
  assert.equal(result.status, 'completed');
  const prompt = dsh.state.prompts[0].text;
  assert.ok(prompt.startsWith('pipelined'), 'filter 改写生效（消息本体替换）');
  assert.ok(prompt.includes('【会话令牌】'), 'protocol 令牌注入');
  assert.equal(prompt.includes('adapter-assembled-prompt'), false, '适配器 prompt 被管线产出替换');
});

test('runner: filter drop 短路——turn 完成、不进 DSH、degraded 标记', async () => {
  const registry = fakeServiceRegistry({
    services: { guard: { id: 'guard', kind: 'resource', role: 'filter' } },
    pipelines: { 'qq-main': ['guard'] },
    results: { guard: { text: '', reason: 'spam' } },
  });
  const pipeline = createPipeline({ registry, builtinSteps: buildBuiltinSteps(), budgetChars: 6000 });
  const { runner, dsh, turns } = await buildRunnerHarness({ pipeline, config: { pipeline: { mode: 'on' } } });
  const record = makeRecord(baseEnvelope());
  const result = await runner.submit(record);
  assert.equal(result.status, 'completed');
  assert.ok(result.degraded.includes('pipeline:dropped'));
  assert.equal(dsh.state.prompts.length, 0, 'drop 短路不得进 DSH');
  const stored = turns.recent(10)[0];
  assert.equal(stored.record.result.context.verdict, 'drop', 'turn 记录可见 verdict（排障第一现场）');
});

test('runner: 引擎失败回退适配器 prompt（fail-safe），degraded 记 fallback', async () => {
  // 引擎级失败（ok:false，如装配配置错误）→ 整体回退适配器 prompt。
  // 步骤级失败（tool.call 抛错 / ok:false）走 fail-safe 继续放行，不触发回退——那是上面的引擎用例。
  const pipeline = {
    runForward: async () => ({ ok: false, verdict: 'pass', text: '', chars: 0, degraded: true, dropped: [], steps: [] }),
  };
  const { runner, dsh } = await buildRunnerHarness({ pipeline, config: { pipeline: { mode: 'on' } } });
  const result = await submitAndFinish(runner, dsh, makeRecord(baseEnvelope()));
  assert.equal(result.status, 'completed');
  assert.equal(dsh.state.prompts[0].text, 'adapter-assembled-prompt');
  assert.ok(result.degraded.includes('context:fallback'), '与旧 fallback 同一标记，消费方无感');
});

test('runner: GATEWAY_PIPELINE=off 回滚通道——prompt 原样透传（P3 转正后无旧 assembler）', async () => {
  const { runner, dsh } = await buildRunnerHarness({ pipeline: null, config: { pipeline: { mode: 'off' } } });
  const result = await submitAndFinish(runner, dsh, makeRecord(baseEnvelope()));
  assert.equal(result.status, 'completed');
  assert.equal(dsh.state.prompts[0].text, 'adapter-assembled-prompt', 'off = 适配器说什么就发什么（含令牌在内的一切注入都停）');
});

test('runner: 回合结束通知——notifyTurnEnded 收到终态推送（适配器释放防重入的信号源）', async () => {
  const notifications = [];
  const { runner, dsh } = await buildRunnerHarness({
    pipeline: null,
    config: { pipeline: { mode: 'off' } },
    notifyTurnEnded: (n) => notifications.push(n),
  });
  const record = makeRecord(baseEnvelope());
  const result = await submitAndFinish(runner, dsh, record);
  assert.equal(result.status, 'completed');
  assert.equal(notifications.length, 1, '一个回合恰好一条通知');
  const { adapterId, payload } = notifications[0];
  assert.ok(adapterId, '通知带适配器 id（sendTo 的目标）');
  assert.equal(payload.type, 'turn/status');
  assert.equal(payload.turnId, record.turnId);
  assert.equal(payload.sessionKey, record.sessionKey);
  assert.equal(payload.status, 'completed');
  assert.equal(payload.v, 1);
});

// ---------------------------------------------------------------- P4.x 注入规则引擎

test('rules: registry 双形态装载——对象条目合法、protocol 对象与坏 regex/坏 fn 启动即拒', () => {
  const ok = writeServices(tmpDir('gw-rules-'), {
    services: [{ id: 'qq-main', name: 'qq-bridge', kind: 'consumer', platform: 'qq', secret: 'r'.repeat(20) }],
    pipelines: { 'qq-main': ['dec', { step: 'card', text: 'ROLECARD' }, { step: 'dec2', join: 'prefix' }] },
  });
  const registry = makeRegistry(ok);
  // 原始条目原样存储（引擎按双形态消费，视图原样透出）。
  assert.deepEqual(registry.pipelineFor('qq-main')[1], { step: 'card', text: 'ROLECARD' });
  assert.deepEqual(registry.pipelineFor('qq-main')[0], 'dec');

  const bad = (pipelines) => makeRegistry(writeServices(tmpDir('gw-rules-'), { services: [], pipelines }));
  assert.throws(() => bad({ 'qq-main': [{ step: 'protocol', once: true }] }), /protocol step must stay a plain string/);
  assert.throws(() => bad({ 'qq-main': [{ step: 'x', join: 'regex', pattern: '([unclosed', replacement: 'r' }] }), /does not compile/);
  assert.throws(() => bad({ 'qq-main': [{ step: 'x', join: 'function', fn: 'const t = message + extra;' }] }), /must contain a return/);
  assert.throws(() => bad({ 'qq-main': [{ step: 'x', join: 'function', fn: 'return 42' }] }), /must return a string/);
  assert.throws(() => bad({ 'qq-main': [{ step: 'x', join: 'prefix', pattern: 'a' }] }), /not valid for join/);
  assert.throws(() => bad({ 'qq-main': [{ step: 'x', join: 'regex' }] }), /not valid for join/);
  assert.throws(() => bad({ 'qq-main': [{ step: 'x', join: 'nope' }] }), /join must be one of/);
  assert.throws(() => bad({ 'qq-main': [{ step: 'x', nope: 1 }] }), /unknown field/);
  assert.throws(() => bad({ 'qq-main': [{ step: 'x', text: '' }] }), /text must be a non-empty/);
});

test('rules: engine validate——静态步骤不做三级解析，未知外部步骤启动即拒', () => {
  const pipeline = createPipeline({
    registry: fakeServiceRegistry({ pipelines: { c: [{ step: 'anyname', text: 'T' }] } }),
    builtinSteps: buildBuiltinSteps(),
  });
  pipeline.validate(['c']); // 本地静态步骤不解析服务名
  const bad = createPipeline({
    registry: fakeServiceRegistry({ pipelines: { c: [{ step: 'ghost', join: 'prefix' }] } }),
    builtinSteps: buildBuiltinSteps(),
  });
  assert.throws(() => bad.validate(['c']), /unknown pipeline step/);
});

test('rules: once——仅首轮注入，非首轮整个步骤跳过（不调服务）；信封无 firstTurn 字段', async () => {
  const calls = [];
  const registry = fakeServiceRegistry({
    services: { card: { id: 'card', kind: 'resource', role: 'decorator' } },
    pipelines: { 'qq-main': [{ step: 'card', once: true, join: 'prefix' }] },
  });
  registry.callServiceTool = async (id, request) => {
    calls.push({ id, request });
    return { ok: true, data: { sections: [{ name: 'card', text: 'ROLECARD' }] } };
  };
  const pipeline = createPipeline({ registry, builtinSteps: buildBuiltinSteps(), budgetChars: 6000 });
  const first = await pipeline.runForward({
    consumerId: 'qq-main', sessionKey: 's', turnToken: 't', text: 'hello', isFirstTurnOfSession: true,
  });
  assert.equal(first.steps[0].outcome, 'injected');
  assert.equal(first.text, `ROLECARD\n\nhello\n\n${protocolTokenLine('t')}`);
  // tool.call 统一改造：首轮语义由网关 once 规则 + epoch 去重覆盖，信封不再带 firstTurn。
  assert.equal('firstTurn' in calls[0].request, false, '信封无 firstTurn 字段');
  assert.deepEqual(calls[0].request.args, {}, 'decorator 的 args 恒为空对象');

  const second = await pipeline.runForward({
    consumerId: 'qq-main', sessionKey: 's', turnToken: 't2', text: 'hello2', isFirstTurnOfSession: false,
  });
  assert.equal(second.steps[0].outcome, 'skipped-once');
  assert.equal(second.text, `hello2\n\n${protocolTokenLine('t2')}`);
  assert.equal(calls.length, 1, '非首轮不调服务');
});

test('rules: 本地静态供料——prefix/suffix/regex/function 四种拼接（不调任何服务）', async () => {
  const make = (entry) => createPipeline({
    registry: fakeServiceRegistry({ pipelines: { c: [entry] } }),
    builtinSteps: buildBuiltinSteps(),
    budgetChars: 6000,
  });
  const run = (entry, text) => make(entry).runForward({ consumerId: 'c', sessionKey: 's', text });

  const prefix = await run({ step: 'card', text: 'CARD', join: 'prefix' }, 'hello');
  assert.equal(prefix.text, 'CARD\n\nhello');
  assert.equal(prefix.steps[0].outcome, 'injected');

  const suffix = await run({ step: 'card', text: 'CARD', join: 'suffix' }, 'hello');
  assert.equal(suffix.text, 'hello\n\nCARD');

  const plain = await run({ step: 'card', text: 'CARD' }, 'hello');
  assert.equal(plain.text, 'hello\n\nCARD', '静态条目无 join = 缺省 suffix（与 sections 语义同向）');

  const regexed = await run({
    step: 'x', text: '已确认', join: 'regex', pattern: '会议改到下午', replacement: '会议改到{extra}',
  }, '会议改到下午，别迟到');
  assert.equal(regexed.text, '会议改到已确认，别迟到', '{extra} 占位符替换');

  const global = await run({ step: 'x', text: 'X', join: 'regex', pattern: 'a+', replacement: '<{extra}>' }, 'baaad');
  assert.equal(global.text, 'b<X>d', 'regex 缺省 flags=g 全局替换');

  const fned = await run({
    step: 'x', text: 'CARD', join: 'function', fn: 'return `[P]${extra}[S]${message}`;',
  }, 'hello');
  assert.equal(fned.text, '[P]CARD[S]hello', '自定义函数决定拼接（强制 return，保存期已校验）');
});

test('rules: 装饰器产出 + join 规则——引擎接管拼接（供料型），sections 不再单独收集', async () => {
  const registry = fakeServiceRegistry({
    services: { feed: { id: 'feed', kind: 'resource', role: 'decorator' } },
    pipelines: { 'qq-main': [{ step: 'feed', join: 'prefix' }] },
    results: { feed: { sections: [{ name: 'mem', text: 'MEMORY' }] } },
  });
  const pipeline = createPipeline({ registry, builtinSteps: buildBuiltinSteps(), budgetChars: 6000 });
  const out = await pipeline.runForward({ consumerId: 'qq-main', sessionKey: 's', turnToken: 't', text: 'hello' });
  assert.equal(out.steps.find((s) => s.name === 'feed').outcome, 'injected');
  assert.equal(out.text, `MEMORY\n\nhello\n\n${protocolTokenLine('t')}`);
});

test('rules: 函数运行期抛错 fail-safe——degraded 保留原文（试运行通过、真实输入触发）', async () => {
  const registry = fakeServiceRegistry({
    pipelines: { 'qq-main': [{ step: 'x', text: 'C', join: 'function', fn: 'if (message === "keep") throw new Error("boom"); return message;' }] },
  });
  const pipeline = createPipeline({ registry, builtinSteps: buildBuiltinSteps(), budgetChars: 6000 });
  const out = await pipeline.runForward({ consumerId: 'qq-main', sessionKey: 's', text: 'keep' });
  assert.equal(out.degraded, true);
  assert.equal(out.text, 'keep', '宁放行不误杀：函数异常保留当前文本');
  assert.equal(out.steps[0].outcome, 'degraded');
});

test('runner: once 首轮判定——首轮注入进 prompt，同会话第二轮不重复注入', async () => {
  const registry = fakeServiceRegistry({
    pipelines: { 'qq-main': [{ step: 'card', text: 'ROLECARD', once: true, join: 'prefix' }] },
  });
  const pipeline = createPipeline({ registry, builtinSteps: buildBuiltinSteps(), budgetChars: 6000 });
  const { runner, dsh } = await buildRunnerHarness({ pipeline, config: { pipeline: { mode: 'on' } } });
  await submitAndFinish(runner, dsh, makeRecord(baseEnvelope()));
  assert.ok(dsh.state.prompts[0].text.startsWith('ROLECARD'), '首轮：本地静态 once 注入进 prompt');
  const envelope2 = { ...baseEnvelope(), message: { ...baseEnvelope().message, id: 'm2' } };
  await submitAndFinish(runner, dsh, makeRecord(envelope2));
  assert.equal(dsh.state.prompts[1].text.startsWith('ROLECARD'), false, '第二轮不再注入');
  assert.ok(dsh.state.prompts[1].text.startsWith('adapter-assembled-prompt'));
});

