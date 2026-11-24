// P3 工具面测试：ToolHost（turnToken 反查/频控/预算/降级透传）、
// V2 P3 服务执行器动态路由（登记工具 → 服务 tool.call）、/v1/tools HTTP 契约、
// mcp-bus 薄壳（JSON-RPC over 内存流，不经 spawn）。
// 注：内置 memory-tools/rolecard-tools executor 已随 P3 退役——chat_memory_* 等
// 工具面改由登记文件声明、经 service-registry.callServiceTool 动态路由。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { createToolHost } = await import(new URL('../src/runtime/tool-host.mjs', import.meta.url).href);
const { createExecutorRegistry, registerExecutor } = await import(new URL('../src/executors/executor-interface.mjs', import.meta.url).href);
const { parseToolCall, parseToolResult } = await import(new URL('../src/core/contracts.mjs', import.meta.url).href);
const { loadConfig } = await import(new URL('../src/core/config.mjs', import.meta.url).href);
const { createGatewayServer } = await import(new URL('../src/core/server.mjs', import.meta.url).href);
const { signRequest } = await import(new URL('../src/core/auth.mjs', import.meta.url).href);
const { createMcpBus, withTurnToken } = await import(new URL('../src/mcp-bus.mjs', import.meta.url).href);
const { createTurnRunner } = await import(new URL('../src/runtime/turn-runner.mjs', import.meta.url).href);
const { createSessionRegistry } = await import(new URL('../src/runtime/session-registry.mjs', import.meta.url).href);
// 建会话需要适配器声明「平台→preset」：测试里用一个最小的声明表顶替登记文件。
const PRESETS_FOR = () => ({ qq: 'qq-chat', wx: 'wx-chat' });
const { createPromptQueue } = await import(new URL('../src/runtime/prompt-queue.mjs', import.meta.url).href);
const { createDshGateway } = await import(new URL('../src/runtime/dsh-gateway.mjs', import.meta.url).href);
const { createTurnStore } = await import(new URL('../src/core/turn-store.mjs', import.meta.url).href);
const { seedConsumer, seedBusSecret, createConsumerRegistry } = await import(
  new URL('./support/consumer-registration.mjs', import.meta.url).href
);

const SECRET = '0123456789abcdef0123456789abcdef';

function toolExecutor(handlers) {
  return registerExecutor({
    name: 'fake-tools',
    actions: ['fake.action'],
    call: async ({ action, ctx }) => handlers(action, ctx),
    tools: [{
      name: 'chat_fake_echo',
      action: 'fake.action',
      description: 'echo 测试工具',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    }],
  });
}

