#!/usr/bin/env node

/**
 * init-env：首跑初始化网关自己的两份凭据文件（并由 start-gateway.bat 调用）。
 *
 * 为什么是脚本而不是服务端自写：
 *   .env 是运维的配置面，运行时进程不该改写自己的输入（会让「真实 env > .env」
 *   的语义变得不可解释，也让两个进程并发启动时可能互相覆盖）。初始化只在
 *   「首次部署」这一动作里发生，放在启动脚本里显式可见。
 *
 * 凭据全部走文件单源（.env 不再承载任何 token）：
 *   <state>/operator-token       控制台登录凭据（base64url，满足 OPERATOR_TOKEN_PATTERN）
 *   <state>/mcp-bus.secret       网关 ↔ mcp-bus 薄壳的 HMAC 共享密钥（hex48，
 *                                DSH 条目经 --token-file 读同一份）
 *
 * 旧 env 键就地清理：GATEWAY_OPERATOR_TOKEN / GATEWAY_MCP_BUS_TOKEN /
 * GATEWAY_MCP_TOKEN（含 *_FILE 变体）已整体退役（网关读到即 fail-closed 拒载），
 * 这里负责把 .env 里的残留行删掉并打印迁移说明——用户不需要手工编辑。
 *
 * 幂等：两份凭据文件已存在且合法 → 绝不改动（轮换会让正在跑的 mcp-bus / 已登录
 * 的控制台会话全部失效）；operator token 只在「新生成」时明文打印一次供登录。
 *
 * 用法：
 *   node scripts/init-env.mjs                     # 默认 <pkg>/.env + <pkg>/state/gateway
 *   node scripts/init-env.mjs --env D:\x\.env --state D:\x\state\gateway
 *   node scripts/init-env.mjs --json              # 机器可读（bat/UI 复用）
 *   node scripts/init-env.mjs --dry-run           # 只报告会做什么，不落盘
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const { generateSecret } = await import(new URL('../src/core/secrets.mjs', import.meta.url).href);
const { OPERATOR_TOKEN_PATTERN } = await import(new URL('../src/core/auth.mjs', import.meta.url).href);

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 已退役的 token env 键：.env 里出现即删除（网关侧读到即拒载）。 */
const RETIRED_TOKEN_KEYS = [
  'GATEWAY_OPERATOR_TOKEN',
  'GATEWAY_MCP_BUS_TOKEN',
  'GATEWAY_MCP_TOKEN',
  'GATEWAY_MCP_TOKEN_FILE',
  'GATEWAY_MCP_BUS_TOKEN_FILE',
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === 'json' || key === 'dry-run' || key === 'help') {
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

/** 从 .env 文本中删除退役键的行（含注释行与同键多行），返回 { text, removed }。 */
function stripRetiredKeys(text) {
  const lines = text.split(/\r?\n/);
  const removed = [];
  const patterns = RETIRED_TOKEN_KEYS.map((key) => ({
    key,
    pattern: new RegExp(`^\\s*(?:#\\s*)?${key}\\s*=`),
  }));
  for (let i = 0; i < lines.length; i += 1) {
    const hit = patterns.find(({ pattern }) => pattern.test(lines[i]));
    if (!hit) continue;
    lines.splice(i, 1);
    i -= 1;
    if (!removed.includes(hit.key)) removed.push(hit.key);
  }
  return { text: lines.join('\n'), removed };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log([
      '用法: node scripts/init-env.mjs [--env <path>] [--state <dir>] [--json] [--dry-run]',
      '',
      '  --env <path>   .env 路径（默认 <pkg>/.env；仅用于清理退役 token 键）',
      '  --state <dir>  状态目录（默认 <pkg>/state/gateway），两份凭据文件落在这里',
      '  --json         机器可读输出',
      '  --dry-run      只报告，不写文件',
    ].join('\n'));
    return 0;
  }

  const envFile = path.resolve(args.env ?? path.join(PACKAGE_ROOT, '.env'));
  const stateDir = path.resolve(args.state ?? path.join(PACKAGE_ROOT, 'state', 'gateway'));
  const dryRun = args['dry-run'] === true;
  const warn = (line) => { if (args.json !== true) console.warn(line); };

  // 1) .env：存在则清理退役 token 键；缺失不创建凭据键（凭据只落 <state>/ 文件）。
  let envChanged = false;
  let removedKeys = [];
  if (fs.existsSync(envFile)) {
    const original = fs.readFileSync(envFile, 'utf8');
    const stripped = stripRetiredKeys(original);
    removedKeys = stripped.removed;
    if (removedKeys.length > 0) {
      warn(`[init-env] 已从 .env 移除退役 token 键：${removedKeys.join(', ')}（凭据改为文件单源）`);
      envChanged = true;
      if (!dryRun) {
        const tmp = `${envFile}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, `${stripped.text.trimEnd()}\n`, 'utf8');
        fs.renameSync(tmp, envFile);
      }
    }
  }

  // 2) mcp-bus 共享密钥：文件缺失/过短 → 生成 hex48（0600）；已存在且合法 → 不动。
  const mcpSecretFile = path.join(stateDir, 'mcp-bus.secret');
  let mcpSecretGenerated = false;
  const onDiskMcp = fs.existsSync(mcpSecretFile)
    ? fs.readFileSync(mcpSecretFile, 'utf8').trim()
    : '';
  if (onDiskMcp.length < 16) {
    if (onDiskMcp !== '') {
      warn(`[init-env] 警告：${mcpSecretFile} 长度不足 16 字符，将重新生成（正在跑的 mcp-bus 会 401，需重启 DSH）。`);
    }
    const value = generateSecret();
    if (!dryRun) {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(mcpSecretFile, `${value}\n`, { encoding: 'utf8', mode: 0o600 });
    }
    mcpSecretGenerated = true;
  }

  // 3) operator token（控制台登录）：文件缺失/非法 → 生成 base64url（0600），
  //    新生成时明文打印一次供登录；已存在 → 绝不打印（避免泄露）。
  const operatorTokenFile = path.join(stateDir, 'operator-token');
  let operatorTokenGenerated = false;
  let operatorTokenValue = '';
  const onDiskOperator = fs.existsSync(operatorTokenFile)
    ? fs.readFileSync(operatorTokenFile, 'utf8').trim()
    : '';
  if (onDiskOperator === '' || !OPERATOR_TOKEN_PATTERN.test(onDiskOperator)) {
    if (onDiskOperator !== '') {
      warn(`[init-env] 警告：${operatorTokenFile} 不满足 ${OPERATOR_TOKEN_PATTERN.source}，将重新生成（已登录的会话会失效）。`);
    }
    operatorTokenValue = randomBytes(24).toString('base64url');
    if (!OPERATOR_TOKEN_PATTERN.test(operatorTokenValue)) {
      operatorTokenValue = randomBytes(24).toString('base64url');
    }
    if (!dryRun) {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(operatorTokenFile, `${operatorTokenValue}\n`, { encoding: 'utf8', mode: 0o600 });
    }
    operatorTokenGenerated = true;
  }

  // 4) 输出。
  if (args.json === true) {
    console.log(JSON.stringify({
      ok: true,
      envFile,
      envChanged,
      removedKeys,
      dryRun,
      mcpSecretFile,
      mcpSecretGenerated,
      operatorTokenFile,
      operatorTokenGenerated,
      ...(operatorTokenGenerated ? { operatorToken: operatorTokenValue } : {}),
    }, null, 2));
    return 0;
  }

  if (removedKeys.length === 0 && !mcpSecretGenerated && !operatorTokenGenerated) {
    console.log('[init-env] 凭据文件均已存在且合法，未做改动。');
  }
  console.log(`[init-env] state 目录: ${stateDir}${dryRun ? '（dry-run，未写入）' : ''}`);
  if (mcpSecretGenerated) console.log(`[init-env] mcp-bus 共享密钥已生成：${mcpSecretFile}`);
  if (operatorTokenGenerated) {
    console.log(`[init-env] 控制台登录凭据已生成：${operatorTokenFile}`);
    if (!dryRun) console.log(`[init-env] 登录 token（仅此一次明文展示）：${operatorTokenValue}`);
  }
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`init-env: ${error?.message ?? error}`);
  process.exit(1);
}
