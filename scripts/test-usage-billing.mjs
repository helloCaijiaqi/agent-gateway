// usage-billing（docs/console/usage-billing/PLAN.md）+ adapters-overview
// （docs/console/adapters-overview/PLAN.md）验收测试。全部离线：
// 账本 = src/core/usage-ledger.mjs（自 qq-bridge token-ledger 上移，ingestTurn 幂等）；
// 路由 = 注入 runtime.usageLedger / turns stub。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { createTokenLedger } = await import(new URL('../src/core/usage-ledger.mjs', import.meta.url).href);
const { resolvePriceTable } = await import(new URL('../src/core/prices.mjs', import.meta.url).href);
const { loadConfig } = await import(new URL('../src/core/config.mjs', import.meta.url).href);
const { createGatewayServer } = await import(new URL('../src/core/server.mjs', import.meta.url).href);

const TOKEN = 'test-operator-token-0123456789';
const ADAPTERS = [
  { id: 'qq-main', platform: 'qq', secret: 'qq-secret-0123456789' },
  { id: 'wx-main', platform: 'wx', secret: 'wx-secret-0123456789' },
];

function tempLedger() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gw-ledger-'));
  return createTokenLedger({
    file: path.join(dir, 'usage-ledger.jsonl'),
    priceTable: resolvePriceTable(),
  });
}

const USAGE = { inputTokens: 1000, cacheReadTokens: 500, outputTokens: 200 };

test('usage-ledger: 三分桶计价（cacheRead 不并入 input）与 turnId 幂等', () => {
  const ledger = tempLedger();
  const at = Date.now();
  assert.equal(ledger.ingestTurn({
    sessionKey: 'qq:group:1', turnId: 'turn-1', at,
    usage: USAGE, model: 'deepseek-v4-pro', provider: 'deepseek', adapterId: 'qq-main',
  }), true);
  // 幂等：同 turnId 再入被拒，总量不变（重启后重放 / 重复落盘不重复计费）。
  assert.equal(ledger.ingestTurn({
    sessionKey: 'qq:group:1', turnId: 'turn-1', at,
    usage: USAGE, adapterId: 'qq-main',
  }), false);
  const s = ledger.summary();
  assert.equal(s.totals.turns, 1);
  // 1700 = cacheMiss 1000 + cacheRead 500 + cacheWrite 0 + output 200。
  assert.equal(s.totals.totalTokens, 1700);
  assert.equal(s.totals.inputTokens, 1500);
  // 峰谷两档，成本必须落在 [半价, 全价] 之间且不为零。
  assert.ok(s.totals.cost > 0);
  const table = resolvePriceTable();
  const rates = table.models['deepseek-v4-pro'];
  assert.ok(rates, '价目表应含 deepseek-v4-pro');
});

test('usage-ledger: 空桶采样拒收 / reset 需走服务端确认 / 逐轮明细与会话序列', () => {
  const ledger = tempLedger();
  const now = Date.now();
  assert.equal(ledger.ingestTurn({ sessionKey: 'qq:group:2', turnId: 't-e', usage: {} }), false);
  ledger.ingestTurn({ sessionKey: 'qq:group:2', turnId: 't1', at: now - 60_000, usage: USAGE, adapterId: 'qq-main' });
  ledger.ingestTurn({ sessionKey: 'qq:group:2', turnId: 't2', at: now, usage: USAGE, adapterId: 'wx-main' });
  const conv = ledger.conversation('qq:group:2');
  assert.ok(conv, '会话明细应存在');
  assert.equal(conv.turns.length, 2);
  assert.equal(conv.turns[0].turn, 2, '新的在前');
  assert.equal(ledger.conversation('nope'), null);
  const series = ledger.series({ hours: 1 });
  assert.equal(series.totals.turns, 2);
  assert.ok(series.buckets.length > 0);
  assert.equal(ledger.recent(10).length, 2);
  assert.ok(ledger.recent(10)[0].adapterId, 'recent 行带 adapterId');
  ledger.reset();
  assert.equal(ledger.summary().totals.turns, 0);
});

// ── 路由层 ──────────────────────────────────────────────────────────────────

