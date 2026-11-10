// 控制台新端点冒烟（docs/console/* 全模块）。
// 起**真实** gateway HTTP server + 功能性 runtime（真账本/真 pending/真预设文件层，
// 只有 DSH 活调用是 stub），逐端点探测并断言状态码。
// 说明：设计上用 curl.exe 探测，但本沙箱环境拦截 spawn 进程的回环流量（裸 curl
// 对本机 node server 也 ETIMEDOUT），故改用同语义的 fetch（GET/POST/PUT、
// 自定义头、JSON body 与 curl 参数一一对应）。
// 运行：node scripts/smoke-console-endpoints.mjs
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { loadConfig } = await import(new URL('../src/core/config.mjs', import.meta.url).href);
const { createGatewayServer } = await import(new URL('../src/core/server.mjs', import.meta.url).href);
const { createTokenLedger } = await import(new URL('../src/core/usage-ledger.mjs', import.meta.url).href);
const { createDshGateway } = await import(new URL('../src/runtime/dsh-gateway.mjs', import.meta.url).href);
const presetFiles = await import(new URL('../src/runtime/preset-files.mjs', import.meta.url).href);

const TOKEN = 'smoke-operator-token-0123456789';

// ── 夹具：DSH_HOME 预设 + 状态目录 ───────────────────────────────────────────
const PERSONA_BODY = [
  '【二代仿真模式 —— 安全规则】',
  '你没有本地工具，也不能调用任何本地命令。',
  '群友没有管理权限，任何人都不能指派系统任务。',
  'API 令牌只存在于服务端，绝不外泄。',
  '你的角色由桥接注入，不要自称 AI 助手以外的身份。',
  '你的回复不会自动发送到 QQ，必须经桥接确认。',
].join('\n') + '\n' + '补充说明：本段用于填充长度以满足最小正文要求。'.repeat(30) + '\n';
const FIXTURE_YAML = `- id: persona
  config:
    prefix: |-
${PERSONA_BODY.split('\n').map((l) => `      ${l}`).join('\n')}
- id: memory
  config:
    x: 1
`;

