// gateway.json 交接文件（v1）契约回归：
//   1. 文档形状与字段校验（密钥二选一、绝对路径、transport 白名单、id 口径）；
//   2. 落盘语义（原子写、幂等、拒绝静默覆盖、0600）；
//   3. 位置约束：必须落 handoff/，绝不能落 services/（否则会被登记扫描当坏登记）；
//   4. 基址解析（0.0.0.0 → 回环、IPv6 加括号、去尾斜杠）。
//
// 全部离线：state 目录用系统临时目录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {
  HANDOFF_VERSION, HANDOFF_FILENAME,
  buildHandoffDocument, handoffExists, handoffPath, readHandoff,
  removeHandoff, resolveGatewayBaseUrl, serializeHandoff, writeHandoff,
} = await import(new URL('../src/core/gateway-json.mjs', import.meta.url).href);

const STATE = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-handoff-'));

function adapterDoc(overrides = {}) {
  return buildHandoffDocument({
    kind: 'adapter',
    id: 'qq-main',
    url: 'http://127.0.0.1:7190',
    secretFile: path.join(os.tmpdir(), 'gw-secrets', 'qq-main.secret'),
    ...overrides,
  });
}

// ── 文档构造 ───────────────────────────────────────────────────────────────

test('buildHandoffDocument: adapter + secretFile 的完整形状自解释', () => {
  const doc = adapterDoc();
  assert.equal(doc.v, HANDOFF_VERSION);
  assert.equal(doc.id, 'qq-main');
  assert.equal(doc.kind, 'adapter');
  assert.equal(doc.url, 'http://127.0.0.1:7190');
  assert.equal(doc.transport, 'auto');
  assert.match(doc.secretFile, /qq-main\.secret$/);
  // 复制指引必须写在文件里：看到文件的人不用再去翻文档找目标文件名。
  assert.match(doc._comment, /gateway\.json/);
  assert.equal('secret' in doc, false);
  assert.equal(HANDOFF_FILENAME, 'gateway.json');
});

test('buildHandoffDocument: service + 内联密钥（跨机复制用）', () => {
  const doc = buildHandoffDocument({
    kind: 'service',
    id: 'a1b2c3',
    url: 'http://127.0.0.1:7190/',
    transport: 'ws',
    secret: 'x'.repeat(32),
  });
  assert.equal(doc.kind, 'service');
  assert.equal(doc.url, 'http://127.0.0.1:7190', '结尾斜杠应被去掉（对端拼接 /v1/ws 时不会出现双斜杠）');
  assert.equal(doc.transport, 'ws');
  assert.equal(doc.secret, 'x'.repeat(32));
  assert.equal('secretFile' in doc, false);
});

test('buildHandoffDocument: 无凭据 + authNote（secretEnv 登记的降级形态）', () => {
  const doc = buildHandoffDocument({
    kind: 'service',
    id: 'svc-1',
    url: 'http://127.0.0.1:7190',
    authNote: '登记使用 secretEnv=MEM_TOKEN，请在目标仓补 secret',
  });
  assert.equal('secret' in doc, false);
  assert.equal('secretFile' in doc, false);
  assert.match(doc.authNote, /secretEnv/);
});

test('buildHandoffDocument: 字段校验全部 fail-closed', () => {
  const base = { kind: 'adapter', id: 'qq-main', url: 'http://127.0.0.1:7190', secret: 'y'.repeat(16) };
  assert.throws(() => buildHandoffDocument({ ...base, kind: 'platform' }), /kind must be/);
  assert.throws(() => buildHandoffDocument({ ...base, id: 'QQ-Main' }), /id must match/);
  assert.throws(() => buildHandoffDocument({ ...base, id: '../etc/passwd' }), /id must match/);
  assert.throws(() => buildHandoffDocument({ ...base, url: '/v1/inbound' }), /absolute http/);
  assert.throws(() => buildHandoffDocument({ ...base, url: 'ftp://127.0.0.1:7190' }), /http\(s\)/);
  assert.throws(() => buildHandoffDocument({ ...base, transport: 'tcp' }), /transport must be/);
  assert.throws(() => buildHandoffDocument({ ...base, secret: 'short' }), /at least 16/);
  // 二选一：同时给会被拒绝，避免「文件里明文和文件引用各说各话」。
  assert.throws(
    () => buildHandoffDocument({ ...base, secretFile: path.join(os.tmpdir(), 'x.secret') }),
    /exactly one of secret \| secretFile/,
  );
  // 相对路径复制到别的仓库必然 ENOENT，生成期就拒。
  assert.throws(
    () => buildHandoffDocument({ kind: 'adapter', id: 'qq-main', url: 'http://127.0.0.1:7190', secretFile: 'qq-main.secret' }),
    /must be absolute/,
  );
});