async function waitFor(predicate, { timeoutMs = 2000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// ---------------------------------------------------------------- ToolHost 单元

function makeHost(handlers, overrides = {}) {
  const registry = createExecutorRegistry();
  registry.add(toolExecutor(handlers));
  return createToolHost({ executorRegistry: registry, logger: () => {}, ...overrides });
}

test('tool-host: turnToken 反查活跃 turn，sessionKey/turnId 自动派生', async () => {
  const seen = [];
  const host = makeHost((action, ctx) => { seen.push(ctx); return { ok: true, receipt: { echo: ctx.payload.value } }; });
  host.registerTurn({ turnId: 'turn_1', turnToken: 'tok-1', sessionKey: 'qq:group:1' });
  assert.equal(host.status().liveTurns, 1);
  const result = await host.handle({ callId: 'c1', tool: 'chat_fake_echo', args: { value: 'hi' }, turnToken: 'tok-1' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { echo: 'hi' });
  assert.equal(seen[0].sessionKey, 'qq:group:1');
  assert.equal(seen[0].turnId, 'turn_1');
  host.releaseTurn('turn_1');
  assert.equal(host.status().liveTurns, 0);
});

test('tool-host: 未知/过期令牌一律 E_FORBIDDEN；显式 sessionKey 不匹配也拒绝', async () => {
  const host = makeHost(() => ({ ok: true, receipt: {} }));
  host.registerTurn({ turnId: 'turn_1', turnToken: 'tok-1', sessionKey: 'qq:group:1' });
  let result = await host.handle({ callId: 'c1', tool: 'chat_fake_echo', args: {}, turnToken: 'wrong' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'E_FORBIDDEN');
  result = await host.handle({ callId: 'c2', tool: 'chat_fake_echo', args: {}, turnToken: 'tok-1', sessionKey: 'qq:group:999' });
  assert.equal(result.error.code, 'E_FORBIDDEN');
  result = await host.handle({ callId: 'c3', tool: 'chat_fake_echo', args: {}, turnToken: '' });
  assert.equal(result.error.code, 'E_FORBIDDEN');
  // 串会话令牌复用：turn 结束后旧令牌必须失效。
  host.releaseTurn('turn_1');
  result = await host.handle({ callId: 'c4', tool: 'chat_fake_echo', args: {}, turnToken: 'tok-1' });
  assert.equal(result.error.code, 'E_FORBIDDEN');
});

test('tool-host: 每 turn 频控；未知工具 E_UNSUPPORTED；executor 降级原样透传', async () => {
  let degrade = false;
  const host = makeHost(() => (degrade
    ? { ok: false, degraded: true, code: 'E_DSH_DOWN', message: 'upstream gone' }
    : { ok: true, receipt: {} }), { maxCallsPerTurn: 2 });
  host.registerTurn({ turnId: 'turn_1', turnToken: 'tok-1', sessionKey: 'qq:group:1' });
  assert.equal((await host.handle({ callId: 'c1', tool: 'chat_fake_echo', args: {}, turnToken: 'tok-1' })).ok, true);
  assert.equal((await host.handle({ callId: 'c2', tool: 'chat_fake_echo', args: {}, turnToken: 'tok-1' })).ok, true);
  const limited = await host.handle({ callId: 'c3', tool: 'chat_fake_echo', args: {}, turnToken: 'tok-1' });
  assert.equal(limited.error.code, 'E_RATE_LIMITED');
  const unknown = await host.handle({ callId: 'c4', tool: 'chat_nope', args: {}, turnToken: 'tok-1' });
  assert.equal(unknown.error.code, 'E_UNSUPPORTED');
  // 频控重置后再试降级透传。
  host.releaseTurn('turn_1');
  host.registerTurn({ turnId: 'turn_2', turnToken: 'tok-2', sessionKey: 'qq:group:1' });
  degrade = true;
  const degraded = await host.handle({ callId: 'c5', tool: 'chat_fake_echo', args: {}, turnToken: 'tok-2' });
  assert.equal(degraded.ok, false);
  assert.equal(degraded.error.code, 'E_DSH_DOWN');
});

test('tool-host: 超时返回 E_TIMEOUT，不炸进程', async () => {
  const host = makeHost(async () => {
    await new Promise((r) => setTimeout(r, 200));
    return { ok: true, receipt: {} };
  }, { callTimeoutMs: 30 });
  host.registerTurn({ turnId: 'turn_1', turnToken: 'tok-1', sessionKey: 'qq:group:1' });
  const result = await host.handle({ callId: 'c1', tool: 'chat_fake_echo', args: {}, turnToken: 'tok-1' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'E_TIMEOUT');
});

test('tool-host: 回路链 drop（suppressed）算成功但不计入 sent、不写记忆', async () => {
  const registry = createExecutorRegistry();
  registry.add(registerExecutor({
    name: 'fake-send',
    actions: ['send_text'],
    call: async () => ({ ok: true, receipt: null, suppressed: true }),
    tools: [{ name: 'chat_fake_send', action: 'send_text', description: 'send', inputSchema: { type: 'object' } }],
  }));
  const ingested = [];
  const host = createToolHost({
    executorRegistry: registry,
    memoryIngest: { observeOutbound: (value) => ingested.push(value) },
    logger: () => {},
  });
  host.registerTurn({ turnId: 'turn_1', turnToken: 'tok-1', sessionKey: 'qq:group:1' });
  const result = await host.handle({ callId: 'c1', tool: 'chat_fake_send', args: { text: 'hi' }, turnToken: 'tok-1' });
  assert.equal(result.ok, true, '对模型而言 drop 仍是成功（无需自我纠正）');
  const stats = host.releaseTurn('turn_1');
  assert.equal(stats.sent, 0, 'drop 的文本不能算作已发送');
  assert.equal(ingested.length, 0, '未发出的文本不能沉淀进记忆');
});

// ------------------------------------------------------------ 契约 schema

test('contracts: toolCall/toolResult schema', () => {
  const parsed = parseToolCall({
    v: 1, callId: 'c1', tool: 'chat_memory_recall', args: { limit: 5 }, turnToken: 'tok',
  });
  assert.equal(parsed.args.limit, 5); // default 应用后保留
  assert.equal(parseToolCall({ v: 1, callId: 'c1', tool: 't', args: {}, turnToken: 'tok' }).sessionKey, undefined);
  assert.throws(() => parseToolCall({ v: 2, callId: 'c1', tool: 't', turnToken: 'tok' }), /toolCall invalid/);
  assert.throws(() => parseToolCall({ v: 1, callId: 'c1', tool: 't', turnToken: 'tok', extra: 1 }), /toolCall invalid/);
  const ok = parseToolResult({ v: 1, callId: 'c1', ok: true, data: { a: 1 } });
  assert.equal(ok.ok, true);
  assert.throws(() => parseToolResult({ v: 1, callId: 'c1', ok: false }), /must carry error/);
  // 执行器业务降级码（2026-11-25 补录）必须是合法 toolResult——否则网关序列化
  // 自身失败（400 E_SCHEMA），模型拿到误导性的 E_DSH_DOWN 而非真实错误。
  for (const code of ['E_NOT_FOUND', 'E_NOT_READY', 'E_SERVICE']) {
    parseToolResult({ v: 1, callId: 'c1', ok: false, error: { code, message: '降级' } });
  }
  assert.throws(() => parseToolResult({ v: 1, callId: 'c1', ok: false, error: { code: 'E_NOT_IN_ENUM', message: 'x' } }), /toolResult invalid/);
});

// ------------------------------------------------------- executor：假上游

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('service-registry: callServiceTool 打到登记服务的 /v1/tools/call；契约与 callId 关联', async () => {
  const calls = [];
  let corrupt = false; // 打开后返回 callId 不匹配的坏响应
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ url: req.url, body: body ? JSON.parse(body) : {} });
      if (req.url !== '/v1/tools/call') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      const parsed = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        v: 1,
        callId: corrupt ? 'someone-else' : parsed.callId,
        ok: true,
        data: { memories: [{ id: 'm1', content: '话题：旅行' }] },
      }));
    });
  });
  const baseUrl = await listen(server);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-tool-'));
  // 登记身份 = 随机 hash（对象唯一性）；name 只是展示名。
  const memId = crypto.randomUUID().replaceAll('-', '');
  fs.writeFileSync(path.join(dir, `${memId}.json`), JSON.stringify({
    v: 1, id: memId, name: 'memory-mcp', kind: 'resource', transport: 'http', url: baseUrl, secret: SECRET,
    tools: [{ name: 'chat_memory_recall', description: '查记忆', inputSchema: { type: 'object' } }],
  }));
  const { createServiceRegistry } = await import(new URL('../src/core/service-registry.mjs', import.meta.url).href);
  try {
    const registry = createServiceRegistry({
      servicesFile: path.join(dir, 'services.json'),
      stateDir: dir,
      registrations: { dir, ledgerFile: path.join(dir, 'ledger.jsonl'), reloadMs: 0 },
      logger: () => {},
    });
    const ok = await registry.callServiceTool(memId, {
      tool: 'chat_memory_recall', args: { limit: 5 }, sessionKey: 'qq:group:1', turnId: 't1',
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.data.memories[0].id, 'm1');
    assert.equal(calls[0].body.tool, 'chat_memory_recall');
    assert.equal(calls[0].body.args.limit, 5);
    assert.equal(calls[0].body.sessionKey, 'qq:group:1');
    assert.equal(calls[0].body.turnToken, undefined, 'turnToken 绝不下放服务（安全链不下放）');
    // callId 不匹配的坏响应 → E_SCHEMA（调用方翻译成 degraded 工具结果）。
    corrupt = true;
    await assert.rejects(
      () => registry.callServiceTool(memId, { tool: 'chat_memory_recall', args: {} }),
      /callId mismatch/,
    );
    // 未知/禁用服务 → 拒绝。
    await assert.rejects(() => registry.callServiceTool('nope', { tool: 'x' }), /unknown service/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tool-host: 登记工具经服务执行器路由；业务失败透传；内置优先不遮蔽', async () => {
  const calls = [];
  const serviceTools = {
    resolveTool: (name) => (name === 'chat_memory_recall' ? { serviceId: 'memory-mcp', name } : null),
    listTools: () => [{ name: 'chat_memory_recall', description: '查记忆', inputSchema: { type: 'object' }, serviceId: 'memory-mcp' }],
    call: async (serviceId, request) => {
      calls.push({ serviceId, ...request });
      return request.args.fail
        ? { callId: 'x', ok: false, error: { code: 'E_ACTION', message: 'content is required' } }
        : { callId: 'x', ok: true, data: { memories: [] } };
    },
  };
  const host = makeHost(() => ({ ok: true, receipt: {} }), { serviceTools });
  host.registerTurn({ turnId: 'turn_1', turnToken: 'tok-1', sessionKey: 'qq:group:1' });
  const ok = await host.handle({ callId: 'c1', tool: 'chat_memory_recall', args: {}, turnToken: 'tok-1' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.data, { memories: [] });
  assert.equal(calls[0].serviceId, 'memory-mcp');
  assert.equal(calls[0].sessionKey, 'qq:group:1', 'sessionKey 随调用下发（令牌反查派生）');
  assert.equal(calls[0].turnId, 'turn_1');
  assert.equal(calls[0].turnToken, undefined, 'turnToken 不下放');
  const failed = await host.handle({ callId: 'c2', tool: 'chat_memory_recall', args: { fail: true }, turnToken: 'tok-1' });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'E_ACTION', '业务失败是正常结果，原样透传');
  // 内置优先：内置 executor 的同名工具不被登记文件遮蔽。
  const registry = createExecutorRegistry();
  registry.add(toolExecutor(() => ({ ok: true, receipt: { from: 'builtin' } })));
  const host2 = createToolHost({
    executorRegistry: registry,
    serviceTools: {
      resolveTool: (name) => ({ serviceId: 'svc', name }),
      listTools: () => [{ name: 'chat_fake_echo', description: 'd', inputSchema: {} }],
      call: async () => { throw new Error('builtin tool must not route to service'); },
    },
    logger: () => {},
  });
  host2.registerTurn({ turnId: 'turn_2', turnToken: 'tok-2', sessionKey: 'qq:group:1' });
  const builtinWins = await host2.handle({ callId: 'c3', tool: 'chat_fake_echo', args: {}, turnToken: 'tok-2' });
  assert.deepEqual(builtinWins.data, { from: 'builtin' });
  // 清单合并：内置 ∪ 显式 isAgentTool 的登记（同名去重，内置在前）。
  // 白名单式（2026-11-25）：登记工具缺省不进清单——chat_fake_echo 未声明
  // isAgentTool，只剩内置 chat_fake_echo；chat_memory_recall 同样未声明。
  assert.deepEqual(host2.listTools().map((tool) => tool.name), ['chat_fake_echo']);
  assert.deepEqual(host.listTools().map((tool) => tool.name).sort(), ['chat_fake_echo']);

  // isAgentTool 白名单：登记工具缺省不进 /v1/tools 模型清单（网关本地工具），
  // 但 handle 调用路径照常路由（sessionSave/媒体旁路等内部通道可达）。
  const hostLocal = createToolHost({
    executorRegistry: createExecutorRegistry(),
    serviceTools: {
      resolveTool: (name) => (name === 'chat_memory_save' ? { serviceId: 'svc', name } : null),
      listTools: () => [
        { name: 'chat_memory_recall', description: '模型面', inputSchema: { type: 'object' }, serviceId: 'svc', isAgentTool: true },
        { name: 'chat_memory_save', description: '网关本地（缺省不暴露）', inputSchema: { type: 'object' }, serviceId: 'svc' },
      ],
      call: async () => ({ callId: 'x', ok: true, data: { saved: true } }),
    },
    logger: () => {},
  });
  assert.deepEqual(
    hostLocal.listTools().map((tool) => tool.name),
    ['chat_memory_recall'],
    '缺省 isAgentTool 不进模型清单（白名单式）',
  );
  hostLocal.registerTurn({ turnId: 'turn_l', turnToken: 'tok-l', sessionKey: 'qq:group:1' });
  const localCall = await hostLocal.handle({ callId: 'c4', tool: 'chat_memory_save', args: {}, turnToken: 'tok-l' });
  assert.equal(localCall.ok, true, '缺省工具仍可经内部通道调用');
});

// ---------------------------------------------------------- HTTP 契约路由

async function startServer(env, runtime) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-tools-'));
  seedConsumer(stateDir, { id: 'qq-main', platform: 'qq', secret: 'adapter-secret-0123456789' });
  // mcp-bus 共享密钥是文件单源（env 通道已退役）：GATEWAY_TOOLS=on 的用例预置密钥文件。
  seedBusSecret(stateDir, SECRET);
  const config = loadConfig({ env, stateDir });
  const services = env.GATEWAY_MODE === 'off' ? null : createConsumerRegistry({ stateDir });
  const gateway = createGatewayServer({ config, logger: () => {}, runtime, services });
  await gateway.listen();
  // GATEWAY_PORT=0 时 config.port 是 0，实际端口要从 server 取。
  return { gateway, port: gateway.server.address().port };
}

