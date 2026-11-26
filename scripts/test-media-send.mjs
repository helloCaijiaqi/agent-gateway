// media-send executor 专项单测（2026-11-25；三工具拆分后更新）：
// ① toolResult 信封 data 层解包——callServiceTool 返回 {v, callId, ok, data}，
//    业务载荷在 data（2026-11-25 修正：旧实现直读 result.found 恒 undefined，
//    ready 资产被误报 E_NOT_FOUND）。
// ② convertSend 发送凭据分流（v8：认知面 ref = media_asset.source_path 唯一真值）：
//    本地路径走 fileRef/voice 通道，http URL 走 url 通道。
// ③ 成功后 best-effort 回写 chat_media_mark_used。
// ④ 三工具拆分（chat_image_send / chat_voice_send / chat_file_send）：
//    各工具按声明 kind 校验资产，错配显式 E_UNSUPPORTED；chat_media_send 退役。
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
    adapters: [{ adapter: { id: 'svc-qq', platform: 'qq' }, manifest: { actions: [{ type: 'send_image' }, { type: 'send_voice' }] } }],
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
  const result = await executor.call({ action: 'chat_image_send', ctx: ctx({ mediaId: MEDIA_ID, caption: 'hi' }) });
  assert.equal(result.ok, true, `应发送成功，实际: ${JSON.stringify(result).slice(0, 200)}`);
  assert.equal(result.receipt.sent, 'send_image');
  assert.equal(result.receipt.mediaId, MEDIA_ID);
  assert.equal(deliveries.at(-1).args.fileRef, REF, 'ref 同机路径应作为 fileRef（sourcePath 缺省回退）');
  assert.equal(deliveries.at(-1).args.caption, 'hi');
  assert.equal(serviceCalls.at(-1).tool, 'chat_media_mark_used', '发送成功应回写学习信号');
});

test('media-send: v8 凭据分流——本地路径走 fileRef 通道；http URL 走 url 通道', async () => {
  const deliveries = [];
  const { executor } = makeExecutor({
    toolResults: [{ ok: true, data: { found: true, media: { mediaId: MEDIA_ID, kind: 'image', ref: 'c:/a.png', status: 'ready' } } }],
    deliveries,
  });
  const r1 = await executor.call({ action: 'chat_image_send', ctx: ctx({ mediaId: MEDIA_ID }) });
  assert.equal(r1.ok, true);
  assert.equal(deliveries.at(-1).args.fileRef, 'c:/a.png', '本地路径 ref 走 fileRef 通道');
  const executor2 = createMediaSendExecutor({
    adapters: [{ adapter: { id: 'svc-qq', platform: 'qq' }, manifest: { actions: [{ type: 'send_image' }] } }],
    deliver: async ({ ctx }) => { deliveries.push({ args: { ...ctx.payload } }); return { ok: true }; },
    resolveMemoryService: () => 'svc-memory',
    callServiceTool: async () => ({ v: 1, callId: 'x', ok: true, data: { found: true, media: { mediaId: MEDIA_ID, kind: 'image', ref: 'https://e.com/a.jpg', status: 'ready' } } }),
    logger: () => {},
  });
  const r2 = await executor2.call({ action: 'chat_image_send', ctx: ctx({ mediaId: MEDIA_ID }) });
  assert.equal(r2.ok, true);
  assert.equal(deliveries.at(-1).args.url, 'https://e.com/a.jpg', 'http ref 走 url 通道');
});

test('media-send: data 层无 found → 结构化 E_NOT_FOUND（不抛异常、不静默）', async () => {
  const { executor } = makeExecutor({ toolResults: [{ ok: true, data: {} }] });
  const result = await executor.call({ action: 'chat_image_send', ctx: ctx({ mediaId: MEDIA_ID }) });
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
  const result = await executor.call({ action: 'chat_image_send', ctx: ctx({ query: '猫' }) });
  assert.equal(result.ok, true);
  assert.equal(result.receipt.mediaId, 'ma_aaaaaaaaaaaa');
  assert.equal(result.receipt.alternatives.length, 1, '候选>1 时附备选列表');
  assert.equal(serviceCalls.at(-2).tool, 'chat_media_search');
});

test('media-send: chat_voice_send 发 voice 资产 → send_voice；错 kind 显式 E_UNSUPPORTED', async () => {
  const deliveries = [];
  const { executor } = makeExecutor({
    toolResults: [
      { ok: true, data: { found: true, media: { mediaId: MEDIA_ID, kind: 'voice', desc: '语音', ref: 'audio/out.wav', status: 'ready' } } },
      { ok: true, data: { marked: true } }, // mark_used 消耗
      { ok: true, data: { found: true, media: { mediaId: MEDIA_ID, kind: 'image', desc: '图', ref: REF, status: 'ready' } } },
    ],
    deliveries,
  });
  const ok = await executor.call({ action: 'chat_voice_send', ctx: ctx({ mediaId: MEDIA_ID }) });
  assert.equal(ok.ok, true, `语音应发送成功: ${JSON.stringify(ok).slice(0, 160)}`);
  assert.equal(ok.receipt.sent, 'send_voice');
  assert.equal(deliveries.at(-1).args.voice, 'audio/out.wav');
  const mismatch = await executor.call({ action: 'chat_voice_send', ctx: ctx({ mediaId: MEDIA_ID }) });
  assert.equal(mismatch.ok, false, 'voice 工具发 image 资产应被拒');
  assert.equal(mismatch.code, 'E_UNSUPPORTED');
});

test('media-send: chat_voice_send 凭据=source_path 派生（分段命名合成产物走同机绝对路径直达）', async () => {
  const deliveries = [];
  const { executor } = makeExecutor({
    toolResults: [
      { ok: true, data: { found: true, media: { mediaId: MEDIA_ID, kind: 'voice', desc: '早上好', ref: 'c:/memory-mcp/state/data/media/qq/audio/ma_0123456789ab.out.wav', status: 'ready' } } },
      { ok: true, data: { marked: true } }, // mark_used 消耗
    ],
    deliveries,
  });
  const ok = await executor.call({ action: 'chat_voice_send', ctx: ctx({ mediaId: MEDIA_ID }) });
  assert.equal(ok.ok, true, `source_path 凭据直发应成功: ${JSON.stringify(ok).slice(0, 160)}`);
  assert.equal(deliveries.at(-1).action, 'send_voice');
  assert.equal(deliveries.at(-1).args.voice, 'c:/memory-mcp/state/data/media/qq/audio/ma_0123456789ab.out.wav', 'voice 参数=同机绝对路径（bridge trustedRoots 白名单直达）');
});

test('media-send: chat_media_send 已退役（E_UNSUPPORTED 并指引新工具）', async () => {
  const { executor } = makeExecutor({ toolResults: [] });
  const result = await executor.call({ action: 'chat_media_send', ctx: ctx({ mediaId: MEDIA_ID }) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_UNSUPPORTED');
  assert.match(result.message, /chat_image_send/);
});
