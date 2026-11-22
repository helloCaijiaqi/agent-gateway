import fs from 'node:fs';
import path from 'node:path';

/**
 * .env 装载（纯函数库，零依赖）。
 *
 * 为什么自己写而不是引 dotenv / node --env-file：
 *   - 仓库原则零外部依赖（ws 除外），dotenv 是唯一的新增包，不值；
 *   - `node --env-file` 要求启动命令统一带旗标（bat / npm start / 手敲三处都得记），
 *     漏掉就静默丢配置；在组合根里显式装载是 fail-soft 且日志可见的。
 *
 * 语义（与 dotenv 默认一致）：
 *   - 只填充 targetEnv 中**未定义**的键 —— 真实环境变量永远优先，.env 只是「默认值层」；
 *   - 文件缺失 = 静默跳过（返回 missing:true，调用方决定要不要记日志），绝不抛错
 *     —— .env 是可选的便利层，不能因为缺文件挡启动；
 *   - 坏行（无 `=`、键名非法、`=` 前空）逐行 console.warn 后跳过，不影响其余行。
 *
 * 什么时候装：main.mjs 组合根最先调用，先于 loadConfig —— 否则退役键
 * （GATEWAY_OPERATOR_TOKEN / GATEWAY_MCP_BUS_TOKEN 残留等）的 fail-closed 校验
 * 会先于 .env 生效，用户 .env 里有残留仍报错。凭据本身是文件单源
 * （<stateDir>/operator-token / mcp-bus.secret），.env 不再承载任何 token。
 */

/** 键名约束：dotenv 同款（字母/数字/下划线开头，不含空格）。 */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 解析 .env 文本 → { entries, badLines }。
 * 支持：`#` 注释与行尾注释（值带引号时行尾 `#` 不算注释）、空行、
 * `export KEY=VALUE` 前缀剥离、单/双引号去壳（双引号内不做转义展开，按字面取值）。
 * 值本身可以含 `=`（按第一个 `=` 切分）。
 */
export function parseEnvFile(text) {
  const entries = [];
  let badLines = 0;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      badLines += 1;
      continue;
    }
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    if (!KEY_RE.test(key)) {
      badLines += 1;
      continue;
    }
    let value = line.slice(eq + 1).trim();
    // 去引号壳：成对的 ' 或 " 包裹时按字面取壳内文本（"1,2" 不再被行尾注释切）。
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    } else {
      // 无引号：剥离行尾注释（ # 后面全丢；值里真需要 # 时应加引号）。
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    entries.push([key, value]);
  }
  return { entries, badLines };
}

/**
 * 把 .env 装进 targetEnv（通常传 process.env）。已定义的键不覆盖。
 * @returns {{ loaded: number, skipped: number, badLines: number, missing: boolean }}
 */
export function loadEnvInto(targetEnv, filePath, { logger = console.warn } = {}) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { loaded: 0, skipped: 0, badLines: 0, missing: true };
    // 其它读取错误（权限/目录）同样不挡启动，但要留痕。
    logger(`[env-file] 读取失败（忽略）: ${filePath}: ${error?.message ?? error}`);
    return { loaded: 0, skipped: 0, badLines: 0, missing: true };
  }
  const { entries, badLines } = parseEnvFile(text);
  let loaded = 0;
  let skipped = 0;
  for (const [key, value] of entries) {
    if (Object.prototype.hasOwnProperty.call(targetEnv, key) && targetEnv[key] !== undefined) {
      skipped += 1;
      continue;
    }
    targetEnv[key] = value;
    loaded += 1;
  }
  if (badLines > 0) logger(`[env-file] ${filePath}: ${badLines} 行无法解析（已跳过）`);
  return { loaded, skipped, badLines, missing: false };
}

/**
 * 原子写回单个键（控制台 GATEWAY_DATA_PLANE 开关的持久化通道）。
 *
 * 保留文件里注释/空行/其余行的原始形态，只替换目标键所在行（`export KEY=`
 * 前缀行也算命中）；键不存在则追加到末尾。写 `<file>.tmp-<pid>` 后 rename
 * 原子落盘（中途崩溃不会留下半截 .env）；目录不存在则创建。
 *
 * 刻意不做：不整理/重排其它行（.env 是用户手工维护的文件，重排 = diff 噪声）、
 * 不加引号（GATEWAY_DATA_PLANE 这类单 token 值无需引号，调用方传复杂值自行加壳）。
 *
 * @returns {{ persisted: boolean, replaced: boolean }} replaced=false 表示键原先
 *          不存在（本次为追加）。
 */
export function upsertEnvValue(filePath, key, value) {
  if (!KEY_RE.test(String(key))) throw new Error(`upsertEnvValue: invalid key "${key}"`);
  if (/[\r\n]/.test(String(value))) throw new Error('upsertEnvValue: value must not contain newlines');
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const lineRe = new RegExp(`^(?:export\\s+)?${key}=`);
  let replaced = false;
  const lines = text.split(/\r?\n/).map((raw) => {
    const trimmed = raw.trim();
    if (!replaced && trimmed !== '' && !trimmed.startsWith('#') && lineRe.test(trimmed)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return raw;
  });
  if (!replaced) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push(`${key}=${value}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, lines.join('\n'), 'utf8');
  fs.renameSync(tmp, filePath);
  return { persisted: true, replaced };
}