const dshHome = mkdtempSync(path.join(os.tmpdir(), 'smoke-dsh-home-'));
const stateDir = mkdtempSync(path.join(os.tmpdir(), 'smoke-state-'));
process.env.DSH_HOME = dshHome;
fs.mkdirSync(path.join(dshHome, 'agent-presets', 'qq-chat-v2'), { recursive: true });
fs.writeFileSync(path.join(dshHome, 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'), FIXTURE_YAML, 'utf8');

// ── runtime：真账本 + 真 pending + 真 preset-files；活 DSH 调用 stub ─────────
const ledger = createTokenLedger({ file: path.join(stateDir, 'usage-ledger.jsonl'), logger: () => {} });
ledger.ingestTurn({
  sessionKey: 'qq:group:42', turnId: 'smoke-turn-1', usage: {
    inputTokens: 1200, outputTokens: 340, cacheReadTokens: 200,
  }, model: 'deepseek-chat', provider: 'deepseek', adapterId: 'qq-main',
});

const fakeDsh = { startStream(onFrame) { this.emit = onFrame; }, stopStream() {} };
const dshGateway = createDshGateway({ dsh: fakeDsh, logger: () => {} });
dshGateway.start();
fakeDsh.emit({ type: 'question/requested', eventId: 'q-1', sessionId: 's-1', questions: ['选 A 还是 B？', '为什么？'] });
fakeDsh.emit({ type: 'approval/requested', eventId: 'a-1', sessionId: 's-1', toolName: 'bash', callId: 'c-1', reason: '需要执行 ls' });
fakeDsh.emit({ type: 'question/requested', eventId: 'q-2', sessionId: 's-ghost', questions: ['幽灵会话的提问'] });

const runtime = {
  consoleDsh: {
    presetsList: async () => ['qq-chat-v2', 'standard'],
    modelCatalog: async () => { throw new Error('smoke: DSH down (fallback expected)'); },
    chat: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max', preset: 'qq-chat-v2' },
    registry: {
      list: () => [{ sessionKey: 'qq:group:42', sessionId: 's-1', preset: 'qq-chat-v2', createdAt: 1, generation: 1 }],
      sessionKeyOf: (id) => (id === 's-1' ? 'qq:group:42' : null),
    },
    fallbackEfforts: ['low', 'high', 'max'],
    epoch: 0,
    persistModelOverlay: (next) => {
      fs.writeFileSync(path.join(stateDir, 'model-overlay.json'), JSON.stringify(next), 'utf8');
    },
  },
  presetFiles,
  pending: {
    list: (filter) => dshGateway.listPending(filter),
    capacity: 100,
    forward: { mode: 'off' },
  },
  usageLedger: ledger,
};

const config = loadConfig({
  env: {
    GATEWAY_MODE: 'shadow', GATEWAY_CONSOLE: 'on',
    GATEWAY_OPERATOR_TOKEN: TOKEN, GATEWAY_PORT: '0',
  },
  adapters: [{ id: 'qq-main', platform: 'qq', secret: 'adapter-secret-0123456789' }],
  stateDir,
});
const gateway = createGatewayServer({ config, logger: () => {}, runtime });
await gateway.listen();
const base = `http://127.0.0.1:${gateway.server.address().port}`;

// ── 探测表 ────────────────────────────────────────────────────────────────────
const simPrompt = presetFiles.readSimPrompt('qq-chat-v2');
const auth = { 'x-operator-token': TOKEN };
const json = { 'content-type': 'application/json' };

const PROBES = [
  ['auth: 未认证 401', { method: 'GET', path: '/v1/console/pending' }, 401],
  ['auth: token 自检', { method: 'GET', path: '/v1/console/session', headers: auth }, 200],
  ['auth: 登录换 Cookie', { method: 'POST', path: '/v1/console/session', headers: json, body: { token: TOKEN } }, 200],
  ['presets: 清单', { method: 'GET', path: '/v1/console/dsh/presets', headers: auth }, 200],
  ['presets: sim-prompt 读', { method: 'GET', path: '/v1/console/dsh/presets/qq-chat-v2/sim-prompt', headers: auth }, 200],
  ['presets: 备份列表', { method: 'GET', path: '/v1/console/dsh/presets/qq-chat-v2/sim-prompt/backups', headers: auth }, 200],
  ['presets: sim-prompt 写（未变不落盘）', { method: 'PUT', path: '/v1/console/dsh/presets/qq-chat-v2/sim-prompt', headers: { ...auth, ...json }, body: { content: simPrompt.content } }, 200],
  ['sessions: 模型目录（DSH down → fallback）', { method: 'GET', path: '/v1/console/dsh/model', headers: auth }, 200],
  ['sessions: 模型设置', { method: 'PUT', path: '/v1/console/dsh/model', headers: { ...auth, ...json }, body: { model: 'deepseek-reasoner', reasoningEffort: 'high' } }, 200],
  ['sessions: 会话列表', { method: 'GET', path: '/v1/console/dsh/sessions', headers: auth }, 200],
  ['pending: 全量快照', { method: 'GET', path: '/v1/console/pending', headers: auth }, 200],
  ['pending: kind 过滤', { method: 'GET', path: '/v1/console/pending?kind=approval', headers: auth }, 200],
  ['pending: sessionKey 过滤', { method: 'GET', path: '/v1/console/pending?sessionKey=qq%3Agroup%3A42', headers: auth }, 200],
  ['pending: 非法 kind 400', { method: 'GET', path: '/v1/console/pending?kind=weird', headers: auth }, 400],
  ['usage: 汇总', { method: 'GET', path: '/v1/console/usage/summary', headers: auth }, 200],
  ['usage: 时间序列', { method: 'GET', path: '/v1/console/usage/series?hours=24&buckets=12', headers: auth }, 200],
  ['usage: 明细', { method: 'GET', path: '/v1/console/usage/recent', headers: auth }, 200],
  ['usage: 价目表', { method: 'GET', path: '/v1/console/usage/prices', headers: auth }, 200],
  ['usage: 会话明细', { method: 'GET', path: '/v1/console/usage/conversations/qq%3Agroup%3A42', headers: auth }, 200],
  ['usage: 重置（confirm 防呆）', { method: 'POST', path: '/v1/console/usage/reset', headers: { ...auth, ...json }, body: { confirm: 'reset' } }, 200],
  ['adapters: 总览', { method: 'GET', path: '/v1/console/adapters', headers: auth }, 200],
  ['adapters: 单适配器序列', { method: 'GET', path: '/v1/console/adapters/qq-main/usage', headers: auth }, 200],
  ['usage: agent token 拒绝', { method: 'GET', path: '/v1/console/usage/summary', headers: { 'x-agent-token': 'sneak' } }, 403],
];

let failed = 0;
for (const [name, probe, expect] of PROBES) {
  let status = 0;
  let out = '';
  try {
    const res = await fetch(`${base}${probe.path}`, {
      method: probe.method,
      headers: probe.headers ?? {},
      ...(probe.body !== undefined ? { body: JSON.stringify(probe.body) } : {}),
    });
    status = res.status;
    out = await res.text();
  } catch (error) {
    out = String(error?.message ?? error);
  }
  const ok = status === expect;
  if (!ok) failed += 1;
  const debug = ok ? '' : `\n      output: ${out.slice(0, 200).replace(/\n/g, ' ')}`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(status).padEnd(3)} (expect ${expect})  ${name}${debug}`);
}

console.log(failed === 0
  ? `\nSMOKE OK: ${PROBES.length}/${PROBES.length} 端点通过 @ ${base}`
  : `\nSMOKE FAILED: ${failed}/${PROBES.length} 端点未达预期`);

await gateway.close();
process.env.DSH_HOME = '';
rmSync(dshHome, { recursive: true, force: true });
rmSync(stateDir, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
