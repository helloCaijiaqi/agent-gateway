/**
 * 回归守卫：mux 重连循环绝不刷连接（2026-11-16 全机断网事故）。
 *
 * 事故形态：`_connectOnce` 在 WebSocket「打开」时就 resolve，`_connectLoop` 拿到
 * resolve 后立刻再建一条新连接——旧连接仍然存活，于是循环以 CPU 速度堆积 socket，
 * 实测 30s 内 3 万条 ESTABLISHED 打向 127.0.0.1:3080，占满本机临时端口，
 * **整机所有新出站连接失败**（浏览器连百度都打不开）。
 *
 * 本测试用一个「接受 upgrade 后立即关闭」的假 DSH 服务端模拟最恶劣对端：
 * 修复后客户端必须退避，4 秒内握手次数应为个位数；修复前会是数百次。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { DshClient } from '../src/runtime/dsh-client.mjs';

test('mux 重连：对端握手后立即关闭时严格退避，不刷连接', async () => {
  let upgrades = 0;
  const server = http.createServer((req, res) => res.end('ok'));
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    upgrades += 1;
    wss.handleUpgrade(req, socket, head, (ws) => {
      // 最恶劣对端：握手成功但立刻关掉（旧代码在这里会无延迟疯狂重连）。
      ws.close(1001, 'go away');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const client = new DshClient({ baseUrl: `http://127.0.0.1:${port}`, logger: () => {} });
  // 测试不涉及鉴权：直接跳过 ensureAuth（它要读 DSH 凭据文件/mint cookie）。
  client.ensureAuth = async () => { client.cookie = 'stub=1'; };
  client.invalidateAuth = () => {};

  try {
    client.startStream(() => {});
    await new Promise((resolve) => setTimeout(resolve, 4000));
    client.stopStream();

    // 4s 窗口：首次连接 + 最多 3 次退避重试（首次退避 3s，之后翻倍）。
    assert.ok(upgrades >= 1, '至少尝试过一次连接');
    assert.ok(upgrades <= 4, `不应出现连接风暴（实际 ${upgrades} 次握手 / 4s）`);
  } finally {
    client.stopStream();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});
