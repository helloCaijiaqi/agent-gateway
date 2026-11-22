#!/usr/bin/env node

/**
 * setup:dsh —— 把网关受管的 DSH 资产安装进 profile（一次性安装动作）。
 *
 * 只做一件事：**MCP（mcp-bus）注册块**——把 `# === agent-gateway MCP BEGIN/END ===`
 * 写进 `<profile>/cordis.patch.yml`（DSH 拉取 chat_qq_* 工具面的唯一入口）。
 *
 * preset bundle 的源码/渲染/物化已随预设所有权迁到 qq-bridge（2026-11-16，
 * 见 qq-bridge 的 `npm run install:preset`）：预设是平台知识，两边不越界。
 *
 * 为什么是显式 CLI 而不是网关启动时自动写：
 *   1. DSH 只在启动期读 cordis.patch.yml，写完必须重启 DSH 才生效——启动时
 *      静默改写只会让人以为「已经好了」；
 *   2. 崩溃重启 loop 会反复改写另一个应用正在读写的配置；
 *   3. 该文件里有用户/其它插件维护的内容（含历史乱码注释），写坏代价极高。
 *   所以网关启动时只做诊断（见 src/main.mjs），安装交给这条命令。
 *
 * 幂等：块内容一致 → noop；链接指向一致 → noop。块外的任何字节都不动；首次写入前自动备份。
 *
 * 用法：
 *   npm run setup:dsh                 # 写入 ~/.dsh/profiles/web 的 marker 块
 *   npm run setup:dsh -- --dry-run    # 只打印将写入的块，不落盘
 *   npm run setup:dsh -- --profile headless
 *   npm run setup:dsh -- --force      # 手工登记过的条目也让本仓库接管
 *   npm run setup:dsh -- --json
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  BLOCK_BEGIN,
  BLOCK_END,
  buildMcpBusBlock,
  planPatch,
  applyPatch,
  readPatchText,
  resolveDshPatchFile,
  checkRegistration,
} from '../src/core/dsh-patch.mjs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';




const DEFAULT_PROFILE = 'web';
const DEFAULT_PORT = 7190;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === 'json' || key === 'dry-run' || key === 'force' || key === 'help') {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    // 空值/纯空白一律视为「没给值」：`--home ` 这种写法会把文件写到默认 home，
    // 静默跑偏比直接报错危险得多（真实踩过：--home 变量名与 PowerShell $HOME 冲突）。
    if (value === undefined || value.startsWith('--') || value.trim() === '') {
      throw new Error(`missing value for --${key}`);
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

// preset bundle 的物化/链接/渲染已随预设所有权迁到 qq-bridge（qq-bridge 的 npm run install:preset）。
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log([
      '用法: npm run setup:dsh -- [--profile <name>] [--file <path>] [--dry-run] [--json] [--force]',
      '',
      '  --profile <name>     DSH profile（默认 web；headless 场景传 headless）',
      '  --home <path>        DSH home（默认 $DSH_HOME 或 ~/.dsh；测试/多实例用）',
      '  --file <path>        直接指定 cordis.patch.yml（优先于 --profile）',
      '  --dry-run            只打印判定与将写入的块，不落盘',
      '  --json               机器可读输出',
      '  --force              检测到「手工登记过 mcp-bus」时仍然写入本仓库的 marker 块',
      '  --token-file <p>     mcp-bus 共享密钥文件（默认 state/gateway/mcp-bus.secret）',
      '  --gateway-url <u>    薄壳回连地址（默认 http://127.0.0.1:$GATEWAY_PORT）',
      '',
      '环境变量：DSH_BIN 指定 dsh 可执行文件（默认取 PATH 上的 dsh）。',
      '',
      'preset bundle 安装已迁到 qq-bridge（npm run install:preset）；本脚本只写 MCP（mcp-bus）注册块。',
      '安装完必须重启 DSH 才生效。',
    ].join('\n'));
    return 0;
  }

  const json = args.json === true;
  const dryRun = args['dry-run'] === true;
  const profile = args.profile ?? DEFAULT_PROFILE;
  const patchFile = resolveDshPatchFile({ profile, file: args.file });
  const stateDir = path.join(REPO_ROOT, 'state', 'gateway');
  const tokenFile = path.resolve(args['token-file'] ?? path.join(stateDir, 'mcp-bus.secret'));
  const gatewayUrl = args['gateway-url'] ?? `http://127.0.0.1:${process.env.GATEWAY_PORT ?? DEFAULT_PORT}`;
  const fail = (message, extra = {}) => {
    if (json) console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
    else console.error(`[setup:dsh] ${message}`);
    return 1;
  };

  // 前置校验：密钥文件单源（env 通道已退役），没有文件注册完也是 401 —— 先在安装期暴露。
  if (!fs.existsSync(tokenFile)) {
    return fail(`缺少 mcp-bus 共享密钥：${tokenFile}。先运行 npm run env:init（或 start-gateway.bat 首跑）。`);
  }
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  if (token.length < 16) {
    return fail(`mcp-bus 共享密钥长度不足 16 字符：${tokenFile}。请重新生成（npm run env:init）。`);
  }

  const block = buildMcpBusBlock({
    nodePath: process.execPath,
    mcpBusPath: path.join(REPO_ROOT, 'src', 'mcp-bus.mjs'),
    gatewayUrl,
    tokenFile,
  });

  const existing = readPatchText(patchFile);
  let planned = planPatch(existing, block);
  if (planned.action === 'skip-manual' && args.force === true) {
    // 显式 force：用户确认要把手工条目换成受管块（旧条目仍需本人删除，否则双份）。
    planned = { action: 'create', text: `${existing.trimEnd()}\n\n${block}`, reason: 'forced' };
  }

  if (planned.action === 'broken') {
    return fail(`marker 不完整（${patchFile}）：只有 BEGIN 或只有 END。请手工修复后重试，脚本不会猜测边界。`);
  }

  const result = dryRun ? { written: false, backupPath: null } : applyPatch(patchFile, planned);
  const status = checkRegistration(patchFile);

  if (json) {
    console.log(JSON.stringify({
      ok: planned.action !== 'broken',
      patchFile,
      action: planned.action,
      reason: planned.reason,
      dryRun,
      written: result.written,
      backupPath: result.backupPath,
      tokenFile,
      gatewayUrl,
      registered: status.registered,
      block: dryRun ? block : undefined,
    }, null, 2));
    return 0;
  }

  const label = {
    create: '已写入注册块',
    replace: '已替换注册块（内容漂移）',
    noop: '已注册且内容一致，未改动',
    'skip-manual': '检测到手工登记的 mcp-bus，未改动',
  }[planned.action] ?? planned.action;

  console.log(`[setup:dsh] 目标: ${patchFile}`);
  console.log(`[setup:dsh] 结果: ${label}${dryRun ? '（dry-run，未落盘）' : ''}`);
  if (result.backupPath) console.log(`[setup:dsh] 备份: ${result.backupPath}`);
  if (planned.action === 'skip-manual') {
    console.log('[setup:dsh] 文件里已有 mcp-bus.mjs 条目但没有 marker 块。');
    console.log('           若确认要由本仓库接管：先删掉旧条目，再运行 npm run setup:dsh。');
  }
  if (dryRun) {
    console.log('--- 将写入的块 ---');
    console.log(block);
  }
  console.log(`[setup:dsh] 注册状态: ${status.registered ? '已注册' : '未注册'}（${status.reason}）`);
  if (planned.action !== 'noop') {
    console.log('[setup:dsh] 注意：DSH 只在启动时读这些配置 —— 需要重启 DSH 才会生效。');
  }
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`setup:dsh: ${error?.message ?? error}`);
  process.exit(1);
}
