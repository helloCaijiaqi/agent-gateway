// metrics：标签基数与标签值长度必须有上限（标签可能来自请求路径/工具名等外部输入）。
import test from 'node:test';
import assert from 'node:assert/strict';

const { createMetrics } = await import(
  new URL('../src/core/metrics.mjs', import.meta.url).href
);

test('metrics: 新增序列超过上限后折叠为 overflow（防止标签基数打爆内存）', () => {
  const metrics = createMetrics();
  for (let i = 0; i < 2600; i += 1) {
    metrics.observe('gateway_request_ms', i, { route: `/v1/x/${i}`, method: 'GET' });
  }
  const { timings } = metrics.snapshot();
  const keys = Object.keys(timings);
  assert.ok(keys.length <= 2001, `序列数应被上限压住，实际 ${keys.length}`);
  assert.ok(keys.some((key) => key.includes('overflow=1')), '超出部分应折叠进 overflow 序列');
  const total = Object.values(timings).reduce((sum, item) => sum + item.count, 0);
  assert.equal(total, 2600, '折叠不能丢样本（计数仍要守恒）');
});

test('metrics: 已存在的序列不受上限影响，计数继续精确累加', () => {
  const metrics = createMetrics();
  // 留出余量：上限是「新序列不得让总量超 2000」，不是「超过后全部折叠」。
  for (let i = 0; i < 1990; i += 1) metrics.inc('noise', { id: String(i) });
  metrics.inc('hits', { route: '/v1/inbound' });
  metrics.inc('hits', { route: '/v1/inbound' });
  const { counters } = metrics.snapshot();
  assert.equal(counters['hits{route=/v1/inbound}'], 2, '上限只拦新序列，不改变已有序列的精确性');
});

test('metrics: 标签值截断到 120 字符（超长 URL 不复制原文）', () => {
  const metrics = createMetrics();
  const long = `/v1/turns/${'a'.repeat(500)}`;
  metrics.inc('hits', { route: long });
  const keys = Object.keys(metrics.snapshot().counters);
  assert.equal(keys.length, 1);
  const [key] = keys;
  const value = key.slice(key.indexOf('route=') + 'route='.length, key.length - 1);
  assert.equal(value.length, 120);
});