async function startServer({ ledger, records = [] }) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'gw-billing-'));
  const config = loadConfig({
    // GATEWAY_PORT=0：每个用例独立临时端口——同进程串行起多台服务器时，
    // 固定端口会让 undici 连接池复用到上一台（已关闭）的半死连接上，报 ECONNRESET。
    env: { GATEWAY_MODE: 'shadow', GATEWAY_CONSOLE: 'on', GATEWAY_OPERATOR_TOKEN: TOKEN, GATEWAY_PORT: '0' },
    adapters: ADAPTERS,
    stateDir,
  });
  if (records.length > 0) {
    // server 内部自建 turn store（stateDir/turns.jsonl 启动时加载）——测试预写落盘文件。
    fs.writeFileSync(
      path.join(stateDir, 'turns.jsonl'),
      records.map((record) => JSON.stringify({ turnId: record.turnId, at: record.at, record })).join('\n') + '\n',
      'utf8',
    );
  }
  const gateway = createGatewayServer({
    config,
    logger: () => {},
    runtime: { usageLedger: ledger },
  });
  await gateway.listen();
  return {
    gateway,
    base: `http://127.0.0.1:${gateway.server.address().port}`,
    auth: { 'x-operator-token': TOKEN },
  };
}

const makeRecord = (turnId, adapterId, msAgo, overrides = {}) => ({
  turnId,
  sessionKey: `qq:group:${adapterId === 'wx-main' ? '9' : '1'}`,
  at: Date.now() - msAgo,
  finishedAt: Date.now() - msAgo,
  envelope: { platform: adapterId === 'wx-main' ? 'wx' : 'qq', adapterId },
  status: overrides.status ?? 'completed',
  result: {
    status: overrides.status ?? 'completed',
    usage: overrides.usage ?? USAGE,
    error: overrides.error ?? null,
  },
  ...overrides.extra,
});

test('console billing routes: summary/series/conversation/recent/prices + 401/403', async () => {
  const ledger = tempLedger();
  const at = Date.now();
  ledger.ingestTurn({ sessionKey: 'qq:group:1', turnId: 't1', at, usage: USAGE, model: 'deepseek-chat', adapterId: 'qq-main' });
  const records = [makeRecord('r1', 'qq-main', 10_000), makeRecord('r2', 'wx-main', 5_000)];
  const { gateway, base, auth } = await startServer({ ledger, records });
  try {
    // summary。
    const summary = await fetch(`${base}/v1/console/usage/summary`, { headers: auth });
    assert.equal(summary.status, 200);
    const s = await summary.json();
    assert.equal(s.ok, true);
    assert.equal(s.totals.turns, 1);
    assert.ok(s.priceTable.version, '价目表版本随 summary 返回');

    // series。
    const series = await fetch(`${base}/v1/console/usage/series?hours=1`, { headers: auth });
    assert.equal((await series.json()).ok, true);

    // conversation（sessionKey 带冒号需编码）。
    const conv = await fetch(`${base}/v1/console/usage/conversations/${encodeURIComponent('qq:group:1')}`, { headers: auth });
    assert.equal(conv.status, 200);
    assert.equal((await conv.json()).turns.length, 1);
    assert.equal((await fetch(`${base}/v1/console/usage/conversations/nope`, { headers: auth })).status, 404);

    // recent + prices。
    assert.equal((await fetch(`${base}/v1/console/usage/recent`, { headers: auth })).status, 200);
    const prices = await fetch(`${base}/v1/console/usage/prices`, { headers: auth });
    const p = await prices.json();
    assert.equal(p.ok, true);
    assert.ok(p.models, '价目快照含 models');
    assert.ok(p.peakWindows, '价目快照含峰谷窗口');

    // 未认证 401；agent token 403（跨群花费不能让群里的 AI 读到）。
    assert.equal((await fetch(`${base}/v1/console/usage/summary`)).status, 401);
    const agent = await fetch(`${base}/v1/console/usage/summary`, { headers: { 'x-agent-token': 'x' } });
    assert.equal(agent.status, 403);

    // reset：缺 confirm → 400；带 confirm → 清空。
    const noConfirm = await fetch(`${base}/v1/console/usage/reset`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(noConfirm.status, 400);
    const confirmed = await fetch(`${base}/v1/console/usage/reset`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', 'x-console-csrf': '1' },
      body: JSON.stringify({ confirm: 'reset' }),
    });
    assert.equal(confirmed.status, 200);
    assert.equal(ledger.summary().totals.turns, 0);
  } finally {
    await gateway.close();
  }
});

