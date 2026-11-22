// POST /v1/console/mode：GATEWAY_DATA_PLANE 控制台开关（常驻装配 + 请求期门禁）。
// 校验链 = 原启动期 fail-closed（消费端非空 + 编排键有主 + 步骤名合法），从启动期
// 挪到切换点；内存 config.mode 即时翻转（全站活读），env 文件原子持久化。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { loadConfig } = await import(new URL('../src/core/config.mjs', import.meta.url).href);
const { createGatewayServer } = await import(new URL('../src/core/server.mjs', import.meta.url).href);
const { createConsumerRegistry, seedConsumer, seedOperatorToken } = await import(
  new URL('./support/consumer-registration.mjs', import.meta.url).href
);

const TOKEN = 'test-operator-token-0123456789';
const OPERATOR = { 'x-operator-token': TOKEN, connection: 'close' };
const JSON_TYPE = { 'content-type': 'application/json', connection: 'close' };

async function startServer({ consumers = [], envFile = true, mode = 'off', pipelines = null } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-mode-test-'));
  seedOperatorToken(stateDir, TOKEN);
  for (const consumer of consumers) {
    seedConsumer(stateDir, {
      id: consumer.id ?? 'qq-main',
      platform: consumer.platform ?? 'qq',
      secret: consumer.secret ?? 'adapter-secret-0123456789',
      url: consumer.url ?? 'http://127.0.0.1:3100',
    });
  }
  if (pipelines) {
    // pipelines.json 结构 = {"pipelines": {...}, "returnPipelines"?：{...}}（键嵌套）。
    fs.writeFileSync(path.join(stateDir, 'pipelines.json'), JSON.stringify({ pipelines }), 'utf8');
  }
  const envFilePath = envFile ? path.join(stateDir, 'test.env') : null;
  // 夹具键为中性运维参数（GATEWAY_WS 开关已退役，不再作夹具）；断言「写回不污染
  // 无关行」用它当锚。
  if (envFile) fs.writeFileSync(envFilePath, 'GATEWAY_WS_HEARTBEAT_MS=30000\n', 'utf8');
  const config = loadConfig({
    env: {
      GATEWAY_DATA_PLANE: mode,
      GATEWAY_ENV_FILE: envFilePath ?? '',
      GATEWAY_PORT: '0',
      GATEWAY_WS_HEARTBEAT_MS: '30000',
      GATEWAY_PIPELINE: pipelines ? 'on' : 'off',
    },
    stateDir,
  });
  const services = createConsumerRegistry({ stateDir });
  const gateway = createGatewayServer({
    config, logger: () => {}, services, envFile: envFilePath,
  });
  await gateway.listen();
  const { port } = gateway.server.address();
  return { gateway, base: `http://127.0.0.1:${port}`, stateDir, envFilePath, services, config };
}

