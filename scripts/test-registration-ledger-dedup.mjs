// registration-ledger 写侧去重 + gzip 轮转（2026-11-26）回归：
//   - 同服务 snapshot 不变的重复 register 只落 snapshotHash 引用行（增量砍冗余）；
//   - 快照变化 / 新进程首条 / unregister·reject 永远落全量；
//   - 超 rotateBytes 产生 .gz 归档、keepArchives 裁剪、readAll 只读现行卷；
//   - contracts 校验 snapshotHash 形状；审计视图 hash-only 事件快照继承重放。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { createRegistrationLedger, redactRegistration } = await import(new URL('../src/core/registration-ledger.mjs', import.meta.url).href);
const { parseRegistrationLedgerEvent } = await import(new URL('../src/core/contracts.mjs', import.meta.url).href);
const { createServiceRegistry } = await import(new URL('../src/core/service-registry.mjs', import.meta.url).href);

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const SNAPSHOT = {
  v: 1, id: '91432b913ede4b3e880c77373183fe50', name: 'memory-mcp', kind: 'resource',
  transport: 'http', url: 'http://127.0.0.1:7181', tools: [{ name: 'chat_memory_get', role: 'decorator' }],
  enabled: true, secret: 'should-be-redacted',
};

test('dedup: 同 snapshot 的重复 register 只落 snapshotHash，变化后落全量', () => {
  const dir = tmpDir('gw-ledger-dedup-');
  const file = path.join(dir, 'ledger.jsonl');
  const ledger = createRegistrationLedger({ file, logger: { info: () => {}, error: () => {} } });

  const redacted = redactRegistration(SNAPSHOT);
  ledger.append({ serviceId: SNAPSHOT.id, action: 'register', source: 'file', snapshot: redacted });
  ledger.append({ serviceId: SNAPSHOT.id, action: 'register', source: 'startup', snapshot: redacted });
  ledger.append({ serviceId: SNAPSHOT.id, action: 'register', source: 'startup', snapshot: redacted });

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.ok(lines[0].snapshot, '首条落全量快照');
  assert.match(lines[0].snapshotHash, /^[\da-f]{64}$/);
  assert.equal(lines[1].snapshot, undefined, '同快照第二条只落 hash 引用');
  assert.equal(lines[1].snapshotHash, lines[0].snapshotHash);
  assert.equal(lines[2].snapshotHash, lines[0].snapshotHash);
  assert.ok(!JSON.stringify(lines[1]).includes('chat_memory_get'), '引用行不含快照内容');

  // 快照变化（url 变了）→ 重新落全量
  const changed = { ...redacted, url: 'http://127.0.0.1:7182' };
  ledger.append({ serviceId: SNAPSHOT.id, action: 'register', source: 'operator', snapshot: changed });
  const lines2 = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines2[3].snapshot.url, 'http://127.0.0.1:7182', '变化后落全量');
  assert.notEqual(lines2[3].snapshotHash, lines2[0].snapshotHash);

  // 读侧重放：readAll 原样返回（继承在视图层做），坏行计数不受影响
  const { events, corrupt } = ledger.readAll();
  assert.equal(events.length, 4);
  assert.equal(corrupt, 0);
});

test('dedup: 新进程首条必落全量（侧车索引不跨进程）；unregister/reject 永远落全量', () => {
  const dir = tmpDir('gw-ledger-proc-');
  const file = path.join(dir, 'ledger.jsonl');
  const redacted = redactRegistration(SNAPSHOT);
  createRegistrationLedger({ file, logger: { info: () => {}, error: () => {} } })
    .append({ serviceId: SNAPSHOT.id, action: 'register', source: 'file', snapshot: redacted });

  // 模拟重启：全新实例（内存侧车为空）
  const ledger2 = createRegistrationLedger({ file, logger: { info: () => {}, error: () => {} } });
  ledger2.append({ serviceId: SNAPSHOT.id, action: 'register', source: 'startup', snapshot: redacted });
  let lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines[1].snapshot, '新实例首条落全量');

  // unregister 同快照也落全量（纠正性事件保持自含）
  ledger2.append({ serviceId: SNAPSHOT.id, action: 'unregister', source: 'file', snapshot: redacted });
  lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines[2].snapshot, 'unregister 落全量');

  // reject 无快照（本来就自含 reason）
  ledger2.append({ serviceId: 'bad-svc', action: 'reject', source: 'file', reason: 'schema mismatch' });
  const { events } = ledger2.readAll();
  assert.equal(events[3].action, 'reject');
  assert.equal(events[3].reason, 'schema mismatch');
});

