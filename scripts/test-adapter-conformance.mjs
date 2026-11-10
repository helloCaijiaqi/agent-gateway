// 双适配器契约符合性套件（P5）。
//
// 目的不是「再测一遍网关」，而是回答一个问题：**同一个网关、同一套用例，
// qq 与 wx 两个真实适配器实现是否都满足线缆契约？** 因此这里不 mock 适配器行为，
// 而是直接驱动：
//   - `../qq-bridge/src/gateway/gateway-client.js` 与 `/src/gateway/gateway-actions.js`（生产实现）
//   - `../wx-adapter/src/gateway-client.mjs` 与 `/src/actions-server.mjs`（生产实现）
//
// 覆盖：入站 schema/鉴权/重放/幂等/白名单路由、出站动作签名回投/回执形状/
// 幂等重投/能力差异（微信没有已读回执与拍一拍）、跨适配器平台冒用。
//
// 全部离线：DSH 用 runtime 桩，适配器回调是本机临时 HTTP 服务。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

const {
  parseReceipt, parseInbound, sessionKeyOf, inboundIdempotencyKey,
} = await import(new URL('../src/core/contracts.mjs', import.meta.url).href);
const { signRequest } = await import(new URL('../src/core/auth.mjs', import.meta.url).href);
const { loadConfig } = await import(new URL('../src/core/config.mjs', import.meta.url).href);
const { createGatewayServer } = await import(new URL('../src/core/server.mjs', import.meta.url).href);
const { buildEnvelope, postAdapterAction } = await import(new URL('./helpers/adapter-wire.mjs', import.meta.url).href);

const { createGatewayClient: createQqClient } = await import('../../qq-bridge/src/gateway/gateway-client.js');
const { createGatewayActionsHandler: createQqActions } = await import('../../qq-bridge/src/gateway/gateway-actions.js');
const { createGatewayClient: createWxClient } = await import('../../wx-adapter/src/gateway-client.mjs');
const { createWxActionsHandler } = await import('../../wx-adapter/src/actions-server.mjs');
const { createDryRunDriver } = await import('../../wx-adapter/src/platform-io.mjs');

const NOW = 1_762_300_000_000;
const MEDIA_DIR = path.join(os.tmpdir(), 'conformance-wx-media');

/**
 * 双适配器矩阵：同一组用例按这份配置各跑一遍。
 * `kind` 刻意不同（qq 用 group、wx 用 room）——漏掉 kind 就会在 wx 侧拼错会话键。
 */
const MATRIX = [
  {
    name: 'qq',
    platform: 'qq',
    adapterId: 'qq-main',
    secret: 'qq-main-secret-0123456789',
    kind: 'group',
    conversationId: '456789',
    sessionKey: 'qq:group:456789',
    capabilities: ['send_text', 'reply', 'mark_read'],
    createClient: createQqClient,
    async startActions({ secret, capabilities }) {
      const sent = [];
      const marked = [];
      const handler = createQqActions({
        secret,
        platform: 'qq',
        capabilities,
        sendText: async ({ key, text }) => {
          sent.push({ key, text });
          return { ok: true, messageId: `qq_${sent.length}` };
        },
        markRead: async ({ key, throughSeq }) => { marked.push({ key, throughSeq }); },
      });
      const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/v1/actions') {
          handler.handle(req, res).catch(() => { res.writeHead(500); res.end(); });
          return;
        }
        res.writeHead(404); res.end();
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return { server, sent, marked, port: server.address().port };
    },
  },
  {
    name: 'wx',
    platform: 'wx',
    adapterId: 'wx-main',
    secret: 'wx-main-secret-0123456789',
    kind: 'room',
    conversationId: '123@chatroom',
    sessionKey: 'wx:room:123@chatroom',
    capabilities: ['send_text', 'reply', 'send_media', 'send_file'],
    createClient: createWxClient,
    async startActions({ secret, capabilities }) {
      const driver = createDryRunDriver();
      const handler = createWxActionsHandler({
        secret,
        capabilities,
        driver,
        mediaDir: MEDIA_DIR,
      });
      const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/v1/actions') {
          handler.handle(req, res).catch(() => { res.writeHead(500); res.end(); });
          return;
        }
        res.writeHead(404); res.end();
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return { server, sent: driver.sent, port: server.address().port };
    },
  },
];

function tmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-conformance-'));
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) { resolve(); return; }
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/**
 * 关网关。必须先 closeAllConnections()：Node 19+ 的 fetch 默认 keep-alive，
 * 只要还有空闲连接挂着，server.close() 的回调就永远不触发——测试全绿但进程不退。
 */
async function closeGateway(gateway) {
  gateway.server.closeAllConnections?.();
  await gateway.close();
}

function envelopeFor(entry, overrides = {}) {
  return {
    v: 1,
    platform: entry.platform,
    adapterId: entry.adapterId,
    traceId: `trace-${entry.name}`,
    receivedAt: NOW,
    conversation: { kind: entry.kind, id: entry.conversationId },
    message: {
      id: `${entry.name}-msg-1`,
      seq: 12,
      sender: { id: `${entry.platform}-member-1`, name: '张三', roles: ['member'] },
      text: '在吗',
    },
    ...overrides,
  };
}

async function startGateway({ conversations, adapters, runtime }) {
  const config = loadConfig({
    env: {
      GATEWAY_MODE: 'on',
      GATEWAY_PORT: '0',
      GATEWAY_CONVERSATIONS: conversations,
      GATEWAY_SECRET: '',
    },
    stateDir: tmpStateDir(),
    adapters,
  });
  const gateway = createGatewayServer({ config, logger: () => {}, runtime });
  await gateway.listen();
  const { port } = gateway.server.address();
  return { gateway, base: `http://127.0.0.1:${port}`, config };
}

function createRuntimeStub() {
  const submitted = [];
  return {
    submitted,
    submit(record) { submitted.push(record); },
    connected: true,
    status: () => ({ liveTurns: 0 }),
    toolList: () => [],
    toolStatus: () => ({ liveTurns: 0, tools: [] }),
    toolCall: async () => ({ ok: false, error: { code: 'E_DISABLED', message: 'no tools' } }),
    stateGet: () => null,
    stateList: () => [],
    stateUpdate: async () => ({ ok: true, data: {} }),
    stateStats: () => ({ sessions: 0 }),
    stop: async () => {},
  };
}

/** 直接按网关签名格式向适配器投动作（模拟网关重投，便于固定 actionId 验幂等）。 */
async function postSignedAction(port, entry, envelope, { timestamp, nonce } = {}) {
  const body = JSON.stringify(envelope);
  const headers = signRequest({
    secret: entry.secret,
    adapterId: 'gateway',
    body,
    timestamp,
    nonce: nonce ?? randomBytes(8).toString('hex'),
  });
  // signRequest 产出的是适配器头；网关→适配器用 x-gateway-secret（同算法不同头）。
  const gatewayHeaders = {
    'content-type': 'application/json; charset=utf-8',
    'x-timestamp': headers['x-timestamp'],
    'x-nonce': headers['x-nonce'],
    'x-gateway-secret': headers['x-signature'],
  };
  const response = await fetch(`http://127.0.0.1:${port}/v1/actions`, {
    method: 'POST', headers: gatewayHeaders, body,
  });
  return { status: response.status, body: await response.json() };
}

// ─────────────────────────────────────────────── 入站（每个适配器各跑一遍）