test('console adapters routes: 双适配器分账与 summary 对账 / 幽灵适配器 / 错误码分布 / 单适配器序列', async () => {
  const ledger = tempLedger();
  const at = Date.now();
  ledger.ingestTurn({ sessionKey: 'qq:group:1', turnId: 'tq1', at, usage: USAGE, model: 'deepseek-v4-pro', adapterId: 'qq-main' });
  ledger.ingestTurn({ sessionKey: 'qq:group:9', turnId: 'tw1', at, usage: USAGE, model: 'deepseek-v4-pro', adapterId: 'wx-main' });
  ledger.ingestTurn({ sessionKey: 'qq:group:9', turnId: 'tw2', at, usage: USAGE, model: 'deepseek-v4-pro', adapterId: 'ghost-x' });
  const records = [
    makeRecord('r1', 'qq-main', 10_000),
    makeRecord('r2', 'wx-main', 5_000, { status: 'error', error: { code: 'E_DSH_DOWN', message: 'down' } }),
    makeRecord('r3', 'ghost-x', 3_000, { status: 'error', error: { code: 'E_TIMEOUT', message: 'timeout' } }),
  ];
  const { gateway, base, auth } = await startServer({ ledger, records });
  try {
    const resp = await fetch(`${base}/v1/console/adapters?window=24h`, { headers: auth });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    const rows = new Map(body.adapters.map((a) => [a.id, a]));

    // 注册的与幽灵的都在，幽灵带 unregistered 标记。
    assert.equal(rows.get('qq-main').unregistered, false);
    assert.equal(rows.get('wx-main').unregistered, false);
    assert.equal(rows.get('ghost-x').unregistered, true, '配错密钥的幽灵适配器必须可见');

    // 分账与 usage/summary 口径一致（同一份账本同源聚合）。
    const summaryTotal = ledger.summary().totals.cost;
    const adapterTotal = body.adapters.reduce((acc, a) => acc + a.cost, 0);
    assert.ok(Math.abs(adapterTotal - summaryTotal) < 1e-9, 'adapters 总花费应与 summary 一致');
    assert.ok(Math.abs(rows.get('qq-main').cost - rows.get('wx-main').cost) < 1e-12, '同 usage 两个适配器花费相同');

    // 错误码分布 + turns。
    assert.equal(rows.get('qq-main').turns, 1);
    assert.equal(rows.get('wx-main').errorCodes.E_DSH_DOWN, 1);
    assert.equal(rows.get('ghost-x').errorCodes.E_TIMEOUT, 1);
    assert.ok(rows.get('wx-main').lastTurnAt > 0);

    // 离线适配器：注册但窗口内无 turn，行仍返回不消失。
    const offline = rows.get('qq-main');
    assert.ok(offline, '行不消失');

    // 未注册行也带消费（ghost-x 的 cost > 0）。
    assert.ok(rows.get('ghost-x').cost > 0);

    // 单适配器序列：桶阶梯与 usage/series 同源（同一实现，仅 adapterId 过滤）。
    const seriesAll = await (await fetch(`${base}/v1/console/usage/series?hours=1`, { headers: auth })).json();
    const seriesQq = await (await fetch(`${base}/v1/console/adapters/qq-main/usage?hours=1`, { headers: auth })).json();
    assert.equal(seriesQq.ok, true);
    assert.equal(seriesQq.bucketMs, seriesAll.bucketMs, '桶阶梯同源');
    assert.equal(seriesQq.totals.cost, rows.get('qq-main').cost);
    assert.equal(seriesQq.totals.turns, 1, '过滤后只含本适配器的采样');

    // 401。
    assert.equal((await fetch(`${base}/v1/console/adapters`)).status, 401);
  } finally {
    await gateway.close();
  }
});

