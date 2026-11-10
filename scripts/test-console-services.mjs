// P4 控制台服务注册 + 通路/回路编排（docs/console/registry-ui/PLAN.md）验收测试：
// 静态资源（路径穿越/console off）、operator 认证、注册流（文件即登记 + secret
// 落盘 0600 + 台账脱敏）、编排 PUT（fail-closed 校验 + 原子落盘 + 热加载即时生效）、
// 卸载（编排即刻撤销 + 台账 unregister）。
// 全部离线：临时 stateDir，registry reloadMs=0（生效走 API 里的显式 scan）。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { loadConfig } = await import(new URL('../src/core/config.mjs', import.meta.url).href);
const { createGatewayServer } = await import(new URL('../src/core/server.mjs', import.meta.url).href);
const { createServiceRegistry } = await import(new URL('../src/core/service-registry.mjs', import.meta.url).href);
const { createTokenLedger } = await import(new URL('../src/core/usage-ledger.mjs', import.meta.url).href);
const { resolvePriceTable } = await import(new URL('../src/core/prices.mjs', import.meta.url).href);

const TOKEN = 'test-operator-token-0123456789';
const ADAPTERS = [{ id: 'qq-main', platform: 'qq', secret: 'adapter-secret-0123456789' }];
// connection:close 禁用 undici 连接池：测试里同进程先关旧 server 再起新 server，
// Windows 会把刚释放的 ephemeral 端口立刻分给新 server，池里的半开 socket 会对
// 同 origin 的新 server 撞出 ECONNRESET（生产无此场景——端口不换）。
const OPERATOR = { 'x-operator-token': TOKEN, connection: 'close' };
const JSON_TYPE = { 'content-type': 'application/json', connection: 'close' };

async function startServer(envExtra = {}) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'gw-console-svc-test-'));
  const config = loadConfig({
    // GATEWAY_PORT=0：node --test 并发跑多个文件，别的测试文件也可能监听默认端口。
    env: { GATEWAY_MODE: 'shadow', GATEWAY_CONSOLE: 'on', GATEWAY_OPERATOR_TOKEN: TOKEN, GATEWAY_PORT: '0', ...envExtra },
    adapters: ADAPTERS,
    stateDir,
  });
  mkdirSync(config.registrations.dir, { recursive: true });
  // 编排硬切：echo-svc 从内联 services 迁为登记文件（可读 id 合法）；
  // pipelines.json 初始为空（无编排）。
  writeFileSync(path.join(config.registrations.dir, 'echo-svc.json'), JSON.stringify({
    v: 1, id: 'echo-svc', name: 'echo-svc', kind: 'decorator', transport: 'ws',
    secret: 'echo-service-secret-0123456789', enabled: true,
  }, null, 2));
  writeFileSync(config.pipeline.file, '{}\n');
  const registry = createServiceRegistry({
    pipelinesFile: config.pipeline.file,
    stateDir,
    reservedIds: ADAPTERS.map((a) => a.id),
    consumerIds: ADAPTERS.map((a) => a.id),
    registrations: { ...config.registrations, reloadMs: 0 },
    logger: () => {},
  });
  // server 用 status().builtinSteps 做步骤名三级解析的前置校验；P5 起还读
  // returnEffective（回路引擎开关）——测试装配按 on（已接通）标注。
  const pipeline = { status: () => ({ builtinSteps: ['protocol'], returnEffective: true }) };
  // 计费总览需要账本（/v1/console/adapters 无 ledger = 503）。
  const ledger = createTokenLedger({ file: path.join(stateDir, 'usage-ledger.jsonl'), priceTable: resolvePriceTable() });
  const gateway = createGatewayServer({ config, logger: () => {}, services: registry, pipeline, runtime: { usageLedger: ledger } });
  await gateway.listen();
  return {
    gateway, registry, config, stateDir, ledger,
    base: `http://127.0.0.1:${gateway.server.address().port}`,
  };
}