for (const entry of MATRIX) {
  test(`[${entry.name}] 入站：接受 → 会话键 → 幂等重投只提交一次`, async () => {
    const runtime = createRuntimeStub();
    const { gateway, base } = await startGateway({
      conversations: 'qq:group:*,wx:room:*',
      adapters: MATRIX.map((item) => ({ id: item.adapterId, platform: item.platform, secret: item.secret })),
      runtime,
    });
    const client = entry.createClient({
      baseUrl: base, adapterId: entry.adapterId, platform: entry.platform, secret: entry.secret, timeoutMs: 2000,
    });
    try {
      const envelope = parseInbound(envelopeFor(entry));
      const first = await client.inbound(envelope);
      assert.equal(first.ok, true, `入站应成功：${JSON.stringify(first)}`);
      assert.equal(first.body.status, 'accepted');
      assert.equal(first.body.routed, true);
      assert.equal(runtime.submitted.length, 1);
      assert.equal(runtime.submitted[0].sessionKey, sessionKeyOf(envelope));

      // turn 记录里的会话键与幂等键必须与契约推导一致。
      const turn = await client.turn(first.body.turnId);
      assert.equal(turn.ok, true);
      assert.equal(turn.body.record.sessionKey, entry.sessionKey);
      assert.equal(inboundIdempotencyKey(envelope), `${entry.platform}:${entry.kind}:${entry.conversationId}:${entry.name}-msg-1`);

      const duplicate = await client.inbound(envelope);
      assert.equal(duplicate.body.deduped, true);
      assert.equal(duplicate.body.turnId, first.body.turnId);
      assert.equal(runtime.submitted.length, 1, '重复入站不得二次提交');
    } finally {
      await closeGateway(gateway);
    }
  });

  test(`[${entry.name}] 入站：坏密钥 / 平台冒用 / 重放 / 未知字段 全部拒绝`, async () => {
    const runtime = createRuntimeStub();
    const { gateway, base } = await startGateway({
      conversations: 'qq:group:*,wx:room:*',
      adapters: MATRIX.map((item) => ({ id: item.adapterId, platform: item.platform, secret: item.secret })),
      runtime,
    });
    const envelope = parseInbound(envelopeFor(entry));
    try {
      const badSecret = entry.createClient({
        baseUrl: base, adapterId: entry.adapterId, platform: entry.platform,
        secret: 'wrong-secret-0123456789', timeoutMs: 2000,
      });
      const denied = await badSecret.inbound(envelope);
      assert.equal(denied.ok, false);
      assert.equal(denied.status, 401);
      assert.equal(denied.code, 'E_AUTH');

      // 平台冒用：用 wx 适配器的密钥声明 qq 平台（反之亦然）。
      const other = MATRIX.find((item) => item.name !== entry.name);
      const impersonate = entry.createClient({
        baseUrl: base, adapterId: other.adapterId, platform: other.platform,
        secret: other.secret, timeoutMs: 2000,
      });
      const spoofed = await impersonate.inbound({ ...envelope, platform: entry.platform, adapterId: entry.adapterId });
      assert.equal(spoofed.ok, false);
      assert.equal(spoofed.status, 401);

      // 逐字节重放：同签名头 + 同 body。
      const raw = JSON.stringify(envelope);
      const headers = signRequest({ secret: entry.secret, adapterId: entry.adapterId, body: raw });
      const headersObj = {
        'content-type': 'application/json; charset=utf-8',
        'x-adapter-id': entry.adapterId,
        'x-timestamp': headers['x-timestamp'],
        'x-nonce': headers['x-nonce'],
        'x-signature': headers['x-signature'],
      };
      const first = await fetch(`${base}/v1/inbound`, { method: 'POST', headers: headersObj, body: raw });
      assert.equal(first.status, 202);
      const replay = await fetch(`${base}/v1/inbound`, { method: 'POST', headers: headersObj, body: raw });
      assert.equal(replay.status, 401);
      assert.equal((await replay.json()).error.code, 'E_REPLAY');

      const strictRaw = JSON.stringify({ ...envelope, surprise: true });
      const strictHeaders = signRequest({ secret: entry.secret, adapterId: entry.adapterId, body: strictRaw });
      const strict = await fetch(`${base}/v1/inbound`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-adapter-id': entry.adapterId,
          'x-timestamp': strictHeaders['x-timestamp'],
          'x-nonce': strictHeaders['x-nonce'],
          'x-signature': strictHeaders['x-signature'],
        },
        body: strictRaw,
      });
      assert.equal(strict.status, 400);
      assert.equal((await strict.json()).error.code, 'E_SCHEMA');
    } finally {
      await closeGateway(gateway);
    }
  });

  test(`[${entry.name}] 入站：白名单未命中 → unrouted，适配器可保留本地路径`, async () => {
    const runtime = createRuntimeStub();
    const { gateway, base } = await startGateway({
      conversations: entry.platform === 'qq' ? 'qq:group:111' : 'wx:room:111@chatroom',
      adapters: MATRIX.map((item) => ({ id: item.adapterId, platform: item.platform, secret: item.secret })),
      runtime,
    });
    const client = entry.createClient({
      baseUrl: base, adapterId: entry.adapterId, platform: entry.platform, secret: entry.secret, timeoutMs: 2000,
    });
    try {
      const result = await client.inbound(parseInbound(envelopeFor(entry)));
      assert.equal(result.body.status, 'unrouted');
      assert.equal(result.body.routed, false);
      assert.equal(runtime.submitted.length, 0);
    } finally {
      await closeGateway(gateway);
    }
  });
}

