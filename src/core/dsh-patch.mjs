/**
 * DSH 注册补丁（cordis.patch.yml）的纯文件操作层。
 *
 * 背景：mcp-bus 是 DSH 侧的 stdio MCP 薄壳，必须在 DSH 的 profile 补丁里登记
 * 一条 dsh-mcp-client 条目，DSH 才会 spawn 它、把工具清单暴露给模型。DSH 只在
 * 启动期读该文件，所以注册后必须重启 DSH。
 *
 * 为什么不用 YAML 解析器：仓库零外部依赖，而这个文件只需要「在顶层序列末尾
 * 追加一项」与「替换一段被 marker 圈住的文本」。解析 + 序列化会把用户手写的
 * 注释、顺序、引号风格全部重写，风险和收益不成比例。
 *
 * 为什么按 latin1 读写：真实的 cordis.patch.yml 里存有历史遗留的乱码注释
 * （GBK 字节被二次编码过）。任何「按 UTF-8 解码再编码」的往返都可能把非法
 * 序列替换成 U+FFFD，把用户配置写坏。latin1 是 1:1 字节映射，marker 之外
 * 的字节可保证完全不变；本模块写入的块本身是纯 ASCII。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BLOCK_BEGIN = '# === agent-gateway MCP BEGIN ===';
export const BLOCK_END = '# === agent-gateway MCP END ===';

/** 备份保留份数（按时间戳倒序留最新的几个）。 */
const BACKUP_KEEP = 3;

/**
 * 解析 DSH 补丁文件路径。默认 `~/.dsh/profiles/<profile>/cordis.patch.yml`。
 * `dsh-web.cmd` 用的是 web profile；headless 场景可传 profile=headless。
 */
export function resolveDshPatchFile({ home, profile = 'web', file } = {}) {
  if (file) return path.resolve(file);
  const root = home || process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(root, '.dsh', 'profiles', profile, 'cordis.patch.yml');
}

/** 生成要写入的块（纯 ASCII，缩进与 DSH 现有条目一致）。 */
export function buildMcpBusBlock({
  nodePath = process.execPath,
  mcpBusPath,
  gatewayUrl = 'http://127.0.0.1:7190',
  tokenFile,
} = {}) {
  if (!mcpBusPath) throw new Error('mcpBusPath required');
  if (!tokenFile) throw new Error('tokenFile required');
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  // 本块必须是纯 ASCII：文件按 latin1 读写以保字节，非 ASCII 字符会被截断成低 8 位。
  return [
    BLOCK_BEGIN,
    '# Managed by `npm run setup:dsh` (agent-gateway repo).',
    '# This block is replaced as a whole; do not edit entries inside it.',
    '# Deleting the whole block uninstalls the gateway tool plane.',
    '- insert:',
    '    - id: mcp-agent-gateway',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: agent-gateway',
    '        transport: stdio',
    `        command: ${quote(nodePath)}`,
    '        args:',
    `          - ${quote(mcpBusPath)}`,
    "          - '--gateway-url'",
    `          - ${quote(gatewayUrl)}`,
    "          - '--token-file'",
    `          - ${quote(tokenFile)}`,
    BLOCK_END,
    '',
  ].join('\n');
}

/** 读文件为 latin1 字符串（字节保真）；不存在返回 null。 */
export function readPatchText(filePath) {
  try {
    return fs.readFileSync(filePath, 'latin1');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** 抽出已有 marker 块（含前后 marker 行）；未找到返回 null。 */
function extractBlock(text) {
  const begin = text.indexOf(BLOCK_BEGIN);
  const end = text.indexOf(BLOCK_END);
  if (begin < 0 && end < 0) return null;
  if (begin < 0 || end < 0 || end < begin) return { broken: true };
  const stop = end + BLOCK_END.length;
  // 连同块尾换行一起切掉，避免每次替换都多留一个空行。
  const tail = text.slice(stop).replace(/^\r?\n/, '');
  return { start: begin, end: stop, existing: text.slice(begin, stop), rest: text.slice(0, begin) + tail };
}

/**
 * 计划一次注册：不写盘，返回 { action, text, reason }。
 * action:
 *   create       文件不存在或没有本模块的块 → 追加
 *   replace      块存在但内容漂移 → 整体替换
 *   noop         块内容一致
 *   skip-manual  文件里已有手工登记的 mcp-bus（无 marker）→ 不动，避免双份
 *   broken       marker 只剩一半 → 报错，绝不猜
 */
export function planPatch(existingText, block) {
  if (existingText === null) {
    return { action: 'create', text: block, reason: 'file-missing' };
  }
  const found = extractBlock(existingText);
  if (found?.broken) return { action: 'broken', text: existingText, reason: 'unbalanced-markers' };
  if (found) {
    // 比较时忽略空白差异，避免 CRLF/LF 变化被当成漂移反复重写。
    const same = found.existing.replace(/\s+/g, ' ').trim() === block.replace(/\s+/g, ' ').trim();
    if (same) return { action: 'noop', text: existingText, reason: 'already-registered' };
    return { action: 'replace', text: `${found.rest.trimEnd()}\n\n${block}`, reason: 'content-drift' };
  }
  // 没有 marker 但已经手工登记过 mcp-bus：不追加第二份（两个同名 MCP 会互相覆盖工具）。
  if (existingText.includes('mcp-bus.mjs')) {
    return { action: 'skip-manual', text: existingText, reason: 'manual-registration-detected' };
  }
  return {
    action: 'create',
    text: `${existingText.trimEnd()}\n\n${block}`,
    reason: 'not-registered',
  };
}

/** 注册状态（供启动诊断使用，只读）。 */
export function checkRegistration(filePath) {
  let text;
  try {
    text = readPatchText(filePath);
  } catch (error) {
    return { registered: false, reason: 'unreadable', detail: String(error?.message ?? error) };
  }
  if (text === null) return { registered: false, reason: 'file-missing' };
  const found = extractBlock(text);
  if (found?.broken) return { registered: false, reason: 'unbalanced-markers' };
  if (found) return { registered: true, reason: 'ok' };
  if (text.includes('mcp-bus.mjs')) return { registered: true, reason: 'manual-registration' };
  return { registered: false, reason: 'not-registered' };
}

/** 备份到 `<file>.bak-<时间戳>`，只保留最近 BACKUP_KEEP 份。返回备份路径。 */
export function backupPatch(filePath, { now = Date.now() } = {}) {
  if (!fs.existsSync(filePath)) return null;
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const backup = `${filePath}.bak-${stamp}`;
  fs.copyFileSync(filePath, backup);
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.bak-`;
  const stale = fs.readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse()
    .slice(BACKUP_KEEP);
  for (const name of stale) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch { /* 备份清理失败不影响主流程 */ }
  }
  return backup;
}

/**
 * 落盘：备份 → 写临时文件 → rename 原子替换（目标目录不存在则创建）。
 * 返回 { written, backupPath }；action 非 create/replace 时不写。
 */
export function applyPatch(filePath, planned, { now = Date.now() } = {}) {
  if (planned.action !== 'create' && planned.action !== 'replace') {
    return { written: false, backupPath: null };
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const backupPath = backupPatch(filePath, { now });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, planned.text, 'latin1');
  fs.renameSync(tmp, filePath);
  return { written: true, backupPath };
}