test('server: /v1/tools 与 /v1/tools/call（HMAC 鉴权 + runtime 注入）', async () => {
  const handled = [];
  const { gateway, port } = await startServer(
    { GATEWAY_MODE: 'on', GATEWAY_TOOLS: 'on', GATEWAY_PORT: '0' },
    {
      toolCall: async (parsed) => {
        handled.push(parsed);
        return { ok: true, data: { memories: [] } };
      },
      toolList: () => [{ name: 'chat_memory_recall', description: 'x', action: 'memory.query', inputSchema: { type: 'object', properties: {} } }],
      toolStatus: () => ({ liveTurns: 0, tools: ['chat_memory_recall'] }),
      submit() {}, stop() {}, status() { return {}; },
    },
  );
  try {
    const base = `http://127.0.0.1:${port}`;
    const headers = signRequest({ secret: SECRET, adapterId: 'mcp-bus', body: '' });
    const toolsRes = await fetch(`${base}/v1/tools`, { headers });
    assert.equal(toolsRes.status, 200);
    const toolsData = await toolsRes.json();
    assert.equal(toolsData.tools[0].name, 'chat_memory_recall');

    const callBody = JSON.stringify({ v: 1, callId: 'c1', tool: 'chat_memory_recall', args: { limit: 5 }, turnToken: 'tok' });
    const callRes = await fetch(`${base}/v1/tools/call`, {
      method: 'POST', headers: signRequest({ secret: SECRET, adapterId: 'mcp-bus', body: callBody }), body: callBody,
    });
    assert.equal(callRes.status, 200);
    const callData = await callRes.json();
    assert.equal(callData.ok, true);
    assert.deepEqual(callData.data, { memories: [] });
    assert.equal(handled[0].turnToken, 'tok');

    // 错误密钥 → 401；schema 违规 → 400；runtime 未注入 handler → 503。
    const badRes = await fetch(`${base}/v1/tools/call`, {
      method: 'POST', headers: signRequest({ secret: 'wrong-wrong-wrong-wrong', adapterId: 'mcp-bus', body: callBody }), body: callBody,
    });
    assert.equal(badRes.status, 401);
    const badSchema = JSON.stringify({ v: 1, callId: 'c2' });
    const schemaRes = await fetch(`${base}/v1/tools/call`, {
      method: 'POST', headers: signRequest({ secret: SECRET, adapterId: 'mcp-bus', body: badSchema }), body: badSchema,
    });
    assert.equal(schemaRes.status, 400);
    assert.equal((await schemaRes.json()).error.code, 'E_SCHEMA');
  } finally {
    await gateway.close();
  }
});

