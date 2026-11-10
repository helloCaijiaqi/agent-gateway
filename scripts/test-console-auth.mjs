// operator 认证（docs/console/auth/PLAN.md）验收测试：
// 双凭据通道、Cookie 签发/过期/吊销、CSRF、rotate、双通道读端点、console off。
// 全部离线：临时 stateDir，适配器 HMAC 通道行为由既有测试钉住（此处仅回归读端点双通道）。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { loadConfig } = await import(new URL('../src/core/config.mjs', import.meta.url).href);
const { createGatewayServer } = await import(new URL('../src/core/server.mjs', import.meta.url).href);
const { issueOperatorSession } = await import(new URL('../src/core/auth.mjs', import.meta.url).href);

const TOKEN = 'test-operator-token-0123456789';
const SECRET = 'adapter-secret-0123456789';
const ADAPTERS = [{ id: 'qq-main', platform: 'qq', secret: SECRET }];

async function startServer(envExtra = {}, adapters = ADAPTERS) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'gw-console-test-'));
  const config = loadConfig({
    // GATEWAY_PORT=0：node --test 并发跑多个文件，别的测试文件也可能监听默认端口。
    env: { GATEWAY_MODE: 'shadow', GATEWAY_CONSOLE: 'on', GATEWAY_OPERATOR_TOKEN: TOKEN, GATEWAY_PORT: '0', ...envExtra },
    adapters,
    stateDir,
  });
  const gateway = createGatewayServer({ config, logger: () => {} });
  await gateway.listen();
  return { gateway, config, stateDir, base: `http://127.0.0.1:${gateway.server.address().port}` };
}

test('console auth: 自动生成并持久化 operator token（fail-closed 的替代路径）', async () => {
  const { gateway, stateDir } = await startServer({ GATEWAY_OPERATOR_TOKEN: '' });
  try {
    const tokenFile = path.join(stateDir, 'operator-token');
    assert.ok(existsSync(tokenFile), 'token 应自动持久化到 state/operator-token');
    const generated = readFileSync(tokenFile, 'utf8').trim();
    assert.match(generated, /^[A-Za-z0-9_-]{16,128}$/);
    const res = await fetch(`${gateway.server.address ? 'http://127.0.0.1:' + gateway.server.address().port : ''}/v1/console/session`, {
      headers: { 'x-operator-token': generated },
    });
    assert.equal(res.status, 200);
  } finally {
    await gateway.close();
  }
});

test('console auth: 登录换发 Cookie（HttpOnly/SameSite）与双凭据自检', async () => {
  const { gateway, base } = await startServer();
  try {
    // x-operator-token 通道。
    const viaToken = await fetch(`${base}/v1/console/session`, { headers: { 'x-operator-token': TOKEN } });
    assert.equal(viaToken.status, 200);
    assert.equal((await viaToken.json()).via, 'token');

    // 登录 → Set-Cookie 旗标。
    const login = await fetch(`${base}/v1/console/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.getSetCookie().join('\n');
    assert.match(setCookie, /console_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    const cookie = /console_session=([^;]+)/.exec(setCookie)[1];

    const viaCookie = await fetch(`${base}/v1/console/session`, { headers: { cookie: `console_session=${cookie}` } });
    assert.equal(viaCookie.status, 200);
    assert.equal((await viaCookie.json()).via, 'cookie');

    // 错误凭据 401（两种通道各自验证）。
    assert.equal((await fetch(`${base}/v1/console/session`, { headers: { 'x-operator-token': 'wrong-token-0123456789' } })).status, 401);
    assert.equal((await fetch(`${base}/v1/console/session`)).status, 401);
    const badLogin = await fetch(`${base}/v1/console/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'wrong-token-0123456789' }),
    });
    assert.equal(badLogin.status, 401);
  } finally {
    await gateway.close();
  }
});

