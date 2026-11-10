// 管线级影子对账（P3 转正后的灰度演练）：shadow 步骤必须**零行为变化**。
//
// 做法：同一批 fixture 各跑两遍 turn —— 基线（空编排，prompt 透传 + protocol
// 令牌）与灰度（编排里放一个 kind=shadow 的登记服务，HTTP 通道指向本地 stub，
// 服务返回「提议的改写 + sections」）。断言两遍真正发给 DSH 的 prompt 逐字节
// 一致（shadow 只记 diff、绝不应用产出，§3）；同时打印 shadow 服务提议的
// 内容形状，作为「影子数据是否可用」的观察值。
//
// GATEWAY_CONTEXT 的旧 assembler 影子通道已随 P3 转正删除——灰度对账现在
// 完全走管线（登记 kind=shadow 的服务步骤）。
//
// 全部离线：假 DSH、本地 HTTP stub shadow 服务，不连真网关/DSH/memory-mcp。
// 用法：npm run verify:shadow
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const { createTurnRunner } = await import(new URL('../src/runtime/turn-runner.mjs', import.meta.url).href);
const { createSessionRegistry } = await import(new URL('../src/runtime/session-registry.mjs', import.meta.url).href);
const { createDshGateway } = await import(new URL('../src/runtime/dsh-gateway.mjs', import.meta.url).href);
const { createPromptQueue } = await import(new URL('../src/runtime/prompt-queue.mjs', import.meta.url).href);
const { createTurnStore } = await import(new URL('../src/core/turn-store.mjs', import.meta.url).href);
const { createServiceRegistry } = await import(new URL('../src/core/service-registry.mjs', import.meta.url).href);
const { createPipeline, protocolTokenLine } = await import(new URL('../src/core/pipeline.mjs', import.meta.url).href);

const CHAT = {
  preset: 'qq-chat-v2',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: 'max',
  workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-shadow-')),
  turnTimeoutMs: 2000,
};
const ADAPTER_ID = 'qq-main';

/** 假 DSH：协议形状与 runtime 消费面一致，prompt 后立刻按 mux 帧序回一个 turn。 */
function createFakeDsh() {
  let seq = 0;
  const state = { sessions: new Map(), follows: new Set(), prompts: [] };
  let onFrame = null;
  const client = {
    state,
    emit(payload) { onFrame?.(payload); },
    finishTurn(sessionId, text) {
      if (!state.sessions.has(sessionId)) throw new Error(`fake dsh: unknown session ${sessionId}`);
      const turn = `turn-${state.sessions.get(sessionId).turns += 1}`;
      client.emit({ type: 'session/event', sessionId, event: { type: 'turn/start', data: { turn } } });
      client.emit({
        type: 'session/event', sessionId,
        event: { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } },
      });
      client.emit({ type: 'session/event', sessionId, event: { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } } });
    },
    async listPresets() { return ['qq-chat-v2']; },
    async ensureWorkspace() { return 'ws-shadow'; },
    async createSession() {
      const sessionId = `sess-${++seq}`;
      state.sessions.set(sessionId, { turns: 0 });
      return sessionId;
    },
    async selectModel() { return {}; },
    async prompt({ sessionId, text }) {
      state.prompts.push({ sessionId, text });
      setImmediate(() => client.finishTurn(sessionId, '影子回复'));
      return { result: { ok: true, value: {} } };
    },
    follow(sessionId) { state.follows.add(sessionId); },
    forget(sessionId) { state.follows.delete(sessionId); },
    startStream(cb) { onFrame = cb; },
    stopStream() { onFrame = null; },
    get connected() { return true; },
  };
  return client;
}

/**
 * 本地 shadow 服务 stub（HTTP 通道）：收到 service.call 后返回「提议的改写 +
 * sections」——真服务（如 memory 装饰器）会给出回忆段；影子期网关只记录不应用。
 */
async function listenShadowStub() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      seen.push({ step: request.step, textChars: request.text?.length ?? 0 });
      const body = JSON.stringify({
        v: 1,
        callId: request.callId,
        verdict: 'pass',
        // 影子服务的「提议」：故意与当前 text 不同（如果网关错误地应用了它，
        // 对账会立刻发现行为变化）。
        message: `${request.text}\n[影子提议] 这一段绝不该出现在实际 prompt 里`,
        sections: [{ name: '记忆', text: '【记忆】\n上次聊到周末去爬山（影子提议）。', priority: 50 }],
      });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, seen };
}

const FIXTURES = [
  {
    sessionKey: 'qq:group:456789',
    envelope: {
      platform: 'qq',
      adapterId: ADAPTER_ID,
      conversation: { kind: 'group', id: '456789' },
      message: { id: 'm-qq-1', sender: { id: '10001', name: '张三', roles: ['member'] }, text: '在吗' },
      prompt: { text: '【平台消息】群 456789\n发送者：张三（10001）\n内容：在吗' },
    },
  },
  {
    sessionKey: 'qq:private:10001',
    envelope: {
      platform: 'qq',
      adapterId: ADAPTER_ID,
      conversation: { kind: 'private', id: '10001' },
      message: { id: 'm-qq-2', sender: { id: '10001', name: '张三', roles: ['member'] }, text: '私聊一句' },
      prompt: { text: '【平台消息】会话 10001\n发送者：张三（10001）\n内容：私聊一句' },
    },
  },
  {
    sessionKey: 'qq:group:777001',
    envelope: {
      platform: 'qq',
      adapterId: ADAPTER_ID,
      kind: 'event',
      wake: { kind: 'cron', status: 'arrived' },
      snapshot: { members: 3, unread: 2 },
    },
  },
];