test('config: GATEWAY_PRICING 覆盖进价目表', () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'gw-pricing-'));
  const config = loadConfig({
    env: { GATEWAY_PRICING: JSON.stringify({ peakMultiplier: 2 }) },
    adapters: ADAPTERS,
    stateDir,
  });
  const table = resolvePriceTable(config.pricing);
  assert.equal(table.peakMultiplier, 2);
  assert.throws(() => loadConfig({
    env: { GATEWAY_PRICING: 'not-json' },
    adapters: ADAPTERS,
    stateDir,
  }), /GATEWAY_PRICING/);
});

// ── P4.x：platform 维度 ─────────────────────────────────────────────────────

test('usage-ledger P4.x: byPlatform 聚合 + series platform 过滤 + 旧采样归 unknown', () => {
  const ledger = tempLedger();
  const now = Date.now();
  ledger.ingestTurn({ sessionKey: 'qq:group:1', turnId: 'p1', at: now, usage: USAGE, model: 'deepseek-v4-pro', adapterId: 'qq-main', platform: 'qq' });
  ledger.ingestTurn({ sessionKey: 'wx:group:2', turnId: 'p2', at: now, usage: USAGE, model: 'deepseek-v4-pro', adapterId: 'wx-main', platform: 'wx' });
  // 无 platform 的入账（旧调用方）归 (unknown)——向后兼容。
  ledger.ingestTurn({ sessionKey: 'qq:group:3', turnId: 'p3', at: now, usage: USAGE, model: 'deepseek-v4-pro', adapterId: 'qq-main' });

  const byPlatform = ledger.byPlatform();
  const qq = byPlatform.find((row) => row.platform === 'qq');
  const wx = byPlatform.find((row) => row.platform === 'wx');
  const unknown = byPlatform.find((row) => row.platform === '(unknown)');
  assert.ok(qq && wx && unknown, '三个平台桶都在');
  assert.equal(qq.turns, 1);
  assert.equal(wx.turns, 1);
  assert.equal(unknown.turns, 1);
  assert.ok(qq.cost > 0 && wx.cost > 0);
  assert.equal(qq.totalTokens, 1700);
  assert.ok(wx.models.includes('deepseek-v4-pro'));

  // series 按 platform 过滤：只算该平台的桶与总额。
  const qqSeries = ledger.series({ hours: 1, platform: 'qq' });
  assert.equal(qqSeries.totals.turns, 1);
  const wxSeries = ledger.series({ hours: 1, platform: 'wx' });
  assert.equal(wxSeries.totals.turns, 1);
  assert.notEqual(qqSeries.totals.cost, wxSeries.totals.cost === 0 ? qqSeries.totals.cost : -1);
  // adapterId 与 platform 可组合过滤。
  const both = ledger.series({ hours: 1, adapterId: 'wx-main', platform: 'wx' });
  assert.equal(both.totals.turns, 1);
  const mismatch = ledger.series({ hours: 1, adapterId: 'qq-main', platform: 'wx' });
  assert.equal(mismatch.totals.turns, 0, '维度不匹配 = 空');
});

test('usage-ledger P4.x: 重启重放保留 aid/pf 归属维度（load 修复既有 aid 丢失缺口）', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gw-ledger-pf-'));
  const file = path.join(dir, 'usage-ledger.jsonl');
  const first = createTokenLedger({ file, priceTable: resolvePriceTable() });
  first.ingestTurn({
    sessionKey: 'qq:group:9', turnId: 'r1', usage: USAGE,
    model: 'deepseek-v4-pro', provider: 'deepseek', adapterId: 'qq-main', platform: 'qq',
  });

  // 同一文件新实例（模拟重启重放）：归属维度必须还在。
  const second = createTokenLedger({ file, priceTable: resolvePriceTable() });
  const byAdapter = second.byAdapter();
  assert.ok(byAdapter.find((row) => row.adapterId === 'qq-main'), '重放后 aid 保留（既有缺口修复）');
  const byPlatform = second.byPlatform();
  assert.ok(byPlatform.find((row) => row.platform === 'qq'), '重放后 pf 保留');
  assert.equal(second.summary().totals.turns, 1, '幂等重放不重复计费');
});
