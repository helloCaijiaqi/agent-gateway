// 回滚演练（P5 verify）：验证每个开关「关掉即回旧行为」，而不是靠文档承诺。
//
// 四道闸门，对应设计文档的回滚矩阵：
//   1. GATEWAY_MODE=off        → 入站 503，适配器拿到明确失败并回本地路径；健康检查仍可用；
//   2. 白名单未命中            → 202 routed:false，适配器继续走自己的 mux（半接管状态自洽）；
//   3. 适配器 enabled:false    → 该平台不再登记：健康检查看不到、入站按未知适配器拒绝；
//   4. tools/state 子开关关掉  → 对应路由 503，core 不残留半装配的 handler。
//
// 全部离线（本机临时端口 + runtime 桩），不碰真 DSH/适配器。
// 用法：npm run verify:rollback
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const { loadConfig, configSummary } = await import(new URL('../src/core/config.mjs', import.meta.url).href);
const { createGatewayServer } = await import(new URL('../src/core/server.mjs', import.meta.url).href);
const { signRequest } = await import(new URL('../src/core/auth.mjs', import.meta.url).href);

const QQ_SECRET = 'rollback-qq-secret-0123456789';
const WX_SECRET = 'rollback-wx-secret-0123456789';

function tmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-rollback-'));
}

function createRuntimeStub() {
  const submitted = [];
  return {
    submitted,
    submit(record) { submitted.push(record); },
    connected: true,
    stop: async () => {},
    status: () => ({ liveTurns: 0 }),
    toolList: () => [],
    toolStatus: () => ({ liveTurns: 0, tools: [] }),
    toolCall: async () => ({ ok: false, error: { code: 'E_DISABLED', message: 'no tools' } }),
    stateGet: () => null,
    stateList: () => [],
    stateUpdate: async () => ({ ok: true, data: {} }),
    stateStats: () => ({ sessions: 0 }),
  };
}

async function startGateway({ mode, conversations = '', adapters = [], runtime = null }) {
  const config = loadConfig({
    env: { GATEWAY_MODE: mode, GATEWAY_PORT: '0', GATEWAY_CONVERSATIONS: conversations },
    stateDir: tmpStateDir(),
    adapters,
  });
  const gateway = createGatewayServer({ config, logger: () => {}, runtime });
  await gateway.listen();
  const { port } = gateway.server.address();
  return { gateway, config, base: `http://127.0.0.1:${port}` };
}

async function closeGateway(gateway) {
  // keep-alive 连接不关掉，close() 回调永远不会触发（测试绿、进程不退）。
  gateway.server.closeAllConnections?.();
  await gateway.close();
}

function envelopeFor({ platform = 'qq', kind = 'group', id = '1', adapterId = 'qq-main', text = '在吗' }) {
  return {
    v: 1,
    platform,
    adapterId,
    traceId: `rollback-${platform}-${id}`,
    receivedAt: Date.now(),
    conversation: { kind, id },
    message: {
      id: `rollback-${platform}-${id}-${randomBytes(4).toString('hex')}`,
      seq: 1,
      sender: { id: '10001', name: '张三', roles: ['member'] },
      text,
    },
  };
}

async function postInbound(base, { secret, adapterId, envelope }) {
  const body = JSON.stringify(envelope);
  const headers = signRequest({ secret, adapterId, body });
  const response = await fetch(`${base}/v1/inbound`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-adapter-id': adapterId,
      'x-timestamp': headers['x-timestamp'],
      'x-nonce': headers['x-nonce'],
      'x-signature': headers['x-signature'],
    },
    body,
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, body: data };
}

const results = [];
function record(name, expected, observed, pass) {
  results.push({ name, expected, observed, pass });
}

// ── 1. 关掉网关 ────────────────────────────────────────────────────────────────
{
  const started = await startGateway({ mode: 'off' });
  try {
    const inbound = await postInbound(started.base, {
      secret: QQ_SECRET,
      adapterId: 'qq-main',
      envelope: envelopeFor({}),
    });
    record(
      'GATEWAY_MODE=off：入站被拒，适配器回本地路径',
      '503 E_DISABLED',
      `${inbound.status} ${inbound.body?.error?.code}`,
      inbound.status === 503 && inbound.body?.error?.code === 'E_DISABLED',
    );
    const health = await fetch(`${started.base}/v1/health`);
    const healthBody = await health.json();
    record(
      'GATEWAY_MODE=off：健康检查仍可用（部署探测）',
      '200 ok:true',
      `${health.status} ok:${healthBody?.ok}`,
      health.status === 200 && healthBody?.ok === true,
    );
  } finally {
    await closeGateway(started.gateway);
  }
}

