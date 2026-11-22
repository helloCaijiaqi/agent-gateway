/**
 * gateway.json：派生进程（平台适配器 / 登记服务）连接本网关所需的**唯一**配置交接文件。
 *
 * 为什么要有它：
 *   过去「连哪个网关、用哪个身份、拿什么密钥」散落在各处——平台侧塞在它自己的
 *   config.json 里，服务侧靠四五个 *_GATEWAY_* 环境变量。两边都要手抄密钥，抄错
 *   只会得到一句 401，且「设了环境变量却没生效」这种故障无从对账。现在把这份契约
 *   收敛成一个自解释的 JSON：网关生成 → 复制到对端仓库根目录（保持文件名
 *   gateway.json）→ 对端启动时只读它。
 *
 * 设计约束：
 *   - 只依赖 node 内置与同目录模块（分层测试会扫 import 与源码里的上层路径）；
 *   - 本模块只**构造与落盘**，不做「顺手改别人配置」的事；
 *   - 生成物落 `<stateDir>/handoff/`，**绝不能放 `<stateDir>/services/`**：登记目录
 *     扫描只认 *.json，而 `<id>.gateway.json` 的文件名 stem 与内部 id 不符，会被
 *     当成坏登记写进 reject 台账。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PORT } from './config.mjs';

export const HANDOFF_VERSION = 1;
/** 生成物所在子目录（相对 stateDir）；与 services/ 分开是硬约束，见文件头。 */
export const HANDOFF_DIRNAME = 'handoff';
/** 对端复制后应有的文件名：消费方只找这个名字，不再靠环境变量。 */
export const HANDOFF_FILENAME = 'gateway.json';

/** 与登记 / 适配器 id 同一口径（文件名即身份，不允许大小写与分隔符漂移）。 */
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TRANSPORTS = Object.freeze(['http', 'ws', 'auto']);
const MIN_SECRET_LENGTH = 16;

/** 交接文件的固定说明：让「复制到哪、文件名是什么」不需要查文档。 */
const HANDOFF_COMMENT = `复制到目标仓库根目录并保持文件名 ${HANDOFF_FILENAME}；`
  + 'url 是网关基址（不是本服务地址），secretFile 为网关侧密钥文件的绝对路径。';

function assertId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    throw new TypeError(`id must match ${SAFE_ID}, got: ${JSON.stringify(id)}`);
  }
  return id;
}

function fingerprint(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 8);
}

/**
 * 网关基址：对端要连的地址。
 *
 * `0.0.0.0` / `::` 是监听地址而不是可达地址，交接文件里必须换成回环，
 * 否则对端会去连一个「本机所有网卡」的占位地址。
 */
export function resolveGatewayBaseUrl({ host = '127.0.0.1', port = DEFAULT_PORT } = {}) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) {
    throw new TypeError(`port must be an integer in 1..65535, got: ${JSON.stringify(port)}`);
  }
  const raw = String(host ?? '').trim() || '127.0.0.1';
  const reachable = ['0.0.0.0', '::', '[::]', '*'].includes(raw) ? '127.0.0.1' : raw;
  // IPv6 字面量要加方括号，否则拼出来的 URL 不可解析。
  const authority = reachable.includes(':') && !reachable.startsWith('[') ? `[${reachable}]` : reachable;
  return `http://${authority}:${numericPort}`;
}

/** 生成物路径：`<stateDir>/handoff/<id>.gateway.json`。 */
export function handoffPath({ stateDir, id }) {
  assertId(id);
  return path.join(path.resolve(String(stateDir)), HANDOFF_DIRNAME, `${id}.gateway.json`);
}

/**
 * 构造 v1 交接文档（纯函数，不落盘）。
 *
 * 密钥二选一：
 *   - `secretFile`（默认，推荐）：指向网关侧 `*.secret` 的**绝对路径**，明文不离开网关；
 *   - `secret`（`--inline-secret`）：跨机复制时用，代价是明文出现在目标仓库。
 * 两者都不给是合法形态（登记用 secretEnv 时网关拿不到明文），此时必须带 `authNote`
 * 说明「密钥从哪里来」，否则对端只能看到一句莫名其妙的失败。
 *
 * @param {object} options
 * @param {'adapter'|'service'} options.kind
 * @param {string} options.id
 * @param {string} options.url 网关基址
 * @param {'http'|'ws'|'auto'} [options.transport]
 * @param {string} [options.secretFile] 绝对路径
 * @param {string} [options.secret] 内联明文（>=16 字符）
 * @param {string} [options.authNote] 无凭据时的解释
 * @returns {Record<string, unknown>}
 */
