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
 *   --json             机器可读输出（未来 UI 直接解析）
 *
 * 刻意不做的：不自动改 adapters.json（避免脚本与 UI/手工编辑打架）；
 * 不做轮换编排（未来 UI 的职责）；不碰桥接 config.json。
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const { generateSecret, writeSecretFile, buildConfigSnippets } = await import(
  new URL('../src/core/secrets.mjs', import.meta.url).href
);
const { DELIVERABLE_ACTIONS } = await import(new URL('../src/core/config.mjs', import.meta.url).href);

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KINDS = ['adapter', 'wx', 'mcp-bus'];

function usage() {
  return [
    '用法: npm run secrets:gen -- [--id <id>] [--kind adapter|wx|mcp-bus] [--platform <p>] [--out <dir>] [--force] [--json]',
    '',
    '  --id <id>       密钥标识与文件名（默认 qq-main；mcp-bus 默认 mcp-bus）',
    '  --kind <k>      adapter（默认）| wx（额外 enabled:false 提示）| mcp-bus（共享 token）',
    '  --platform <p>  适配器平台（默认 qq；wx kind 缺省 wx）',
    '  --out <dir>     输出目录（默认 agent-gateway/state/gateway）',
    '  --force         覆盖已存在的密钥文件',
    '  --json          机器可读 JSON 输出',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === 'force' || key === 'json' || key === 'help') {
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
const id = args.id ?? (kind === 'mcp-bus' ? 'mcp-bus' : 'qq-main');
const platform = args.platform ?? (kind === 'wx' ? 'wx' : 'qq');
const outDir = args.out ?? path.join(PACKAGE_ROOT, 'state', 'gateway');

let result = null;
try {
  const secret = generateSecret();
  const file = writeSecretFile({ dir: outDir, id, secret, force: args.force === true });
  const snippets = buildConfigSnippets({
    kind,
    id,
    platform,
    secret,
    capabilities: kind === 'mcp-bus' ? null : [...DELIVERABLE_ACTIONS],
  });
  result = {
    ok: true,
    kind,
    id,
    platform,
    file: file.filePath,
    sha256: file.sha256,
    overwritten: file.overwritten,
    secret,
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
console.log(`1) agent-gateway/state/gateway/adapters.json 条目:`);
if (result.snippets.adaptersEntry) {
  console.log(JSON.stringify(result.snippets.adaptersEntry, null, 2));
} else {
  console.log('   （mcp-bus 不进 adapters.json）');
}
console.log('');
console.log(`2) 桥接侧配置片段:`);
if (result.snippets.bridgeGateway) {
  console.log(JSON.stringify(result.snippets.bridgeGateway, null, 2));
} else {
  for (const note of result.snippets.mcpToken ? [result.snippets.mcpToken.note] : []) {
    console.log(`   ${note}`);
  }
  console.log(`   $env:GATEWAY_MCP_TOKEN='${result.secret}'`);
}
console.log('');
console.log('注意:');
for (const note of result.notes) {
  console.log(`- ${note}`);
}
