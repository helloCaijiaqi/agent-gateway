// gen-secret 契约回归：
//   1. 脚本产物的密钥必须能通过网关的 signRequest/verifyRequest（鉴权互认钉子）；
//   2. 写文件的拒绝覆盖 / --force 语义；
//   3. 三类 kind 的片段装配正确；
//   4. CLI 的 --json 可解析、重复执行被拒、--force 覆盖。
//
// 离线运行：state 目录指向系统临时目录，不碰生产凭据。
// 运行：npm test（agent-gateway 包内）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const { generateSecret, writeSecretFile, buildConfigSnippets, sha256Prefix, MIN_SECRET_LENGTH } =
  await import(new URL('../src/core/secrets.mjs', import.meta.url).href);
const { createNonceCache, signRequest, verifyRequest } = await import(
  new URL('../src/core/auth.mjs', import.meta.url).href
);
const { loadConfig } = await import(new URL('../src/core/config.mjs', import.meta.url).href);
const { createConsumerRegistry } = await import(
  new URL('./support/consumer-registration.mjs', import.meta.url).href
);

const SCRIPT = new URL('./gen-secret.mjs', import.meta.url).href;

function tmpDir(prefix = 'gateway-secrets-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── generateSecret ─────────────────────────────────────────────────────────

test('generateSecret: 48 位十六进制、每次不同、满足 auth 下限', () => {
  const a = generateSecret();
  const b = generateSecret();
  assert.match(a, /^[0-9a-f]{48}$/);
  assert.notEqual(a, b);
  assert.ok(a.length >= MIN_SECRET_LENGTH);
  assert.throws(() => generateSecret({ bytes: 4 }), TypeError);
});

test('脚本产物密钥通过网关鉴权互认（signRequest → verifyRequest）', () => {
  const secret = generateSecret();
  const body = JSON.stringify({ probe: true });
  const headers = signRequest({ secret, adapterId: 'probe-main', body });
  const verified = verifyRequest({
    secret,
    expectedAdapterId: 'probe-main',
    headers,
    body,
    nonceCache: createNonceCache(),
  });
  assert.equal(verified.adapterId, 'probe-main');
});

test('错密钥必须被拒（负例：密钥生成不能造成鉴权放水）', () => {
  const secret = generateSecret();
  const body = '{}';
  const headers = signRequest({ secret, adapterId: 'probe-main', body });
  assert.throws(() => verifyRequest({
    secret: generateSecret(),
    expectedAdapterId: 'probe-main',
    headers,
    body,
    nonceCache: createNonceCache(),
  }), (error) => error.code === 'E_AUTH');
});

// ── writeSecretFile ────────────────────────────────────────────────────────

test('writeSecretFile: 创建目录写入；重复拒绝；force 覆盖；指纹一致', () => {
  const dir = tmpDir();
  const first = writeSecretFile({ dir, id: 'probe-main', secret: generateSecret() });
  assert.equal(first.overwritten, false);
  assert.ok(fs.existsSync(first.filePath));
  assert.equal(first.sha256, sha256Prefix(fs.readFileSync(first.filePath, 'utf8').trim()));
  // 0600：密钥文件不能对同机其他用户可读（Windows 上 mode 不生效，靠 ACL）。
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(first.filePath).mode & 0o777, 0o600);
  }
  // 带 id 的路径穿越被拒
  assert.throws(() => writeSecretFile({ dir, id: '../evil', secret: generateSecret() }), TypeError);
  // 重复执行拒绝
  assert.throws(() => writeSecretFile({ dir, id: 'probe-main', secret: generateSecret() }),
    /refusing to overwrite/);
  const original = fs.readFileSync(first.filePath, 'utf8');
  // --force 覆盖
  const rotated = writeSecretFile({ dir, id: 'probe-main', secret: generateSecret(), force: true });
  assert.equal(rotated.overwritten, true);
  assert.notEqual(fs.readFileSync(rotated.filePath, 'utf8'), original);
});

// ── buildConfigSnippets ────────────────────────────────────────────────────

