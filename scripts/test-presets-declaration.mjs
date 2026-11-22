// 「平台→preset 由适配器声明」的契约测试（2026-11-16 起网关不再持有映射表）。
//
// 钉住三件事：
//   ① 登记文件可以声明 presets，形状是 { <platform>: <preset> }；
//   ② 形状不对直接拒绝（平台键与预设名都必须是 lowercase kebab/单段）；
//   ③ 注册表把声明原样保存在内存记录里，并从 services()/registrations() 透出。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { serviceRegistrationSchema } = await import(
  new URL('../src/core/contracts.mjs', import.meta.url).href
);
const { createServiceRegistry } = await import(
  new URL('../src/core/service-registry.mjs', import.meta.url).href
);

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function baseRegistration(overrides = {}) {
  return {
    v: 1,
    id: 'svc-test',
    name: 'qq 适配器',
    kind: 'consumer',
    transport: 'ws',
    platform: 'qq',
    secret: 'secret-0123456789abcdef',
    ...overrides,
  };
}

test('契约：登记声明可以带 presets（平台 → preset）', () => {
  const parsed = serviceRegistrationSchema.parse(baseRegistration({ presets: { qq: 'qq-chat' } }));
  assert.deepEqual(parsed.presets, { qq: 'qq-chat' });
});

test('契约：presets 的键与值都必须是单段小写（拒绝大写/空格/路径）', () => {
  for (const bad of [{ qq: 'QQ Chat' }, { qq: 'qq-chat/../x' }, { 'QQ': 'qq-chat' }, { '': 'qq-chat' }]) {
    assert.throws(
      () => serviceRegistrationSchema.parse(baseRegistration({ presets: bad })),
      (error) => error.name === 'ZodError',
      `应拒绝 ${JSON.stringify(bad)}`,
    );
  }
});

test('注册表：声明被持久化记录并透出到 services()/registrations()', () => {
  const stateDir = tmpDir('gw-presets-');
  const dir = path.join(stateDir, 'services');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'svc-test.json'),
    JSON.stringify(baseRegistration({ presets: { qq: 'qq-chat' } })),
    'utf8',
  );

  const registry = createServiceRegistry({
    stateDir,
    logger: () => {},
    registrations: { dir, reloadMs: 0, ledgerFile: path.join(stateDir, 'ledger.json') },
  });
  assert.deepEqual(registry.services().find((s) => s.id === 'svc-test').presets, { qq: 'qq-chat' });
  assert.deepEqual(registry.registrations().find((s) => s.id === 'svc-test').presets, { qq: 'qq-chat' });
  // resolveService 是建会话时的取值入口：必须拿到同一份声明。
  assert.deepEqual(registry.resolveService('svc-test').presets, { qq: 'qq-chat' });
});

test('注册表：没有声明时透出 null（不是空对象，避免被误判为「已声明但没值」）', () => {
  const stateDir = tmpDir('gw-presets-null-');
  const dir = path.join(stateDir, 'services');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'svc-test.json'), JSON.stringify(baseRegistration()), 'utf8');

  const registry = createServiceRegistry({
    stateDir,
    logger: () => {},
    registrations: { dir, reloadMs: 0, ledgerFile: path.join(stateDir, 'ledger.json') },
  });
  assert.equal(registry.services().find((s) => s.id === 'svc-test').presets, null);
});

test('注册表：updateRegistrationPresets 写回文件并热更新内存（清除=回到 null）', () => {
  const stateDir = tmpDir('gw-presets-write-');
  const dir = path.join(stateDir, 'services');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'svc-test.json');
  fs.writeFileSync(file, JSON.stringify(baseRegistration()), 'utf8');
  const registry = createServiceRegistry({
    stateDir,
    logger: () => {},
    registrations: { dir, reloadMs: 0, ledgerFile: path.join(stateDir, 'ledger.json') },
  });

  // 写入：文件与内存同步带上声明。
  const set = registry.updateRegistrationPresets('svc-test', { qq: 'qq-chat' });
  assert.deepEqual(set, { ok: true, id: 'svc-test', presets: { qq: 'qq-chat' } });
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk.presets, { qq: 'qq-chat' });
  assert.deepEqual(registry.resolveService('svc-test').presets, { qq: 'qq-chat' });

  // 非法形状：400 语义，文件保持原样。
  const bad = registry.updateRegistrationPresets('svc-test', { qq: 'QQ Chat' });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).presets, { qq: 'qq-chat' });

  // 未知 id：404 语义。
  assert.equal(registry.updateRegistrationPresets('svc-none', {}).ok, false);

  // 清除：文件里删掉字段，内存回到 null。
  const cleared = registry.updateRegistrationPresets('svc-test', null);
  assert.deepEqual(cleared, { ok: true, id: 'svc-test', presets: null });
  assert.equal('presets' in JSON.parse(fs.readFileSync(file, 'utf8')), false, '清除后不残留空字段');
  assert.equal(registry.resolveService('svc-test').presets, null);
});