const builtinSteps = {
  protocol: {
    name: 'protocol', priority: 100,
    build: ({ deps }) => (deps?.turnToken ? { text: protocolTokenLine(deps.turnToken) } : null),
  },
};

async function runCase({ withShadow, fixture, index, shadowUrl }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-shadow-run-'));
  // 编排硬切后：shadow 服务经登记目录注册（kind=shadow 已进入登记词典），
  // 编排只写 pipelines.json。基线（withShadow=false）= 无编排 + 空登记。
  const pipelinesFile = path.join(dir, 'pipelines.json');
  fs.writeFileSync(pipelinesFile, JSON.stringify(withShadow
    ? { pipelines: { [ADAPTER_ID]: ['memory-shadow'] } }
    : {}));
  const regDir = path.join(dir, 'services');
  fs.mkdirSync(regDir, { recursive: true });
  if (withShadow) {
    fs.writeFileSync(path.join(regDir, 'memory-shadow.json'), JSON.stringify({
      v: 1, id: 'memory-shadow', name: 'memory-shadow', kind: 'shadow',
      transport: 'http', url: shadowUrl, secret: 's'.repeat(20), enabled: true,
    }));
  }
  const registry = createServiceRegistry({
    pipelinesFile,
    stateDir: dir,
    // 过渡期消费端身份（adapters.json id）：编排权限门禁要求消费端有身份。
    consumerIds: [ADAPTER_ID],
    registrations: { dir: regDir, ledgerFile: path.join(dir, 'ledger.jsonl'), reloadMs: 0 },
    logger: () => {},
  });
  const dsh = createFakeDsh();
  const sessionRegistry = createSessionRegistry({ dsh, chat: CHAT, file: null });
  const gateway = createDshGateway({ dsh, turnTimeoutMs: CHAT.turnTimeoutMs });
  const turns = createTurnStore({ file: null });
  const pipeline = createPipeline({ registry, builtinSteps, budgetChars: 6000, logger: () => {} });
  const runner = createTurnRunner({
    config: { chat: CHAT, pipeline: { mode: 'on' } },
    dsh, registry: sessionRegistry, gateway,
    queue: createPromptQueue({}),
    turns,
    pipeline,
    logger: () => {},
  });
  gateway.start();
  try {
    const turnId = `shadow-${withShadow ? 'on' : 'off'}-${index}`;
    const result = await runner.submit({ turnId, sessionKey: fixture.sessionKey, envelope: fixture.envelope, degraded: [] });
    const sent = dsh.state.prompts.at(-1)?.text ?? '';
    const context = turns.get(turnId)?.result?.context ?? null;
    return { status: result.status, sent, context };
  } finally {
    gateway.stop();
  }
}

const shadow = await listenShadowStub();
const rows = [];
let failed = 0;
for (const [index, fixture] of FIXTURES.entries()) {
  const baseline = await runCase({ withShadow: false, fixture, index, shadowUrl: shadow.url });
  const shadowed = await runCase({ withShadow: true, fixture, index, shadowUrl: shadow.url });
  // turnToken 每轮随机（randomUUID，安全设计）：对账忽略令牌行、比较其余内容——
  // 影子期验收标准是「除轮换凭据外零行为变化」。
  const stripToken = (text) => text.split('\n').filter((line) => !line.startsWith('【会话令牌】')).join('\n');
  const identical = stripToken(baseline.sent) === stripToken(shadowed.sent);
  if (!identical) failed += 1;
  const shadowStep = shadowed.context?.steps?.find((step) => step.outcome?.startsWith('shadow'));
  rows.push({
    sessionKey: fixture.sessionKey,
    baselineChars: baseline.sent.length,
    shadowChars: shadowed.sent.length,
    outcome: shadowStep?.outcome ?? '(shadow step absent)',
    degraded: shadowed.context?.degraded === true,
    identical,
  });
}
shadow.server.close();

const pad = (value, width) => String(value).padEnd(width);
console.log('\n管线影子对账（kind=shadow 步骤 vs 空编排基线）：');
console.log(`${pad('会话', 24)}${pad('基线 prompt', 14)}${pad('影子 prompt', 14)}${pad('shadow 步骤', 16)}${pad('degraded', 10)}结果`);
for (const row of rows) {
  console.log(
    `${pad(row.sessionKey, 24)}${pad(`${row.baselineChars}c`, 14)}${pad(`${row.shadowChars}c`, 14)}`
    + `${pad(row.outcome, 16)}${pad(row.degraded ? 'yes' : 'no', 10)}`
    + `${row.identical ? 'prompt 一致' : 'prompt 变了'}`,
  );
}
console.log(`\nshadow 服务被调用 ${shadow.seen.length} 次（每个 fixture 一次），提议内容均未进入实际 prompt。`);

const mismatched = rows.filter((row) => !row.identical);
if (mismatched.length) {
  console.error(`\n影子期行为变化：${mismatched.map((row) => row.sessionKey).join(', ')} 的实际 prompt 与基线不同。`);
  process.exit(1);
}
if (rows.some((row) => row.outcome === '(shadow step absent)')) {
  console.error('\nshadow 步骤没有执行：检查编排与消费端身份（编排权限门禁）。');
  process.exit(1);
}
console.log(`\n结论：${rows.length}/${rows.length} 会话实际 prompt 逐字节一致（影子期零行为变化）；提议内容可从 shadow 服务日志/指标观察。`);