// ─────────────────────────────────────────────── 出站动作（双向）

for (const entry of MATRIX) {
  test(`[${entry.name}] 动作：网关签名回投 → 回执符合 receiptSchema，重投不重复执行`, async () => {
    const actions = await entry.startActions({ secret: entry.secret, capabilities: entry.capabilities });
    try {
      const envelope = {
        v: 1,
        actionId: `act-${entry.name}-1`,
        turnId: 'turn-conformance',
        type: 'send_text',
        target: { platform: entry.platform, conversationId: entry.conversationId, kind: entry.kind },
        payload: { text: '收到' },
        idempotencyKey: 'turn-conformance:send_text',
      };
      const first = await postSignedAction(actions.port, entry, envelope);
      assert.equal(first.status, 200);
      const receipt = parseReceipt(first.body);
      assert.equal(receipt.ok, true);
      assert.equal(receipt.actionId, envelope.actionId);
      assert.match(receipt.platformMessageId ?? '', /^(qq|dry)_1$/);
      assert.equal(actions.sent.length, 1);
      assert.equal(actions.sent[0].text, '收到');

      // 网关重投同一信封（同 idempotencyKey，新 nonce）：回执一致且不重复发送。
      const retry = await postSignedAction(actions.port, entry, envelope);
      assert.equal(retry.status, 200);
      assert.deepEqual(retry.body, first.body);
      assert.equal(actions.sent.length, 1);
    } finally {
      await closeServer(actions.server);
    }
  });

  test(`[${entry.name}] 动作：坏签名 401、平台错配 400、能力外动作回失败回执`, async () => {
    const actions = await entry.startActions({ secret: entry.secret, capabilities: entry.capabilities });
    const envelope = {
      v: 1,
      actionId: `act-${entry.name}-bad`,
      turnId: 'turn-conformance',
      type: 'send_text',
      target: { platform: entry.platform, conversationId: entry.conversationId, kind: entry.kind },
      payload: { text: 'hi' },
      idempotencyKey: `turn-conformance:bad:${entry.name}`,
    };
    try {
      const body = JSON.stringify(envelope);
      const forgedHeaders = signRequest({ secret: 'not-the-secret-0123456789', adapterId: 'gateway', body });
      const forged = await fetch(`http://127.0.0.1:${actions.port}/v1/actions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-timestamp': forgedHeaders['x-timestamp'],
          'x-nonce': forgedHeaders['x-nonce'],
          'x-gateway-secret': forgedHeaders['x-signature'],
        },
        body,
      });
      assert.equal(forged.status, 401);

      const wrongTarget = await postSignedAction(actions.port, entry, {
        ...envelope,
        actionId: `act-${entry.name}-wrong`,
        target: { platform: entry.platform === 'qq' ? 'wx' : 'qq', conversationId: entry.conversationId, kind: entry.kind },
        idempotencyKey: `turn-conformance:wrong:${entry.name}`,
      });
      assert.equal(wrongTarget.status, 400);
      assert.equal(actions.sent.length, 0);

      // 能力差异：对方平台支持、本平台不支持的动作。
      const unsupportedType = entry.platform === 'wx' ? 'poke' : 'send_media';
      const unsupported = await postSignedAction(actions.port, entry, {
        ...envelope,
        actionId: `act-${entry.name}-unsupported`,
        type: unsupportedType,
        payload: unsupportedType === 'poke' ? { userId: 'x' } : { kind: 'image', ref: 'inbox/a.png' },
        idempotencyKey: `turn-conformance:unsupported:${entry.name}`,
      });
      assert.equal(unsupported.status, 200);
      assert.equal(unsupported.body.ok, false);
      assert.equal(unsupported.body.error.code, 'E_UNSUPPORTED');
    } finally {
      await closeServer(actions.server);
    }
  });
}

test('动作：能力门控在适配器侧（qq 的 mark_read 成功、wx 的 mark_read/poke 回 E_UNSUPPORTED）', async () => {
  const started = new Map();
  for (const entry of MATRIX) {
    started.set(entry.name, await entry.startActions({ secret: entry.secret, capabilities: entry.capabilities }));
  }
  try {
    const qq = MATRIX.find((entry) => entry.name === 'qq');
    const wx = MATRIX.find((entry) => entry.name === 'wx');
    const base = `http://127.0.0.1:${started.get('qq').port}`;
    const wxBase = `http://127.0.0.1:${started.get('wx').port}`;

    const qqRead = await postAdapterAction({
      callbackBase: base,
      secret: qq.secret,
      envelope: buildEnvelope({
        type: 'mark_read', turnId: 'turn_route', platform: 'qq',
        conversationId: '456789', kind: 'group', payload: { throughSeq: 3 },
      }),
    });
    assert.equal(qqRead.ok, true);

    const wxRead = await postAdapterAction({
      callbackBase: wxBase,
      secret: wx.secret,
      envelope: buildEnvelope({
        type: 'mark_read', turnId: 'turn_route', platform: 'wx',
        conversationId: '123@chatroom', kind: 'room', payload: { throughSeq: 3 },
      }),
    });
    assert.equal(wxRead.ok, false);
    assert.equal(wxRead.code, 'E_UNSUPPORTED');
    assert.match(wxRead.message, /does not support mark_read/);

    const wxPoke = await postAdapterAction({
      callbackBase: wxBase,
      secret: wx.secret,
      envelope: buildEnvelope({
        type: 'poke', turnId: 'turn_route', platform: 'wx',
        conversationId: '123@chatroom', kind: 'room', payload: { userId: 'wxid_x' },
      }),
    });
    assert.equal(wxPoke.code, 'E_UNSUPPORTED');

    // wx 的媒体发送走通（同一个线缆，只是能力不同）。
    const wxMedia = await postAdapterAction({
      callbackBase: wxBase,
      secret: wx.secret,
      envelope: buildEnvelope({
        type: 'send_media', turnId: 'turn_route', platform: 'wx',
        conversationId: '123@chatroom', kind: 'room',
        payload: { kind: 'image', ref: 'https://cdn.example.com/a.png' },
      }),
    });
    assert.equal(wxMedia.ok, true);
    assert.equal(wxMedia.receipt.ok, true);
  } finally {
    for (const actions of started.values()) await closeServer(actions.server);
  }
});

test('动作：适配器回执形状漂移时网关拒绝（不把 {} 当发送成功）', async () => {
  const lying = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => lying.listen(0, '127.0.0.1', resolve));
  try {
    const result = await postAdapterAction({
      callbackBase: `http://127.0.0.1:${lying.address().port}`,
      secret: 'wx-main-secret-0123456789',
      envelope: buildEnvelope({
        type: 'send_text', turnId: 'turn_liar', platform: 'wx',
        conversationId: '1', kind: 'room', payload: { text: 'hi' },
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_PLATFORM');
    assert.match(result.message, /non-conforming receipt/);
  } finally {
    await closeServer(lying);
  }
});

test('健康检查：两个适配器同时登记，能力与回投地址可观测', async () => {
  const runtime = createRuntimeStub();
  const { gateway, base } = await startGateway({
    conversations: 'qq:group:*,wx:room:*',
    adapters: MATRIX.map((entry) => ({
      id: entry.adapterId,
      platform: entry.platform,
      secret: entry.secret,
      callbackBase: `http://127.0.0.1:9${entry.name === 'qq' ? 1 : 2}`,
      capabilities: entry.capabilities,
    })),
    runtime,
  });
  try {
    // 适配器能力/回投地址属于排障细节：公开 health 只剩最小事实，细节要签名。
    const signed = signRequest({ secret: MATRIX[0].secret, adapterId: MATRIX[0].adapterId, body: '' });
    const response = await fetch(`${base}/v1/health?detail=1`, { headers: signed });
    const health = await response.json();
    assert.equal(response.status, 200);
    assert.equal(health.ok, true);
    assert.deepEqual(health.adapters.map((item) => item.platform).sort(), ['qq', 'wx']);
    const wx = health.adapters.find((item) => item.platform === 'wx');
    assert.deepEqual(wx.capabilities, MATRIX[1].capabilities);
    assert.match(wx.actionsEndpoint, /\/v1\/actions$/);
  } finally {
    await closeGateway(gateway);
  }
});

test('注册表：enabled:false 与 GATEWAY_DISABLED_ADAPTERS 都能单独摘掉适配器', async () => {
  const adapters = MATRIX.map((entry) => ({
    id: entry.adapterId,
    platform: entry.platform,
    secret: entry.secret,
    ...(entry.platform === 'wx' ? { enabled: false } : {}),
  }));
  const disabledByFile = loadConfig({
    env: { GATEWAY_MODE: 'on', GATEWAY_PORT: '0' },
    stateDir: tmpStateDir(),
    adapters,
  });
  assert.deepEqual(disabledByFile.adapters.map((item) => item.platform), ['qq']);

  const disabledByEnv = loadConfig({
    env: { GATEWAY_MODE: 'on', GATEWAY_PORT: '0', GATEWAY_DISABLED_ADAPTERS: 'qq-main' },
    stateDir: tmpStateDir(),
    adapters: MATRIX.map((entry) => ({ id: entry.adapterId, platform: entry.platform, secret: entry.secret })),
  });
  assert.deepEqual(disabledByEnv.adapters.map((item) => item.platform), ['wx']);

  // 能力写错必须是启动期错误，而不是等到模型调用时才 500。
  assert.throws(() => loadConfig({
    env: { GATEWAY_MODE: 'on', GATEWAY_PORT: '0' },
    stateDir: tmpStateDir(),
    adapters: [{ id: 'wx-main', platform: 'wx', secret: 'x'.repeat(20), capabilities: ['wait'] }],
  }), /unknown capabilities/);

  // 开关键写成字符串会静默「开」——必须在启动期拦住。
  assert.throws(() => loadConfig({
    env: { GATEWAY_MODE: 'on', GATEWAY_PORT: '0' },
    stateDir: tmpStateDir(),
    adapters: [{ id: 'wx-main', platform: 'wx', secret: 'x'.repeat(20), enabled: 'false' }],
  }), /enabled must be a boolean/);

  // 动作按 platform 路由，同平台两个适配器只会互相覆盖。
  assert.throws(() => loadConfig({
    env: { GATEWAY_MODE: 'on', GATEWAY_PORT: '0' },
    stateDir: tmpStateDir(),
    adapters: [
      { id: 'wx-main', platform: 'wx', secret: 'a'.repeat(20) },
      { id: 'wx-backup', platform: 'wx', secret: 'b'.repeat(20) },
    ],
  }), /share platform "wx"/);
});

/** 每个动作一份最小合法 payload：用于验证「示例声明了什么，实现就真能执行什么」。 */
const ACTION_PROBES = {
  send_text: { text: '在吗' },
  reply: { text: '在吗' },
  send_media: { kind: 'image', ref: 'https://cdn.example.com/a.png' },
  send_file: { ref: 'https://cdn.example.com/a.png', name: 'a.png' },
  mark_read: { throughSeq: 3 },
  poke: { userId: 'wxid_x' },
};

test('示例登记：adapters.example.json 声明的能力都能被对应实现执行', async () => {
  // 这一条钉的是「文档漂移」：示例曾给 qq 声明 send_media/poke，而 gateway-actions.js
  // 只实现 send_text/reply/mark_read——网关就会把动作发给一个只会回 E_UNSUPPORTED 的适配器。
  // 所以不比对代码里的常量，而是拿示例里的能力列表逐个真投一次。
  const example = JSON.parse(fs.readFileSync(new URL('../adapters.example.json', import.meta.url), 'utf8'));
  for (const entry of MATRIX) {
    const row = example.adapters.find((item) => item.platform === entry.platform);
    assert.ok(row, `adapters.example.json 缺少 ${entry.platform} 适配器`);
    assert.equal(row.id, entry.adapterId);

    const actions = await entry.startActions({ secret: entry.secret, capabilities: row.capabilities });
    try {
      for (const type of row.capabilities) {
        const envelope = {
          v: 1,
          actionId: `act-example-${entry.name}-${type}`,
          turnId: 'turn-example',
          type,
          target: { platform: entry.platform, conversationId: entry.conversationId, kind: entry.kind },
          payload: ACTION_PROBES[type] ?? {},
          idempotencyKey: `example:${entry.name}:${type}`,
        };
        const result = await postSignedAction(actions.port, entry, envelope);
        assert.equal(result.status, 200, `${entry.name}/${type}: HTTP ${result.status}`);
        assert.notEqual(
          result.body?.error?.code, 'E_UNSUPPORTED',
          `示例声明了 ${entry.platform}/${type}，实现却回 E_UNSUPPORTED`,
        );
      }
    } finally {
      await closeServer(actions.server);
    }
  }
});