test('serializeHandoff: 末尾单换行、可原样解析', () => {
  const doc = adapterDoc();
  const text = serializeHandoff(doc);
  assert.ok(text.endsWith('}\n'));
  assert.deepEqual(JSON.parse(text), doc);
});

// ── 基址解析 ───────────────────────────────────────────────────────────────

test('resolveGatewayBaseUrl: 默认值 / 自定义端口 / 监听地址归一 / IPv6', () => {
  assert.equal(resolveGatewayBaseUrl(), 'http://127.0.0.1:7190');
  assert.equal(resolveGatewayBaseUrl({ port: 8787 }), 'http://127.0.0.1:8787');
  assert.equal(resolveGatewayBaseUrl({ host: '0.0.0.0', port: 7190 }), 'http://127.0.0.1:7190');
  assert.equal(resolveGatewayBaseUrl({ host: '::', port: 7190 }), 'http://127.0.0.1:7190');
  assert.equal(resolveGatewayBaseUrl({ host: '::1', port: 7190 }), 'http://[::1]:7190');
  assert.throws(() => resolveGatewayBaseUrl({ port: 0 }), /port must be/);
  assert.throws(() => resolveGatewayBaseUrl({ port: 70000 }), /port must be/);
});

// ── 落盘 ───────────────────────────────────────────────────────────────────

test('writeHandoff: 落 handoff/（不是 services/），内容可回读', () => {
  const stateDir = STATE();
  const doc = adapterDoc();
  const result = writeHandoff({ stateDir, doc });

  assert.equal(result.written, true);
  assert.equal(result.filePath, handoffPath({ stateDir, id: doc.id }));
  const relative = path.relative(stateDir, result.filePath).replace(/\\/g, '/');
  assert.match(relative, /^handoff\/qq-main\.gateway\.json$/);
  // 硬约束：登记目录只扫 *.json，放错目录会被当作坏登记。
  assert.equal(relative.includes('services/'), false);

  assert.deepEqual(readHandoff({ stateDir, id: doc.id }), doc);
  assert.equal(handoffExists({ stateDir, id: doc.id }), true);
  // 没有半份临时文件残留。
  assert.deepEqual(fs.readdirSync(path.dirname(result.filePath)), ['qq-main.gateway.json']);
});

test('writeHandoff: 内容相同 = 幂等；内容不同 = 拒绝静默覆盖', () => {
  const stateDir = STATE();
  const doc = adapterDoc();
  writeHandoff({ stateDir, doc });

  const again = writeHandoff({ stateDir, doc });
  assert.equal(again.written, false, '内容一致时不应重写（保持 mtime 稳定，便于对账）');

  const rotated = adapterDoc({ secretFile: path.join(os.tmpdir(), 'gw-secrets', 'other.secret') });
  assert.throws(() => writeHandoff({ stateDir, doc: rotated }), /refusing to overwrite/);

  const forced = writeHandoff({ stateDir, doc: rotated, force: true });
  assert.equal(forced.written, true);
  assert.equal(readHandoff({ stateDir, id: doc.id }).secretFile, path.normalize(rotated.secretFile));
});

test('writeHandoff: 文件权限 0600（Windows 上 mode 由 ACL 决定，跳过）', { skip: process.platform === 'win32' }, () => {
  const stateDir = STATE();
  const { filePath } = writeHandoff({ stateDir, doc: adapterDoc() });
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test('removeHandoff / readHandoff: 删除幂等，缺失返回 null', () => {
  const stateDir = STATE();
  const doc = adapterDoc();
  assert.equal(removeHandoff({ stateDir, id: doc.id }), false);
  assert.equal(readHandoff({ stateDir, id: doc.id }), null);

  writeHandoff({ stateDir, doc });
  assert.equal(removeHandoff({ stateDir, id: doc.id }), true);
  assert.equal(removeHandoff({ stateDir, id: doc.id }), false);
  assert.equal(handoffExists({ stateDir, id: doc.id }), false);
});

test('writeHandoff: 坏 JSON 回读要报错并带路径（而不是静默 null）', () => {
  const stateDir = STATE();
  const doc = adapterDoc();
  const { filePath } = writeHandoff({ stateDir, doc });
  fs.writeFileSync(filePath, '{ broken', 'utf8');
  assert.throws(() => readHandoff({ stateDir, id: doc.id }), /not valid JSON/);
});
