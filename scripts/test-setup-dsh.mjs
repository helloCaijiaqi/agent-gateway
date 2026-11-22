/**
 * setup:dsh 专项：块计划（create/replace/noop/skip-manual/broken）、字节保真、
 * 备份轮转、注册状态判定，以及 CLI 的 dry-run / json / 前置校验。
 *
 * 所有落盘都在临时目录，绝不触碰真实 ~/.dsh。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BLOCK_BEGIN,
  BLOCK_END,
  buildMcpBusBlock,
  resolveDshPatchFile,
  planPatch,
  applyPatch,
  checkRegistration,
  readPatchText,
} from '../src/core/dsh-patch.mjs';

// dsh-bundle（物化/链接/profile package.json）的测试随该模块迁到了 qq-bridge（2026-11-16）。

/** DSH 侧包名由平台注册表给出（qq → qq-agent-presets），测试里写一份便于断言。 */
const BUNDLE = 'qq-agent-presets';

const CLI = new URL('./setup-dsh.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-dsh-'));
}

function block(overrides = {}) {
  return buildMcpBusBlock({
    nodePath: 'C:\\node\\node.exe',
    mcpBusPath: 'C:\\agent-gateway\\src\\mcp-bus.mjs',
    gatewayUrl: 'http://127.0.0.1:7190',
    tokenFile: 'C:\\agent-gateway\\state\\gateway\\mcp-bus.secret',
    ...overrides,
  });
}

test('resolveDshPatchFile：默认 web profile，file 优先', () => {
  assert.equal(
    resolveDshPatchFile({ home: 'C:\\Users\\x' }),
    path.join('C:\\Users\\x', '.dsh', 'profiles', 'web', 'cordis.patch.yml'),
  );
  assert.match(
    resolveDshPatchFile({ home: 'C:\\Users\\x', profile: 'headless' }),
    /headless[\\/]cordis\.patch\.yml$/,
  );
  assert.equal(resolveDshPatchFile({ home: 'C:\\Users\\x', file: 'D:\\a.yml' }), 'D:\\a.yml');
});

test('planPatch：文件不存在 → create；已有其它条目 → 追加且原内容逐字保留', () => {
  assert.equal(planPatch(null, block()).action, 'create');

  const original = "- id: ui-settings-general\n  name: 'x'\n";
  const planned = planPatch(original, block());
  assert.equal(planned.action, 'create');
  assert.equal(planned.reason, 'not-registered');
  assert.ok(planned.text.startsWith(original), '原有内容必须逐字保留前缀');
  assert.ok(planned.text.includes(BLOCK_BEGIN) && planned.text.includes(BLOCK_END));
});

test('planPatch：块内容一致 → noop；漂移 → replace 且只留一份块', () => {
  const text = `- id: a\n\n${block()}`;
  assert.equal(planPatch(text, block()).action, 'noop');

  const drifted = block({ mcpBusPath: 'D:\\moved\\src\\mcp-bus.mjs' });
  const planned = planPatch(text, drifted);
  assert.equal(planned.action, 'replace');
  // 只应剩一块：BEGIN 出现一次。
  assert.equal(planned.text.split(BLOCK_BEGIN).length - 1, 1);
  assert.ok(planned.text.includes('D:\\moved\\src\\mcp-bus.mjs'));
  assert.ok(planned.text.startsWith('- id: a'));
});

test('planPatch：手工登记过 mcp-bus（无 marker）→ skip-manual，不写第二份', () => {
  const manual = "- id: mcp-manual\n  config:\n    args:\n      - 'C:\\x\\src\\mcp-bus.mjs'\n";
  const planned = planPatch(manual, block());
  assert.equal(planned.action, 'skip-manual');
  assert.equal(planned.text, manual);
});

test('planPatch：marker 只剩一半 → broken（绝不猜边界）', () => {
  assert.equal(planPatch(`- id: a\n${BLOCK_BEGIN}\n`, block()).action, 'broken');
  assert.equal(planPatch(`- id: a\n${BLOCK_END}\n`, block()).action, 'broken');
});