test('console auth: 过期 Cookie 401；DELETE 吊销后旧 Cookie 失效', async () => {
  const { gateway, base } = await startServer({ GATEWAY_CONSOLE_SESSION_TTL_MS: '1000' });
  try {
    const login = await fetch(`${base}/v1/console/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
    const cookie = /console_session=([^;]+)/.exec(login.headers.getSetCookie().join('\n'))[1];

    // 手工构造过期会话：签名有效但 exp 已过 → 401（区分于 invalid 的语义由 metrics 承担）。
    const expired = issueOperatorSession({ secret: TOKEN, ttlMs: -1000 });
    const expiredRes = await fetch(`${base}/v1/console/session`, {
      headers: { cookie: `console_session=${expired.value}` },
    });
    assert.equal(expiredRes.status, 401);

    // 登出吊销。
    const logout = await fetch(`${base}/v1/console/session`, {
      method: 'DELETE',
      headers: { cookie: `console_session=${cookie}` },
    });
    assert.equal(logout.status, 200);
    const after = await fetch(`${base}/v1/console/session`, { headers: { cookie: `console_session=${cookie}` } });
    assert.equal(after.status, 401, '吊销后的旧 Cookie 必须失效');
  } finally {
    await gateway.close();
  }
});

test('console auth: CSRF——写操作要求 JSON content-type 且同源 Origin', async () => {
  const { gateway, base } = await startServer();
  try {
    const port = gateway.server.address().port;
    // 非 JSON 写 → 403。
    const formPost = await fetch(`${base}/v1/console/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=' + TOKEN,
    });
    assert.equal(formPost.status, 403);
    // 异源 Origin → 403。
    const crossOrigin = await fetch(`${base}/v1/console/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ token: TOKEN }),
    });
    assert.equal(crossOrigin.status, 403);
    // 同源 Origin → 200（host 一致）。
    const sameOrigin = await fetch(`${base}/v1/console/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ token: TOKEN }),
    });
    assert.equal(sameOrigin.status, 200);
  } finally {
    await gateway.close();
  }
});

test('console auth: rotate 更换长期 token 并让旧凭据/旧会话全部失效', async () => {
  const { gateway, config, base } = await startServer();
  try {
    const login = await fetch(`${base}/v1/console/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
    const oldCookie = /console_session=([^;]+)/.exec(login.headers.getSetCookie().join('\n'))[1];

    const nextToken = 'rotated-operator-token-0123456789';
    const rotate = await fetch(`${base}/v1/console/session/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-operator-token': TOKEN },
      body: JSON.stringify({ token: nextToken }),
    });
    assert.equal(rotate.status, 200);
    assert.equal(config.console.operatorToken, nextToken, 'rotate 后网关内凭据立即切换');

    // 旧 token / 旧 Cookie → 401；新 token → 200。
    assert.equal((await fetch(`${base}/v1/console/session`, { headers: { 'x-operator-token': TOKEN } })).status, 401);
    assert.equal((await fetch(`${base}/v1/console/session`, { headers: { cookie: `console_session=${oldCookie}` } })).status, 401);
    assert.equal((await fetch(`${base}/v1/console/session`, { headers: { 'x-operator-token': nextToken } })).status, 200);

    // rotate 落盘：重启后凭据仍是新值（读 token 文件）。
    const persisted = readFileSync(config.console.tokenFile, 'utf8').trim();
    assert.equal(persisted, nextToken);

    // 非法格式的新 token → 400。
    const bad = await fetch(`${base}/v1/console/session/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-operator-token': nextToken },
      body: JSON.stringify({ token: 'short' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await gateway.close();
  }
});

test('console auth: rotate 空 body 自动生成新 token（randomBytes 分支）', async () => {
  const { gateway, config, base } = await startServer();
  try {
    const res = await fetch(`${base}/v1/console/session/rotate`, {
      method: 'POST',
      headers: {
        'x-operator-token': TOKEN,
        'content-type': 'application/json',
        // CSRF：跨源被拒，同源放行（与上面的 session 用例同口径）。
        origin: new URL(base).origin,
      },
      body: JSON.stringify({}),
    });
    // 以前这里会 ReferenceError（randomBytes 未导入）→ 500。
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.generated, true);
    assert.equal(typeof config.console.operatorToken, 'string');
    assert.notEqual(config.console.operatorToken, TOKEN, '自动生成的分支必须换掉旧凭据');
    assert.match(config.console.operatorToken, /^[A-Za-z0-9_-]{24,}$/);
  } finally {
    await gateway.close();
  }
});

test('console auth: /v1/turns 双通道——仅持 operator 凭据可读（无适配器密钥）', async () => {
  const { gateway, base } = await startServer();
  try {
    const res = await fetch(`${base}/v1/turns`, { headers: { 'x-operator-token': TOKEN } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    // 无凭据 → 401。
    assert.equal((await fetch(`${base}/v1/turns`)).status, 401);
  } finally {
    await gateway.close();
  }
});

test('console auth: GATEWAY_CONSOLE=off 时控制面 503 且不要求凭据', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'gw-console-off-'));
  const config = loadConfig({
    env: { GATEWAY_MODE: 'shadow', GATEWAY_CONSOLE: 'off', GATEWAY_OPERATOR_TOKEN: TOKEN, GATEWAY_PORT: '0' },
    adapters: ADAPTERS,
    stateDir,
  });
  const gateway = createGatewayServer({ config, logger: () => {} });
  await gateway.listen();
  try {
    const res = await fetch(`http://127.0.0.1:${gateway.server.address().port}/v1/console/session`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'E_DISABLED');
  } finally {
    await gateway.close();
  }
});
