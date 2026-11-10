// web-search executor 测试：key 发现 / SSRF 防护 / 响应映射 / 缓存 / 熔断 /
// registry + tool-host + 真实网关 + mcp-bus JSON-RPC 全链路（chat_web_search 可调）。
//
// 手法：真起 http 假上游（Anthropic Messages 形状），executor 用
// validateEndpoint:false 指向它（SSRF 校验本身有独立单测，不需要真外网）；
// mcp-bus 链路用 createGatewayServer + createMcpBus.handleMessage 走真实
// JSON-RPC——「经 mcp-bus 可调」在这条测试里被端到端钉住。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { createWebSearchExecutor, resolveSearchApiKey, readDshCredentialRef, validateSearchEndpoint, isPrivateAddress } =
  await import(new URL('../src/executors/web-search.mjs', import.meta.url).href);
const { createExecutorRegistry } = await import(new URL('../src/executors/executor-interface.mjs', import.meta.url).href);
const { createToolHost } = await import(new URL('../src/runtime/tool-host.mjs', import.meta.url).href);
const { loadConfig } = await import(new URL('../src/core/config.mjs', import.meta.url).href);
const { createGatewayServer } = await import(new URL('../src/core/server.mjs', import.meta.url).href);
const { createMcpBus } = await import(new URL('../src/mcp-bus.mjs', import.meta.url).href);

const KEY = 'sk-test-web-search-key-0123456789';
const SECRET = 'test-secret-0123456789abcdef';

/** 假 DeepSeek 上游：POST /messages 回 Anthropic 形状；requests 记录每次请求。 */
async function withFakeUpstream({ payload, status = 200 } = {}, run) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, headers: { ...req.headers }, body: body ? JSON.parse(body) : null });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(typeof payload === 'function' ? payload(requests.length) : payload));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run({ baseUrl, requests });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function makeExecutor({ baseUrl, ...rest } = {}) {
  return createWebSearchExecutor({
    apiKey: KEY,
    baseUrl,
    validateEndpoint: false, // 假上游跑在 http://127.0.0.1 上；SSRF 校验有独立单测
    timeoutMs: 5000,
    env: {},
    logger: () => {},
    ...rest,
  });
}

/** Anthropic 形状：结果块 + 文本引用块（cite.url 带 `#1` 锚点，验证清理）。 */
function deepseekPayload(items) {
  return {
    content: [
      {
        type: 'web_search_tool_result',
        content: items.map((item) => ({ type: 'web_search_result', url: item.url, title: item.title, page_age: item.page_age })),
      },
      {
        type: 'text',
        text: '根据搜索结果……',
        citations: items.map((item) => ({ url: `${item.url}#1`, cited_text: item.snippet })),
      },
    ],
  };
}

const RESULTS = [
  { url: 'https://example.com/a', title: '结果 A', snippet: '片段 A', page_age: '2 days ago' },
  { url: 'https://example.com/b', title: '结果 B', snippet: '片段 B' },
];

const ctx = (overrides = {}) => ({
  sessionKey: 'qq:group:456',
  turnId: 'turn_1',
  turnToken: 'tok',
  payload: {},
  ...overrides,
});

// ── key 发现 ────────────────────────────────────────────────────────────────

test('key 发现：param → GATEWAY_WEB_SEARCH_KEY → key 文件 → DEEPSEEK_API_KEY → DSH 凭据', () => {
  assert.deepEqual(resolveSearchApiKey({ apiKey: ' k1 ', env: {} }), { key: 'k1', source: 'param' });
  assert.deepEqual(resolveSearchApiKey({ env: { GATEWAY_WEB_SEARCH_KEY: 'k2' } }), { key: 'k2', source: 'env' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'websearch-test-'));
  const keyFile = path.join(dir, 'search.key');
  fs.writeFileSync(keyFile, 'k3\n');
  assert.deepEqual(resolveSearchApiKey({ env: { GATEWAY_WEB_SEARCH_KEY_FILE: keyFile } }), { key: 'k3', source: 'key-file' });

  assert.deepEqual(resolveSearchApiKey({ env: { DEEPSEEK_API_KEY: 'k4' } }), { key: 'k4', source: 'env-deepseek' });

  const dshHome = path.join(dir, 'dsh-home');
  fs.mkdirSync(dshHome);
  fs.writeFileSync(
    path.join(dshHome, '.credentials.yaml'),
    '# comment\nother: value\nrefs:\n  OTHER_KEY: should-not-read\n  DEEPSEEK_API_KEY: "k5"\n',
  );
  assert.deepEqual(resolveSearchApiKey({ env: { DSH_HOME: dshHome } }), { key: 'k5', source: 'dsh-credentials' });
  // 缺失/写坏的凭据文件 = 该来源没有 key，绝不抛异常。
  assert.equal(readDshCredentialRef('MISSING_REF', { DSH_HOME: dshHome }), '');
  assert.equal(readDshCredentialRef('DEEPSEEK_API_KEY', { DSH_HOME: path.join(dir, 'nope') }), '');

  // 全部落空：source=none，工厂拒绝装配（宁可缺工具，不放必然失败的占位工具）。
  assert.deepEqual(resolveSearchApiKey({ env: {} }), { key: '', source: 'none' });
  assert.throws(() => createWebSearchExecutor({ env: {} }), /no web-search API key/);
});