test('server: tools=off 时 /v1/tools 与 /v1/tools/call 返回 503', async () => {
  const { gateway, port } = await startServer(
    { GATEWAY_MODE: 'on', GATEWAY_TOOLS: 'off', GATEWAY_PORT: '0' },
    { submit() {}, stop() {}, status() { return {}; } },
  );
  try {
    const headers = signRequest({ secret: SECRET, adapterId: 'mcp-bus', body: '' });
    const res = await fetch(`http://127.0.0.1:${port}/v1/tools`, { headers });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'E_DISABLED');
  } finally {
    await gateway.close();
  }
});

// ------------------------------------------------------------- mcp-bus 薄壳

// 假网关：/v1/tools/call 可按开关返回 400 错误（供错误详情透传用例复用）。
function createBusFakeGateway({ calls, failWith = null } = {}) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      if (failWith) res.writeHead(failWith.status, { 'content-type': 'application/json' });
      else res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/v1/tools') {
        res.end(JSON.stringify({ ok: true, tools: [{ name: 'chat_memory_recall', description: '查记忆', action: 'memory.query', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } } }] }));
      } else if (failWith) {
        res.end(JSON.stringify({ ok: false, error: { code: failWith.code, message: failWith.message } }));
      } else {
        res.end(JSON.stringify({ v: 1, callId: calls.at(-1).body.callId, ok: true, data: { memories: [] } }));
      }
    });
  });
}

