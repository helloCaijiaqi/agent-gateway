// actions-manifest 符合性套件（清单驱动的 /v1/actions 契约）。
//
// 跨仓驱动：直接加载 qq-bridge 的清单 + 清单校验器 + 生产 gateway-actions 工厂，
// 用与 test-adapter-conformance.mjs 相同的签名/回执手法做真投验证。规则：
//   1. 清单必须通过自身 schema + 语义校验（type 唯一、payloadSchema 是对象）；
//   2. 清单 type ⊆ 网关 ACTION_TYPES（两仓词汇表对齐，孤儿 type = 清单失效）；
//   3. wired 条目必须真投成功（handler 在位），未接线条目必须干净回 E_UNSUPPORTED；
//   4. payload 按 payloadSchema 判 E_SCHEMA（send_text 空文本 / 超长）；
//   5. GET /v1/actions/manifest 鉴权后返回清单，未签名 401；
//   6. set_wake 必须是 sensitive（网关侧显式允许的门在清单上，不在代码里）。
//
// 运行：npm test（agent-gateway 包内；qq-bridge 的 test:gateway 转发到这里）。
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

const { validateAgainstSchema, validatePayload, loadActionsManifest } =
  await import('../../qq-bridge/src/gateway/actions-manifest.js');
const { createGatewayActionsHandler } = await import('../../qq-bridge/src/gateway/gateway-actions.js');
const { createWaitAction, createWaitRegistry } = await import('../../qq-bridge/src/gateway/wait-registry.js');
const { signRequest } = await import('../src/core/auth.mjs');
const { ACTION_TYPES } = await import('../src/core/contracts.mjs');

const SECRET = 'test-gateway-actions-secret-0123456789';

