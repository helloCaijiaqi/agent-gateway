// 配置 fail-closed 用例：数值型环境变量非法值必须挡在启动，而不是变成 NaN
// 让重放窗/超时/TTL 静默失效。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/core/config.mjs';
const { seedBusSecret } = await import(new URL('./support/consumer-registration.mjs', import.meta.url).href);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-config-test-'));
}

function load(extra = {}, { stateDir } = {}) {
  return loadConfig({
    // console 关掉，避免在临时目录之外生成 operator token。
    env: { GATEWAY_MODE: 'off', GATEWAY_CONSOLE: 'off', ...extra },
    stateDir: stateDir ?? tmpDir(),
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

test('MCP 薄壳密钥：env 键（新名/旧名/FILE 变体）全部退役拒载；busSecret 只认 mcp-bus.secret 文件', () => {
  // env 通道整体退役（读到即拒载，与 GATEWAY_CONTEXT 同范式）。
  for (const key of ['GATEWAY_MCP_TOKEN', 'GATEWAY_MCP_BUS_TOKEN', 'GATEWAY_MCP_TOKEN_FILE', 'GATEWAY_MCP_BUS_TOKEN_FILE']) {
    assert.throws(
      () => load({ [key]: 'a'.repeat(48) }),
      new RegExp(`${key} retired: the mcp-bus shared secret now lives ONLY in`),
      `${key} 应被拒载`,
    );
  }
  // 文件单源：预置 <stateDir>/mcp-bus.secret → busSecret 取文件值。
  const dir = tmpDir();
  seedBusSecret(dir, 'b'.repeat(48));
  const cfg = load({ GATEWAY_TOOLS: 'on' }, { stateDir: dir });
  assert.equal(cfg.tools.mode, 'on');
  assert.equal(cfg.tools.busSecret, 'b'.repeat(48));
  // GATEWAY_TOOLS=on 且文件缺失/过短 → fail-closed，文案指向 env:init。
  assert.throws(
    () => load({ GATEWAY_TOOLS: 'on' }, { stateDir: tmpDir() }),
    /mcp-bus\.secret[\s\S]*run "npm run env:init"/,
  );
  const shortDir = tmpDir();
  // 夹具拒绝过短值：这里就是要测「文件里是过短密钥」，直接落盘。
  fs.writeFileSync(path.join(shortDir, 'mcp-bus.secret'), 'short\n', 'utf8');
  assert.throws(
    () => load({ GATEWAY_TOOLS: 'on' }, { stateDir: shortDir }),
    /file missing or too short/,
  );
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

test('memory save：退役的 GATEWAY_MEMORY_INGEST* 只记录告警，不致命（存量 .env 平滑升级）', () => {
  const cfg = load({
    GATEWAY_MEMORY_SAVE: 'on',
    GATEWAY_MEMORY_INGEST: 'on',
    GATEWAY_MEMORY_INGEST_WINDOW_MS: '30000',
    GATEWAY_MEMORY_INGEST_URL: 'http://127.0.0.1:7181',
    GATEWAY_MEMORY_INGEST_TOKEN: 'x'.repeat(32),
    GATEWAY_MEMORY_INGEST_TOKEN_FILE: 'token.txt',
    GATEWAY_MEMORY_INGEST_TOKEN_ENV: 'MEM_TOKEN',
  });
  assert.equal(cfg.memorySave.mode, 'on');
  assert.deepEqual(cfg.memorySave.retired, [
    'GATEWAY_MEMORY_INGEST',
    'GATEWAY_MEMORY_INGEST_WINDOW_MS',
    'GATEWAY_MEMORY_INGEST_URL',
    'GATEWAY_MEMORY_INGEST_TOKEN',
    'GATEWAY_MEMORY_INGEST_TOKEN_FILE',
    'GATEWAY_MEMORY_INGEST_TOKEN_ENV',
  ]);
  // 老配置不再进 config：没有 url/token 字段，地址与密钥只来自登记目录。
  assert.equal('url' in cfg.memorySave, false);
  assert.equal('token' in cfg.memorySave, false);
});

test('memory save：默认 off、serviceId 空 = selectMemoryService 自动选路；缓冲阈值有默认值', () => {
  const cfg = load();
  assert.equal(cfg.memorySave.mode, 'off');
  assert.equal(cfg.memorySave.serviceId, null);
  assert.deepEqual(cfg.memorySave.retired, []);
  assert.equal(cfg.memorySave.idleMs, 3_600_000);
  assert.equal(cfg.memorySave.maxMessages, 200);
  assert.equal(cfg.memorySave.maxChars, 20_000);
  assert.ok(cfg.memorySave.bufferDir.endsWith('session-buffer'));
  // mode=on 不读任何 ingest token：缺 token 也必须能启动。
  assert.equal(load({ GATEWAY_MEMORY_SAVE: 'on' }).memorySave.mode, 'on');
});

test('memory save：阈值与 serviceId 的边界校验', () => {
  assert.equal(load({ GATEWAY_MEMORY_SAVE_IDLE_MS: '5000' }).memorySave.idleMs, 5000);
  assert.equal(load({ GATEWAY_MEMORY_SAVE_MAX_MESSAGES: '50' }).memorySave.maxMessages, 50);
  assert.equal(load({ GATEWAY_MEMORY_SAVE_MAX_CHARS: '5000' }).memorySave.maxChars, 5000);
  assert.throws(() => load({ GATEWAY_MEMORY_SAVE_IDLE_MS: '500' }), /GATEWAY_MEMORY_SAVE_IDLE_MS/);
  assert.throws(() => load({ GATEWAY_MEMORY_SAVE_MAX_MESSAGES: '0' }), /GATEWAY_MEMORY_SAVE_MAX_MESSAGES/);
  assert.throws(() => load({ GATEWAY_MEMORY_SAVE: 'maybe' }), /GATEWAY_MEMORY_SAVE/);
  assert.equal(load({ GATEWAY_MEMORY_SERVICE: 'a1b2c3d4' }).memorySave.serviceId, 'a1b2c3d4');
  assert.throws(() => load({ GATEWAY_MEMORY_SERVICE: 'Bad Id' }), /GATEWAY_MEMORY_SERVICE/);
});

test('消费端身份：env 单适配器三元组已退役，读到即拒载并给登记目录迁移文案', () => {
  for (const key of ['GATEWAY_ADAPTER_ID', 'GATEWAY_ADAPTER_PLATFORM', 'GATEWAY_SECRET', 'GATEWAY_DISABLED_ADAPTERS']) {
    assert.throws(
      () => load({ [key]: 'a'.repeat(20) }),
      /retired[\s\S]*registration dir[\s\S]*secrets:gen/,
      `${key} 应当被拒绝`,
    );
  }
  // 拒载发生在「至少一个消费端」前置校验之前：错误文案必须指向退役变量，而不是“没有消费端”。
  assert.throws(() => load({ GATEWAY_MODE: 'on', GATEWAY_ADAPTER_ID: 'qq-main' }), /GATEWAY_ADAPTER_ID retired/);
});

test('消费端身份：adapters.json 已退役，文件存在即拒载并给逐条迁移文案', () => {
  const stateDir = tmpDir();
  fs.writeFileSync(path.join(stateDir, 'adapters.json'), JSON.stringify({ adapters: [] }));
  assert.throws(
    () => loadConfig({ env: { GATEWAY_MODE: 'off', GATEWAY_CONSOLE: 'off' }, stateDir }),
    /adapters\.json retired[\s\S]*kind="consumer"[\s\S]*delete adapters\.json/,
  );
});

test('消费端身份：mode≠off 且登记目录为空 → 启动放行（校验挪到切换点）', () => {
  // 2026-11-16 常驻装配改造：mode 变成请求期活读门禁，on + 零消费端启动合法
  // （消息面武装但无人能入站，main 打告警）。fail-closed 校验链（消费端非空 +
  // 编排键有主 + 步骤名合法）在 POST /v1/console/mode 切 on 时执行（见
  // test-console-mode.mjs），错误当场 400 回给 UI。
  const cfg = load({ GATEWAY_MODE: 'on' });
  assert.equal(cfg.mode, 'on');
});