test('mcp-bus: initialize/tools/list/tools/call 全链路（经假网关）', async () => {
  const calls = [];
  const server = createBusFakeGateway({ calls });
  const baseUrl = await listen(server);
  try {
    const bus = createMcpBus({ gatewayUrl: baseUrl, secret: SECRET, logger: () => {} });
    const init = await bus.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    assert.equal(init.result.serverInfo.name, 'agent-gateway-mcp-bus');
    assert.equal(await bus.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    const list = await bus.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tool = list.result.tools[0];
    assert.equal(tool.name, 'chat_memory_recall');
    assert.equal(tool.inputSchema.required.includes('turnToken'), true, 'turnToken 必须注入为必填参数');
    const call = await bus.handleMessage({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'chat_memory_recall', arguments: { limit: 5, turnToken: 'tok-9' } },
    });
    assert.equal(call.result.isError, false);
    const forwarded = calls.at(-1);
    assert.equal(forwarded.body.tool, 'chat_memory_recall');
    assert.equal(forwarded.body.turnToken, 'tok-9');
    assert.equal(forwarded.body.args.limit, 5);
    assert.equal(forwarded.body.args.turnToken, undefined, 'turnToken 不应留在 args 里');
    assert.equal(forwarded.headers['x-adapter-id'], 'mcp-bus');
    assert.match(forwarded.headers['x-signature'], /^v1=/);
    // 网关不可达 → isError 结果而非抛异常。
    const brokenBus = createMcpBus({ gatewayUrl: 'http://127.0.0.1:9', secret: SECRET, requestTimeoutMs: 300, logger: () => {} });
    const failed = await brokenBus.handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'chat_memory_recall', arguments: { turnToken: 'tok' } } });
    assert.equal(failed.result.isError, true);
    const parsed = JSON.parse(failed.result.content[0].text);
    assert.equal(parsed.ok, false);
    // 未知方法 → -32601。
    const unknown = await bus.handleMessage({ jsonrpc: '2.0', id: 5, method: 'resources/list' });
    assert.equal(unknown.error.code, -32601);
  } finally {
    server.close();
  }
});