test('rotation: 超 rotateBytes 产生 .gz 归档 + keepArchives 裁剪 + readAll 只读现行卷', async () => {
  const dir = tmpDir('gw-ledger-rot-');
  const file = path.join(dir, 'ledger.jsonl');
  const ledger = createRegistrationLedger({
    file, rotateBytes: 600, keepArchives: 2, logger: { info: () => {}, error: () => {} },
  });
  const redacted = redactRegistration(SNAPSHOT);
  // 每条 ~250 字节，第 3 条触发轮转
  for (let i = 0; i < 6; i++) {
    ledger.append({
      serviceId: `svc${i < 3 ? 'a' : 'b'}`.padEnd(12, '0'),
      action: 'register', source: 'file', snapshot: i % 2 ? { ...redacted, url: `http://x/${i}` } : redacted,
    });
  }
  const archives = fs.readdirSync(dir).filter((f) => f.startsWith('ledger.jsonl.') && f.endsWith('.gz'));
  assert.ok(archives.length >= 1 && archives.length <= 2, `归档 1~2 份，实际 ${archives.length}`);
  assert.ok(fs.existsSync(file), '现行文件存在');
  assert.ok(fs.statSync(file).size < 600 * 2, '现行卷已重新开始');
  const { events } = ledger.readAll();
  assert.ok(events.length >= 1 && events.length < 6, 'readAll 只读现行卷');
  // 归档内容人可读（gunzip 后是合法 JSONL）
  const { gunzipSync } = await import('node:zlib');
  const archived = gunzipSync(fs.readFileSync(path.join(dir, archives[0]))).toString('utf8');
  for (const line of archived.trim().split('\n')) JSON.parse(line);
});

test('contracts: snapshotHash 形状校验（非法格式拒，合法过，缺省可）', () => {
  const base = { at: Date.now(), serviceId: 'svc-0768297f65f9', action: 'register', source: 'file' };
  assert.equal(parseRegistrationLedgerEvent(base).snapshotHash, undefined, '缺省合法');
  assert.equal(
    parseRegistrationLedgerEvent({ ...base, snapshotHash: 'a'.repeat(64) }).snapshotHash,
    'a'.repeat(64),
  );
  assert.throws(() => parseRegistrationLedgerEvent({ ...base, snapshotHash: 'zz' }), '非法十六进制拒');
  assert.throws(() => parseRegistrationLedgerEvent({ ...base, snapshotHash: 'a'.repeat(63) }), '长度 63 拒');
});

test('registry 审计视图：hash-only 事件快照继承重放，展示口径与去重前一致', async () => {
  const dir = tmpDir('gw-ledger-view-');
  const regDir = path.join(dir, 'services');
  fs.mkdirSync(regDir, { recursive: true });
  const reg = {
    v: 1, id: 'svc-0768297f65f9', name: 'qq-bridge', kind: 'consumer', transport: 'auto',
    url: 'http://127.0.0.1:3100', platform: 'qq', presets: { qq: 'qq-chat' }, enabled: true,
    secret: 'x'.repeat(20),
  };
  fs.writeFileSync(path.join(regDir, 'svc-0768297f65f9.json'), JSON.stringify(reg));
  const services = createServiceRegistry({
    pipelinesFile: path.join(dir, 'pipelines.json'),
    stateDir: dir,
    registrations: { dir: regDir, ledgerFile: path.join(dir, 'ledger.jsonl'), reloadMs: 0 },
    logger: () => {},
  });
  await services.ready?.();
  const view = services.registrationLedger({ limit: 50 });
  assert.ok(view && view.events.length >= 1);
  // 每个 register 事件都带可展示快照（全量或继承），且脱敏
  for (const ev of view.events) {
    if (ev.action === 'register') {
      assert.ok(ev.snapshot, `事件 ${ev.at} 有展示快照`);
      assert.equal(ev.snapshot.secret, undefined, '脱敏保留');
    }
  }
});
