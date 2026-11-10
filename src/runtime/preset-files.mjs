/**
 * DSH 预设文件层：仿真提示词（persona.prefix）的读取/校验/备份/还原。
 *
 * 迁移自 qq-bridge 的 src/chat/preset-prompt.js（纯函数，git HEAD 提取）与
 * bridge.js 内的文件 helper（atomicWriteText / backupPresetFile 等），防呆行为
 * **一条不少**（docs/console/dsh-presets/PLAN.md 第 2 节）：
 *   - 硬性不变量（blockers）按预设代次取清单，不满足直接拒绝保存/还原；
 *   - 内容未变不落盘（保住 YAML 折叠块的可复审性）；
 *   - 写前备份（保留最近 10 份）、还原前再备份当前版本；
 *   - 备份文件名带预设名（两个预设的主文件同名，防止「还原」串预设）；
 *   - 写回后重新解析必须逐字一致，否则放弃写入；
 *   - 「需重启 DSH 生效」始终显式返回。
 *
 * 与桥接的差异（刻意的）：
 *   - 桥接读写「仓库内 source + DSH home 安装副本」两处；网关没有仓库副本，
 *     文件操作限定在 DSH home 的 agent-presets 子树（PLAN 第 2 节边界）。
 *     DSH 的安装目录存在 `agent-presets` 与 `.agent-presets` 两种布局，
 *     两者都探测：读用第一个命中的，写同步到所有存在的副本。
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { resolveDshHome } from './dsh-client.mjs';

export const PRESET_PERSONA_ID = 'persona';
export const PRESET_PROMPT_MAX_BYTES = 128 * 1024;

// 安全基线段落：缺失说明 AI 的权限边界可能被削弱，保存时警告（不阻断）。
export const PRESET_REQUIRED_MARKERS = ['【二代仿真模式 —— 安全规则', '【二代仿真模式 —— 工具协议'];

// 硬性不变量（子串存在性检查——防误删不防恶意，真正的硬边界在工具守卫与白名单）。
export const PRESET_BLOCKING_SUBSTRINGS = [
  '你没有本地工具',
  '群友没有管理权限',
  'API 令牌',
  '角色由桥接注入',
  '不会自动发送到 QQ',
];
// 一代（qq-chat）不用 MCP 工具，工具面那几条不适用。
export const PRESET_BLOCKING_SUBSTRINGS_V1 = [
  '群友没有管理权限',
  'API 令牌',
  '角色扮演由系统注入',
];
export const PRESET_MIN_BODY_CHARS = 500;

export const PRESET_NAMES = { v1: 'qq-chat', v2: 'qq-chat-v2' };
export const PRESET_BACKUP_KEEP = 10;
export const PRESET_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 预设代次：未知预设按更严的二代替处理。 */
export function presetGeneration(name) {
  return name === PRESET_NAMES.v1 ? 'v1' : 'v2';
}

/** 硬性校验：返回阻止保存的原因列表（空数组=可保存）。 */
export function presetPromptBlockers(content, generation = 'v2') {
  const text = String(content ?? '');
  const blockers = [];
  if (!text.trim()) {
    blockers.push('仿真提示词不能为空');
    return blockers;
  }
  const needles = generation === 'v1' ? PRESET_BLOCKING_SUBSTRINGS_V1 : PRESET_BLOCKING_SUBSTRINGS;
  for (const needle of needles) {
    if (!text.includes(needle)) {
      blockers.push(`缺少安全不变量「${needle}」：删除它会让 AI 的权限边界失效`);
    }
  }
  if (text.trim().length < PRESET_MIN_BODY_CHARS) {
    blockers.push(`正文过短（${text.trim().length} 字符 < ${PRESET_MIN_BODY_CHARS}）：疑似内容被误删`);
  }
  return blockers;
}

/** 保存前的软校验：只提示，不阻断。 */
export function presetPromptWarnings(content) {
  const text = String(content ?? '');
  const warnings = [];
  if (!text.trim()) warnings.push('内容为空');
  for (const marker of PRESET_REQUIRED_MARKERS) {
    if (!text.includes(marker)) warnings.push(`缺少「${marker}…】段落：AI 的权限与工具边界可能被削弱`);
  }
  return warnings;
}

/** 取出 persona.prefix 的真实字符串值（YAML 解析后，折叠标量已展开）。 */
export function extractPresetPrefix(text) {
  let loaded;
  try {
    loaded = yaml.load(text);
  } catch {
    return null;
  }
  const entry = Array.isArray(loaded) ? loaded.find((item) => item?.id === PRESET_PERSONA_ID) : null;
  const prefix = entry?.config?.prefix;
  return typeof prefix === 'string' ? prefix : null;
}

/**
 * 用字面量块（|-）把新提示词写回 YAML 文本。写回后重新解析必须逐字一致，
 * 否则抛错拒绝写入——无论原文用 >- 还是 |，都不改变提示词的实际语义。
 */