test('mcp-bus: 模型漏传 turnToken → 请求体省略字段（2026-11-25 防呆）', async () => {
  const calls = [];
  const server = createBusFakeGateway({ calls });
  const baseUrl = await listen(server);
  try {
    const bus = createMcpBus({ gatewayUrl: baseUrl, secret: SECRET, logger: () => {} });
    await bus.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'chat_media_send', arguments: { mediaId: 'ma_0123456789ab' } } });
    const forwarded = calls.at(-1);
    assert.equal('turnToken' in forwarded.body, false, '漏传令牌时不应带空串字段（空串会被网关拒成 400 E_SCHEMA，模型拿不到 E_FORBIDDEN 自纠指引）');
    assert.equal(forwarded.body.args.mediaId, 'ma_0123456789ab');
    // 显式传空串同样按「缺失」处理。
    await bus.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'chat_media_send', arguments: { mediaId: 'ma_0123456789ab', turnToken: '' } } });
    assert.equal('turnToken' in calls.at(-1).body, false, '显式空串也按缺失省略');
  } finally {
    server.close();
  }
});

test('mcp-bus: 网关 4xx 错误详情透传（E_SCHEMA 等不再丢失）', async () => {
  const calls = [];
  const server = createBusFakeGateway({ calls, failWith: { status: 400, code: 'E_SCHEMA', message: 'toolCall invalid: turnToken Too small' } });
  const baseUrl = await listen(server);
  try {
    const bus = createMcpBus({ gatewayUrl: baseUrl, secret: SECRET, logger: () => {} });
    const resp = await bus.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'chat_media_send', arguments: { turnToken: 'x' } } });
    assert.equal(resp.result.isError, true);
    const parsed = JSON.parse(resp.result.content[0].text);
    assert.equal(parsed.error.code, 'E_DSH_DOWN');
    assert.match(parsed.error.message, /\(E_SCHEMA: toolCall invalid: turnToken Too small\)/, '错误详情应含 (错误码: 消息)，不得静默丢失');
  } finally {
    server.close();
  }
});