// ── 2. 灰度白名单未命中 ───────────────────────────────────────────────────────
{
  const runtime = createRuntimeStub();
  const started = await startGateway({
    mode: 'on',
    conversations: 'qq:group:1',
    adapters: [{ id: 'qq-main', platform: 'qq', secret: QQ_SECRET }],
    runtime,
  });
  try {
    const outside = await postInbound(started.base, {
      secret: QQ_SECRET,
      adapterId: 'qq-main',
      envelope: envelopeFor({ id: '2' }),
    });
    record(
      '白名单外的会话：202 routed:false，不接管',
      '202 routed:false',
      `${outside.status} routed:${outside.body?.routed}`,
      outside.status === 202 && outside.body?.routed === false,
    );
    const inside = await postInbound(started.base, {
      secret: QQ_SECRET,
      adapterId: 'qq-main',
      envelope: envelopeFor({ id: '1' }),
    });
    record(
      '白名单内的会话：202 routed:true，交给 runtime',
      '202 routed:true',
      `${inside.status} routed:${inside.body?.routed}`,
      inside.status === 202 && inside.body?.routed === true && runtime.submitted.length === 1,
    );
  } finally {
    await closeGateway(started.gateway);
  }
}

// ── 3. 摘掉第二个适配器 ───────────────────────────────────────────────────────
{
  const started = await startGateway({
    mode: 'on',
    conversations: 'qq:group:1',
    adapters: [
      { id: 'qq-main', platform: 'qq', secret: QQ_SECRET },
      { id: 'wx-main', platform: 'wx', secret: WX_SECRET, enabled: false },
    ],
    runtime: createRuntimeStub(),
  });
  try {
    const summary = configSummary(started.config);
    record(
      'wx-main enabled:false：健康检查只剩 qq',
      'adapters=[qq]',
      `adapters=[${summary.adapters.map((item) => item.platform).join(',')}]`,
      summary.adapters.length === 1 && summary.adapters[0].platform === 'qq',
    );
    const wx = await postInbound(started.base, {
      secret: WX_SECRET,
      adapterId: 'wx-main',
      envelope: envelopeFor({ platform: 'wx', kind: 'room', id: '123@chatroom', adapterId: 'wx-main' }),
    });
    record(
      '未登记的适配器入站：401 E_AUTH（不暴露「不存在」）',
      '401 E_AUTH',
      `${wx.status} ${wx.body?.error?.code}`,
      wx.status === 401 && wx.body?.error?.code === 'E_AUTH',
    );
  } finally {
    await closeGateway(started.gateway);
  }
}

// ── 4. 子开关关闭 ─────────────────────────────────────────────────────────────
{
  const started = await startGateway({
    mode: 'on',
    conversations: 'qq:group:1',
    adapters: [{ id: 'qq-main', platform: 'qq', secret: QQ_SECRET }],
    runtime: createRuntimeStub(),
  });
  try {
    const tools = await fetch(`${started.base}/v1/tools`);
    const toolsBody = await tools.json();
    record(
      'GATEWAY_TOOLS=off：/v1/tools 503',
      '503 E_DISABLED',
      `${tools.status} ${toolsBody?.error?.code}`,
      tools.status === 503 && toolsBody?.error?.code === 'E_DISABLED',
    );
    const stateUpdate = await fetch(`${started.base}/v1/state/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ v: 1, sessionKey: 'qq:group:1', action: 'inbound', seq: 1 }),
    });
    const stateBody = await stateUpdate.json();
    record(
      'GATEWAY_STATE=off：/v1/state/update 503',
      '503 E_DISABLED',
      `${stateUpdate.status} ${stateBody?.error?.code}`,
      stateUpdate.status === 503 && stateBody?.error?.code === 'E_DISABLED',
    );
    // P3 转正：GATEWAY_CONTEXT 已退役（读到一个都不行，fail-closed）；
    // 拼装回滚 = GATEWAY_PIPELINE=off 透传，这里只验缺省 on 接管。
    let retiredRejected = false;
    try {
      loadConfig({
        env: { GATEWAY_MODE: 'on', GATEWAY_PORT: '0', GATEWAY_CONTEXT: 'off' },
        stateDir: tmpStateDir(),
        adapters: [{ id: 'qq-main', platform: 'qq', secret: QQ_SECRET }],
      });
    } catch (error) {
      retiredRejected = /retired/.test(String(error?.message));
    }
    record(
      'GATEWAY_CONTEXT 设置：启动即拒（开关已退役）',
      'throw retired',
      retiredRejected ? 'throw retired' : 'accepted',
      retiredRejected,
    );
  } finally {
    await closeGateway(started.gateway);
  }
}

const pad = (value, width) => String(value).padEnd(width);
console.log('\n回滚演练：');
console.log(`${pad('闸门', 46)}${pad('预期', 18)}${pad('实测', 22)}结果`);
for (const row of results) {
  console.log(`${pad(row.name, 46)}${pad(row.expected, 18)}${pad(row.observed, 22)}${row.pass ? 'PASS' : 'FAIL'}`);
}

const failed = results.filter((row) => !row.pass);
if (failed.length) {
  console.error(`\n回滚演练失败 ${failed.length}/${results.length}：${failed.map((row) => row.name).join('；')}`);
  process.exit(1);
}
console.log(`\n结论：${results.length}/${results.length} 道闸门关闭后都回到旧行为。`);