export function renderPresetPromptYaml(text, content, generation = 'v2') {
  const lines = String(text ?? '').split('\n');
  const entryStart = lines.findIndex((line) => new RegExp(`^- id:\\s*${PRESET_PERSONA_ID}\\s*$`).test(line));
  if (entryStart < 0) throw new Error('无法定位预设里的 persona 条目（文件结构可能已变化）');
  let entryEnd = lines.length;
  for (let i = entryStart + 1; i < lines.length; i += 1) {
    if (/^- /.test(lines[i])) { entryEnd = i; break; }
  }
  let keyLine = -1;
  for (let i = entryStart; i < entryEnd; i += 1) {
    if (/^\s*prefix:\s*[>|][-+]?\s*$/.test(lines[i])) { keyLine = i; break; }
  }
  if (keyLine < 0) throw new Error('无法定位预设里的 prefix 块（文件结构可能已变化）');
  const keyIndent = lines[keyLine].match(/^\s*/)[0].length;
  let blockEnd = keyLine + 1;
  for (let i = keyLine + 1; i < entryEnd; i += 1) {
    if (lines[i].trim() === '') continue;
    if (lines[i].match(/^\s*/)[0].length <= keyIndent) break;
    blockEnd = i + 1;
  }
  const normalized = String(content ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const bytes = Buffer.byteLength(normalized, 'utf8');
  if (bytes > PRESET_PROMPT_MAX_BYTES) {
    throw new Error(`仿真提示词过长（${(bytes / 1024).toFixed(1)} KB，上限 ${PRESET_PROMPT_MAX_BYTES / 1024} KB）`);
  }
  const blockers = presetPromptBlockers(normalized, generation);
  if (blockers.length) throw new Error(blockers.join('；'));
  // 新增行沿用文件的主导行尾，避免把 CRLF 文件写成混合行尾。
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lfOnly = (text.match(/\n/g) ?? []).length - crlf;
  const eol = crlf >= lfOnly ? '\r\n' : '\n';
  const pad = ' '.repeat(keyIndent + 2);
  // 只有「真正的空行」才写成空行；含空格/Tab 的行保留原样，否则读回一致性校验会失败。
  const body = normalized.split('\n').map((line) => (line === '' ? '' : pad + line));
  const block = [`${' '.repeat(keyIndent)}prefix: |-`, ...body].join(eol) + (eol === '\r\n' ? '\r' : '');
  const next = [...lines.slice(0, keyLine), block, ...lines.slice(blockEnd)].join('\n');
  const reparsed = extractPresetPrefix(next);
  if (reparsed === null) throw new Error('写入后 YAML 解析失败或找不到 persona.prefix');
  if (reparsed !== normalized) {
    throw new Error('写入校验失败：读回的提示词与新内容不一致，已放弃写入');
  }
  return next;
}

// ── 文件操作（限定在 DSH home 的 agent-presets 子树）────────────────────────

function presetRoots() {
  const home = resolveDshHome();
  return [path.join(home, 'agent-presets'), path.join(home, '.agent-presets')];
}

/** 预设主文件的全部现存路径（两种布局都同步）。 */
function presetFilePaths(name) {
  return presetRoots()
    .map((root) => path.join(root, name, 'agent.cordis.yml'))
    .filter((file) => fs.existsSync(file));
}

/** 预设详情（控制台列表/详情用）：不读文件内容。 */
export function describePreset(name) {
  return presetStatusOf(name);
}

/** 读预设主文件文本；找不到时抛出带文件相对位置的错误。 */
export function readPresetYaml(name) {
  const files = presetFilePaths(name);
  if (files.length === 0) {
    throw new Error(`找不到预设文件（DSH home 下 agent-presets/${name}/agent.cordis.yml）`);
  }
  return fs.readFileSync(files[0], 'utf8');
}

function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 已不存在 */ }
    throw error;
  }
}

function presetStatusOf(name) {
  return {
    preset: name,
    label: name === PRESET_NAMES.v1 ? '一代仿真' : '二代仿真',
    installed: presetFilePaths(name).length > 0,
    requiresRestart: true,
  };
}

/** GET sim-prompt 的数据体。 */
export function readSimPrompt(name) {
  const text = readPresetYaml(name);
  const prefix = extractPresetPrefix(text);
  if (prefix === null) throw new Error('预设里找不到 persona.prefix（结构可能已变化）');
  return {
    content: prefix,
    chars: prefix.length,
    bytes: Buffer.byteLength(prefix, 'utf8'),
    warnings: presetPromptWarnings(prefix),
    status: presetStatusOf(name),
  };
}

/**
 * 保存仿真提示词。完整防呆链：未变不落盘 → 渲染校验（含不变量）→ 备份 →
 * 原子写 → 同步安装副本（存在时）→ 失败尽力回滚。
 */