async function postMode(base, body, headers = { ...OPERATOR, ...JSON_TYPE }) {
  const res = await fetch(`${base}/v1/console/mode`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('mode 开关：无 operator 凭据 401；非法 body 400', async () => {
  const { gateway, base } = await startServer();
  try {
    const noAuth = await postMode(base, { mode: 'on' }, JSON_TYPE);
    assert.equal(noAuth.status, 401);
    const badBody = await postMode(base, { mode: 'shadow' });
    assert.equal(badBody.status, 400);
    assert.equal(badBody.json.error.code, 'E_SCHEMA');
    // GET 不允许（显式 405，避免「读不到就猜」）。
    const getRes = await fetch(`${base}/v1/console/mode`, { headers: OPERATOR });
    assert.equal(getRes.status, 405);
  } finally {
    await gateway.close();
  }
});

test('mode 开关：切 on 且零消费端 → 400 E_STATE，env 文件不被污染', async () => {
  const { gateway, base, envFilePath, config } = await startServer();
  try {
    assert.equal(config.mode, 'off');
    const result = await postMode(base, { mode: 'on' });
    assert.equal(result.status, 400);
    assert.equal(result.json.error.code, 'E_STATE');
    assert.match(result.json.error.message, /no consumer registration/);
    // 校验失败不翻转内存、不写 env。
    assert.equal(config.mode, 'off');
    assert.equal(fs.readFileSync(envFilePath, 'utf8'), 'GATEWAY_WS_HEARTBEAT_MS=30000\n');
  } finally {
    await gateway.close();
  }
});

test('mode 开关：有消费端 → 切 on 即时生效（health dataPlane=active）+ env 原子持久化', async () => {
  const { gateway, base, envFilePath, config } = await startServer({ consumers: [{}] });
  try {
    const result = await postMode(base, { mode: 'on' });
    assert.equal(result.status, 200);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.mode, 'on');
    assert.equal(result.json.previous, 'off');
    assert.equal(result.json.persisted, true, 'env 文件写回成功');
    // 内存即时翻转（零重启）：health 活读。
    const health = await (await fetch(`${base}/v1/health`)).json();
    assert.equal(health.mode, 'on');
    assert.equal(health.dataPlane, 'active');
    assert.equal(config.mode, 'on');
    // env 文件：原行保留 + GATEWAY_DATA_PLANE 追加。
    const envText = fs.readFileSync(envFilePath, 'utf8');
    assert.match(envText, /^GATEWAY_WS_HEARTBEAT_MS=30000$/m);
    assert.match(envText, /^GATEWAY_DATA_PLANE=on$/m);
  } finally {
    await gateway.close();
  }
});

test('mode 开关：切换写 env 保留注释与既有行；重复 upsert 原地替换', async () => {
  const { gateway, base, envFilePath } = await startServer({ consumers: [{}] });
  try {
    await postMode(base, { mode: 'on' });
    // 再切一次（on→off→...）：同键行原地替换，不重复追加。
    const off = await postMode(base, { mode: 'off' });
    assert.equal(off.status, 200);
    const on = await postMode(base, { mode: 'on' });
    assert.equal(on.status, 200);
    const envText = fs.readFileSync(envFilePath, 'utf8');
    assert.equal(envText.split('\n').filter((line) => line === 'GATEWAY_DATA_PLANE=on').length, 1, '无重复键行');
  } finally {
    await gateway.close();
  }
});

test('mode 开关：无 envFile → 内存生效但 persisted:false 明示重启回退', async () => {
  const { gateway, base, config } = await startServer({ consumers: [{}], envFile: false });
  try {
    const result = await postMode(base, { mode: 'on' });
    assert.equal(result.status, 200);
    assert.equal(result.json.persisted, false);
    assert.ok(result.json.persistNote);
    assert.equal(config.mode, 'on');
  } finally {
    await gateway.close();
  }
});

test('mode 开关：编排键无主 → 切 on 400（fail-closed 挪到切换点）', async () => {
  // pipelines.json 里 'ghost' 键没有对应消费端 → assertPipelinePermissions 拒绝。
  const { gateway, base, config } = await startServer({
    consumers: [{}],
    pipelines: { ghost: ['chat_memory_recall'] },
  });
  try {
    const result = await postMode(base, { mode: 'on' });
    assert.equal(result.status, 400);
    assert.equal(result.json.error.code, 'E_STATE');
    assert.match(result.json.error.message, /has no consumer behind it/);
    assert.equal(config.mode, 'off', '校验失败不翻转');
  } finally {
    await gateway.close();
  }
});

test('mode 开关：off 后入站 503 E_DISABLED（请求期门禁活读）', async () => {
  const { gateway, base, envFilePath } = await startServer({ consumers: [{}] });
  try {
    await postMode(base, { mode: 'on' });
    const healthOn = await (await fetch(`${base}/v1/health`)).json();
    assert.equal(healthOn.dataPlane, 'active');
    // 切 off：inbound 路由立即 503（不需要重启）。
    await postMode(base, { mode: 'off' });
    const healthOff = await (await fetch(`${base}/v1/health`)).json();
    assert.equal(healthOff.mode, 'off');
    assert.equal(healthOff.dataPlane, 'disabled');
    const inbound = await fetch(`${base}/v1/inbound`, {
      method: 'POST', headers: JSON_TYPE,
      body: JSON.stringify({ v: 1, platform: 'qq', adapterId: 'qq-main', conversationId: 'c1', kind: 'friend', msgId: 'm1', text: 'hi' }),
    });
    assert.equal(inbound.status, 503);
    assert.equal((await inbound.json()).error.code, 'E_DISABLED');
    assert.match(fs.readFileSync(envFilePath, 'utf8'), /^GATEWAY_DATA_PLANE=off$/m);
  } finally {
    await gateway.close();
  }
});
