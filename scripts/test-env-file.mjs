/**
 * .env 装载专项：parseEnvFile 纯解析 + loadEnvInto 优先级/缺文件/坏行语义。
 * 覆盖计划钉住的五类边界：真实 env 优先、引号剥离、坏行跳过、缺文件静默、路径覆盖。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseEnvFile, loadEnvInto } from '../src/core/env-file.mjs';

function tmpFile(content, name = '.env') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-env-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

test('parseEnvFile：注释/空行/export 前缀/行尾注释', () => {
  const { entries, badLines } = parseEnvFile([
    '# 全注释行',
    '',
    'GATEWAY_PORT=7190',
    'export GATEWAY_HOST=127.0.0.1',
    'GATEWAY_MODEL=deepseek-flash # 行尾注释',
    'QUOTED="a # not comment"',
    "SINGLE='带 空格'",
    'KEY_WITH_EQUALS=a=b=c',
  ].join('\n'));
  assert.equal(badLines, 0);
  assert.deepEqual(Object.fromEntries(entries), {
    GATEWAY_PORT: '7190',
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_MODEL: 'deepseek-flash',
    QUOTED: 'a # not comment',
    SINGLE: '带 空格',
    KEY_WITH_EQUALS: 'a=b=c',
  });
});

test('parseEnvFile：坏行计数（无等号/空键/非法键名），不影响其余行', () => {
  const { entries, badLines } = parseEnvFile([
    'NO_EQUALS_SIGN',
    '=EMPTY_KEY',
    'BAD-KEY=x',
    'GOOD=1',
  ].join('\n'));
  assert.equal(badLines, 3);
  assert.deepEqual(entries, [['GOOD', '1']]);
});

test('loadEnvInto：真实环境变量优先（不覆盖已定义键）', () => {
  const file = tmpFile('A=from-file\nB=from-file\n');
  const target = { A: 'from-real-env' };
  const r = loadEnvInto(target, file, { logger: () => {} });
  assert.equal(r.loaded, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.missing, false);
  assert.equal(target.A, 'from-real-env');
  assert.equal(target.B, 'from-file');
});

test('loadEnvInto：缺文件静默（missing:true，不抛错）', () => {
  const r = loadEnvInto({}, path.join(os.tmpdir(), `gw-missing-${Date.now()}`, '.env'), { logger: () => {} });
  assert.equal(r.missing, true);
  assert.equal(r.loaded, 0);
});

test('loadEnvInto：坏行留痕跳过，其余照常装载', () => {
  const warns = [];
  const file = tmpFile('OK=1\nBROKEN_LINE\n');
  const r = loadEnvInto({}, file, { logger: (m) => warns.push(m) });
  assert.equal(r.loaded, 1);
  assert.equal(r.badLines, 1);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /1 行无法解析/);
});

test('loadEnvInto：引号壳剥离（含 # 的值不被当注释切）', () => {
  const file = tmpFile('TOKEN="abc#123"\nURL=\'http://x/#frag\'\n');
  const target = {};
  loadEnvInto(target, file, { logger: () => {} });
  assert.equal(target.TOKEN, 'abc#123');
  assert.equal(target.URL, 'http://x/#frag');
});
