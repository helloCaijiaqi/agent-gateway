// 登记目录专项测试（V2 P3）：hash 身份（id 格式 + 文件名即身份）、工具级 roles
// 两层声明、台账（append-only + 脱敏）、热加载（注册即生效 / 卸载即撤销编排）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { createServiceRegistry } = await import(new URL('../src/core/service-registry.mjs', import.meta.url).href);
const { newRegistrationId } = await import(new URL('../src/core/contracts.mjs', import.meta.url).href);

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeRegistry(dir, overrides = {}) {
  return createServiceRegistry({
    pipelinesFile: path.join(dir, 'pipelines.json'),
    stateDir: dir,
    registrations: {
      dir: path.join(dir, 'services'),
      ledgerFile: path.join(dir, 'ledger.jsonl'),
      reloadMs: overrides.reloadMs ?? 0,
    },
    logger: () => {},
  });
}

function writeRegistration(dir, file, body) {
  const regDir = path.join(dir, 'services');
  fs.mkdirSync(regDir, { recursive: true });
  fs.writeFileSync(path.join(regDir, file), JSON.stringify(body));
}

const SECRET = 's'.repeat(20);

test('registration: id 词典——可读 id 合法（运维挂载），文件名与 id 不一致仍拒载，台账记 reject', () => {
  const dir = tmpDir('gw-regdir-');
  // 可读 id 现在合法（编排硬切后 fixture 从内联 services 迁来，沿用 P2 服务 id 词典）。
  writeRegistration(dir, 'memory-mcp.json', {
    v: 1, id: 'memory-mcp', name: 'memory', kind: 'resource', transport: 'http', url: 'http://127.0.0.1:7181', secret: SECRET,
  });
  const goodId = newRegistrationId();
  writeRegistration(dir, 'not-the-id.json', { // 文件名 ≠ id → 拒载
    v: 1, id: goodId, name: 'memory', kind: 'resource', transport: 'http', url: 'http://127.0.0.1:7181', secret: SECRET,
  });
  const registry = makeRegistry(dir);
  assert.equal(registry.registrations().length, 1, '可读 id 装载、文件名不一致的拒载');
  assert.equal(registry.registrations()[0].id, 'memory-mcp');
  const ledger = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const rejects = ledger.filter((e) => e.action === 'reject');
  assert.deepEqual(rejects.map((e) => e.action), ['reject']);
  assert.match(rejects[0].reason, /file name must be "<id>.json"/);
});

test('registration: 合法 hash 登记——register 台账脱敏（secret 三态不落盘），name/memoryService 进视图', () => {
  const dir = tmpDir('gw-regdir-');
  const id = newRegistrationId();
  writeRegistration(dir, `${id}.json`, {
    v: 1, id, name: 'memory-mcp', kind: 'resource', transport: 'http',
    url: 'http://127.0.0.1:7181', secret: SECRET, memoryService: true,
    tools: [{ name: 'chat_memory_recall', description: 'r', role: 'decorator' }],
  });
  const registry = makeRegistry(dir);
  const view = registry.registrations();
  assert.equal(view.length, 1);
  assert.equal(view[0].id, id);
  assert.equal(view[0].name, 'memory-mcp', '展示名随条目透出');
  assert.equal(view[0].memoryService, true, '记忆服务声明透出（控制台记忆徽标数据源）');
  const ledger = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const register = ledger.find((e) => e.action === 'register');
  assert.equal(register.serviceId, id);
  assert.equal(register.snapshot.secret, undefined, '密钥绝不落台账');
  assert.equal(register.snapshot.secretEnv, undefined);
  assert.equal(register.snapshot.name, 'memory-mcp');
});

test('registration: role 单值三选一——缺省 tool、decorator 角色要求 kind=resource、roles 数组报迁移错、resolveToolStep 命中', () => {
  const dir = tmpDir('gw-regdir-');
  const decId = newRegistrationId();
  writeRegistration(dir, `${decId}.json`, {
    v: 1, id: decId, name: 'memory-mcp', kind: 'resource', transport: 'http',
    url: 'http://127.0.0.1:7181', secret: SECRET,
    tools: [
      { name: 'chat_memory_get', description: 'r', role: 'decorator' },
      { name: 'chat_memory_record', description: 'w' }, // 缺省 tool
    ],
  });
  const badId = newRegistrationId();
  writeRegistration(dir, `${badId}.json`, { // consumer 服务带 decorator 工具 → 一致性拒载
    v: 1, id: badId, name: 'bridge', kind: 'consumer', transport: 'ws', platform: 'qq', secret: SECRET,
    tools: [{ name: 'chat_bridge_thing', description: 'x', role: 'decorator' }],
  });
  const legacyId = newRegistrationId();
  writeRegistration(dir, `${legacyId}.json`, { // roles 数组 → 单值 role 硬切后非法（迁移文案）
    v: 1, id: legacyId, name: 'legacy', kind: 'resource', transport: 'http',
    url: 'http://127.0.0.1:7181', secret: SECRET,
    tools: [{ name: 'chat_legacy_tool', description: 'x', roles: ['tool', 'decorator'] }],
  });
  const registry = makeRegistry(dir);
  assert.equal(registry.registrations().length, 1, '不一致声明与 roles 数组均拒载');
  const tools = registry.registeredTools();
  assert.equal(tools.find((t) => t.name === 'chat_memory_get').role, 'decorator');
  assert.equal(tools.find((t) => t.name === 'chat_memory_record').role, 'tool');
  // 工具即步骤：decorator/filter 角色工具可被编排解析（两级解析的第二级）。
  const step = registry.resolveToolStep('chat_memory_get');
  assert.equal(step.service.id, decId);
  assert.equal(registry.resolveToolStep('chat_memory_record'), null, '纯工具不是步骤');
  // 拒载理由核对：consumer 带管线型工具与新一致性校验文案对齐。
  const ledger = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const rejects = ledger.filter((e) => e.action === 'reject');
  assert.ok(rejects.some((e) => /require kind "resource"/.test(e.reason)), 'decorator/filter 角色工具要求 kind=resource');
  assert.ok(rejects.some((e) => /declares a "roles" array/.test(e.reason)), 'roles 数组迁移文案仍在');
});

