// shared/http-client：AbortSignal 必须真正取消请求（否则 turn 超时/关停时
// 请求仍会跑满 timeout，连接与句柄一直占着）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { createHttpClient } = await import(
  new URL('../src/shared/http-client.mjs', import.meta.url).href
);

async function startServer() {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    // 永不响应：只有 signal 能让请求提前结束。
    if (req.url === '/hang') return;
    res.end('ok');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('http-client: request() 透传 signal，取消立即返回 E_NETWORK', async () => {
  const server = await startServer();
  try {
    // timeoutMs 远大于取消时间：若 signal 被丢弃，这条会跑满 5s。
    const client = createHttpClient({ baseUrl: `http://127.0.0.1:${server.port}`, timeoutMs: 5000 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    timer.unref?.();
    const started = Date.now();
    const result = await client.get('/hang', { signal: controller.signal });
    const elapsed = Date.now() - started;
    clearTimeout(timer);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_NETWORK');
    assert.ok(elapsed < 1000, `取消后应在 1s 内返回（实际 ${elapsed}ms）`);
  } finally {
    await server.close();
  }
});

test('http-client: requestRaw() 透传 signal，取消立即返回', async () => {
  const server = await startServer();
  try {
    const client = createHttpClient({ timeoutMs: 5000 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    timer.unref?.();
    const started = Date.now();
    const result = await client.requestRaw('GET', `http://127.0.0.1:${server.port}/hang`, {
      signal: controller.signal,
    });
    const elapsed = Date.now() - started;
    clearTimeout(timer);
    assert.equal(result.ok, false);
    assert.ok(elapsed < 1000, `取消后应在 1s 内返回（实际 ${elapsed}ms）`);
  } finally {
    await server.close();
  }
});

test('http-client: 未取消时正常返回', async () => {
  const server = await startServer();
  try {
    const client = createHttpClient({ baseUrl: `http://127.0.0.1:${server.port}`, timeoutMs: 2000 });
    const result = await client.get('/ok');
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
  } finally {
    await server.close();
  }
});
