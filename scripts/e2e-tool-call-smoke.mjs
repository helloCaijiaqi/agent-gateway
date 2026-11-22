/**
 * 端到端冒烟（tool.call 统一改造 + 消费端收编验收）：
 *   消费端登记 → 入站验签/编排门禁 → 动作下行 → 注册（memoryService 能力对象）
 *   → 缓冲落盘 → save 事务（saveTool 按声明动态调用）→ get 新纪元注入
 *   → filter 改写/丢弃 → 崩溃恢复。
 *
 * 运行：node scripts/e2e-tool-call-smoke.mjs（或 npm run smoke:e2e）
 *
 * 覆盖的是**网关侧真实链路**：登记文件即身份（同平台双账号 kind=consumer，svc-<hash>
 * adapters.json 兼容条目——登记目录唯一事实源）→ 真实 service-registry
 * consumers() 活视图（HTTP 入站验签 / 编排门禁 / 动作下行）→ 控制台注册
 * （文件即登记 + 密钥落盘 + memoryService:{saveTool}）→ 真实 pipeline（两级
 * 解析 / filter 改写器 / decorator 纪元去重）→ 真实 session-save 缓冲（JSONL
 * 落盘 + 崩溃恢复，save 工具名按登记声明动态解析）。对端服务用进程内 HTTP
 * 假实现（bridge 的 actions/回执 + memory 的 get/save + filter 的改写/丢弃），
 * 不要求各服务仓在线；它们自身的契约由各自测试覆盖。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { loadConfig } = await import(new URL('../src/core/config.mjs', import.meta.url).href);
const { createGatewayServer } = await import(new URL('../src/core/server.mjs', import.meta.url).href);
const { createServiceRegistry, selectMemoryService } = await import(new URL('../src/core/service-registry.mjs', import.meta.url).href);
const { createPipeline } = await import(new URL('../src/core/pipeline.mjs', import.meta.url).href);
const { createSessionSave, encodeSessionKey } = await import(new URL('../src/runtime/memory-ingest.mjs', import.meta.url).href);
const { createTokenLedger } = await import(new URL('../src/core/usage-ledger.mjs', import.meta.url).href);
const { resolvePriceTable } = await import(new URL('../src/core/prices.mjs', import.meta.url).href);
const { signRequest } = await import(new URL('../src/core/auth.mjs', import.meta.url).href);
const { deliverAction } = await import(new URL('../src/executors/adapter-tools/common/transport.mjs', import.meta.url).href);

const TOKEN = 'e2e-operator-token-0123456789';
const OPERATOR = { 'x-operator-token': TOKEN, connection: 'close' };
const JSON_TYPE = { 'content-type': 'application/json', connection: 'close' };
// 多消费端收编：同平台双账号（各自 svc-<hash> id），会话键 4 段绑消费端。
const CONSUMER_A = 'svc-1a2b3c4d5e6f';
const CONSUMER_B = 'svc-9f8e7d6c5b4a';
const SESSION = `qq:${CONSUMER_A}:group:123`;

function log(step, extra = '') {
  console.log(`\n▶ ${step}${extra ? `：${extra}` : ''}`);
}

/** 假服务：一个 HTTP server 同时扮演 memory（get/save）与 filter（改写/丢弃）。 */
async function startFakeServices() {
  const state = {
    epochs: new Map(), // sessionKey → epoch（save 收尾 = +1）
    saves: [],         // 收到的 chat_memory_save payload
    calls: [],         // 全部 tool.call（tool/args/context）
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const reply = (payload) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      };
      if (req.url !== '/v1/tools/call') return reply({ error: 'not found' });
      const request = JSON.parse(body || '{}');
      state.calls.push({ tool: request.tool, args: request.args, context: request.context });
      const data = (() => {
        switch (request.tool) {
          case 'chat_memory_get': {
            const epoch = state.epochs.get(request.sessionKey) ?? 1;
            return {
              // decorator 契约：{sections, epoch}（无 verdict / message）。
              sections: [
                { name: '画像', text: '【画像】\n- 喜欢火锅', priority: 90 },
                { name: '长期记忆', text: '【长期记忆】\n- 上次聊到部署', priority: 50 },
              ],
              epoch,
            };
          }
          case 'chat_memory_save': {
            state.saves.push(request.args);
            if (request.args?.partial !== true) {
              state.epochs.set(request.sessionKey, (state.epochs.get(request.sessionKey) ?? 1) + 1);
            }
            return { raw: { created: request.args?.messages?.length ?? 0, duplicate: 0 } };
          }
          case 'chat_filter_rewrite':
            // filter 契约：{text, reason?}——输入取 context.text。
            return { text: String(request.context?.text ?? '').replaceAll('敏感', '***') };
          case 'chat_filter_drop':
            return String(request.context?.text ?? '').includes('垃圾')
              ? { text: '', reason: 'spam' }
              : { text: String(request.context?.text ?? '') };
          default:
            return null;
        }
      })();
      reply({ v: 1, callId: request.callId, ok: data !== null, data, error: data === null ? { code: 'E_UNSUPPORTED', message: request.tool } : undefined });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 假消费端（qq-bridge 替身）：/v1/actions 动作接收 + 回执（供动作下行断言）。 */
async function startFakeBridge() {
  const state = { actions: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/v1/actions/manifest') {
        res.end(JSON.stringify({ v: 1, actions: [] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/actions') {
        const envelope = JSON.parse(body || '{}');
        state.actions.push(envelope);
        res.end(JSON.stringify({ v: 1, actionId: envelope.actionId, ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const BUILTINS = {
  protocol: { name: 'protocol', priority: 100, build: ({ deps }) => (deps?.turnToken ? { text: `【会话令牌】${deps.turnToken}` } : null) },
};

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-e2e-'));
// 消费端登记先于 config 装载（fail-closed 前提 = 兼容条目或登记文件至少其一）：
// 同平台双账号走纯登记接入（登记目录唯一事实源，adapters.json 已退役；id 强制
// svc-<hash>——只标识服务实例，与平台解耦）。
const bridge = await startFakeBridge();
const BRIDGE_SECRET_A = 'bridge-secret-a-0123456789abc';
const BRIDGE_SECRET_B = 'bridge-secret-b-0123456789abc';
fs.mkdirSync(path.join(stateDir, 'services'), { recursive: true });
for (const [id, secret, name] of [[CONSUMER_A, BRIDGE_SECRET_A, 'qq-bridge-a'], [CONSUMER_B, BRIDGE_SECRET_B, 'qq-bridge-b']]) {
  fs.writeFileSync(path.join(stateDir, `${id}.secret`), secret);
  fs.writeFileSync(path.join(stateDir, 'services', `${id}.json`), JSON.stringify({
    v: 1, id, name, kind: 'consumer', transport: 'http',
    url: bridge.url, platform: 'qq', secretFile: `${id}.secret`,
  }, null, 2));
}
// 控制台凭据文件单源（env 通道已退役）。
fs.writeFileSync(path.join(stateDir, 'operator-token'), `${TOKEN}\n`, { encoding: 'utf8', mode: 0o600 });
const config = loadConfig({
  env: { GATEWAY_MODE: 'shadow', GATEWAY_CONSOLE: 'on', GATEWAY_PORT: '0', GATEWAY_MEMORY_SAVE: 'on' },
  stateDir,
});
fs.mkdirSync(config.registrations.dir, { recursive: true });
fs.writeFileSync(config.pipeline.file, JSON.stringify({
  pipelines: { [CONSUMER_A]: ['chat_filter_rewrite', 'chat_memory_get'] },
  returnPipelines: { [CONSUMER_A]: ['chat_filter_drop', 'chat_filter_rewrite'] },
}));

const fake = await startFakeServices();
const registry = createServiceRegistry({
  pipelinesFile: config.pipeline.file,
  stateDir,
  registrations: { ...config.registrations, reloadMs: 0 },
  logger: () => {},
});
const pipeline = createPipeline({ registry, builtinSteps: BUILTINS, budgetChars: 6000 });
const ledger = createTokenLedger({ file: path.join(stateDir, 'usage-ledger.jsonl'), priceTable: resolvePriceTable() });
const gateway = createGatewayServer({
  config,
  logger: () => {},
  services: registry,
  pipeline: { status: () => ({ builtinSteps: ['protocol'], returnEffective: true }) },
  runtime: { usageLedger: ledger },
});
await gateway.listen();
const base = `http://127.0.0.1:${gateway.server.address().port}`;

let failed = false;
let sessionSave = null;
/** save 工具名按登记声明动态解析（网关不写死 chat_memory_save）。 */
const resolveSaveRoute = () => selectMemoryService(registry.services(), { defaultSaveTool: 'chat_memory_save' });
const deliverSave = async (payload) => {
  const route = resolveSaveRoute();
  assert.ok(route?.id && route?.saveTool, `save 选路失败：${JSON.stringify(route)}`);
  const result = await registry.callServiceTool(route.id, {
    tool: route.saveTool,
    args: { sessionKey: payload.sessionKey, messages: payload.messages, partial: payload.partial === true },
    sessionKey: payload.sessionKey,
  });
  if (result.ok !== true) throw new Error(`save failed: ${result.error?.message ?? 'unknown'}`);
};

try {
  // ── 0. 消费端收编（登记 kind=consumer → 入站验签 / 编排门禁 / 动作下行）──
  log('消费端收编', '同平台双账号（svc- hash id，无 adapters.json 兼容条目）');
  const consumers = registry.consumers();
  assert.equal(consumers.length, 2, '双账号进入统一活视图（同平台多消费端合法）');
  assert.ok(consumers.every((consumer) => consumer.platform === 'qq' && consumer.source === 'registry'));
  assert.ok(consumers.every((consumer) => /^svc-[a-z0-9]{12}$/.test(consumer.id)), '消费端 id 为 svc-<hash> 形态');
  // HTTP 入站验签：各账号用各自登记密钥签名 → 放行；未知 id → 拒绝。
  for (const [id, secret] of [[CONSUMER_A, BRIDGE_SECRET_A], [CONSUMER_B, BRIDGE_SECRET_B]]) {
    const res = await fetch(`${base}/v1/metrics`, { headers: { ...signRequest({ secret, adapterId: id }), connection: 'close' } });
    assert.equal(res.status, 200, `登记 consumer ${id} 通过 HTTP 验签`);
  }
  const metricsBad = await fetch(`${base}/v1/metrics`, { headers: { ...signRequest({ secret: BRIDGE_SECRET_A, adapterId: 'ghost' }), connection: 'close' } });
  assert.equal(metricsBad.status, 401, '未知消费端拒绝');
  // 编排门禁：登记 consumer 拥有编排权（pipelines 键 = 账号 A 的 svc- id）。
  assert.deepEqual(registry.pipelineFor(CONSUMER_A), ['chat_filter_rewrite', 'chat_memory_get']);
  // 动作下行：consumers() 条目直接喂 deliverAction（callbackBase + secret + platform）；
  // 会话键 4 段（绑账号 B）也能按 consumerId 定位到对应账号。
  const delivery = await deliverAction({
    adapter: registry.consumerById(CONSUMER_B),
    action: 'send_text',
    entry: {},
    ctx: { sessionKey: `qq:${CONSUMER_B}:group:123`, payload: { key: 'group:123', text: 'e2e 下行动作' }, turnId: 't-e2e-0' },
  });
  assert.equal(delivery.ok, true, `动作下行失败：${delivery.message ?? ''}`);
  assert.equal(bridge.state.actions.at(-1)?.type, 'send_text');
  assert.equal(bridge.state.actions.at(-1)?.payload.text, 'e2e 下行动作');

  // ── 1. 注册（控制台写路径：文件即登记 + 密钥落盘 + memoryService 能力对象）──
  log('注册', 'memory（kind=resource, memoryService 能力对象）+ filter（工具 role 承担）');
  const register = async (body) => {
    const res = await fetch(`${base}/v1/console/services`, {
      method: 'POST', headers: { ...OPERATOR, ...JSON_TYPE }, body: JSON.stringify(body),
    });
    const text = await res.text();
    assert.equal(res.status, 201, `注册失败：${text}`);
    return JSON.parse(text).id;
  };
  const memoryId = await register({
    name: 'memory-mcp', kind: 'resource', transport: 'http', url: fake.url,
    // memoryService 能力对象（权威形态）：saveTool 按声明动态调用。
    memoryService: { saveTool: 'chat_memory_save' },
    secret: 'memory-secret-0123456789abcdef',
    tools: [
      { name: 'chat_memory_get', description: '记忆注入', role: 'decorator' },
      { name: 'chat_memory_save', description: '整段缓冲落地', role: 'tool' },
    ],
  });
  assert.equal(resolveSaveRoute()?.saveTool, 'chat_memory_save', 'saveTool 按登记声明解析');
  const filterId = await register({
    name: 'content-filter', kind: 'resource', transport: 'http', url: fake.url,
    secret: 'filter-secret-0123456789abcdef',
    tools: [
      { name: 'chat_filter_rewrite', description: '敏感词改写', role: 'filter' },
      { name: 'chat_filter_drop', description: '垃圾消息丢弃', role: 'filter' },
    ],
  });
  const view = registry.registrations();
  assert.equal(view.length, 4, '双 consumer + memory + filter');
  assert.equal(view.find((item) => item.id === memoryId).memoryService, true);
  assert.ok(fs.existsSync(path.join(stateDir, 'secrets', `${memoryId}.secret`)), '密钥独立落盘');

  // ── 2. 缓冲落盘（observe → JSONL 逐条持久化）─────────────────────────────
  log('缓冲落盘', '入站 + 出站观察 → session-buffer JSONL');
  sessionSave = createSessionSave({
    deliver: deliverSave,
    bufferDir: config.memorySave.bufferDir,
    idleMs: 60_000,
    maxMessages: 200,
    maxChars: 20_000,
    logger: (message) => console.log(`   [session-save] ${message}`),
  });
  sessionSave.start();
  sessionSave.observeInbound({
    sessionKey: SESSION,
    envelope: {
      message: { id: 'in:001', text: '今天聊了部署方案', sender: { id: '10001', name: '小明哥', names: { nickname: '小明', card: '小明哥' } } },
      receivedAt: 1_700_000_000_000,
    },
  });
  sessionSave.observeOutbound({ sessionKey: SESSION, tool: 'send_text', args: { content: '收到，我来跟进' }, msgId: 'out:t1:c1' });
  const bufferFile = path.join(config.memorySave.bufferDir, `${encodeSessionKey(SESSION)}.jsonl`);
  assert.ok(fs.existsSync(bufferFile), '缓冲文件已落盘');
  const lines = fs.readFileSync(bufferFile, 'utf8').trim().split('\n');
  assert.equal(JSON.parse(lines[0]).type, 'meta', '首行 meta 声明 sessionKey');
  assert.equal(lines.length, 3, 'meta + 2 条消息');

  // ── 3. save 事务（整段缓冲经 tool.call 一次投递）──────────────────────────
  log('save 事务', 'flushAll → tool.call chat_memory_save（sender.names 随 payload）');
  await sessionSave.flushAll();
  assert.equal(fake.state.saves.length, 1, '整段缓冲一次 save');
  const saved = fake.state.saves[0];
  assert.equal(saved.sessionKey, SESSION);
  assert.equal(saved.partial, false, '会话收尾 save');
  assert.equal(saved.messages.length, 2);
  assert.equal(saved.messages[0].senderId, '10001');
  assert.equal(saved.messages[0].nickname, '小明');
  assert.equal(saved.messages[0].card, '小明哥');
  assert.equal(saved.messages[1].senderId, undefined, '出站（assistant）无 senderId');
  assert.equal(fs.existsSync(bufferFile), false, 'save 成功后缓冲清理');
  assert.equal(fake.state.epochs.get(SESSION), 2, 'save 收尾 → 纪元推进');

  // ── 4. get 新纪元注入（filter 改写 + decorator 纪元去重）───────────────────
  log('get 注入', 'filter 改写敏感词 → decorator 注入画像/长期记忆');
  const runForward = (text) => pipeline.runForward({
    consumerId: CONSUMER_A, sessionKey: SESSION, turnToken: 'tk-1', text,
    envelope: { message: { id: `in:${Math.random().toString(16).slice(2)}`, text, sender: { id: '10001', name: '小明哥' } } },
  });

  const first = await runForward('你好 敏感词');
  assert.equal(first.ok, true);
  assert.ok(first.text.startsWith('你好 ***'), `filter 改写生效，got=${JSON.stringify(first.text.slice(0, 20))}`);
  assert.ok(first.text.includes('【画像】'), 'decorator 注入画像');
  assert.ok(first.text.includes('【长期记忆】'), 'decorator 注入长期记忆');
  assert.ok(first.text.includes('【会话令牌】tk-1'), 'protocol 殿后');
  const getCall = fake.state.calls.filter((call) => call.tool === 'chat_memory_get').at(-1);
  assert.equal(getCall.context.senderId, '10001', 'decorator 调用的 context.senderId = 对话对象');

  const second = await runForward('再来一句');
  assert.equal(second.text.includes('【画像】'), false, '同 epoch 去重：不重复注入');

  // ── 5. filter 丢弃（text 空串 = 拦截）────────────────────────────────────
  log('filter 丢弃', 'returnPipelines 空串拦截');
  const dropped = await pipeline.runReturn({ consumerId: CONSUMER_A, sessionKey: SESSION, text: '这是垃圾消息' });
  assert.equal(dropped.verdict, 'drop');
  assert.equal(dropped.reason, 'spam');
  const rewritten = await pipeline.runReturn({ consumerId: CONSUMER_A, sessionKey: SESSION, text: '正常回复 敏感词' });
  assert.equal(rewritten.text, '正常回复 ***词', '回路 filter 改写外发文本');

  // ── 6. 崩溃恢复（残留 JSONL → 重启加载 + 定时器补发）─────────────────────
  log('崩溃恢复', '残留缓冲 + 撕裂行 → 新实例恢复并补发');
  sessionSave.stop();
  const leftover = path.join(config.memorySave.bufferDir, `${encodeSessionKey('qq:group:999')}.jsonl`);
  fs.mkdirSync(config.memorySave.bufferDir, { recursive: true });
  fs.writeFileSync(leftover, [
    JSON.stringify({ type: 'meta', v: 1, sessionKey: 'qq:group:999' }),
    JSON.stringify({ msgId: 'in:crash-1', senderId: '20002', text: '崩溃前的最后一句', createdAt: 1_700_000_100_000, kind: 'episodic' }),
    '{"msgId":"in:crash-2","text":"撕裂行',
  ].join('\n'));
  const recovered = [];
  const revived = createSessionSave({
    deliver: async (payload) => {
      await deliverSave(payload);
      recovered.push(payload);
    },
    bufferDir: config.memorySave.bufferDir,
    idleMs: 300,
    maxMessages: 200,
    maxChars: 20_000,
  });
  revived.start();
  await new Promise((resolve) => setTimeout(resolve, 700));
  revived.stop();
  assert.equal(recovered.length, 1, '恢复后空闲到期自动补发');
  assert.equal(recovered[0].sessionKey, 'qq:group:999');
  assert.equal(recovered[0].messages.length, 1, '撕裂行跳过，有效行恢复');
  assert.equal(fs.existsSync(leftover), false, '补发成功 → 残留清理');

  console.log('\n✅ E2E SMOKE PASSED：消费端登记 → 入站验签/编排门禁 → 动作下行 → 注册(memoryService 能力对象) → 缓冲落盘 → saveTool 动态 save → get 新纪元注入 → filter 改写/丢弃 → 崩溃恢复');
} catch (error) {
  failed = true;
  console.error('\n❌ E2E SMOKE FAILED:', error?.message ?? error);
  console.error(error?.stack ?? '');
} finally {
  try { await sessionSave.flushAll(); } catch { /* 已尽力 */ }
  try { sessionSave.stop(); } catch { /* 已停 */ }
  await gateway.close().catch(() => {});
  await fake.close().catch(() => {});
  await bridge.close().catch(() => {});
  process.exit(failed ? 1 : 0);
}