test('registration: 旧 kind（decorator/filter/shadow）fail-closed 拒载并给迁移文案', () => {
  const dir = tmpDir('gw-regdir-');
  for (const kind of ['decorator', 'filter', 'shadow']) {
    writeRegistration(dir, `legacy-${kind}.json`, {
      v: 1, id: `legacy-${kind}`, name: 'legacy', kind, transport: 'http',
      url: 'http://127.0.0.1:7181', secret: SECRET,
    });
  }
  const registry = makeRegistry(dir);
  assert.deepEqual(registry.registrations(), [], '旧 kind 一律拒载');
  const ledger = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const rejects = ledger.filter((e) => e.action === 'reject');
  assert.equal(rejects.length, 3);
  for (const kind of ['decorator', 'filter', 'shadow']) {
    const event = rejects.find((e) => e.serviceId === `legacy-${kind}`);
    assert.match(event.reason, /kind ".*" is retired/);
    assert.match(event.reason, /migrate "kind": ".*" → "kind": "resource"/);
  }
});

test('registration: 传输非对称——resource 配 ws/auto fail-closed 拒载并给迁移文案', () => {
  const dir = tmpDir('gw-regdir-');
  for (const transport of ['ws', 'auto']) {
    writeRegistration(dir, `bad-transport-${transport}.json`, {
      v: 1, id: `bad-transport-${transport}`, name: 'bad', kind: 'resource', transport,
      url: 'http://127.0.0.1:7181', secret: SECRET,
    });
  }
  const registry = makeRegistry(dir);
  assert.deepEqual(registry.registrations(), [], 'resource 只允许 http');
  const ledger = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const rejects = ledger.filter((e) => e.action === 'reject');
  assert.equal(rejects.length, 2);
  for (const transport of ['ws', 'auto']) {
    const event = rejects.find((e) => e.serviceId === `bad-transport-${transport}`);
    assert.match(event.reason, /kind "resource" with transport ".*" is not supported/);
    assert.match(event.reason, /migrate "transport": ".*" → "transport": "http"/);
  }
});

test('registration: resource 服务可同时声明 tool/decorator/filter 三种 role 工具', () => {
  const dir = tmpDir('gw-regdir-');
  const id = newRegistrationId();
  writeRegistration(dir, `${id}.json`, {
    v: 1, id, name: 'omni', kind: 'resource', transport: 'http',
    url: 'http://127.0.0.1:7181', secret: SECRET,
    tools: [
      { name: 'chat_omni_query', description: 'q', role: 'tool' },
      { name: 'chat_omni_render', description: 'd', role: 'decorator' },
      { name: 'chat_omni_guard', description: 'f', role: 'filter' },
    ],
  });
  const registry = makeRegistry(dir);
  assert.equal(registry.registrations().length, 1, '三种 role 全部合法');
  assert.deepEqual(registry.registeredTools().map((t) => t.role).sort(), ['decorator', 'filter', 'tool']);
  assert.equal(registry.resolveToolStep('chat_omni_render').service.id, id, 'decorator 工具可编排');
  assert.equal(registry.resolveToolStep('chat_omni_guard').service.id, id, 'filter 工具可编排');
});

test('registration: 热加载——注册即生效（含编排权限），卸载即撤销', async () => {
  const dir = tmpDir('gw-regdir-');
  const consumerId = newRegistrationId();
  // 预配编排键（hash）：注册前门禁拦住，注册后即刻生效。
  fs.writeFileSync(path.join(dir, 'pipelines.json'), JSON.stringify({ pipelines: { [consumerId]: ['chat_memory_recall'] } }));
  const registry = makeRegistry(dir, { reloadMs: 30 });
  try {
    // 未注册：有预配编排也无权限（门禁 fail-closed 启动校验会挡住这种启动，
    // 这里直接建 registry 验运行时行为）——装饰器工具步骤未登记也解析不了。
    assert.deepEqual(registry.pipelineFor(consumerId), []);
    // 放入登记文件（kind=consumer）→ 轮询装载 → 编排权限即刻拥有。
    writeRegistration(dir, `${consumerId}.json`, {
      v: 1, id: consumerId, name: 'bridge', kind: 'consumer', transport: 'ws', platform: 'qq', secret: SECRET,
    });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(registry.registrations().length, 1, '热加载注册生效');
    assert.deepEqual(registry.pipelineFor(consumerId), ['chat_memory_recall']);
    // 删文件 = 卸载 → 编排权限即刻撤销（下次 pipelineFor 生效，无需重启）。
    fs.unlinkSync(path.join(dir, 'services', `${consumerId}.json`));
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(registry.registrations().length, 0, '卸载生效');
    assert.deepEqual(registry.pipelineFor(consumerId), [], '编排随卸载撤销');
    const ledger = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const actions = ledger.filter((e) => e.serviceId === consumerId).map((e) => e.action);
    assert.deepEqual(actions, ['register', 'unregister']);
  } finally {
    registry.stop();
  }
});
