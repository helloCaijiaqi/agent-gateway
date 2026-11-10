// 执行层契约测试：registry 的路由/失败语义 + executor 模块的静态合规检查。
//
// 静态检查保证分层规则不被腐蚀：executors/ 下的任何模块只允许 import
// executor-interface、node 内置模块与 src/shared/（连接协议共有工具库，
// 2026-11-06 决定「所有出站请求一律走共享传输库」）——一旦有人从 executor 里
// import core 或另一个 executor，这条测试在 CI 直接失败，而不是等运行期出现
// 隐性耦合。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const { ExecutorError, createExecutorRegistry, registerExecutor } = await import(new URL('../src/executors/executor-interface.mjs', import.meta.url).href);

const EXECUTORS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'executors');

function memoryExecutorStub(overrides = {}) {
  return registerExecutor({
    name: 'memory',
    actions: ['memory_recall', 'memory_append'],
    call: async ({ action, ctx }) => ({ ok: true, action, sessionKey: ctx.sessionKey, ...overrides }),
  });
}

const baseCtx = { sessionKey: 'qq:group:123456', turnId: 'turn_1', turnToken: 'tok' };

// ---------------------------------------------------------------- registry

test('registry: 注册、按 action 路由、重复注册拒绝', async () => {
  const registry = createExecutorRegistry();
  registry.add(memoryExecutorStub());

  assert.equal(registry.supports('memory_recall'), true);
  assert.equal(registry.supports('memory_forget'), false);
  assert.equal(registry.ownerOf('memory_append'), 'memory');

  const result = await registry.call('memory_recall', baseCtx);
  assert.equal(result.ok, true);
  assert.equal(result.sessionKey, 'qq:group:123456');

  // 同名重复注册。
  assert.throws(() => registry.add(memoryExecutorStub()), (error) => error.code === 'E_INTERNAL');
  // 两个 executor 声明同一 action。
  const other = registerExecutor({
    name: 'memory-clone',
    actions: ['memory_recall'],
    call: async () => ({ ok: true }),
  });
  assert.throws(() => registry.add(other), /already owned/);
});

test('registry: ctx 缺失 fail-closed，未知动作 E_UNSUPPORTED，executor 异常降级不外抛', async () => {
  const registry = createExecutorRegistry();
  registry.add(memoryExecutorStub());

  // ctx 缺字段：这是 runtime 的错误，必须抛。
  for (const field of ['sessionKey', 'turnId', 'turnToken']) {
    const broken = { ...baseCtx, [field]: undefined };
    await assert.rejects(() => registry.call('memory_recall', broken), (error) => error.code === 'E_INTERNAL');
  }

  // 未注册的动作。
  await assert.rejects(() => registry.call('memory_forget', baseCtx), (error) => error.code === 'E_UNSUPPORTED');

  // executor 抛异常 → 结构化降级结果，而不是异常穿透。
  const bomb = createExecutorRegistry();
  bomb.add(registerExecutor({
    name: 'bomb',
    actions: ['boom'],
    call: async () => { throw new Error('service down'); },
  }));
  const result = await bomb.call('boom', baseCtx);
  assert.equal(result.ok, false);
  assert.equal(result.degraded, true);
  assert.equal(result.code, 'E_INTERNAL');
  assert.match(result.message, /service down/);

  // executor 返回非结果对象 → 同样降级。
  const liar = createExecutorRegistry();
  liar.add(registerExecutor({
    name: 'liar',
    actions: ['lie'],
    call: async () => 'i am fine',
  }));
  const bad = await liar.call('lie', baseCtx);
  assert.equal(bad.ok, false);
  assert.equal(bad.degraded, true);
});

test('registerExecutor: 形参校验', () => {
  assert.throws(() => registerExecutor({ name: 'Memory', actions: ['a'], call: async () => ({}) }), /name/);
  assert.throws(() => registerExecutor({ name: 'ok', actions: [], call: async () => ({}) }), /actions/);
  assert.throws(() => registerExecutor({ name: 'ok', actions: ['a', 'a'], call: async () => ({}) }), /duplicate/);
  assert.throws(() => registerExecutor({ name: 'ok', actions: ['a'], call: 'nope' }), /call/);
});

// ------------------------------------------------------- static conformance

/** 递归收集 executors/ 下全部 .mjs（adapter-tools 目录化后顶层扫描会漏掉子树）。 */
function listExecutorFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(full);
    }
  };
  walk(root);
  return out.filter((file) => path.resolve(file) !== path.join(root, 'executor-interface.mjs'));
}

test('conformance: executors/ 分层规则（interface+node:、子树封闭、common 禁平台字样）', () => {
  const violations = [];
  for (const file of listExecutorFiles(EXECUTORS_DIR)) {
    const rel = path.relative(EXECUTORS_DIR, file).replace(/\\/g, '/');
    const source = fs.readFileSync(file, 'utf8');
    const inAdapterTools = rel.startsWith('adapter-tools/');
    const inCommon = rel.startsWith('adapter-tools/common/');
    for (const match of source.matchAll(/(?:^|\n)\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) continue;
      if (specifier.endsWith('executor-interface.mjs')) continue;
      if (specifier.startsWith('.')) {
        const resolved = path.relative(EXECUTORS_DIR, path.resolve(path.dirname(file), specifier)).replace(/\\/g, '/');
        // 相对引用不允许逃出 executors/，唯一例外是 ../shared/（协议共有工具库）。
        if (resolved.startsWith('..') && !resolved.startsWith('../shared/')) {
          violations.push(`${rel}: import "${specifier}" escapes executors/`);
          continue;
        }
        // adapter-tools 子树封闭：内部模块互引可以，但不许反向依赖子树之外的
        // executor（../shared/ 协议库是唯一例外）。
        if (inAdapterTools && !resolved.startsWith('adapter-tools/') && !resolved.startsWith('../shared/')) {
          violations.push(`${rel}: import "${specifier}" escapes adapter-tools/`);
          continue;
        }
        // 平台目录互不引用：qq 与 wx 的能力模块不允许互相 import（防串线暗道）。
        if (rel.startsWith('adapter-tools/qq/') && resolved.startsWith('adapter-tools/wx/')) {
          violations.push(`${rel}: import "${specifier}" crosses into wx/`);
        }
        if (rel.startsWith('adapter-tools/wx/') && resolved.startsWith('adapter-tools/qq/')) {
          violations.push(`${rel}: import "${specifier}" crosses into qq/`);
        }
        continue;
      }
      // 裸包名一律禁止：executors 只依赖 interface 与 node 内置。
      violations.push(`${rel}: import "${specifier}"`);
    }
    // 决策 12 的评审硬标准落成静态检查：common/ 装配机器不出现任何平台业务字样。
    if (inCommon && /\bqq\b|\bwx\b/i.test(source)) {
      violations.push(`${rel}: common/ must not contain platform-specific words (qq/wx)`);
    }
  }
  assert.deepEqual(violations, []);
});
