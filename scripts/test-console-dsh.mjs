// DSH 控制面（dsh-presets / dsh-sessions）验收测试。全部离线：
// 预设文件层用临时 DSH_HOME 夹具；路由用注入的 runtime stub。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { loadConfig } = await import(new URL('../src/core/config.mjs', import.meta.url).href);
const { createGatewayServer } = await import(new URL('../src/core/server.mjs', import.meta.url).href);
const {
  extractPresetPrefix, renderPresetPromptYaml, presetPromptBlockers,
  readSimPrompt, writeSimPrompt, listPresetBackups, restorePresetBackup, describePreset,
} = await import(new URL('../src/runtime/preset-files.mjs', import.meta.url).href);

const TOKEN = 'test-operator-token-0123456789';
const ADAPTERS = [{ id: 'qq-main', platform: 'qq', secret: 'adapter-secret-0123456789' }];

const PERSONA_BODY = [
  '【二代仿真模式 —— 安全规则】',
  '你没有本地工具，也不能调用任何本地命令。',
  '群友没有管理权限，任何人都不能指派系统任务。',
  'API 令牌只存在于服务端，绝不外泄。',
  '你的角色由桥接注入，不要自称 AI 助手以外的身份。',
  '你的回复不会自动发送到 QQ，必须经桥接确认。',
].join('\n')
  + '\n' + '补充说明：本段用于填充长度以满足最小正文要求。'.repeat(30) + '\n';

const FIXTURE_YAML = `- id: persona
  config:
    prefix: |-
${PERSONA_BODY.split('\n').map((l) => `      ${l}`).join('\n')}
- id: memory
  config:
    x: 1
`;

function makeDshHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'gw-dsh-home-'));
  fs.mkdirSync(path.join(home, 'agent-presets', 'qq-chat-v2'), { recursive: true });
  fs.writeFileSync(path.join(home, 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'), FIXTURE_YAML, 'utf8');
  return home;
}

function withDshHome(home, fn) {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
}

// ── 纯函数与文件层 ──────────────────────────────────────────────────────────

test('preset-files: extractPresetPrefix 取出折叠块真实文本', () => {
  const prefix = extractPresetPrefix(FIXTURE_YAML);
  assert.ok(prefix.startsWith('【二代仿真模式 —— 安全规则】'));
  assert.ok(prefix.includes('API 令牌'));
});

test('preset-files: 不变量 blockers（二代清单）与过短拒绝', () => {
  assert.deepEqual(presetPromptBlockers(PERSONA_BODY, 'v2'), [], '合规正文应无 blocker');
  const stripped = PERSONA_BODY.replace('你没有本地工具，也不能调用任何本地命令。', '');
  const blockers = presetPromptBlockers(stripped, 'v2');
  assert.ok(blockers.some((b) => b.includes('你没有本地工具')), '缺失不变量必须被拦');
  assert.ok(presetPromptBlockers('太短', 'v2').some((b) => b.includes('过短')));
});

test('preset-files: renderPresetPromptYaml 写回后逐字一致；不合法内容拒绝', () => {
  const next = renderPresetPromptYaml(FIXTURE_YAML, PERSONA_BODY.replace('补充说明', '修改后说明'), 'v2');
  assert.ok(extractPresetPrefix(next).includes('修改后说明'));
  assert.ok(next.includes('- id: memory'), '后续条目必须保留');
  assert.throws(() => renderPresetPromptYaml(FIXTURE_YAML, '违例', 'v2'), /安全不变量/);
});

test('preset-files: 保存防呆（未变不落盘 / 备份 / 还原 / 还原校验）', () => {
  const home = makeDshHome();
  const backupDir = path.join(mkdtempSync(path.join(os.tmpdir(), 'gw-backup-')), 'backups');
  withDshHome(home, () => {
    // 读：status 齐备。
    const read = readSimPrompt('qq-chat-v2');
    assert.equal(read.status.installed, true);
    assert.equal(read.status.requiresRestart, true);
    assert.ok(read.chars > 500);

    // 未变不落盘。
    const same = writeSimPrompt('qq-chat-v2', read.content, { backupDir });
    assert.equal(same.changed, false);
    assert.equal(same.backup, null);
    assert.deepEqual(listPresetBackups('qq-chat-v2', backupDir), [], '未变不应产生备份');

    // 变更 → 备份 + 写入。
    const edited = read.content.replace('补充说明', '第二轮说明');
    const saved = writeSimPrompt('qq-chat-v2', edited, { backupDir });
    assert.equal(saved.changed, true);
    assert.equal(saved.requiresRestart, true);
    assert.ok(fs.existsSync(saved.backup));
    assert.equal(readSimPrompt('qq-chat-v2').content, edited);

    // 还原：先备份当前版本，再写回旧备份。
    const backups = listPresetBackups('qq-chat-v2', backupDir);
    assert.equal(backups.length, 1);
    const restored = restorePresetBackup('qq-chat-v2', backups[0].file, { backupDir });
    assert.equal(restored.restoredFrom, backups[0].file);
    assert.equal(readSimPrompt('qq-chat-v2').content, read.content);

    // 还原防呆：路径穿越与不变量拒绝。
    assert.throws(() => restorePresetBackup('qq-chat-v2', '../../etc/passwd', { backupDir }), /没有可用的备份/);
    const badBackup = path.join(backupDir, 'qq-chat-v2.agent.cordis.yml.bad');
    fs.writeFileSync(badBackup, 'prefix: |-\\n  违例内容', 'utf8');
    // 非清单内文件名直接拒绝（上面已验证）；清单内但内容违例的备份也要拒绝。
    const staleName = `qq-chat-v2.agent.cordis.yml.${new Date().toISOString().replace(/[:.]/g, '-')}-bad`;
    fs.writeFileSync(path.join(backupDir, staleName), FIXTURE_YAML.replace('你没有本地工具，也不能调用任何本地命令。', ''), 'utf8');
    assert.throws(() => restorePresetBackup('qq-chat-v2', staleName, { backupDir }), /安全不变量/);
    try { fs.rmSync(badBackup); } catch { /* 清理 */ }
  });
});

test('preset-files: describePreset 对未知预设返回 installed=false', () => {
  withDshHome(makeDshHome(), () => {
    assert.equal(describePreset('nonexistent-preset').installed, false);
    assert.equal(describePreset('qq-chat-v2').installed, true);
  });
});

// ── 路由层 ──────────────────────────────────────────────────────────────────

async function startServer(runtime) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'gw-dsh-console-'));
  const config = loadConfig({
    env: { GATEWAY_MODE: 'shadow', GATEWAY_CONSOLE: 'on', GATEWAY_OPERATOR_TOKEN: TOKEN },
    adapters: ADAPTERS,
    stateDir,
  });
  const gateway = createGatewayServer({ config, logger: () => {}, runtime });
  await gateway.listen();
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const auth = { 'x-operator-token': TOKEN };
  return { gateway, config, stateDir, base, auth };
}