export function buildHandoffDocument({
  kind, id, url, transport = 'auto', secretFile, secret, authNote,
} = {}) {
  if (kind !== 'adapter' && kind !== 'service') {
    throw new TypeError(`kind must be "adapter" or "service", got: ${JSON.stringify(kind)}`);
  }
  assertId(id);

  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new TypeError(`url must be an absolute http(s) URL, got: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`url must be http(s), got: ${parsed.protocol}`);
  }
  if (!TRANSPORTS.includes(transport)) {
    throw new TypeError(`transport must be one of ${TRANSPORTS.join('|')}, got: ${JSON.stringify(transport)}`);
  }
  if (secret !== undefined && secretFile !== undefined) {
    throw new TypeError('provide exactly one of secret | secretFile (inline secret is opt-in via --inline-secret)');
  }
  if (secret !== undefined && (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH)) {
    throw new TypeError(`secret must be a string of at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (secretFile !== undefined) {
    if (typeof secretFile !== 'string' || !secretFile.trim()) {
      throw new TypeError('secretFile must be a non-empty path');
    }
    // 相对路径在「复制到另一个仓库」之后必然解析失败，与其让对端启动时报
    // ENOENT，不如在生成时就拒绝——跨机场景请用 --inline-secret。
    if (!path.isAbsolute(secretFile)) {
      throw new TypeError(`secretFile must be absolute (got "${secretFile}"); use --inline-secret for cross-machine handoff`);
    }
  }

  return {
    v: HANDOFF_VERSION,
    id,
    kind,
    // 去掉结尾斜杠：对端拼接 `/v1/ws`、`/v1/inbound` 时不会出现双斜杠。
    url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`,
    transport,
    ...(secretFile !== undefined ? { secretFile: path.normalize(secretFile) } : {}),
    ...(secret !== undefined ? { secret } : {}),
    ...(authNote ? { authNote: String(authNote) } : {}),
    _comment: HANDOFF_COMMENT,
  };
}

/** 序列化：末尾带一个换行，diff 友好；消费方 JSON.parse 不依赖它。 */
export function serializeHandoff(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * 原子落盘（tmp + rename，0600）。
 *
 * 覆盖语义与密钥文件一致：内容完全相同 → 视为幂等（`written:false`，不碰 mtime）；
 * 内容不同且未显式 force → 抛错。轮换密钥后想重出交接文件必须 `--force`，
 * 避免「悄悄改了对端还没同步的凭据」。
 *
 * @returns {{ filePath: string, sha256: string, written: boolean }}
 */
export function writeHandoff({ stateDir, doc, force = false }) {
  if (!doc || typeof doc !== 'object') throw new TypeError('doc must be an object');
  assertId(doc.id);
  const filePath = handoffPath({ stateDir, id: doc.id });
  const text = serializeHandoff(doc);
  const digest = fingerprint(text);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  if (fs.existsSync(filePath)) {
    const current = fs.readFileSync(filePath, 'utf8');
    if (current === text) return { filePath, sha256: digest, written: false };
    if (!force) {
      throw new Error(`refusing to overwrite existing handoff file: ${filePath} (pass --force to regenerate)`);
    }
  }

  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (error) {
    // 半份临时文件比没有更糟：清理后再抛，保证目录里只有完整文件。
    try { fs.rmSync(tmp, { force: true }); } catch { /* 尽力清理 */ }
    throw error;
  }
  return { filePath, sha256: digest, written: true };
}

/** 删除生成物（注销服务时调用）：返回是否真的删掉了。 */
export function removeHandoff({ stateDir, id }) {
  const filePath = handoffPath({ stateDir, id });
  if (!fs.existsSync(filePath)) return false;
  fs.rmSync(filePath, { force: true });
  return true;
}

/** 该 id 的交接文件是否已生成（控制台列表用，只做一次 existsSync）。 */
export function handoffExists({ stateDir, id }) {
  return fs.existsSync(handoffPath({ stateDir, id }));
}

/** 读取并解析生成物（CLI 幂等判断/自检用）；不存在返回 null。 */
export function readHandoff({ stateDir, id }) {
  const filePath = handoffPath({ stateDir, id });
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`handoff file is not valid JSON: ${filePath} (${error?.message ?? error})`);
  }
}