/** 与 conformance 同款：真起 HTTP server，签名投递，解析回执。 */
async function withServer(handler, run) {
  const server = http.createServer((req, res) => handler.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function postSigned(port, path, body, { headers = {} } = {}) {
  const raw = JSON.stringify(body ?? {});
  const signed = signRequest({ secret: SECRET, adapterId: 'qq-main', body: raw });
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-timestamp': signed['x-timestamp'],
      'x-nonce': signed['x-nonce'],
      // 同算法不同头名：适配器方向（网关→适配器）用 x-gateway-secret。
      'x-gateway-secret': signed['x-signature'],
      ...headers,
    },
    body: raw,
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

function getSigned(port, path) {
  const signed = signRequest({ secret: SECRET, adapterId: 'qq-main', body: '' });
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'GET',
    headers: {
      'x-timestamp': signed['x-timestamp'],
      'x-nonce': signed['x-nonce'],
      'x-gateway-secret': signed['x-signature'],
    },
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

function makeHandler(overrides = {}) {
  const sent = [];
  const waits = [];
  const registry = createWaitRegistry();
  const send = async ({ key, text }) => { sent.push({ key, text }); return { ok: true, messageId: 'm1' }; };
  return {
    sent,
    waits,
    registry,
    handler: createGatewayActionsHandler({
      secret: SECRET,
      platform: 'qq',
      sendText: send,
      markRead: async () => {},
      // 与 bridge.js 的接线同源（createWaitAction）：这里断言的是回执契约；
      // 桥接侧「登记 → 消息推进 → 唤醒事件」的整链路由 test-wait-pushback 覆盖。
      // ask/approve（pending 平台转发）在桥接侧走 action-handlers 的 run（格式化
      // 文本后进 send-message）；这里用等价的内联 handler 钉住回执与 E_SCHEMA 面。
      handlers: {
        wait: createWaitAction({ registry, baselineOf: () => 40, onRegister: (entry) => waits.push(entry) }),
        ask: async ({ payload }) => {
          const questions = (Array.isArray(payload?.questions) ? payload.questions : [])
            .map((q) => String(q ?? '').trim()).filter(Boolean).slice(0, 5);
          if (!questions.length) {
            return { ok: false, error: { code: 'E_SCHEMA', message: 'payload.questions is required (1-5 non-empty strings)' } };
          }
          const text = ['【agent 提问】需要你的输入才能继续：', ...questions.map((q, i) => `${i + 1}. ${q}`)].join('\n');
          const result = await send({ key: 'group:456', text });
          return result.ok === false ? result : { ok: true, messageId: result.messageId };
        },
        approve: async ({ payload }) => {
          const toolName = String(payload?.toolName ?? '').trim();
          if (!toolName) {
            return { ok: false, error: { code: 'E_SCHEMA', message: 'payload.toolName is required' } };
          }
          const reason = String(payload?.reason ?? '').trim();
          const text = [`【工具审批请求】agent 想调用工具「${toolName}」`,
            ...(reason ? [`理由：${reason}`] : []),
            '（此消息仅作同步；批准/拒绝请在网关控制台操作）'].join('\n');
          const result = await send({ key: 'group:456', text });
          return result.ok === false ? result : { ok: true, messageId: result.messageId };
        },
      },
      logger: () => {},
      ...overrides,
    }),
  };
}

// ── 清单本体 ────────────────────────────────────────────────────────────────

test('qq 清单：schema + 语义校验通过，type 无重复', () => {
  // loadActionsManifest 内部即按 actions-manifest.schema.json 做结构 + 语义校验。
  const { manifest, error } = loadActionsManifest();
  assert.equal(error, null, error ?? '');
  assert.equal(manifest.platform, 'qq');
  const types = manifest.actions.map((entry) => entry.type);
  assert.equal(new Set(types).size, types.length, 'duplicate action types');
  assert.ok(types.length >= 30, `expected full surface, got ${types.length}`);
});

test('清单 type ⊆ 网关 ACTION_TYPES（两仓词汇表对齐）', () => {
  const { manifest } = loadActionsManifest();
  const gatewayTypes = new Set(ACTION_TYPES);
  const orphans = manifest.actions.map((entry) => entry.type).filter((type) => !gatewayTypes.has(type));
  assert.deepEqual(orphans, [], `orphan types not in gateway ACTION_TYPES: ${orphans.join(', ')}`);
});

test('set_wake 必须声明为 sensitive（网关显式允许的门在清单上）', () => {
  const { manifest } = loadActionsManifest();
  const entry = manifest.actions.find((action) => action.type === 'set_wake');
  assert.ok(entry, 'set_wake declared');
  assert.equal(entry.kind, 'sensitive');
});

// ── 通用受限 JSON Schema 校验器 ─────────────────────────────────────────────

test('validateAgainstSchema：type 数组/required/items/number 边界/additionalProperties', () => {
  assert.equal(validateAgainstSchema({ type: ['string', 'number'] }, 3), null);
  assert.match(validateAgainstSchema({ type: ['string', 'number'] }, true), /must be string\|number/);
  assert.match(validateAgainstSchema({ required: ['a'] }, {}), /\.a is required/);
  assert.match(validateAgainstSchema({ properties: { n: { type: 'integer', minimum: 0 } } }, { n: -1 }),
    /must be a non-negative integer/);
  assert.match(validateAgainstSchema({ properties: { n: { type: 'integer', minimum: 0 } } }, { n: 1.5 }),
    /must be integer/);
  assert.match(validateAgainstSchema({ additionalProperties: false, properties: {} }, { x: 1 }),
    /not an allowed property/);
  assert.match(validateAgainstSchema({ items: { type: 'string' } }, [1]), /\[0\] must be string/);
  assert.match(validateAgainstSchema({ enum: ['a', 'b'] }, 'c'), /must be one of a, b/);
  assert.equal(validatePayload(null, undefined), null, 'absent schema = permissive');
});

// ── 真投：wired 成功 / 未接线干净拒绝 / E_SCHEMA ────────────────────────────

const WIRED_PROBES = {
  send_text: { text: 'hello' },
  reply: { text: 'hello', replyToMessageId: '42' },
  mark_read: { throughSeq: 7 },
};

test('wired 条目真投成功且回执符合契约', async () => {
  const { manifest } = loadActionsManifest();
  const { handler } = makeHandler({ manifest });
  await withServer(handler, async (port) => {
    for (const [type, payload] of Object.entries(WIRED_PROBES)) {
      const res = await postSigned(port, '/v1/actions', {
        v: 1, actionId: `probe-${type}`, type, turnId: 't1',
        target: { platform: 'qq', conversationId: '456', kind: 'group' },
        payload, idempotencyKey: `probe-${type}`,
      });
      assert.equal(res.status, 200, `${type}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.ok, true, `${type}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.v, 1);
      assert.equal(res.body.actionId, `probe-${type}`);
    }
  });
});

test('wait 登记：立即回执 registered=true（不阻塞），带 expiresAt 与基线 seq', async () => {
  const { manifest } = loadActionsManifest();
  const { handler, waits } = makeHandler({ manifest });
  await withServer(handler, async (port) => {
    const before = Date.now();
    const res = await postSigned(port, '/v1/actions', {
      v: 1, actionId: 'probe-wait', type: 'wait', turnId: 't1',
      target: { platform: 'qq', conversationId: '456', kind: 'group' },
      payload: { purpose: 'messages', minNewMessages: 2, timeoutMs: 60000 },
      idempotencyKey: 'probe-wait',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true, JSON.stringify(res.body));
    assert.equal(res.body.data.registered, true);
    assert.equal(res.body.data.baselineSeq, 40, '基线 seq 由适配器在登记那一刻快照');
    assert.equal(res.body.data.minNewMessages, 2);
    assert.equal(res.body.data.purpose, 'messages');
    assert.ok(res.body.data.expiresAt >= before + 59000, `expiresAt 应为登记时刻 + timeoutMs，got ${res.body.data.expiresAt}`);
    assert.equal(waits.length, 1, '每次登记都触发桥接侧过期定时器挂钩');

    // 同一 idempotencyKey 重投：动作层幂等表复用回执，不会重复登记。
    const replay = await postSigned(port, '/v1/actions', {
      v: 1, actionId: 'probe-wait-2', type: 'wait', turnId: 't1',
      target: { platform: 'qq', conversationId: '456', kind: 'group' },
      payload: { purpose: 'messages', minNewMessages: 2, timeoutMs: 60000 },
      idempotencyKey: 'probe-wait',
    });
    assert.equal(replay.body.ok, true);
    assert.equal(waits.length, 1, '幂等重投不得重复登记');
  });
});

test('未实现/未启用的条目回 E_UNSUPPORTED 且消息指明 not enabled', async () => {
  const { manifest } = loadActionsManifest();
  const { handler } = makeHandler({ manifest });
  const probes = {
    send_message: { messages: ['hi'] },
    send_burst: { groupId: '1', messages: ['hi'] },
    set_wake: { config: { mode: 'active' } },
    get_unread: { key: 'group:456' },
    social_state: {},
    list_groups: {},
  };
  await withServer(handler, async (port) => {
    for (const [type, payload] of Object.entries(probes)) {
      const res = await postSigned(port, '/v1/actions', {
        v: 1, actionId: `probe-${type}`, type, turnId: 't1',
        target: { platform: 'qq', conversationId: '456', kind: 'group' },
        payload, idempotencyKey: `probe-${type}`,
      });
      assert.equal(res.status, 200, type);
      assert.equal(res.body.ok, false, `${type} should be unwired`);
      assert.equal(res.body.error.code, 'E_UNSUPPORTED', `${type}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error.message, /declared in the manifest but not enabled/);
    }
  });
});

test('清单条目覆盖全部 probe（无清单孤儿：每个动作都真投过一次）', async () => {
  const { manifest } = loadActionsManifest();
  const { handler } = makeHandler({ manifest });
  const minimalPayload = {
    send_text: { text: 'x' }, reply: { text: 'x' }, mark_read: { throughSeq: 0 },
    send_message: { messages: ['x'] }, send_burst: { groupId: '1', messages: ['x'] },
    send_group_message: { groupId: '1', message: 'x' }, send_private_message: { userId: '1', message: 'x' },
    poke: { targetUserId: '1' }, wait: {}, set_wake: { config: {} },
    social_state: {}, get_prompt: {}, get_unread: {}, get_recent: {}, get_my_recent: {},
    get_message_detail: { messageId: '1' }, get_message_images: { messageId: '1' },
    get_forward_msg: { id: '1' }, get_active_members: {}, get_group_members: {},
    list_groups: {}, get_history: { groupId: '1' }, list_stickers: {},
    get_sticker_image: { stickerId: '1' }, get_self_image: {}, send_sticker: { stickerId: '1' },
    collect_sticker: { messageId: '1' }, sticker_note: { stickerId: '1' },
    set_sticker_remark: { stickerId: '1', remark: 'r' }, send_voice: { voice: 'v' },
    list_voices: {},
    ask: { questions: ['需要哪个选项？'] }, approve: { toolName: 'bash', reason: '列出目录' },
  };
  await withServer(handler, async (port) => {
    for (const entry of manifest.actions) {
      const res = await postSigned(port, '/v1/actions', {
        v: 1, actionId: `coverage-${entry.type}`, type: entry.type, turnId: 't1',
        target: { platform: 'qq', conversationId: '456', kind: 'group' },
        payload: minimalPayload[entry.type] ?? {}, idempotencyKey: `coverage-${entry.type}`,
      });
      assert.equal(res.status, 200, `${entry.type}: HTTP ${res.status}`);
      assert.equal(res.body.ok, entry.wired === true,
        `${entry.type}: wired=${entry.wired} but ok=${res.body.ok}`);
      if (res.body.ok === false) {
        assert.equal(res.body.error.code, 'E_UNSUPPORTED', `${entry.type}: ${JSON.stringify(res.body)}`);
      }
    }
  });
});

test('payload 按 payloadSchema 判 E_SCHEMA（空文本 / 超长 / 缺必填）', async () => {
  const { manifest } = loadActionsManifest();
  const { handler } = makeHandler({ manifest });
  // 注意：payloadSchema 校验发生在 handler 查找之后（未接线先回 E_UNSUPPORTED），
  // 所以 E_SCHEMA 用例只覆盖 wired 类型（send_text/reply/mark_read）。
  const badCases = [
    { type: 'send_text', payload: {}, why: 'missing text' },
    { type: 'send_text', payload: { text: '   ' }, why: 'blank text' },
    { type: 'send_text', payload: { text: 'x'.repeat(4001) }, why: 'over 4000' },
  ];
  await withServer(handler, async (port) => {
    for (const { type, payload, why } of badCases) {
      const res = await postSigned(port, '/v1/actions', {
        v: 1, actionId: `bad-${type}-${why}`, type, turnId: 't1',
        target: { platform: 'qq', conversationId: '456', kind: 'group' },
        payload, idempotencyKey: `bad-${type}-${why}`,
      });
      assert.equal(res.body.ok, false, `${type}/${why}`);
      assert.equal(res.body.error.code, 'E_SCHEMA', `${type}/${why}: ${JSON.stringify(res.body)}`);
    }
  });
});

test('清单外的 type 仍回 E_UNSUPPORTED（词汇表不能被 payload 夹带扩容）', async () => {
  const { manifest } = loadActionsManifest();
  const { handler } = makeHandler({ manifest });
  await withServer(handler, async (port) => {
    const res = await postSigned(port, '/v1/actions', {
      v: 1, actionId: 'probe-unknown', type: 'fly_to_moon', turnId: 't1',
      target: { platform: 'qq', conversationId: '456', kind: 'group' },
      payload: {}, idempotencyKey: 'probe-unknown',
    });
    assert.equal(res.body.error.code, 'E_UNSUPPORTED');
  });
});

// ── GET /v1/actions/manifest ───────────────────────────────────────────────

test('GET /v1/actions/manifest：签名后返回清单；未签名 401', async () => {
  const { manifest } = loadActionsManifest();
  const { handler } = makeHandler({ manifest });
  await withServer(handler, async (port) => {
    const ok = await getSigned(port, '/v1/actions/manifest');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.v, 1);
    assert.equal(ok.body.platform, 'qq');
    assert.ok(Array.isArray(ok.body.actions) && ok.body.actions.length >= 30);
    assert.equal(ok.body.actions[0].type, 'send_text');

    const anonymous = await fetch(`http://127.0.0.1:${port}/v1/actions/manifest`);
    assert.equal(anonymous.status, 401);
  });
});

test('无清单时 GET manifest 回 503（降级到内置三分发的形态）', async () => {
  const { handler } = makeHandler();
  await withServer(handler, async (port) => {
    const res = await getSigned(port, '/v1/actions/manifest');
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'E_DISABLED');
  });
});
