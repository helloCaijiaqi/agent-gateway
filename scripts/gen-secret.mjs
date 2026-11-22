#!/usr/bin/env node
/**
 * gen-secret：一条命令完成「生成密钥 → 写入 state/gateway/<id>.secret → 打印两侧配置片段」。
 *
 * 用法：
 *   npm run secrets:gen -- --id qq-main                 # 适配器密钥（默认 kind=adapter）
 *   npm run secrets:gen -- --kind wx --id wx-main       # 微信适配器（默认 enabled:false 灰度）
 *   npm run secrets:gen -- --kind mcp-bus               # mcp-bus 共享 token
 *
 * 参数：
 *   --id <id>          密钥标识（默认 qq-main；mcp-bus kind 默认 mcp-bus），也决定文件名 <id>.secret
 *   --platform <p>     适配器平台（默认 qq；wx kind 缺省 wx）
 *   --kind <k>         adapter | wx | mcp-bus（默认 adapter）
 *   --out <dir>        输出目录（默认 <pkg>/state/gateway）
 *   --force            覆盖已存在的密钥文件（轮换语义：另一侧要同步换，否则 401）
 *   --gateway-url <u>  交接文件里的网关基址（默认 http://<GATEWAY_HOST|127.0.0.1>:<GATEWAY_PORT|7190>）
 *   --inline-secret    交接文件内联明文密钥（跨机复制用；默认写 secretFile 引用）
 *   --json             机器可读输出（未来 UI 直接解析）
 *
 * 刻意不做的：不自动改 services/<id>.json 登记（避免脚本与 UI/手工编辑打架）；
 * 不做轮换编排（未来 UI 的职责）；不改目标仓库的任何文件——交接文件只写在
 * state/gateway/handoff/，复制由使用者完成。
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const { generateSecret, writeSecretFile, buildConfigSnippets } = await import(
  new URL('../src/core/secrets.mjs', import.meta.url).href
);
const {
  buildHandoffDocument, resolveGatewayBaseUrl, writeHandoff,
} = await import(new URL('../src/core/gateway-json.mjs', import.meta.url).href);


const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KINDS = ['adapter', 'wx', 'mcp-bus'];

function usage() {
  return [
    '用法: npm run secrets:gen -- [--id <id>] [--kind adapter|wx|mcp-bus] [--platform <p>] [--out <dir>] [--force] [--gateway-url <u>] [--inline-secret] [--json]',
    '',
    '  --id <id>         密钥标识与文件名（默认 qq-main；mcp-bus 默认 mcp-bus）',
    '  --kind <k>        adapter（默认）| wx（额外 enabled:false 提示）| mcp-bus（共享 token）',
    '  --platform <p>    适配器平台（默认 qq；wx kind 缺省 wx）',
    '  --out <dir>       输出目录（默认 agent-gateway/state/gateway）',
    '  --force           覆盖已存在的密钥文件（交接文件也一并重写）',
    '  --gateway-url <u> 交接文件里的网关基址（默认取 GATEWAY_HOST/GATEWAY_PORT，否则 127.0.0.1:7190）',
    '  --inline-secret   交接文件内联明文密钥（跨机复制用；默认写 secretFile 引用）',
    '  --json            机器可读 JSON 输出',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === 'force' || key === 'json' || key === 'help' || key === 'inline-secret') {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    args[key] = value;
    i += 1;
  }
  return args;
}

function fail(message) {
  console.error(`gen-secret: ${message}`);
  console.error(usage());
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}

const kind = args.kind ?? 'adapter';
if (!KINDS.includes(kind)) fail(`unknown kind "${kind}" (allowed: ${KINDS.join(', ')})`);
// 消费端 id 强制 hash 形态（svc-<12hex>）：id 只标识服务实例，与平台解耦——
// 同平台多账号 = 多次运行本脚本各得一个新 hash id + 各自登记文件。
const id = args.id ?? (kind === 'mcp-bus' ? 'mcp-bus' : `svc-${randomBytes(6).toString('hex')}`);
const platform = args.platform ?? (kind === 'wx' ? 'wx' : 'qq');
const outDir = args.out ?? path.join(PACKAGE_ROOT, 'state', 'gateway');

let result = null;
try {
  const secret = generateSecret();
  const file = writeSecretFile({ dir: outDir, id, secret, force: args.force === true });
  const snippets = buildConfigSnippets({ kind, id, platform, secret });
  // 适配器：顺带产出可复制的交接文件（state/gateway/handoff/<id>.gateway.json）。
  // mcp-bus 不是「连网关的派生进程」，没有交接文件。
  let handoff = null;
  if (kind !== 'mcp-bus') {
    const doc = buildHandoffDocument({
      kind: 'adapter',
      id,
      url: args['gateway-url'] ?? resolveGatewayBaseUrl({
        host: process.env.GATEWAY_HOST,
        port: process.env.GATEWAY_PORT,
      }),
      transport: 'auto',
      ...(args['inline-secret'] === true ? { secret } : { secretFile: file.filePath }),
    });
    const written = writeHandoff({ stateDir: outDir, doc, force: args.force === true });
    handoff = {
      file: written.filePath,
      auth: args['inline-secret'] === true ? 'inline' : 'secretFile',
      written: written.written,
      sha256: written.sha256,
    };
  }
  result = {
    ok: true,
    kind,
    id,
    platform,
    file: file.filePath,
    sha256: file.sha256,
    overwritten: file.overwritten,
    secret,
    handoff,
    snippets,
    notes: [
      file.overwritten
        ? '已覆盖旧密钥（--force）：务必同步更新另一侧，否则签名校验全部 401。'
        : '重复执行会被拒绝；轮换需 --force 并同步另一侧。',
      ...(snippets.notes ?? []),
    ],
  };
} catch (error) {
  const message = String(error?.message ?? error);
  if (args.json === true) {
    console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  } else {
    fail(message);
  }
  process.exit(1);
}

if (args.json === true) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

// ── 人类可读输出 ──────────────────────────────────────────────────────────
console.log(`密钥已写入: ${result.file}`);
console.log(`文件指纹:   sha256:${result.sha256}…（前 8 位，肉眼核对两侧一致用）`);
console.log('');
console.log(`1) 消费端登记条目（写入 state/gateway/services/<id>.json，热加载生效）:`);
if (result.snippets.consumerEntry) {
  console.log(JSON.stringify(result.snippets.consumerEntry, null, 2));
} else {
  console.log('   （mcp-bus 不是消费端，无登记条目）');
}
console.log('');
console.log('2) 交接文件（gateway.json）:');
if (result.handoff) {
  console.log(`   ${result.handoff.file}`);
  console.log(`   认证形态: ${result.handoff.auth}`
    + (result.handoff.auth === 'inline'
      ? '（明文，跨机复制用；目标仓 .gitignore 已忽略 gateway.json）'
      : '（指向网关侧密钥文件，明文不出网关）'));
  console.log(`   指纹: sha256:${result.handoff.sha256}…（复制后可用 npm run handoff 校验）`);
  console.log('   复制到目标仓库根目录并保持文件名 gateway.json，然后重启目标进程。');
} else {
  for (const note of result.snippets.mcpToken ? [result.snippets.mcpToken.note] : []) {
    console.log(`   ${note}`);
  }
  console.log(`   npm run env:init   # 确保 state/gateway/mcp-bus.secret 存在（文件单源，密钥值一致时无需重跑）`);
}
console.log('');
console.log('注意:');
for (const note of result.notes) {
  console.log(`- ${note}`);
}