test('applyPatch：字节保真（含非 UTF-8 字节）+ 备份', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'cordis.patch.yml');
  // 0x80 0xFF 不是合法 UTF-8：任何「解码再编码」都会把它们改掉。
  const raw = Buffer.concat([
    Buffer.from("- id: a\n# ", 'utf8'),
    Buffer.from([0x80, 0xff, 0x0a]),
  ]);
  fs.writeFileSync(file, raw);

  const planned = planPatch(readPatchText(file), block());
  const result = applyPatch(file, planned);
  assert.equal(result.written, true);
  assert.ok(result.backupPath && fs.existsSync(result.backupPath));

  const after = fs.readFileSync(file);
  assert.deepEqual(after.subarray(0, raw.length), raw, '块之前的字节必须完全不变');
  assert.ok(after.toString('latin1').includes('mcp-agent-gateway'));
});

test('applyPatch：noop 不写盘；备份只保留最近 3 份', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'cordis.patch.yml');
  fs.writeFileSync(file, '- id: a\n');
  const noop = applyPatch(file, { action: 'noop', text: 'x' });
  assert.equal(noop.written, false);

  for (let i = 0; i < 5; i += 1) {
    applyPatch(file, planPatch(readPatchText(file), block({ gatewayUrl: `http://127.0.0.1:${7000 + i}` })));
  }
  const backups = fs.readdirSync(dir).filter((name) => name.includes('.bak-'));
  assert.equal(backups.length, 3, `备份应轮转到 3 份，实际 ${backups.length}`);
});

test('checkRegistration：missing / not-registered / ok / manual / broken', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'cordis.patch.yml');
  assert.deepEqual(checkRegistration(file), { registered: false, reason: 'file-missing' });

  fs.writeFileSync(file, '- id: a\n');
  assert.equal(checkRegistration(file).reason, 'not-registered');

  fs.writeFileSync(file, `- id: a\n\n${block()}`);
  assert.deepEqual(checkRegistration(file), { registered: true, reason: 'ok' });

  fs.writeFileSync(file, "- id: m\n  args: ['C:\\x\\mcp-bus.mjs']\n");
  assert.deepEqual(checkRegistration(file), { registered: true, reason: 'manual-registration' });

  fs.writeFileSync(file, `${BLOCK_BEGIN}\n`);
  assert.equal(checkRegistration(file).reason, 'unbalanced-markers');
});

function runCli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('CLI：缺 token 文件 → 退出码 1 并给出可执行提示', () => {
  const dir = tmpDir();
  const out = runCli(['--file', path.join(dir, 'cordis.patch.yml'), '--token-file', path.join(dir, 'nope')]);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /npm run env:init/);
});

test('CLI：--dry-run 不落盘；--json 给出 action/registered；实写后第二次为 noop', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'cordis.patch.yml');
  const token = path.join(dir, 'mcp-bus.secret');
  fs.writeFileSync(file, '- id: a\n');
  fs.writeFileSync(token, `${'a'.repeat(48)}\n`);

  // 不带任何 bundle 旗标：本脚本现在只管 MCP 块（预设安装已迁到 qq-bridge）。
  const dry = runCli(['--file', file, '--token-file', token, '--dry-run', '--json']);
  assert.equal(dry.code, 0, dry.stderr);
  const dryPayload = JSON.parse(dry.stdout);
  assert.equal(dryPayload.action, 'create');
  assert.equal(dryPayload.written, false);
  assert.ok(dryPayload.block.includes('mcp-agent-gateway'));
  assert.equal(fs.readFileSync(file, 'utf8'), '- id: a\n', 'dry-run 不得改写文件');

  const first = runCli(['--file', file, '--token-file', token, '--json']);
  const firstPayload = JSON.parse(first.stdout);
  assert.equal(firstPayload.action, 'create');
  assert.equal(firstPayload.registered, true);
  assert.ok(fs.existsSync(firstPayload.backupPath));

  const second = runCli(['--file', file, '--token-file', token, '--json']);
  const secondPayload = JSON.parse(second.stdout);
  assert.equal(secondPayload.action, 'noop');
  assert.equal(secondPayload.written, false);
});

// ── preset bundle 安装（dsh-bundle.mjs）────────────────────────────────────────
