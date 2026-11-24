// media-send executor 专项单测（2026-11-25）：
// ① toolResult 信封 data 层解包——callServiceTool 返回 {v, callId, ok, data}，
//    业务载荷在 data（2026-11-25 修正：旧实现直读 result.found 恒 undefined，
//    ready 资产被误报 E_NOT_FOUND）。
// ② convertSend 发送凭据三级回退：sourcePath > http URL > ref 同机路径。
// ③ 成功后 best-effort 回写 chat_media_mark_used。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMediaSendExecutor } = await import(new URL('../src/executors/media-send.mjs', import.meta.url).href);

const SESSION_KEY = 'qq:svc-x:private:123';
const MEDIA_ID = 'ma_5c409939feba';
const REF = 'c:/memory-mcp/state/media/qq/a.jpg';

function makeExecutor({ toolResults, deliveries = [] }) {
  const serviceCalls = [];
  const executor = createMediaSendExecutor({
    adapters: [{ adapter: { id: 'svc-qq', platform: 'qq' }, manifest: { actions: [{ type: 'send_image' }] } }],
    deliver: async ({ action, ctx }) => {
      deliveries.push({ action, args: { ...ctx.payload } });
      return { ok: true };
    },
    resolveMemoryService: () => 'svc-memory',
    callServiceTool: async (serviceId, request) => {
      serviceCalls.push({ serviceId, ...request });
      const next = toolResults.shift() ?? { ok: true, data: {} };
      return { v: 1, callId: 'svctool-x', ...next };
    },
    logger: () => {},
  });
  return { executor, serviceCalls, deliveries };
}

const ctx = (payload) => ({
  sessionKey: SESSION_KEY,
  turnId: 'turn_t1',
  turnToken: 'tok',
  payload,
});

test('media-send: toolResult data 层解包——mediaId 直发 ready 资产（fileRef 回退）', async () => {
  const deliveries = [];
  const { executor, serviceCalls } = makeExecutor({
    toolResults: [{ ok: true, data: { found: true, media: { mediaId: MEDIA_ID, kind: 'image', desc: '动漫', ref: REF, status: 'ready' } } }],
    deliveries,
  });
  const result = await executor.call({ action: 'chat_media_send', ctx: ctx({ mediaId: MEDIA_ID, caption: 'hi' }) });
  assert.equal(result.ok, true, `应发送成功，实际: ${JSON.stringify(result).slice(0, 200)}`);
  assert.equal(result.receipt.sent, 'send_image');
  assert.equal(result.receipt.mediaId, MEDIA_ID);
  assert.equal(deliveries.at(-1).args.fileRef, REF, 'ref 同机路径应作为 fileRef（sourcePath 缺省回退）');
  assert.equal(deliveries.at(-1).args.caption, 'hi');
  assert.equal(serviceCalls.at(-1).tool, 'chat_media_mark_used', '发送成功应回写学习信号');
});

test('media-send: sourcePath 优先于 ref；http URL 走 url 通道', async () => {
  const deliveries = [];
  const { executor } = makeExecutor({
    toolResults: [{ ok: true, data: { found: true, media: { mediaId: MEDIA_ID, kind: 'image', sourcePath: 'c:/a.png', ref: REF, status: 'ready' } } }],
    deliveries,
  });
  const r1 = await executor.call({ action: 'chat_media_send', ctx: ctx({ mediaId: MEDIA_ID }) });
  assert.equal(deliveries.at(-1).args.fileRef, 'c:/a.png', '显式 sourcePath 优先');
  const executor2 = createMediaSendExecutor({
    adapters: [{ adapter: { id: 'svc-qq', platform: 'qq' }, manifest: { actions: [{ type: 'send_image' }] } }],
    deliver: async ({ ctx }) => { deliveries.push({ args: { ...ctx.payload } }); return { ok: true }; },
    resolveMemoryService: () => 'svc-memory',
    callServiceTool: async () => ({ v: 1, callId: 'x', ok: true, data: { found: true, media: { mediaId: MEDIA_ID, kind: 'image', ref: 'https://e.com/a.jpg', status: 'ready' } } }),
    logger: () => {},
  });
  const r2 = await executor2.call({ action: 'chat_media_send', ctx: ctx({ mediaId: MEDIA_ID }) });
  assert.equal(r2.ok, true);
  assert.equal(deliveries.at(-1).args.url, 'https://e.com/a.jpg', 'http ref 走 url 通道');
});

test('media-send: data 层无 found → 结构化 E_NOT_FOUND（不抛异常、不静默）', async () => {
  const { executor } = makeExecutor({ toolResults: [{ ok: true, data: {} }] });
  const result = await executor.call({ action: 'chat_media_send', ctx: ctx({ mediaId: MEDIA_ID }) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_NOT_FOUND');
  assert.equal(result.degraded, true);
});

test('media-send: query 模式走 search（data.media 列表）并取评分第一名', async () => {
  const deliveries = [];
  const { executor, serviceCalls } = makeExecutor({
    toolResults: [{ ok: true, data: { media: [{ mediaId: 'ma_aaaaaaaaaaaa', kind: 'image', desc: '猫', ref: 'c:/cat.jpg', status: 'ready' }, { mediaId: 'ma_bbbbbbbbbbbb', kind: 'image', desc: '狗', ref: 'c:/dog.jpg', status: 'ready' }] } }],
    deliveries,
  });
  const result = await executor.call({ action: 'chat_media_send', ctx: ctx({ query: '猫' }) });
  assert.equal(result.ok, true);
  assert.equal(result.receipt.mediaId, 'ma_aaaaaaaaaaaa');
  assert.equal(result.receipt.alternatives.length, 1, '候选>1 时附备选列表');
  assert.equal(serviceCalls.at(-2).tool, 'chat_media_search');
});
