/**
 * init-env 专项（凭据文件单源版）：
 *   - operator-token / mcp-bus.secret 两份凭据文件的生成与幂等；
 *   - .env 里退役 token 键（GATEWAY_OPERATOR_TOKEN / GATEWAY_MCP_*）的就地清理；
 *   - 过短密钥重新生成、--dry-run / --json 行为。
 *
 * 全部在临时目录跑（--env / --state 指过去），不碰仓库真实 .env。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const SCRIPT = new URL('./init-env.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-init-'));
}

function runInit({ envFile, stateDir, json = false, dryRun = false }) {
  const args = [SCRIPT, '--env', envFile, '--state', stateDir];
  if (json) args.push('--json');
  if (dryRun) args.push('--dry-run');
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function readEnv(file) {
  const text = fs.readFileSync(file, 'utf8');
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) map.set(match[1], match[2].trim());
  }
  return { text, map };
}

test('首跑：两份凭据文件生成（operator token 明文返回一次），.env 不承载任何 token', () => {
  const root = tmpRoot();
  const envFile = path.join(root, '.env');
  const stateDir = path.join(root, 'state');
  const out = runInit({ envFile, stateDir, json: true });
  assert.equal(out.code, 0, out.stderr);

  const payload = JSON.parse(out.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.mcpSecretGenerated, true);
  assert.equal(payload.operatorTokenGenerated, true);
  assert.ok(payload.operatorToken.length >= 20, 'operator token 需明文返回（登录控制台用）');
  assert.equal(payload.removedKeys.length, 0);

  // mcp-bus.secret：hex48。
  const secret = fs.readFileSync(path.join(stateDir, 'mcp-bus.secret'), 'utf8').trim();
  assert.match(secret, /^[0-9a-f]{48}$/);
  // operator-token：满足控制台凭据词法。
  assert.match(fs.readFileSync(path.join(stateDir, 'operator-token'), 'utf8').trim(), /^[\w-]{16,128}$/);
});

test('幂等：第二次执行不重新生成、不改字节、不再明文输出 operator token', () => {
  const root = tmpRoot();
  const envFile = path.join(root, '.env');
  const stateDir = path.join(root, 'state');
  assert.equal(runInit({ envFile, stateDir, json: true }).code, 0);
  const before = fs.readFileSync(path.join(stateDir, 'operator-token'), 'utf8');

  const second = runInit({ envFile, stateDir, json: true });
  assert.equal(second.code, 0, second.stderr);
  const payload = JSON.parse(second.stdout);
  assert.equal(payload.mcpSecretGenerated, false);
  assert.equal(payload.operatorTokenGenerated, false);
  assert.equal('operatorToken' in payload, false, '已存在的 operator token 不得再次明文输出');
  assert.equal(fs.readFileSync(path.join(stateDir, 'operator-token'), 'utf8'), before, '凭据文件不应变化');
});

test('.env 残留退役 token 键：就地删除（含注释行），其余行逐字保留', () => {
  const root = tmpRoot();
  const envFile = path.join(root, '.env');
  const stateDir = path.join(root, 'state');
  fs.writeFileSync(envFile, [
    '# 用户手写注释：不要动',
    'GATEWAY_PORT=7777',
    'GATEWAY_OPERATOR_TOKEN=my-own-operator-token-0123456789',
    '# GATEWAY_MCP_BUS_TOKEN=',
    '',
    'CUSTOM_KEY=keep-me',
  ].join('\n'), 'utf8');

  const out = runInit({ envFile, stateDir, json: true });
  assert.equal(out.code, 0, out.stderr);
  const payload = JSON.parse(out.stdout);
  assert.deepEqual(payload.removedKeys.sort(), ['GATEWAY_MCP_BUS_TOKEN', 'GATEWAY_OPERATOR_TOKEN']);
  assert.equal(payload.envChanged, true);

  const { text } = readEnv(envFile);
  assert.match(text, /# 用户手写注释：不要动/);
  assert.match(text, /^GATEWAY_PORT=7777$/m);
  assert.match(text, /^CUSTOM_KEY=keep-me$/m);
  assert.doesNotMatch(text, /GATEWAY_OPERATOR_TOKEN/);
  assert.doesNotMatch(text, /GATEWAY_MCP_BUS_TOKEN/);
});

test('退役旧名键（GATEWAY_MCP_TOKEN[_FILE]）同样被就地删除', () => {
  const root = tmpRoot();
  const envFile = path.join(root, '.env');
  const stateDir = path.join(root, 'state');
  fs.writeFileSync(envFile, [
    `GATEWAY_MCP_TOKEN=${'c'.repeat(32)}`,
    `GATEWAY_MCP_TOKEN_FILE=${path.join(stateDir, 'mcp-bus.secret')}`,
    '',
  ].join('\n'), 'utf8');

  const out = runInit({ envFile, stateDir });
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /已从 \.env 移除退役 token 键：GATEWAY_MCP_TOKEN/);
  const { text } = readEnv(envFile);
  assert.doesNotMatch(text, /^GATEWAY_MCP_TOKEN=/m);
  assert.doesNotMatch(text, /^GATEWAY_MCP_TOKEN_FILE=/m);
});

test('mcp-bus.secret 过短：重新生成并告警', () => {
  const root = tmpRoot();
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'mcp-bus.secret'), 'short\n', 'utf8');

  // 告警走 stderr（--json 下静默），所以这里用非 json 模式断言。
  const out = runInit({ envFile: path.join(root, '.env'), stateDir });
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /长度不足 16 字符/);
  assert.match(fs.readFileSync(path.join(stateDir, 'mcp-bus.secret'), 'utf8').trim(), /^[0-9a-f]{48}$/);
});

test('--dry-run 只报告不落盘', () => {
  const root = tmpRoot();
  const envFile = path.join(root, '.env');
  fs.writeFileSync(envFile, 'GATEWAY_OPERATOR_TOKEN=to-be-removed-0123456789\n', 'utf8');
  const stateDir = path.join(root, 'state');
  const out = runInit({ envFile, stateDir, json: true, dryRun: true });
  assert.equal(out.code, 0, out.stderr);
  const payload = JSON.parse(out.stdout);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.mcpSecretGenerated, true);
  assert.equal(payload.operatorTokenGenerated, true);
  assert.equal(fs.existsSync(path.join(stateDir, 'mcp-bus.secret')), false);
  assert.equal(fs.existsSync(path.join(stateDir, 'operator-token')), false);
  // .env 同样不动（退役键仍在）。
  assert.match(fs.readFileSync(envFile, 'utf8'), /GATEWAY_OPERATOR_TOKEN=/);
});