// ── SSRF 防护 ───────────────────────────────────────────────────────────────

test('SSRF：http/带凭据/回环/内网端点一律拒绝；私网地址表覆盖 v4/v6/映射地址', async () => {
  await assert.rejects(() => validateSearchEndpoint('http://api.deepseek.com/anthropic/v1'), /must be https/);
  await assert.rejects(() => validateSearchEndpoint('https://user:pass@api.deepseek.com/v1'), /credentials/);
  await assert.rejects(() => validateSearchEndpoint('https://127.0.0.1/v1'), /no public address/);
  await assert.rejects(() => validateSearchEndpoint('https://localhost/v1'), /no public address/);
  await assert.rejects(() => validateSearchEndpoint('not a url'), /invalid/);

  for (const address of ['0.0.0.1', '10.1.2.3', '127.0.0.1', '100.64.0.1', '169.254.1.1', '172.16.0.1', '192.168.1.1', '::', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

// ── 调用链路 ────────────────────────────────────────────────────────────────

test('调用：Anthropic 响应映射（锚点清理/引用片段/key 只进请求头）', async () => {
  await withFakeUpstream({ payload: deepseekPayload(RESULTS) }, async ({ baseUrl, requests }) => {
    const executor = makeExecutor({ baseUrl });
    const result = await executor.call({ action: 'web_search', ctx: ctx({ payload: { query: '测试搜索' } }) });
    assert.equal(result.ok, true);
    assert.equal(result.receipt.provider, 'deepseek');
    assert.equal(result.receipt.query, '测试搜索');
    assert.equal(result.receipt.results.length, 2);
    assert.equal(result.receipt.results[0].url, 'https://example.com/a');
    assert.equal(result.receipt.results[0].snippet, '片段 A');
    assert.equal(result.receipt.results[0].publishedAt, '2 days ago');
    assert.equal(result.receipt.results[1].publishedAt, undefined);
    assert.equal(result.receipt.results[0].url.includes('#1'), false, '纯数字锚点应被清理');

    const request = requests[0];
    assert.equal(request.url, '/messages');
    assert.equal(request.headers['x-api-key'], KEY);
    assert.equal(request.headers.authorization, `Bearer ${KEY}`);
    assert.equal(request.body.tools[0].type, 'web_search_20250305');
    assert.match(request.body.messages[0].content[0].text, /测试搜索/);
  });
});

test('调用：无结果块/HTTP 错误降级且 key 不泄漏；空结果带可操作 note', async () => {
  await withFakeUpstream({ payload: { content: [{ type: 'text', text: 'no search happened' }] } }, async ({ baseUrl }) => {
    const executor = makeExecutor({ baseUrl });
    const result = await executor.call({ action: 'web_search', ctx: ctx({ payload: { query: 'q' } }) });
    assert.equal(result.ok, false);
    assert.equal(result.degraded, true);
    assert.match(result.message, /no web_search_tool_result/);
  });

  await withFakeUpstream({ status: 401, payload: { error: { message: 'bad key' } } }, async ({ baseUrl }) => {
    const executor = makeExecutor({ baseUrl });
    const result = await executor.call({ action: 'web_search', ctx: ctx({ payload: { query: 'q' } }) });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_PLATFORM');
    assert.match(result.message, /HTTP 401/);
    assert.match(result.message, /bad key/);
    assert.equal(result.message.includes(KEY), false, '错误信息绝不包含 API key');
  });

  await withFakeUpstream({ payload: deepseekPayload([]) }, async ({ baseUrl }) => {
    const executor = makeExecutor({ baseUrl });
    const result = await executor.call({ action: 'web_search', ctx: ctx({ payload: { query: 'q' } }) });
    assert.equal(result.ok, true);
    assert.deepEqual(result.receipt.results, []);
    assert.match(result.receipt.note, /没有搜到结果/);
  });
});

test('参数清洗：空/超长 query 是 E_ACTION；maxResults 参与缓存键', async () => {
  await withFakeUpstream({ payload: deepseekPayload(RESULTS) }, async ({ baseUrl, requests }) => {
    const executor = makeExecutor({ baseUrl });
    const empty = await executor.call({ action: 'web_search', ctx: ctx({ payload: { query: '   ' } }) });
    assert.equal(empty.code, 'E_ACTION');
    const tooLong = await executor.call({ action: 'web_search', ctx: ctx({ payload: { query: 'x'.repeat(201) } }) });
    assert.equal(tooLong.code, 'E_ACTION');

    // 同 query 不同 maxResults = 不同缓存键（结果条数不同，语义上必须分开）。
    await executor.call({ action: 'web_search', ctx: ctx({ payload: { query: 'q', maxResults: 1 } }) });
    await executor.call({ action: 'web_search', ctx: ctx({ payload: { query: 'q', maxResults: 20 } }) });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, '/messages');
  });
});

test('缓存：TTL 内同查询只打一次上游', async () => {
  await withFakeUpstream({ payload: deepseekPayload(RESULTS) }, async ({ baseUrl, requests }) => {
    const executor = makeExecutor({ baseUrl });
    const first = await executor.call({ action: 'web_search', ctx: ctx({ payload: { query: '同一句话' } }) });
    const second = await executor.call({ action: 'web_search', ctx: ctx({ payload: { query: '同一句话' } }) });
    assert.equal(requests.length, 1, 'TTL 内第二次调用必须命中缓存');
    assert.deepEqual(second.receipt, first.receipt);
  });
});

test('熔断：连续 3 次失败后短路，第 4 次不再打上游', async () => {
  await withFakeUpstream({ status: 500, payload: { error: 'down' } }, async ({ baseUrl, requests }) => {
    const executor = makeExecutor({ baseUrl });
    for (let i = 0; i < 3; i += 1) {
      const result = await executor.call({ action: 'web_search', ctx: ctx({ payload: { query: `q${i}` } }) });
      assert.equal(result.ok, false);
    }
    assert.equal(requests.length, 3);
    const fourth = await executor.call({ action: 'web_search', ctx: ctx({ payload: { query: 'q4' } }) });
    assert.equal(fourth.ok, false);
    assert.match(fourth.message, /circuit open/);
    assert.equal(requests.length, 3, '熔断打开后不再消耗上游');
  });
});

// ── 集成：registry + tool-host + 真实网关 + mcp-bus 全链路 ──────────────────

test('集成：chat_web_search 经 /v1/tools 与 mcp-bus JSON-RPC 端到端可调', async () => {
  await withFakeUpstream({ payload: deepseekPayload(RESULTS) }, async ({ baseUrl }) => {
    const registry = createExecutorRegistry();
    registry.add(makeExecutor({ baseUrl }));
    const host = createToolHost({ executorRegistry: registry, logger: () => {}, callTimeoutMs: 5000 });
    host.registerTurn({ turnId: 'turn_1', turnToken: 'tok-1', sessionKey: 'qq:group:456' });

    const config = loadConfig({
      env: {
        GATEWAY_MODE: 'off',
        GATEWAY_PORT: '0',
        GATEWAY_HOST: '127.0.0.1',
        GATEWAY_TOOLS: 'on',
        GATEWAY_MCP_TOKEN: SECRET,
      },
      stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'websearch-gw-')),
      adapters: [{ id: 'qq-test', platform: 'qq', secret: SECRET }],
    });
    const gateway = createGatewayServer({
      config,
      logger: () => {},
      runtime: {
        toolList: () => registry.listTools(),
        toolCall: (parsed) => host.handle(parsed),
      },
    });
    await gateway.listen();
    try {
      // 真实 mcp-bus 薄壳（stdio 入口之外的 handleMessage 是同一处理函数）。
      const bus = createMcpBus({
        gatewayUrl: `http://127.0.0.1:${gateway.server.address().port}`,
        secret: SECRET,
        logger: () => {},
      });

      const listed = await bus.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const listedTool = listed.result.tools.find((tool) => tool.name === 'chat_web_search');
      assert.ok(listedTool, `tools/list should include chat_web_search, got ${listed.result.tools.map((tool) => tool.name).join(',')}`);
      assert.ok(listedTool.inputSchema.required.includes('turnToken'), 'mcp-bus 必须注入 turnToken 参数');

      const called = await bus.handleMessage({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'chat_web_search', arguments: { query: 'gateway mcp-bus test', turnToken: 'tok-1' } },
      });
      assert.equal(called.result.isError, false);
      const payload = JSON.parse(called.result.content[0].text);
      assert.equal(payload.ok, true);
      assert.equal(payload.data.provider, 'deepseek');
      assert.ok(payload.data.results.length >= 1);
      assert.equal(payload.data.results[0].url.includes('#1'), false);
    } finally {
      await gateway.close();
      host.releaseTurn('turn_1');
    }
  });
});