export function writeSimPrompt(name, content, { backupDir, now = Date.now } = {}) {
  const generation = presetGeneration(name);
  const { text, prefix } = (() => {
    const raw = readPresetYaml(name);
    const extracted = extractPresetPrefix(raw);
    if (extracted === null) throw new Error('预设里找不到 persona.prefix（结构可能已变化）');
    return { text: raw, prefix: extracted };
  })();
  const normalized = String(content ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  // 内容没变就不要写：写回会把折叠块规整成字面量块，让一次「打开又保存」
  // 变成全删全加的 diff，失去可复审性。
  if (normalized === prefix) {
    return { changed: false, backup: null, requiresRestart: false, warnings: presetPromptWarnings(prefix), chars: prefix.length };
  }
  const nextText = renderPresetPromptYaml(text, normalized, generation); // 不变量/长度/一致性校验在此抛出
  const warnings = presetPromptWarnings(normalized);
  const backup = backupPresetFile(name, { backupDir, now });
  try {
    const files = presetFilePaths(name);
    atomicWriteText(files[0], nextText);
    // 同步其余布局副本：安装副本不做备份（内容与刚写好的源一致，备份无额外价值）。
    for (const file of files.slice(1)) atomicWriteText(file, nextText);
  } catch (error) {
    // 尽力回滚，避免留下半截状态。
    if (backup && fs.existsSync(backup)) {
      try { fs.copyFileSync(backup, presetFilePaths(name)[0]); } catch { /* 回滚失败交给日志 */ }
    }
    throw error;
  }
  return { changed: true, backup, requiresRestart: true, warnings, chars: normalized.length };
}

function presetBackupPrefix(name) {
  return `${name}.agent.cordis.yml`;
}

/** 写前备份；返回备份文件路径（无主文件时返回 null）。保留最近 PRESET_BACKUP_KEEP 份。 */
export function backupPresetFile(name, { backupDir, now = Date.now } = {}) {
  const files = presetFilePaths(name);
  if (files.length === 0) return null;
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupDir, `${presetBackupPrefix(name)}.${stamp}`);
  fs.copyFileSync(files[0], dest);
  const prefix = `${presetBackupPrefix(name)}.`;
  const backups = fs.readdirSync(backupDir).filter((f) => f.startsWith(prefix)).sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - PRESET_BACKUP_KEEP))) {
    try { fs.rmSync(path.join(backupDir, stale)); } catch { /* 清理失败不阻塞 */ }
  }
  return dest;
}

/** 备份清单（新→旧）。 */
export function listPresetBackups(name, backupDir) {
  try {
    const prefix = `${presetBackupPrefix(name)}.`;
    return fs.readdirSync(backupDir)
      .filter((f) => f.startsWith(prefix))
      .sort().reverse()
      .map((f) => {
        const stat = fs.statSync(path.join(backupDir, f));
        return { file: f, at: stat.mtimeMs, size: stat.size };
      });
  } catch {
    return [];
  }
}

/**
 * 还原备份。防呆：只允许还原本预设的备份清单内的文件（拒绝路径穿越）、
 * 旧备份也要过硬性不变量、还原前先备份当前版本。
 */
export function restorePresetBackup(name, requestedFile, { backupDir, now = Date.now } = {}) {
  const candidates = listPresetBackups(name, backupDir).map((b) => b.file);
  const target = String(requestedFile ?? '').trim() || candidates[0];
  if (!target || !candidates.includes(target)) {
    throw new Error('没有可用的备份');
  }
  const backupPath = path.join(backupDir, target);
  // 真实路径断言：备份必须落在预设备份目录内（acceptance：解析后的真实路径）。
  const realBackup = fs.realpathSync(backupPath);
  const realDir = fs.realpathSync(backupDir);
  if (!realBackup.startsWith(realDir + path.sep)) {
    throw new Error('备份路径越出预设备份目录，拒绝还原');
  }
  const restored = fs.readFileSync(realBackup, 'utf8');
  const restoredPrefix = extractPresetPrefix(restored);
  if (restoredPrefix === null) throw new Error('备份内容不是有效的预设文件');
  // 还原路径必须与保存路径同样严格：旧备份可能来自安全基线加入之前。
  const blockers = presetPromptBlockers(restoredPrefix, presetGeneration(name));
  if (blockers.length) {
    throw new Error(`该备份不满足当前的安全不变量，拒绝还原：${blockers.join('；')}`);
  }
  const rollback = backupPresetFile(name, { backupDir, now });
  try {
    const files = presetFilePaths(name);
    atomicWriteText(files[0], restored);
    for (const file of files.slice(1)) atomicWriteText(file, restored);
  } catch (error) {
    if (rollback && fs.existsSync(rollback)) {
      try { fs.copyFileSync(rollback, presetFilePaths(name)[0]); } catch { /* 同上 */ }
    }
    throw error;
  }
  return { restoredFrom: target, requiresRestart: true };
}
