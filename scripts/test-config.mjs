// 配置 fail-closed 用例：数值型环境变量非法值必须挡在启动，而不是变成 NaN
// 让重放窗/超时/TTL 静默失效。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/core/config.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-config-test-'));
}

function load(extra = {}) {
  return loadConfig({
    // console 关掉，避免在临时目录之外生成 operator token。
    env: { GATEWAY_MODE: 'off', GATEWAY_CONSOLE: 'off', ...extra },
    adapters: [],
    stateDir: tmpDir(),
  });
}

test('数值环境变量：非法值启动即失败（NaN / 越界 / 单位混写）', () => {
  const cases = [
    ['GATEWAY_REPLAY_WINDOW_MS', 'abc'],
    ['GATEWAY_REPLAY_WINDOW_MS', '0'],
    ['GATEWAY_TURN_TIMEOUT_MS', '300s'],
    ['GATEWAY_TOOL_CALL_TIMEOUT_MS', '-1'],
    ['GATEWAY_TOOL_MAX_CALLS_PER_TURN', '9999'],
    ['GATEWAY_CONSOLE_SESSION_TTL_MS', '0'],
    ['GATEWAY_DSH_TIMEOUT_MS', 'NaN'],
  ];
  for (const [key, value] of cases) {
    assert.throws(
      () => load({ [key]: value }),
      /must be an integer in \[\d+, \d+\]/,
      `${key}=${value} 应当被拒绝`,
    );
  }
});

test('数值环境变量：缺省与空串使用内置默认值', () => {
  const defaults = load();
  assert.equal(defaults.replayWindowMs, 5 * 60 * 1000);
  assert.equal(defaults.chat.turnTimeoutMs, 300_000);
  assert.equal(defaults.tools.callTimeoutMs, 20_000);
  assert.equal(defaults.tools.maxCallsPerTurn, 30);
  assert.equal(defaults.console.sessionTtlMs, 12 * 60 * 60 * 1000);
  assert.equal(defaults.dsh.timeoutMs, 30_000);

  const empty = load({
    GATEWAY_REPLAY_WINDOW_MS: '',
    GATEWAY_TURN_TIMEOUT_MS: '',
    GATEWAY_TOOL_CALL_TIMEOUT_MS: '',
  });
  assert.equal(empty.replayWindowMs, 5 * 60 * 1000, '空串按缺省处理');
  assert.equal(empty.chat.turnTimeoutMs, 300_000);
});

test('数值环境变量：边界值可接受', () => {
  const cfg = load({
    GATEWAY_REPLAY_WINDOW_MS: '60000',
    GATEWAY_TURN_TIMEOUT_MS: '60000',
    GATEWAY_TOOL_CALL_TIMEOUT_MS: '5000',
  });
  assert.equal(cfg.replayWindowMs, 60_000);
  assert.equal(cfg.chat.turnTimeoutMs, 60_000);
  assert.equal(cfg.tools.callTimeoutMs, 5000);
});