test('withTurnToken: 保留原 schema 字段并强制 turnToken 必填', () => {
  const out = withTurnToken({ name: 'chat_x', description: 'd', inputSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } });
  assert.deepEqual(out.inputSchema.required, ['a', 'turnToken']);
  assert.equal(out.inputSchema.properties.a.type, 'string');
  assert.equal(withTurnToken({ name: 'chat_y', description: 'd', inputSchema: null }).inputSchema.type, 'object');
});

// ------------------------------------------------- turn-runner 集成（注册/注销）

function createFakeDsh() {
  let seq = 0;
  const state = { sessions: new Map(), prompts: [] };
  let onFrame = null;
  return {
    state,
    emit(payload) { onFrame?.(payload); },
    finishTurn(sessionId, text) {
      const s = state.sessions.get(sessionId);
      const turn = `t${++s.turns}`;
      this.emit({ type: 'session/event', sessionId, event: { type: 'turn/start', data: { turn } } });
      this.emit({ type: 'session/event', sessionId, event: { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } } });
      this.emit({ type: 'session/event', sessionId, event: { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } } });
    },
    async listPresets() { return ['qq-chat', 'minimal']; },
    async ensureWorkspace() { return 'ws'; },
    async createSession() { const id = `s${++seq}`; state.sessions.set(id, { turns: 0 }); return id; },
    async selectModel() { return {}; },
    async prompt({ sessionId, text }) { state.prompts.push({ sessionId, text }); return { result: { ok: true, value: {} } }; },
    follow() {}, forget() {},
    startStream(cb) { onFrame = cb; },
    stopStream() { onFrame = null; },
    get connected() { return true; },
  };
}

