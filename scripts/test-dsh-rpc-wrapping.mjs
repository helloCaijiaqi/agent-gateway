// 离线单测：dsh-client 的 mux 参数封装（callUnary）。
//
// 背景（2026-11-16 实测）：`session/modelCatalog` 被默认包成
// `{ args: { request: {} } }`，DSH 直接回
// `gateway/arguments-invalid: … args fields do not match the descriptor: unexpected "request"`，
// 于是 /v1/console/dsh/model 永远 source=fallback、控制台只能显示静态 efforts。
// 本文件把五类端点的 payload 形状钉死，避免再次「静默回退」。
import test from 'node:test';
import assert from 'node:assert/strict';

const { DshClient } = await import(new URL('../src/runtime/dsh-client.mjs', import.meta.url).href);

/** 桩：拦下 fetch 层，记录 message.payload，回伪造的 server-response。 */
function stubClient(value = null) {
  const client = new DshClient({
    baseUrl: 'http://127.0.0.1:3099',
    authOverride: { secret: null },
    logger: () => {},
  });
  const calls = [];
  client._doFetchWithAuth = async (url, init) => {
    const message = JSON.parse(init.body);
    calls.push({ url, method: message.method, payload: message.payload });
    return {
      json: async () => ({
        type: 'server-response',
        rpcId: message.rpcId,
        result: { ok: true, value },
      }),
    };
  };
  return { client, calls };
}

test('callUnary：session/modelCatalog 不套 request 包裹（descriptor 不接受）', async () => {
  const { client, calls } = stubClient();
  await client.callUnary('session.modelCatalog', {});
  assert.deepEqual(calls[0].payload, { args: {} });
  assert.ok(calls[0].url.endsWith('/api/session/modelCatalog'), calls[0].url);
});

test('callUnary：零参方法（agentPresets/list、settings/describe）同样不套包裹', async () => {
  const { client, calls } = stubClient();
  await client.callUnary('agentPresets.list', {});
  await client.callUnary('settings.describe', {});
  assert.deepEqual(calls.map((c) => c.payload), [{ args: {} }, { args: {} }]);
});

test('callUnary：session/list 用 _request 包裹（DSH 历史形状，不能跟着改）', async () => {
  const { client, calls } = stubClient();
  await client.callUnary('session.list', { workspaceId: 'ws-1' });
  assert.deepEqual(calls[0].payload, { args: { _request: { workspaceId: 'ws-1' } } });
});

test('callUnary：普通方法与 session/prompt 用 request 包裹，prompt 自动补 requestId', async () => {
  const { client, calls } = stubClient();
  await client.callUnary('agentPresets.list', {});
  await client.callUnary('session.prompt', { sessionId: 's1', text: 'hi' });
  assert.deepEqual(calls[0].payload, { args: {} });

  const promptArgs = calls[1].payload.args.request;
  assert.equal(promptArgs.sessionId, 's1');
  assert.equal(promptArgs.text, 'hi');
  assert.equal(typeof promptArgs.requestId, 'string');
  assert.ok(promptArgs.requestId.length > 10, 'requestId 必须是 uuid 形态');
});

test('modelCatalog：解包 catalog 字段（DSH 外面还包了一层 value）', async () => {
  const catalog = { groups: [{ models: [{ id: 'deepseek-flash', reasoning: { efforts: [{ id: 'max' }] } }] }] };
  const { client } = stubClient({ catalog });
  assert.deepEqual(await client.modelCatalog(), catalog);

  const bare = { groups: [] };
  const { client: client2 } = stubClient(bare);
  assert.deepEqual(await client2.modelCatalog(), bare, '没有 catalog 键时按原样返回');
});