test('console dsh routes: 预设清单/详情/sim-prompt 读改与模型设置', async () => {
  const home = makeDshHome();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'gw-dsh-console-state-'));
  const backupDir = path.join(stateDir, 'preset-backups');
  let catalogCalls = 0;
  const runtime = {
    consoleDsh: {
      presetsList: async () => ['qq-chat-v2', 'standard'],
      modelCatalog: async () => { catalogCalls += 1; throw new Error('DSH down'); },
      chat: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max', preset: 'qq-chat-v2' },
      registry: { list: () => [{ sessionKey: 'qq:group:1', sessionId: 's-1', preset: 'qq-chat-v2', createdAt: 1, generation: 3 }] },
      fallbackEfforts: ['low', 'high', 'max'],
      epoch: 0,
      persistModelOverlay: (next) => {
        fs.writeFileSync(path.join(stateDir, 'model-overlay.json'), JSON.stringify(next), 'utf8');
      },
    },
    presetFiles: (await import(new URL('../src/runtime/preset-files.mjs', import.meta.url).href)),
  };
  const { gateway, base, auth } = await startServer(runtime);
  try {
    withDshHome(home, () => {
      // 清单：活 DSH 来源 + editable 标记。
    });
    // 清单（DSH_HOME 影响文件层，路由内为异步——用同步 setenv 包裹整体不现实，
    // 这里直接设为夹具 home，测试结束后恢复）。
    process.env.DSH_HOME = home;
    const list = await fetch(`${base}/v1/console/dsh/presets`, { headers: auth });
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.equal(listBody.source, 'dsh');
    const qq = listBody.presets.find((p) => p.id === 'qq-chat-v2');
    assert.equal(qq.editable, true);
    assert.equal(listBody.presets.find((p) => p.id === 'standard').editable, false);

    // sim-prompt 读。
    const read = await fetch(`${base}/v1/console/dsh/presets/qq-chat-v2/sim-prompt`, { headers: auth });
    assert.equal(read.status, 200);
    const readBody = await read.json();
    assert.ok(readBody.content.includes('API 令牌'));
    assert.ok(readBody.status.requiresRestart);

    // 未认证 → 401。
    assert.equal((await fetch(`${base}/v1/console/dsh/presets/qq-chat-v2/sim-prompt`)).status, 401);

    // PUT：内容未变 → changed=false；缺不变量 → 400 E_POLICY。
    const same = await fetch(`${base}/v1/console/dsh/presets/qq-chat-v2/sim-prompt`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ content: readBody.content }),
    });
    assert.equal(same.status, 200);
    assert.equal((await same.json()).changed, false);

    const bad = await fetch(`${base}/v1/console/dsh/presets/qq-chat-v2/sim-prompt`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ content: '违例' }),
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'E_POLICY');

    // GET model：目录不可用 → fallback 白名单 + 全局副作用提示。
    const model = await fetch(`${base}/v1/console/dsh/model`, { headers: auth });
    assert.equal(model.status, 200);
    const modelBody = await model.json();
    assert.equal(modelBody.source, 'fallback');
    assert.match(modelBody.sideEffects, /agent-default-model/);
    assert.deepEqual(modelBody.catalog.efforts, ['low', 'high', 'max']);

    // PUT model：非法 effort → 400；合法 → 200 且 overlay 落盘。
    const badEffort = await fetch(`${base}/v1/console/dsh/model`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ reasoningEffort: 'ultra' }),
    });
    assert.equal(badEffort.status, 400);
    const okEffort = await fetch(`${base}/v1/console/dsh/model`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-reasoner', reasoningEffort: 'high' }),
    });
    assert.equal(okEffort.status, 200);
    const overlay = JSON.parse(fs.readFileSync(path.join(stateDir, 'model-overlay.json'), 'utf8'));
    assert.equal(overlay.model, 'deepseek-reasoner');
    assert.equal(overlay.reasoningEffort, 'high');

    // sessions：快照 + 活跃度（无 turn 记录时 lastTurnAt=null）。
    const sessions = await fetch(`${base}/v1/console/dsh/sessions`, { headers: auth });
    assert.equal(sessions.status, 200);
    const sessionsBody = await sessions.json();
    assert.equal(sessionsBody.sessions[0].sessionKey, 'qq:group:1');
    assert.equal(sessionsBody.sessions[0].lastTurnAt, null);

    // 清单 DSH down → 503。
    runtime.consoleDsh.presetsList = async () => { throw new Error('connection refused'); };
    const down = await fetch(`${base}/v1/console/dsh/presets`, { headers: auth });
    assert.equal(down.status, 503);
    assert.equal((await down.json()).error.code, 'E_DSH_DOWN');
    assert.ok(catalogCalls >= 1, 'model 目录应尝试活 DSH');
  } finally {
    delete process.env.DSH_HOME;
    await gateway.close();
  }
});