test('turn-runner: turn 存活期间 ToolHost 有活跃登记，结束后注销', async () => {
  const dsh = createFakeDsh();
  const chat = { preset: 'qq-chat', provider: 'p', model: 'm', reasoningEffort: 'max', workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gw-th-')), turnTimeoutMs: 2000 };
  const registry = createSessionRegistry({ presetsFor: PRESETS_FOR, dsh, chat, file: null });
  const gateway = createDshGateway({ dsh, turnTimeoutMs: 2000 });
  const turns = createTurnStore({ file: null });
  const toolHost = makeHost(() => ({ ok: true, receipt: {} }));
  const runner = createTurnRunner({
    config: { chat, context: { mode: 'off' }, tools: { mode: 'on' } },
    dsh, registry, gateway, queue: createPromptQueue({}), turns, toolHost, logger: () => {},
  });
  gateway.start();
  const done = runner.submit({
    turnId: 'turn_th1', sessionKey: 'qq:group:7',
    envelope: { platform: 'qq', conversation: { kind: 'group', id: '7' }, message: { id: 'm1', sender: { id: '1', name: 'a', roles: ['member'] }, text: 'hi' } },
    degraded: [],
  });
  await waitFor(() => dsh.state.prompts.length === 1);
  assert.equal(toolHost.status().liveTurns, 1, 'prompt 发出后 turn 必须处于登记状态');
  dsh.finishTurn(dsh.state.prompts[0].sessionId, 'ok');
  await done;
  assert.equal(toolHost.status().liveTurns, 0, 'turn 结束后必须注销');
  gateway.stop();
});


test('tool-host: 白名单通道已退役——无 turnToken 调用（含 chat_role_render）一律 E_FORBIDDEN', async () => {
  // 2026-11-21：persona 插件改为 bootstrap+HMAC 直连 rolecard，网关不再中转
  // render——免 token 白名单通道随之删除。任何无 token 调用都落主路径被拒。
  const seen = [];
  const serviceTools = {
    resolveTool: (name) => (name === 'chat_role_render' ? { serviceId: 'svc-rolecard', name } : null),
    listTools: () => [],
    call: async (serviceId, request) => {
      seen.push({ serviceId, request });
      return { ok: true, data: {} };
    },
  };
  const host = createToolHost({
    executorRegistry: createExecutorRegistry(),
    serviceTools,
    logger: () => {},
  });
  const result = await host.handle({ callId: 'c1', tool: 'chat_role_render', args: {} });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'E_FORBIDDEN');
  assert.equal(seen.length, 0, '拒绝路径不得外发调用');
  assert.equal(host.status().liveTurns, 0);
});

test('tool-host: 无 turnToken 调用未知工具仍 E_FORBIDDEN（主路径统一拒绝）', async () => {
  const host = makeHost(() => ({ ok: true, receipt: {} }));
  const result = await host.handle({ callId: 'c1', tool: 'chat_fake_echo', args: {} });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'E_FORBIDDEN');
});

test('tool-host: 带合法 turnToken 时登记工具走 turn 路径（sessionKey 随回合）', async () => {
  const seen = [];
  const serviceTools = {
    resolveTool: (name) => (name === 'chat_role_render' ? { serviceId: 'svc-rolecard', name } : null),
    listTools: () => [],
    call: async (serviceId, request) => { seen.push({ serviceId, request }); return { ok: true, data: {} }; },
  };
  const host = createToolHost({
    executorRegistry: createExecutorRegistry(),
    serviceTools,
    logger: () => {},
  });
  host.registerTurn({ turnId: 'turn_1', turnToken: 'tok-1', sessionKey: 'qq:group:1' });
  const result = await host.handle({ callId: 'c1', tool: 'chat_role_render', args: {}, turnToken: 'tok-1' });
  assert.equal(result.ok, true);
  assert.equal(seen[0].request.sessionKey, 'qq:group:1');
  assert.equal(host.status().liveTurns, 1);
});