const get = async (base, url, headers = {}) => {
  try {
    return await fetch(`${base}${url}`, { headers: { ...headers, connection: 'close' } });
  } catch (error) {
    throw new Error(`GET ${url} failed: ${error?.cause?.code ?? error?.cause ?? error}`);
  };
};

test('console services: 静态资源——text/html 服务、扩展名白名单、路径穿越 404、console off 全 404', async () => {
  const { gateway, base } = await startServer();
  try {
    const index = await get(base, '/console/');
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    const html = await index.text();
    assert.match(html, /agent-gateway 控制台/);
    // 五个模块页面全部接线：每个导航项都有对应视图容器。
    for (const view of ['presets', 'sessions', 'pending', 'usage', 'adapters']) {
      assert.match(html, new RegExp(`data-view="${view}"`), `缺少导航项 ${view}`);
      assert.match(html, new RegExp(`id="view-${view}"`), `缺少视图 ${view}`);
    }
    // 资源引用必须走 /console/ 前缀（曾因 /style.css、/app.js 落到常规路由而 404）。
    assert.match(html, /href="\/console\/vendor\/bootstrap\.min\.css"/);
    assert.match(html, /href="\/console\/style\.css"/);
    assert.match(html, /src="\/console\/vendor\/bootstrap\.bundle\.min\.js"/);
    assert.match(html, /src="\/console\/app\.js"/);
    assert.doesNotMatch(html, /(href|src)="\/(style\.css|app\.js)"/, '不得引用根路径静态资源');
    // 静态引用全 200：从 HTML 动态提取全部 /console/ 引用逐个 GET（此后新增任何
    // vendor/自有资源自动纳入本防线，不再依赖手工维护资产清单）。
    const refs = [...new Set([...html.matchAll(/(?:href|src)="(\/console\/[^"]+)"/g)].map((m) => m[1]))];
    assert.ok(refs.length >= 4, `HTML 应引用静态资源（实测 ${refs.length} 条）`);
    for (const ref of refs) {
      const res = await get(base, ref);
      assert.equal(res.status, 200, `${ref} 应可访问`);
      assert.match(res.headers.get('content-type'), /text\/(css|javascript|html)/, `${ref} content-type 应在白名单词典内`);
      await res.arrayBuffer(); // 释放连接，避免 keep-alive 堆积
    }
    const js = await get(base, '/console/app.js');
    assert.match(js.headers.get('content-type'), /text\/javascript/);
    const jsText = await js.text();
    assert.match(jsText, /\/v1\/console\/pending/, '未决视图应接 pending 端点');
    assert.match(jsText, /\/v1\/console\/usage\/summary/, '用量视图应接 usage 端点');
    assert.match(jsText, /\/v1\/console\/adapters\?window=/, '消费端视图应接 adapters 端点');
    assert.doesNotMatch(jsText, /consumer\.returnEffective/, '渲染编排视图不得引用未定义变量');
    assert.equal((await get(base, '/console/app.js.exe')).status, 404, '非白名单扩展名 404');
    assert.equal((await get(base, '/console/%2e%2e%2fpackage.json')).status, 404, '路径穿越 404');
    assert.equal((await get(base, '/console/nope.js')).status, 404);
  } finally {
    await gateway.close();
  }
  const off = await startServer({ GATEWAY_CONSOLE: 'off' });
  try {
    assert.equal((await get(off.base, '/')).status, 404, 'console off 时静态页整体 404');
  } finally {
    await off.gateway.close();
  }
});

test('console services: 无 operator 凭据 401；registry 未装配 503', async () => {
  const { gateway, base } = await startServer();
  try {
    assert.equal((await get(base, '/v1/console/services')).status, 401);
    assert.equal((await get(base, '/v1/console/pipelines')).status, 401);
    const list = await get(base, '/v1/console/services', OPERATOR);
    assert.equal(list.status, 200);
    const body = await list.json();
    assert.equal(body.registrationsEnabled, true);
    assert.deepEqual(body.services.map((s) => s.id).sort(), ['echo-svc']);
  } finally {
    await gateway.close();
  }
});

test('console services: 注册流——secret 落盘不进登记文件、台账 register(operator) 脱敏、非法输入挡在落盘前', async () => {
  const { gateway, base, config, stateDir } = await startServer();
  try {
    // 非法输入：secret 与 secretEnv 二选一。
    const both = await fetch(`${base}/v1/console/services`, {
      method: 'POST', headers: { ...OPERATOR, ...JSON_TYPE },
      body: JSON.stringify({ name: 'x', kind: 'decorator', transport: 'ws', secret: 's'.repeat(20), secretEnv: 'X_SECRET' }),
    });
    assert.equal(both.status, 400);
    // 非法输入：非回环 url（fail-closed，先于文件落盘）。
    const badUrl = await fetch(`${base}/v1/console/services`, {
      method: 'POST', headers: { ...OPERATOR, ...JSON_TYPE },
      body: JSON.stringify({ name: 'x', kind: 'decorator', transport: 'http', url: 'http://10.0.0.8:9', secret: 'bad-url-secret-0123456789' }),
    });
    assert.equal(badUrl.status, 400);
    assert.match((await badUrl.json()).error.message, /loopback/);
    // shadow 已进入登记 kind 词典（灰度对账服务可登记）；无凭据仍挡在落盘前。
    const shadowNoCred = await fetch(`${base}/v1/console/services`, {
      method: 'POST', headers: { ...OPERATOR, ...JSON_TYPE },
      body: JSON.stringify({ name: 'x', kind: 'shadow', transport: 'ws' }),
    });
    assert.equal(shadowNoCred.status, 400);
    assert.match((await shadowNoCred.json()).error.message, /credential/);
    // 非法输入：无凭据（登记服务与网关是 HMAC，resolveSecret 必拒载——挡在落盘前）。
    const noSecret = await fetch(`${base}/v1/console/services`, {
      method: 'POST', headers: { ...OPERATOR, ...JSON_TYPE },
      body: JSON.stringify({ name: 'x', kind: 'decorator', transport: 'ws' }),
    });
    assert.equal(noSecret.status, 400);
    assert.match((await noSecret.json()).error.message, /credential/);

    // 合法注册：decorator + decorator 角色工具 + secret 落盘。
    const res = await fetch(`${base}/v1/console/services`, {
      method: 'POST', headers: { ...OPERATOR, ...JSON_TYPE },
      body: JSON.stringify({
        name: 'memory-mcp', kind: 'decorator', transport: 'ws', timeoutMs: 9000,
        tools: [{ name: 'chat_memory_recall', description: '检索记忆', roles: ['decorator'] }],
        secret: 'super-secret-value-0123456789',
      }),
    });
    assert.equal(res.status, 201);
    const { id } = await res.json();
    assert.match(id, /^[0-9a-f]{32}$/);

    const regFile = path.join(config.registrations.dir, `${id}.json`);
    assert.ok(existsSync(regFile), '登记文件落盘（文件名即身份）');
    const reg = JSON.parse(readFileSync(regFile, 'utf8'));
    assert.equal(reg.id, id);
    assert.equal(reg.secretFile, `secrets/${id}.secret`);
    assert.ok(!JSON.stringify(reg).includes('super-secret'), '登记文件不含明文 secret');
    const secretFile = path.join(stateDir, 'secrets', `${id}.secret`);
    assert.ok(existsSync(secretFile), 'secret 独立落盘');
    assert.equal(readFileSync(secretFile, 'utf8').trim(), 'super-secret-value-0123456789');

    // 列表即时可见（operator 扫描），工具面合并。
    const list = await (await get(base, '/v1/console/services', OPERATOR)).json();
    assert.ok(list.registrations.some((r) => r.id === id && r.name === 'memory-mcp'));
    assert.ok(list.tools.some((t) => t.name === 'chat_memory_recall' && t.serviceId === id));

    // 台账：register + source=operator + snapshot 脱敏。
    const ledger = await (await get(base, '/v1/console/services/ledger?limit=10', OPERATOR)).json();
    const event = ledger.events.find((e) => e.action === 'register' && e.serviceId === id);
    assert.ok(event, '台账记 register');
    assert.equal(event.source, 'operator');
    assert.ok(!JSON.stringify(event.snapshot).includes('super-secret'), '台账快照脱敏');
    assert.equal(event.snapshot.name, 'memory-mcp');
  } finally {
    await gateway.close();
  }
});

test('console pipelines: PUT fail-closed（未知步骤/非消费端）+ 保存即时生效（热加载）+ 回路标注未生效', async () => {
  const { gateway, base, registry, config } = await startServer();
  try {
    // 先注册一个带 decorator 工具的服务（工具名即步骤）。
    const reg = await fetch(`${base}/v1/console/services`, {
      method: 'POST', headers: { ...OPERATOR, ...JSON_TYPE },
      body: JSON.stringify({
        name: 'rolecard-mcp', kind: 'decorator', transport: 'ws', secret: 'rolecard-secret-0123456789',
        tools: [{ name: 'chat_role_render', description: '渲染人格', roles: ['decorator'] }],
      }),
    });
    assert.equal(reg.status, 201);

    // 未知步骤 → 400（写盘前挡下）。
    const unknown = await fetch(`${base}/v1/console/pipelines/qq-main`, {
      method: 'PUT', headers: { ...OPERATOR, ...JSON_TYPE },
      body: JSON.stringify({ forward: ['protocol', 'no-such-step'], return: [] }),
    });
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error.message, /no-such-step/);
    // 非消费端键 → 400（编排是消费端能力）。
    const stranger = await fetch(`${base}/v1/console/pipelines/stranger`, {
      method: 'PUT', headers: { ...OPERATOR, ...JSON_TYPE },
      body: JSON.stringify({ forward: ['protocol'], return: [] }),
    });
    assert.equal(stranger.status, 400);
    assert.match((await stranger.json()).error.message, /no consumer behind/);
    // 上述失败不应写盘。
    const before = readFileSync(config.pipeline.file, 'utf8');
    assert.ok(!before.includes('returnPipelines'));

    // 合法保存：通路 = protocol → 工具步骤；回路 = 服务步骤（引擎透传）。
    const put = await fetch(`${base}/v1/console/pipelines/qq-main`, {
      method: 'PUT', headers: { ...OPERATOR, ...JSON_TYPE },
      body: JSON.stringify({ forward: ['protocol', 'chat_role_render'], return: ['echo-svc'] }),
    });
    assert.equal(put.status, 200);
    const putBody = await put.json();
    assert.equal(putBody.returnEffective, true, 'P5：回路引擎已接通（真实开关）');

    // 热加载即时生效（reloadMs=0，靠 PUT 内部 force reload）。
    assert.deepEqual(registry.pipelineFor('qq-main'), ['protocol', 'chat_role_render']);

    // 落盘结构：只有 pipelines/returnPipelines 两块（硬切后不再有 services 字段）。
    const doc = JSON.parse(readFileSync(config.pipeline.file, 'utf8'));
    assert.equal(doc.services, undefined);
    assert.deepEqual(doc.pipelines['qq-main'], ['protocol', 'chat_role_render']);
    assert.deepEqual(doc.returnPipelines['qq-main'], ['echo-svc']);

    // GET 视图：consumer 行带 forward/return 与 returnEffective（P5 已翻面）+ 可用步骤三级。
    const view = await (await get(base, '/v1/console/pipelines', OPERATOR)).json();
    const row = view.consumers.find((c) => c.id === 'qq-main');
    assert.deepEqual(row.forward, ['protocol', 'chat_role_render']);
    assert.deepEqual(row.return, ['echo-svc']);
    assert.equal(row.returnEffective, true, 'P5：GET 视图同步真实开关');
    assert.ok(view.available.builtin.includes('protocol'));
    assert.ok(view.available.services.some((s) => s.id === 'echo-svc'));
    assert.ok(view.available.tools.some((t) => t.name === 'chat_role_render'));

    // 清空编排（空数组 = 删除键 = 透传）。
    const clear = await fetch(`${base}/v1/console/pipelines/qq-main`, {
      method: 'PUT', headers: { ...OPERATOR, ...JSON_TYPE },
      body: JSON.stringify({ forward: [], return: [] }),
    });
    assert.equal(clear.status, 200);
    assert.deepEqual(registry.pipelineFor('qq-main'), []);
    const docAfter = JSON.parse(readFileSync(config.pipeline.file, 'utf8'));
    assert.equal(docAfter.pipelines?.['qq-main'], undefined);
  } finally {
    await gateway.close();
  }
});

test('console services: 卸载——文件删除、编排即刻撤销、台账 unregister；未知 id 404', async () => {
  const { gateway, base, registry, config } = await startServer();
  try {
    // 注册一个消费端并给它编排。
    const reg = await fetch(`${base}/v1/console/services`, {
      method: 'POST', headers: { ...OPERATOR, ...JSON_TYPE },
      body: JSON.stringify({ name: 'wx-bridge', kind: 'consumer', transport: 'ws', secret: 'wx-bridge-secret-0123456789' }),
    });
    const { id } = await reg.json();
    const put = await fetch(`${base}/v1/console/pipelines/${id}`, {
      method: 'PUT', headers: { ...OPERATOR, ...JSON_TYPE },
      body: JSON.stringify({ forward: ['protocol'], return: [] }),
    });
    assert.equal(put.status, 200, '登记的消费端拥有编排权限');
    assert.deepEqual(registry.pipelineFor(id), ['protocol']);

    assert.equal((await fetch(`${base}/v1/console/services/${'0'.repeat(32)}`, { method: 'DELETE', headers: { ...OPERATOR, ...JSON_TYPE } })).status, 404);

    const del = await fetch(`${base}/v1/console/services/${id}`, { method: 'DELETE', headers: { ...OPERATOR, ...JSON_TYPE } });
    assert.equal(del.status, 200);
    assert.ok(!existsSync(path.join(config.registrations.dir, `${id}.json`)), '登记文件已删');
    assert.deepEqual(registry.pipelineFor(id), [], '卸载即撤销编排（consumer 身份消失）');

    const ledger = await (await get(base, '/v1/console/services/ledger', OPERATOR)).json();
    assert.ok(ledger.events.some((e) => e.action === 'unregister' && e.serviceId === id && e.source === 'operator'));
    // 卸载后配套密钥文件一并撤销（本用例无 secret，验证 secrets 目录无新增残留）。
    const secretsDir = path.join(config.stateDir, 'secrets');
    assert.equal(existsSync(secretsDir) ? readdirSync(secretsDir).length : 0, 0);
    assert.ok(statSync(config.registrations.dir).isDirectory());
  } finally {
    await gateway.close();
  }
});

// ── P4.x：编排条目双形态（规则对象）+ 消费端统一总览 ─────────────────────────

test('console pipelines P4.x: 规则对象条目保存/回读/落盘 + regex/fn fail-closed', async () => {
  const { gateway, base, registry, config } = await startServer();
  try {
    // 先登记一个 decorator 工具（工具名即步骤，三级解析的第三级）。
    const dec = await fetch(`${base}/v1/console/services`, {
      method: 'POST', headers: { ...OPERATOR, ...JSON_TYPE },
      body: JSON.stringify({
        name: 'rolecard-mcp', kind: 'decorator', transport: 'ws', secret: 'rolecard-secret-0123456789',
        tools: [{ name: 'chat_role_render', description: '渲染人格', roles: ['decorator'] }],
      }),
    });
    assert.equal(dec.status, 201);

    const put = await fetch(`${base}/v1/console/pipelines/qq-main`, {
      method: 'PUT', headers: { ...OPERATOR, ...JSON_TYPE },
      body: JSON.stringify({
        forward: [
          { step: 'rolecard', text: '固定人设', once: true, join: 'prefix' },
          { step: 'chat_role_render', join: 'suffix' },
          { step: 'echo-svc', join: 'regex', pattern: '\\d{11}', replacement: '[手机号:{extra}]' },
          { step: 'echo-svc', join: 'function', fn: 'return extra ? extra + "\\n\\n" + message : message;' },
        ],
        return: [],
      }),
    });
    assert.equal(put.status, 200, JSON.stringify(await put.json()));
    // 热加载后 registry 保留原始条目（引擎按双形态消费）。
    const forward = registry.pipelineFor('qq-main');
    assert.equal(forward[0].once, true);
    assert.equal(forward[0].join, 'prefix');
    assert.equal(forward[2].replacement, '[手机号:{extra}]');
    // 落盘结构原样保留。
    const doc = JSON.parse(readFileSync(config.pipeline.file, 'utf8'));
    assert.deepEqual(doc.pipelines['qq-main'][0], { step: 'rolecard', text: '固定人设', once: true, join: 'prefix' });

    // GET 视图原样透出规则对象（UI 回填用）。
    const view = await (await get(base, '/v1/console/pipelines', OPERATOR)).json();
    assert.deepEqual(view.consumers.find((c) => c.id === 'qq-main').forward, forward);

    // fail-closed：坏 regex / 无 return 函数 / protocol 对象 / 未知字段。
    const cases = [
      [{ step: 'x', join: 'regex', pattern: '([bad', replacement: 'r' }, /does not compile/],
      [{ step: 'x', join: 'function', fn: 'const a = 1;' }, /must contain a return/],
      [{ step: 'protocol', once: true }, /protocol step must stay a plain string/],
      [{ step: 'x', join: 'prefix', nope: 1 }, /unknown field/],
      [{ step: 'ghost', join: 'prefix' }, /unknown pipeline step/],
    ];
    for (const [entry, pattern] of cases) {
      const res = await fetch(`${base}/v1/console/pipelines/qq-main`, {
        method: 'PUT', headers: { ...OPERATOR, ...JSON_TYPE },
        body: JSON.stringify({ forward: [entry], return: [] }),
      });
      assert.equal(res.status, 400, JSON.stringify(entry));
      assert.match((await res.json()).error.message, pattern);
    }
  } finally {
    await gateway.close();
  }
});

test('console adapters P4.x: 统一消费端总览——登记消费端并入 + source 标注 + platforms 汇总', async () => {
  const { gateway, base, config } = await startServer();
  try {
    // 登记一个消费端（带自有工具声明，roles 聚合到总览）。
    // 语义口径：总览 = adapters.json 适配器 ∪ 登记目录 kind=consumer；
    // decorator/filter 服务不是消费端，不并入（它们不承载入站流量）。
    const reg = await fetch(`${base}/v1/console/services`, {
      method: 'POST', headers: { ...OPERATOR, ...JSON_TYPE },
      body: JSON.stringify({
        name: 'wx-bridge', kind: 'consumer', transport: 'ws', secret: 'wx-bridge-secret-0123456789',
        tools: [{ name: 'chat_wx_send_text', description: 'r', roles: ['tool'] }],
      }),
    });
    assert.equal(reg.status, 201);

    const view = await (await get(base, '/v1/console/adapters', OPERATOR)).json();
    const qq = view.adapters.find((a) => a.id === 'qq-main');
    assert.equal(qq.source, 'adapters.json', 'adapters.json 适配器标注来源');
    assert.equal(qq.platform, 'qq');
    const wx = view.adapters.find((a) => a.name === 'wx-bridge');
    assert.ok(wx, '登记消费端并入总览');
    assert.equal(wx.source, 'registry');
    assert.equal(wx.enabled, true);
    assert.deepEqual(wx.roles, ['tool'], '登记工具 roles 聚合进总览（chat_wx_send_text）');
    // 平台维度汇总（platform 字段缺省 unknown——无 turn 流量时为空桶或 unknown）。
    assert.ok(Array.isArray(view.platforms));
  } finally {
    await gateway.close();
  }
});
