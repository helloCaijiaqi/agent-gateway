// 编排配置硬切迁移专项：旧 services.json / 旧 env 的 fail-closed 行为、
// pipelines.json 缺失语义、控制台写路径不再补 services 字段。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/core/config.mjs';
import { createServiceRegistry } from '../src/core/service-registry.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-pl-mig-'));
}

const REG = (dir) => ({ dir: path.join(dir, 'services'), ledgerFile: path.join(dir, 'ledger.jsonl'), reloadMs: 0 });

function makeRegistry(file, overrides = {}) {
  const dir = path.dirname(file);
  return createServiceRegistry({
    pipelinesFile: file,
    stateDir: overrides.stateDir ?? dir,
    reservedIds: overrides.reservedIds ?? [],
    consumerIds: overrides.consumerIds ?? [],
    registrations: overrides.registrations ?? REG(dir),
    logger: () => {},
  });
}

test('config: pipelines.json 是默认编排文件；GATEWAY_PIPELINES_FILE 可改路径', () => {
  const dir = tmpDir();
  const config = loadConfig({ env: { GATEWAY_PORT: '0' }, stateDir: dir, adapters: [] });
  assert.ok(config.pipeline.file.endsWith('pipelines.json'), `默认编排文件应为 pipelines.json，实际 ${config.pipeline.file}`);
  const custom = loadConfig({
    env: { GATEWAY_PORT: '0', GATEWAY_PIPELINES_FILE: path.join(dir, 'custom.json') },
    stateDir: dir, adapters: [],
  });
  assert.equal(custom.pipeline.file, path.join(dir, 'custom.json'));
});

test('config: GATEWAY_SERVICES_FILE 设置即报错，且文案给出迁移三步', () => {
  const dir = tmpDir();
  assert.throws(
    () => loadConfig({ env: { GATEWAY_PORT: '0', GATEWAY_SERVICES_FILE: path.join(dir, 'services.json') }, stateDir: dir, adapters: [] }),
    (error) => /GATEWAY_SERVICES_FILE is retired/.test(error.message)
      && /registration dir/.test(error.message)
      && /delete the old services\.json/.test(error.message),
  );
});

test('pipelines.json 缺失 = 无编排，透传不报错（可之后再补文件热加载）', () => {
  const dir = tmpDir();
  const registry = makeRegistry(path.join(dir, 'pipelines.json'), { consumerIds: ['qq-main'] });
  assert.deepEqual(registry.pipelineFor('qq-main'), []);
  assert.deepEqual(registry.pipelineForReturn('qq-main'), []);
  assert.equal(registry.pipelineKeys().length, 0);

  // 事后补文件 + 热加载 = 编排生效（运维「先启动后补配置」的路径）。
  fs.writeFileSync(path.join(dir, 'pipelines.json'), JSON.stringify({ pipelines: { 'qq-main': ['dec'] } }));
  assert.equal(registry.reloadPipelines(), true);
  assert.deepEqual(registry.pipelineFor('qq-main'), ['dec']);
});

test('pipelines.json 残留 services 键：启动、热加载、写路径三处 fail-closed', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'pipelines.json');
  const legacy = { services: [], pipelines: { 'qq-main': ['dec'] } };
  fs.writeFileSync(file, JSON.stringify(legacy));

  const migration = (error) => /contains a "services" key/.test(error.message)
    && /registration dir/.test(error.message)
    && /delete the old services\.json/.test(error.message);
  assert.throws(() => makeRegistry(file), migration, '启动装载必须拒载');

  // 热加载同样拒绝（force 热加载读取旧文件会抛迁移错误，不会静默吞掉）：
  const dir2 = tmpDir();
  const file3 = path.join(dir2, 'pipelines.json');
  fs.writeFileSync(file3, JSON.stringify({ pipelines: {} }));
  const registry3 = makeRegistry(file3);
  fs.writeFileSync(file3, JSON.stringify(legacy));
  assert.throws(() => registry3.reloadPipelines({ force: true }), migration);

  // 写路径兜底：doc 里残留 services 键时不落盘（先建空编排的 registry，再注入残留）。
  const dir3 = tmpDir();
  const file4 = path.join(dir3, 'pipelines.json');
  fs.writeFileSync(file4, JSON.stringify({ pipelines: {} }));
  const registry4 = makeRegistry(file4, { consumerIds: ['qq-main'] });
  fs.writeFileSync(file4, JSON.stringify(legacy));
  assert.throws(() => registry4.updateConsumerPipeline('qq-main', ['dec'], null), /still contains a "services" key/);
});

test('updateConsumerPipeline：只写 pipelines/returnPipelines 两块，不补 services 字段', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'pipelines.json');
  const registry = makeRegistry(file, { consumerIds: ['qq-main'] });
  registry.updateConsumerPipeline('qq-main', ['dec'], ['echo']);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.services, undefined, '硬切后文件里不应再有 services 键');
  assert.deepEqual(doc.pipelines['qq-main'], ['dec']);
  assert.deepEqual(doc.returnPipelines['qq-main'], ['echo']);

  // 文件不存在时直接保存：底稿是空对象（旧实现会补 "services": []）。
  const dir2 = tmpDir();
  const file2 = path.join(dir2, 'pipelines.json');
  const registry2 = makeRegistry(file2, { consumerIds: ['qq-main'] });
  registry2.updateConsumerPipeline('qq-main', ['dec'], null);
  const doc2 = JSON.parse(fs.readFileSync(file2, 'utf8'));
  assert.equal(doc2.services, undefined);
  assert.deepEqual(doc2.pipelines['qq-main'], ['dec']);
});
