// qq-tools 清单驱动 executor 测试：工具面生成 + 动作信封投递 + 回执契约。
//
// 手法与 test-tool-host.mjs 一致：真起 HTTP 假适配器（服务端**真验签**——
// 证明 executor 的本地签名实现与线缆契约一致），用 registry/tool-host 真链路
// 驱动，断言模型侧看到的结果形状。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

const { createAdapterToolsExecutor, fetchAdapterManifest } =
  await import(new URL('../src/executors/adapter-tools/index.mjs', import.meta.url).href);
const { passthrough } =
  await import(new URL('../src/executors/adapter-tools/common/capability.mjs', import.meta.url).href);
const { CAPABILITIES: QQ_CAPABILITIES } =
  await import(new URL('../src/executors/adapter-tools/qq/index.mjs', import.meta.url).href);
const { CAPABILITIES: WX_CAPABILITIES } =
  await import(new URL('../src/executors/adapter-tools/wx/index.mjs', import.meta.url).href);
const { createExecutorRegistry } = await import(new URL('../src/executors/executor-interface.mjs', import.meta.url).href);
const { createToolHost } = await import(new URL('../src/runtime/tool-host.mjs', import.meta.url).href);

const SECRET = 'qq-tools-test-secret-0123456789';

/** 适配器侧验签：ts\nnonce\nsha256(body)，签名在 x-gateway-secret。 */
function verifyAdapterSignature({ secret, headers, body }) {
  const timestamp = headers['x-timestamp'];
  const nonce = headers['x-nonce'];
  const signature = headers['x-gateway-secret'];
  if (!timestamp || !nonce || !signature) return false;
  if (Math.abs(Date.now() - Number(timestamp)) > 60_000) return false;
  const digest = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}\n${nonce}\n${digest}`, 'utf8').digest('hex');
  return signature === `v1=${expected}`;
}

/** 与桥接 actions-manifest 同形的夹具：含投递类、读类、敏感类、显式未接线。 */
function manifestFixture(overrides = {}) {
  return {
    v: 1,
    platform: 'qq',
    adapter: 'qq-bridge',
    actions: [
      { type: 'send_text', summary: '发送纯文本', kind: 'write', wired: true, payloadSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 4000 } } } },
      { type: 'reply', summary: '回复指定消息', kind: 'write', wired: true, payloadSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
      { type: 'get_unread', summary: '读取未读消息', kind: 'read', payloadSchema: { type: 'object', properties: { key: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } } } },
      { type: 'social_state', summary: '读取社交状态机快照', kind: 'read', payloadSchema: { type: 'object', properties: {} } },
      { type: 'send_message', summary: '分句发送消息', kind: 'write', payloadSchema: { type: 'object', required: ['messages'], properties: { messages: { type: ['string', 'array'] } } } },
      { type: 'set_wake', summary: '设置唤醒配置', kind: 'sensitive', payloadSchema: { type: 'object', required: ['config'], properties: { config: { type: 'object' } } } },
      { type: 'get_history', summary: '读取群历史消息', kind: 'read', wired: false, payloadSchema: { type: 'object', required: ['groupId'], properties: { groupId: { type: ['string', 'number'] } } } },
    ],
    ...overrides,
  };
}

/**
 * 假适配器：GET /v1/actions/manifest + POST /v1/actions。
 * respond(envelope) 决定回执（默认成功回执，读类带 data）。
 */
async function withFakeAdapter({ manifest = manifestFixture(), respond, secret = SECRET } = {}, run) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const signed = verifyAdapterSignature({ secret, headers: req.headers, body });
      requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null, signed });
      if (!signed) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'E_AUTH', message: 'bad signature' } }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/actions/manifest') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(manifest));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/actions') {
        const envelope = JSON.parse(body);
        const reply = respond
          ? respond(envelope)
          : { v: 1, actionId: envelope.actionId, ok: true, at: Date.now(), data: { echo: envelope.type } };
        res.writeHead(reply.__status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'E_NOT_FOUND', message: req.url } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const adapter = { id: 'qq-main', platform: 'qq', secret, callbackBase: base };
  try {
    return await run({ adapter, base, requests });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** 夹具清单通常只覆盖真实清单的一个子集：按清单类型过滤全量注册表。 */
const capsFor = (manifest) =>
  QQ_CAPABILITIES.filter((cap) => (manifest.actions ?? []).some((entry) => entry?.type === cap.type));

function makeExecutor({ adapter, manifest = manifestFixture(), capabilities } = {}) {
  // 未显式给能力注册表时按清单类型过滤（生产装配路径不做过滤——反向孤儿
  // 检测仍然钉住「清单 ↔ 平台目录 1:1」）。
  return createAdapterToolsExecutor({
    adapters: [{ adapter, manifest, capabilities: capabilities ?? capsFor(manifest) }],
    logger: () => {},
  });
}

const ctx = (overrides = {}) => ({
  sessionKey: 'qq:group:456',
  turnId: 'turn_1',
  turnToken: 'tok',
  payload: {},
  ...overrides,
});

// ── 工具面生成 ──────────────────────────────────────────────────────────────

test('工具面：清单动作全部进工具面（含发送类/敏感类），enabled:false 与 wired:false 不暴露', () => {
  return withFakeAdapter({}, async ({ adapter }) => {
    const executor = makeExecutor({ adapter });
    const names = executor.tools.map((tool) => tool.name);
    // 发送类不再让位任何执行器：adapter-tools 是全部清单动作的唯一 owner。
    for (const action of ['send_text', 'reply', 'send_message']) {
      assert.ok(names.includes(`chat_qq_${action}`), `${action} must be a tool now`);
      assert.ok(executor.actions.includes(action));
    }
    assert.ok(names.includes('chat_qq_get_unread'));
    assert.ok(names.includes('chat_qq_social_state'));
    // 敏感动作是否可用由清单 enabled 决定（提示词要求调用 set_wake，工具面不能缺）。
    const setWake = executor.tools.find((tool) => tool.name === 'chat_qq_set_wake');
    assert.ok(setWake);
    assert.match(setWake.description, /^\[敏感\]/);
    // 显式 wired:false（closed-agent 遗留、本机未接线）仍然不暴露。
    assert.equal(names.includes('chat_qq_get_history'), false);
    // action 与 tool 一一对应，schema 原样透传。
    const unread = executor.tools.find((tool) => tool.name === 'chat_qq_get_unread');
    assert.equal(unread.action, 'get_unread');
    assert.equal(unread.inputSchema.properties.limit.maximum, 100);
    assert.match(unread.description, /^\[读\] 读取未读消息/);
  });
});

test('工具面：enabled:false 的动作不暴露（适配器现算的可用性优先于 wired）', () => {
  return withFakeAdapter({}, async ({ adapter }) => {
    const manifest = manifestFixture();
    manifest.actions = manifest.actions.map((entry) => (
      entry.type === 'get_unread' ? { ...entry, enabled: false } : entry
    ));
    const executor = makeExecutor({ adapter, manifest });
    const names = executor.tools.map((tool) => tool.name);
    assert.equal(names.includes('chat_qq_get_unread'), false);
    assert.ok(names.includes('chat_qq_social_state'));
  });
});

test('工具面：清单重复 type 拒绝装配；全部被过滤时也拒绝（空工具面是装配错误）', async () => {
  await withFakeAdapter({}, async ({ adapter }) => {
    const dup = manifestFixture();
    dup.actions.push({ type: 'get_unread', summary: '重复', kind: 'read' });
    assert.throws(() => makeExecutor({ adapter, manifest: dup }), /duplicate action type/);

    const empty = { v: 1, platform: 'qq', actions: [{ type: 'send_text', summary: 'x', kind: 'write', enabled: false }] };
    assert.throws(() => makeExecutor({ adapter, manifest: empty }), /no usable actions/);

    // adapter 与清单平台不一致：宁可不装。
    assert.throws(() => makeExecutor({ adapter, manifest: manifestFixture({ platform: 'wx' }) }), /does not match/);
  });
});

// ── 调用链路 ────────────────────────────────────────────────────────────────

test('调用：信封 target 从 sessionKey 派生，签名投递，回执 data 原样上抛', () => {
  return withFakeAdapter({}, async ({ adapter, requests }) => {
    const executor = makeExecutor({ adapter });
    const result = await executor.call({ action: 'get_unread', ctx: ctx({ payload: { limit: 5 } }) });
    assert.equal(result.ok, true);
    assert.equal(result.receipt.data.echo, 'get_unread');
    const posted = requests.find((entry) => entry.method === 'POST');
    assert.equal(posted.signed, true, 'adapter must accept the executor signature');
    assert.equal(posted.body.v, 1);
    assert.equal(posted.body.type, 'get_unread');
    assert.deepEqual(posted.body.target, { platform: 'qq', conversationId: '456', kind: 'group' });
    assert.equal(posted.body.payload.limit, 5);
    assert.equal(posted.body.turnId, 'turn_1');
  });
});

test('调用：payload.key 显式指定跨会话目标；无法派生会话时 E_UNSUPPORTED', () => {
  return withFakeAdapter({}, async ({ adapter, requests }) => {
    const executor = makeExecutor({ adapter });
    await executor.call({ action: 'get_unread', ctx: ctx({ payload: { key: 'friend:789' } }) });
    const posted = requests.find((entry) => entry.method === 'POST');
    assert.deepEqual(posted.body.target, { platform: 'qq', conversationId: '789', kind: 'friend' });

    // 非 qq 会话 / 坏 sessionKey：不猜会话，结构化失败。
    const wrongPlatform = await executor.call({ action: 'get_unread', ctx: ctx({ sessionKey: 'wx:group:1' }) });
    assert.equal(wrongPlatform.ok, false);
    assert.equal(wrongPlatform.code, 'E_UNSUPPORTED');
    const malformed = await executor.call({ action: 'get_unread', ctx: ctx({ sessionKey: 'garbage' }) });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.code, 'E_UNSUPPORTED');
  });
});

test('调用：适配器 E_UNSUPPORTED 原样透传；不可达与非合规回执降级为 E_PLATFORM', async () => {
  await withFakeAdapter({
    respond: (envelope) => ({
      v: 1, actionId: envelope.actionId, ok: false, at: Date.now(),
      error: { code: 'E_UNSUPPORTED', message: 'get_unread is declared in the manifest but not wired in this adapter' },
    }),
  }, async ({ adapter }) => {
    const executor = makeExecutor({ adapter });
    const result = await executor.call({ action: 'get_unread', ctx: ctx() });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_UNSUPPORTED');
    assert.match(result.message, /not wired/);
  });

  // 不可达：降级，不抛异常。
  const offline = makeExecutor({
    adapter: { id: 'qq-main', platform: 'qq', secret: SECRET, callbackBase: 'http://127.0.0.1:9' },
  });
  const unreachable = await offline.call({ action: 'get_unread', ctx: ctx({ budget: { timeoutMs: 500 } }) });
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.code, 'E_PLATFORM');

  // 回 {} 的适配器不能被当成调用成功。
  await withFakeAdapter({ respond: () => ({}) }, async ({ adapter }) => {
    const executor = makeExecutor({ adapter });
    const result = await executor.call({ action: 'get_unread', ctx: ctx() });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_PLATFORM');
    assert.match(result.message, /non-conforming receipt/);
  });

  // actionId 不一致同样拒绝（防应答串线）。
  await withFakeAdapter({ respond: (envelope) => ({ v: 1, actionId: `${envelope.actionId}-other`, ok: true }) }, async ({ adapter }) => {
    const executor = makeExecutor({ adapter });
    const result = await executor.call({ action: 'get_unread', ctx: ctx() });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_PLATFORM');
  });
});

test('集成：registry 路由 + tool-host（chat_qq_* 工具调用返回 {ok, data}）', async () => {
  await withFakeAdapter({}, async ({ adapter }) => {
    const executor = makeExecutor({ adapter });
    const registry = createExecutorRegistry();
    registry.add(executor);
    // 模型侧工具名 → action 的映射来自 registry（MCP 薄壳的 tools/list 同源）。
    assert.equal(registry.actionForTool('chat_qq_get_unread'), 'get_unread');
    assert.equal(registry.actionForTool('chat_qq_send_text'), 'send_text');

    const host = createToolHost({ executorRegistry: registry, logger: () => {}, callTimeoutMs: 2000 });
    host.registerTurn({ turnId: 'turn_1', turnToken: 'tok-1', sessionKey: 'qq:group:456' });
    const ok = await host.handle({ callId: 'c1', tool: 'chat_qq_get_unread', args: { limit: 3 }, turnToken: 'tok-1' });
    assert.equal(ok.ok, true);
    assert.equal(ok.data.data.echo, 'get_unread');
    // 发送类工具同样是 adapter-tools 的工具，可以正常调用。
    const send = await host.handle({ callId: 'c2', tool: 'chat_qq_send_text', args: { text: 'hi' }, turnToken: 'tok-1' });
    assert.equal(send.ok, true);
    // 未知工具不消耗额度，直接 E_UNSUPPORTED。
    const unknown = await host.handle({ callId: 'c3', tool: 'chat_qq_nope', args: {}, turnToken: 'tok-1' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, 'E_UNSUPPORTED');
    // releaseTurn 的返回值是本轮工具快照：calls=3（c1/c2/c3 中未知工具不计额度）→ 2，
    // sent=1（只有 send_text 是成功的发送类动作）。
    const stats = host.releaseTurn('turn_1');
    assert.deepEqual(stats, { calls: 2, sent: 1 });
  });
});

// ── 跨仓：真实桥接清单 ──────────────────────────────────────────────────────

test('跨仓：真实 qq-bridge 清单可直接装配（工具名合规、投递让位、敏感默认关闭）', async () => {
  // 与 test-actions-manifest.mjs 同一跨仓驱动方式：清单是唯一事实源，
  // 网关必须能吃下桥接仓的真实清单——结构漂移会在这里先炸，而不是等上线。
  const { loadActionsManifest } = await import('../../qq-bridge/src/gateway/actions-manifest.js');
  const { manifest, error } = loadActionsManifest();
  assert.equal(error, null, error ?? '');
  const executor = makeExecutor({
    adapter: { id: 'qq-main', platform: 'qq', secret: SECRET, callbackBase: 'http://127.0.0.1:9' },
    manifest,
  });
  const names = executor.tools.map((tool) => tool.name);
  assert.ok(names.length >= 20, `expected full surface, got ${names.length}: ${names.join(',')}`);
  for (const name of names) {
    // 与 executor-interface 的 TOOL_NAME_RE 同界（上限 64）。
    assert.match(name, /^chat_qq_[a-z0-9_]{1,55}$/);
  }
  // 发送类动作必须在工具面里：删掉回合文本自动投递后，这是模型唯一的发言通道。
  for (const action of ['send_text', 'reply', 'send_message', 'send_sticker', 'send_voice', 'poke']) {
    assert.ok(names.includes(`chat_qq_${action}`), `${action} must be exposed`);
  }
  assert.ok(names.includes('chat_qq_set_wake'));
  assert.ok(names.includes('chat_qq_get_unread'));
  assert.ok(names.includes('chat_qq_social_state'));
});

// ── 多适配器并存（决策 10/11/12）───────────────────────────────────────────

test('并存：qq 与 wx 清单同名 type 合并进单 executor，路由凭工具名前缀互不串线', async () => {
  // registry 按 action 全局路由（一 action 一 owner），同名 type（get_unread）
  // 跨清单重复是正常形态——所以 adapter-tools 必须单 executor 内部按平台分派。
  const wxAdapter = { id: 'wx-main', platform: 'wx', secret: SECRET, callbackBase: 'http://127.0.0.1:9' };
  const wxManifest = {
    v: 1, platform: 'wx', adapter: 'wx-adapter',
    actions: [
      { type: 'get_unread', summary: '读取未读消息', kind: 'read', payloadSchema: { type: 'object', properties: { limit: { type: 'integer' } } } },
    ],
  };
  await withFakeAdapter({
    respond: (envelope) => ({ v: 1, actionId: envelope.actionId, ok: true, at: Date.now(), data: { hit: envelope.target.platform } }),
  }, async ({ adapter }) => {
    const executor = createAdapterToolsExecutor({
      adapters: [
        { adapter, manifest: manifestFixture(), capabilities: capsFor(manifestFixture()) },
        { adapter: wxAdapter, manifest: wxManifest, capabilities: [passthrough('get_unread')] },
      ],
      logger: () => {},
    });
    const names = executor.tools.map((tool) => tool.name);
    assert.ok(names.includes('chat_qq_get_unread'));
    assert.ok(names.includes('chat_wx_get_unread'));
    const registry = createExecutorRegistry();
    registry.add(executor);
    assert.equal(registry.actionForTool('chat_qq_get_unread'), 'get_unread');
    assert.equal(registry.actionForTool('chat_wx_get_unread'), 'get_unread');

    // 平台选择权在工具名前缀：chat_wx_* 的请求必须进 wx 适配器。跨平台调用
    // 必须显式给 payload.key（qq 会话派生不出 wx 会话，绝不把 qq 会话 id 发给 wx）；
    // wx 适配器不可达（port 9）→ E_PLATFORM，恰好证明请求去了 wx 而不是 qq。
    const viaWx = await executor.call({ action: 'get_unread', ctx: ctx({ tool: 'chat_wx_get_unread', payload: { key: 'group:789' } }) });
    assert.equal(viaWx.ok, false);
    assert.equal(viaWx.code, 'E_PLATFORM');
    // 不给 key：qq 会话派生不出 wx 会话 → 结构化失败（不是降级串线）。
    const wxWithoutKey = await executor.call({ action: 'get_unread', ctx: ctx({ tool: 'chat_wx_get_unread' }) });
    assert.equal(wxWithoutKey.ok, false);
    assert.equal(wxWithoutKey.code, 'E_UNSUPPORTED');
    const viaQq = await executor.call({ action: 'get_unread', ctx: ctx({ tool: 'chat_qq_get_unread' }) });
    assert.equal(viaQq.ok, true);
    assert.equal(viaQq.receipt.data.hit, 'qq');
    // ctx.tool 缺省（如直调）时回退会话平台。
    const viaSession = await executor.call({ action: 'get_unread', ctx: ctx() });
    assert.equal(viaSession.ok, true);
    assert.equal(viaSession.receipt.data.hit, 'qq');
  });
});

test('冲突拒绝：同平台两份清单装配显式失败（目录合并冲突不静默）', () => {
  const a = { id: 'qq-a', platform: 'qq', secret: SECRET, callbackBase: 'http://127.0.0.1:9' };
  const b = { id: 'qq-b', platform: 'qq', secret: SECRET, callbackBase: 'http://127.0.0.1:9' };
  assert.throws(
    () => createAdapterToolsExecutor({
      adapters: [
        { adapter: a, manifest: manifestFixture(), capabilities: capsFor(manifestFixture()) },
        { adapter: b, manifest: manifestFixture(), capabilities: capsFor(manifestFixture()) },
      ],
      logger: () => {},
    }),
    /duplicate adapter platform/,
  );
});

test('覆盖完整性：孤儿条目 / 孤儿模块都拒绝装配（决策 12 的 1:1 硬标准）', async () => {
  const adapter = { id: 'qq-main', platform: 'qq', secret: SECRET, callbackBase: 'http://127.0.0.1:9' };
  // 清单有条目、平台目录没模块 → 拒绝装配（用真实清单，条目是全集）。
  const { loadActionsManifest } = await import('../../qq-bridge/src/gateway/actions-manifest.js');
  const realManifest = loadActionsManifest().manifest;
  assert.throws(
    () => makeExecutor({
      adapter,
      manifest: realManifest,
      // 记忆动作随桥接侧 strip-extensions 从清单移除；孤儿探针只挑仍在目录里的 social_state。
      capabilities: QQ_CAPABILITIES.filter((cap) => cap.type !== 'social_state' && !cap.type.startsWith('memory')),
    }),
    /no capability module/,
  );
  // 平台目录有模块、清单没条目 → 同样拒绝。
  const mini = { v: 1, platform: 'qq', actions: [{ type: 'social_state', summary: 'x', kind: 'read' }] };
  assert.throws(
    () => makeExecutor({ adapter, manifest: mini, capabilities: [passthrough('social_state'), passthrough('not_in_manifest')] }),
    /not declared in the manifest/,
  );
});

test('骨架：wx 注册表为空时装配显式拒绝（清单落地前不暴露半套目录）', () => {
  const wxAdapter = { id: 'wx-main', platform: 'wx', secret: SECRET, callbackBase: 'http://127.0.0.1:9' };
  const wxManifest = { v: 1, platform: 'wx', actions: [{ type: 'get_unread', summary: 'x', kind: 'read' }] };
  assert.throws(
    () => createAdapterToolsExecutor({ adapters: [{ adapter: wxAdapter, manifest: wxManifest }], logger: () => {} }),
    /no capability registry/,
  );
  assert.equal(WX_CAPABILITIES.length, 0);
});

// ── 清单拉取 ────────────────────────────────────────────────────────────────

test('fetchAdapterManifest：签名 GET 成功；平台不匹配/非合规/HTTP 错误一律拒绝', async () => {
  await withFakeAdapter({}, async ({ adapter }) => {
    const manifest = await fetchAdapterManifest({ adapter, logger: () => {} });
    assert.equal(manifest.platform, 'qq');
    assert.equal(manifest.actions.length, 7);
  });

  await withFakeAdapter({ manifest: manifestFixture({ platform: 'wx' }) }, async ({ adapter }) => {
    await assert.rejects(() => fetchAdapterManifest({ adapter }), /does not match/);
  });

  await withFakeAdapter({ manifest: { v: 1, platform: 'qq' } }, async ({ adapter }) => {
    await assert.rejects(() => fetchAdapterManifest({ adapter }), /non-conforming/);
  });

  // 服务端验签失败（错误密钥）→ 401 → 拒绝。
  await withFakeAdapter({}, async ({ base }) => {
    const wrongSecret = { id: 'qq-main', platform: 'qq', secret: 'wrong-secret-0123456789', callbackBase: base };
    await assert.rejects(() => fetchAdapterManifest({ adapter: wrongSecret }), /HTTP 401/);
  });

  // 不可达。
  await assert.rejects(
    () => fetchAdapterManifest({ adapter: { id: 'qq-main', platform: 'qq', secret: SECRET, callbackBase: 'http://127.0.0.1:9' }, timeoutMs: 300 }),
    /unreachable/,
  );
});
