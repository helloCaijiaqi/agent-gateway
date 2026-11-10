// 分层边界检查（P5 verify）。
//
// 这些断言不测行为，只测「依赖方向有没有被腐蚀」。它们失败时的含义是：
// 某个本该中立的一层开始认识具体平台/服务，之后每加一个适配器都要改它。
//
// 规则：
//   1. `src/core/` 只 import `node:*`、`zod`、`ws`（连接协议一律走库，2026-11-06
//      决定）与同目录模块——不碰上层（turn 编排、executor、上下文组装）；
//   2. `src/core/` 源码不出现具体适配器名（qq-bridge / wx-adapter）与上游服务名
//      （memory-mcp / rolecard-mcp）。`qq`/`wx` 作为**线缆契约取值**是允许的
//      （platform 字段必须能表达），禁止的是「core 知道谁实现了它」；
//   3. `src/context/` 不得反向 import runtime / executors；
//   4. `src/runtime/` 不得 import executors（executor 由组合根注入）；
//   5. 装配只发生在 `src/main.mjs`（组合根）。
//
// executors 之间互不 import 已由 `test-executor-contract.mjs` 的静态合规检查覆盖。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function listModules(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listModules(full));
    else if (entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const rel = (file) => path.relative(SRC, file).replace(/\\/g, '/');

function importsOf(source) {
  return [...source.matchAll(/(?:^|\n)\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/g)]
    .map((match) => match[1]);
}

test('layering: core 只依赖 node 内置 / zod / 同目录模块', () => {
  const violations = [];
  for (const file of listModules(path.join(SRC, 'core'))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const specifier of importsOf(source)) {
      const allowed = specifier.startsWith('node:')
        || specifier === 'zod'
        || specifier === 'ws'
        || specifier.startsWith('./')
        // V2 P2：service-registry 的 HTTP 备用通道走 shared/http-client（总纲
        // 「协议一律走库」）；shared 是中立工具层，不 import core，方向不腐蚀。
        || specifier.startsWith('../shared/');
      if (!allowed) violations.push(`${rel(file)}: import "${specifier}"`);
    }
  }
  assert.deepEqual(violations, []);
});

test('layering: core 源码不出现具体适配器与上游服务名', () => {
  const banned = [
    { pattern: /\bqq-bridge\b/, why: '具体适配器名' },
    { pattern: /\bwx-adapter\b/, why: '具体适配器名' },
    { pattern: /\bmemory-mcp\b/, why: '上游服务名' },
    { pattern: /\brolecard-mcp\b/, why: '上游服务名' },
    { pattern: /\b(?:executors|context|runtime)\//, why: '上层模块路径' },
  ];
  const violations = [];
  for (const file of listModules(path.join(SRC, 'core'))) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const { pattern, why } of banned) {
        if (pattern.test(line)) violations.push(`${rel(file)}:${index + 1} ${why}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(violations, []);
});

test('layering: 旧 context 层已随 P3 转正删除（目录不得复活）', () => {
  // P3 起拼装只有管线一条路：src/context/（旧 assembler + sections）物理删除，
  // 这里钉住「不得回来」——有人重新放回 context 目录直接报错。
  assert.equal(fs.existsSync(path.join(SRC, 'context')), false, 'src/context/ must stay deleted (P3 cutover)');
});

test('layering: runtime 不直接 import executors（由组合根注入）', () => {
  const violations = [];
  for (const file of listModules(path.join(SRC, 'runtime'))) {
    for (const specifier of importsOf(fs.readFileSync(file, 'utf8'))) {
      if (/^\.\.\/executors\//.test(specifier)) {
        violations.push(`${rel(file)}: import "${specifier}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('layering: 装配只发生在 src/main.mjs', () => {
  assert.ok(fs.existsSync(path.join(SRC, 'main.mjs')), '组合根 src/main.mjs 必须存在');
  const offenders = [];
  for (const file of listModules(SRC)) {
    const name = rel(file);
    if (name === 'main.mjs') continue;
    // executors/context 内部互相引用属于层内关系，不算装配。
    if (name.startsWith('executors/') || name.startsWith('context/')) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (/from\s*['"]\.\.?\/(?:executors|context)\//.test(source)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});