test('adapter kind: 消费端登记条目（kind=consumer，svc id 语义）+ 交接文件提示；wx: enabled:false；mcp-bus: 无条目/交接', () => {
  const secret = generateSecret();
  const caps = ['send_text', 'mark_read'];

  // 历史调用方可能仍传 capabilities（旧脚本/MCP 封装），必须被忽略而不是写进条目：
  // 工具面唯一事实源是适配器的 actions-manifest。
  const adapter = buildConfigSnippets({ kind: 'adapter', id: 'svc-1a2b3c4d5e6f', secret, capabilities: caps });
  assert.deepEqual(adapter.consumerEntry, {
    v: 1,
    id: 'svc-1a2b3c4d5e6f',
    name: 'svc-1a2b3c4d5e6f',
    kind: 'consumer',
    transport: 'auto',
    url: 'http://127.0.0.1:3100',
    platform: 'qq',
    secretFile: 'svc-1a2b3c4d5e6f.secret',
  });
  assert.equal('capabilities' in adapter.consumerEntry, false);
  // 网关连接信息不再以「桥接 config.json 片段」形式给出：改为指向交接文件。
  assert.equal('bridgeGateway' in adapter, false);
  assert.equal(adapter.handoff.fileName, 'gateway.json');
  assert.equal(adapter.handoff.copyFrom, 'handoff/svc-1a2b3c4d5e6f.gateway.json');
  assert.equal(JSON.stringify(adapter.handoff).includes(secret), false, '片段不得回显密钥明文');
  assert.equal(adapter.mcpToken, null);

  const wx = buildConfigSnippets({ kind: 'wx', id: 'svc-9f8e7d6c5b4a', secret });
  assert.equal(wx.consumerEntry.platform, 'wx');
  assert.equal(wx.consumerEntry.enabled, false);
  assert.equal(wx.consumerEntry.url, 'http://127.0.0.1:7192');
  assert.ok(wx.notes.some((note) => note.includes('enabled:false')));

  const bus = buildConfigSnippets({ kind: 'mcp-bus', id: 'mcp-bus', secret });
  assert.equal(bus.consumerEntry, null);
  assert.equal(bus.handoff, null);
  assert.equal(bus.mcpToken.value, secret);
  // 文件单源：指引指向密钥文件，不再有 env 通道。
  assert.equal(bus.mcpToken.file, 'state/gateway/mcp-bus.secret');
  assert.ok(bus.notes.some((note) => note.includes('state/gateway/mcp-bus.secret')));
});

// ── 集成：脚本产物 → 登记目录(secretFile) → 网关鉴权 ───────────────────────

test('端到端：生成的 secret 文件经登记目录装载并可通过 verifyRequest', () => {
  const dir = tmpDir();
  const { filePath } = writeSecretFile({ dir, id: 'probe-main', secret: generateSecret() });
  // 消费端身份只认登记目录：写 services/probe-main.json（secretFile 相对 stateDir）。
  fs.mkdirSync(path.join(dir, 'services'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'services', 'probe-main.json'), JSON.stringify({
    v: 1, id: 'probe-main', name: 'probe', kind: 'consumer', transport: 'http',
    platform: 'qq', url: 'http://127.0.0.1:3100', secretFile: 'probe-main.secret',
  }));
  loadConfig({ stateDir: dir, env: { GATEWAY_MODE: 'off' } });
  const registry = createConsumerRegistry({ stateDir: dir });
  const adapter = registry.consumers().find((entry) => entry.id === 'probe-main');
  assert.ok(adapter, 'consumer registered');
  assert.equal(adapter.secret, fs.readFileSync(filePath, 'utf8').trim());

  const body = '{}';
  verifyRequest({
    secret: adapter.secret,
    expectedAdapterId: adapter.id,
    headers: signRequest({ secret: adapter.secret, adapterId: adapter.id, body }),
    body,
    nonceCache: createNonceCache(),
  });
});

// ── CLI ────────────────────────────────────────────────────────────────────

test('CLI: --json 可解析；重复执行退出非零；--force 覆盖成功', () => {
  const dir = tmpDir();
  const run = (extraArgs = []) => spawnSync(process.execPath, [fileURLToPath(SCRIPT), ...extraArgs], {
    encoding: 'utf8',
  });

  const first = run(['--id', 'probe-main', '--out', dir, '--json']);
  assert.equal(first.status, 0, first.stderr);
  const parsed = JSON.parse(first.stdout);
  assert.equal(parsed.ok, true);
  assert.match(parsed.file, /probe-main\.secret$/);
  assert.equal(parsed.snippets.consumerEntry.id, 'probe-main');
  assert.ok(fs.existsSync(parsed.file));

  const repeat = run(['--id', 'probe-main', '--out', dir, '--json']);
  assert.notEqual(repeat.status, 0);
  const repeatJson = JSON.parse(repeat.stdout);
  assert.equal(repeatJson.ok, false);

  const forced = run(['--id', 'probe-main', '--out', dir, '--force', '--json']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(JSON.parse(forced.stdout).overwritten, true);

  const human = run(['--kind', 'wx', '--id', 'probe-wx', '--out', dir]);
  assert.equal(human.status, 0, human.stderr);
  assert.ok(human.stdout.includes('enabled'));

  const badKind = run(['--kind', 'nope', '--out', dir]);
  assert.notEqual(badKind.status, 0);
});
