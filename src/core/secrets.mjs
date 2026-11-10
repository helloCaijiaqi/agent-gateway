/**
 * 密钥生成与配置片段装配（纯函数库）。
 *
 * 为什么抽成独立模块：scripts/gen-secret.mjs 只是薄 CLI；未来网关增加 UI 后，
 * 「生成密钥 → 写 state/gateway → 出两侧配置片段」的注册流程由 UI 直接 import
 * 本模块复用，不再二次实现。
 *
 * 约束：
 *   - 只依赖 node 内置模块（UI/脚本/测试三方共用，不引入 zod 等重依赖）；
 *   - 密钥下限与 core/auth.mjs 的 signRequest/verifyRequest 一致（>=16 字符）；
 *   - 本模块不做任何「顺手改配置」的事：不写 adapters.json、不碰桥接 config.json，
 *     片段只打印/返回，由操作者（或未来 UI）决定如何落位。
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 与 core/auth.mjs 的下限保持一致；改这里必须同步改 auth。 */
export const MIN_SECRET_LENGTH = 16;

/** 密钥文件名的合法字符：防路径穿越，也防手滑把空格带进文件名。 */
const SAFE_ID = /^[\w][\w.-]*$/;

/**
 * 生成随机密钥：randomBytes(24).toString('hex') → 48 位十六进制。
 * 24 字节（192 bit）对 HMAC-SHA256 共享密钥绰绰有余，且 hex 形态无特殊字符，
 * 粘贴进 JSON/env 都不需要转义。
 */
export function generateSecret({ bytes = 24 } = {}) {
  if (!Number.isInteger(bytes) || bytes < 8) {
    throw new TypeError('bytes must be an integer >= 8');
  }
  const secret = randomBytes(bytes).toString('hex');
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`generated secret shorter than ${MIN_SECRET_LENGTH} chars (bug)`);
  }
  return secret;
}

/** 内容 sha256 指纹的前 chars 位：供肉眼核对两侧文件一致。 */
export function sha256Prefix(text, chars = 8) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, Math.max(1, chars));
}

/**
 * 把密钥写入 `<dir>/<id>.secret`。
 *
 * 消费方（config.resolveSecret / mcp-bus --token-file）读取时都做 .trim()，
 * 所以写文件带一个结尾换行是安全的，且对手工编辑器友好。
 *
 * @returns {{ filePath: string, sha256: string, overwritten: boolean }}
 * @throws 文件已存在且未显式 force 时抛错——静默轮换密钥会让另一侧突然 401。
 */
export function writeSecretFile({ dir, id, secret, force = false }) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    throw new TypeError(`id must match ${SAFE_ID}, got: ${JSON.stringify(id)}`);
  }
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new TypeError(`secret must be a string of at least ${MIN_SECRET_LENGTH} characters`);
  }
  const filePath = path.resolve(String(dir), `${id}.secret`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existed = fs.existsSync(filePath);
  if (existed && !force) {
    throw new Error(`refusing to overwrite existing secret file: ${filePath} (pass --force to rotate)`);
  }
  // 0600：与 operator-token / 其它凭据落盘同口径。flag 'wx' 已保证不覆盖，但
  // 默认 umask 会让文件对其他本地用户可读（Windows 上 mode 被忽略，需 ACL）。
  fs.writeFileSync(filePath, `${secret}\n`, {
    encoding: 'utf8', flag: existed && force ? 'w' : 'wx', mode: 0o600,
  });
  return { filePath, sha256: sha256Prefix(secret), overwritten: existed && force };
}

/**
 * 按 --kind 装配两侧配置片段（纯函数，只构造不落盘）。
 *
 * @param {object} options
 * @param {'adapter'|'wx'|'mcp-bus'} [options.kind]
 * @param {string} options.id
 * @param {string} [options.platform]   adapter/wx 用；wx kind 缺省 'wx'
 * @param {string} options.secret
 * @param {string} [options.callbackBase] 适配器 /v1/actions 基址（片段展示用）
 * @param {string[]|null} [options.capabilities] 投递能力提示（来自 config.DELIVERABLE_ACTIONS）
 * @param {string} [options.gatewayUrl]
 */
export function buildConfigSnippets({
  kind = 'adapter',
  id,
  platform,
  secret,
  callbackBase,
  capabilities = null,
  gatewayUrl = 'http://127.0.0.1:7190',
} = {}) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new TypeError(`secret must be a string of at least ${MIN_SECRET_LENGTH} characters`);
  }

  if (kind === 'mcp-bus') {
    return {
      adaptersEntry: null,
      bridgeGateway: null,
      mcpToken: {
        env: 'GATEWAY_MCP_TOKEN',
        value: secret,
        note: 'mcp-bus 不进 adapters.json；setup-dsh.mjs 以 --token-file 指向 state/gateway/mcp-bus.secret，网关侧用 GATEWAY_MCP_TOKEN 或同一文件。',
      },
      notes: [
        `设置环境变量：$env:GATEWAY_MCP_TOKEN='${secret}'`,
        `或在接入侧：$env:GATEWAY_MCP_TOKEN_FILE='<网关 state/gateway>/${id}.secret'（宿主 setup 脚本默认即此路径）`,
      ],
    };
  }

  const resolvedPlatform = platform ?? (kind === 'wx' ? 'wx' : 'qq');
  const resolvedCallbackBase = callbackBase ?? (resolvedPlatform === 'wx'
    ? 'http://127.0.0.1:7192'
    : 'http://127.0.0.1:3100');

  const adaptersEntry = {
    id,
    platform: resolvedPlatform,
    secretFile: `${id}.secret`,
    callbackBase: resolvedCallbackBase,
    ...(capabilities ? { capabilities: [...capabilities] } : {}),
    ...(kind === 'wx' ? { enabled: false } : {}),
  };

  const bridgeGateway = {
    mode: 'on',
    url: gatewayUrl,
    adapterId: id,
    platform: resolvedPlatform,
    secret,
    conversations: [],
  };

  const notes = [
    'adapters.json 片段放入 agent-gateway/state/gateway/adapters.json 的 adapters 数组（secretFile 相对 state/gateway 目录）。',
    '桥接侧 gateway 段含密钥明文，粘贴进 config.json 后建议删除本密钥文件副本（保留 adapters.json 侧的 secretFile 即可）。',
  ];
  if (kind === 'wx') {
    notes.push('wx 条目默认 enabled:false 灰度：先以禁用状态登记，验证 /v1/health 可见后再翻转。');
    notes.push('微信适配器侧不经 config.json，用等价环境变量/配置方式填入同一 secret。');
  }
  return { adaptersEntry, bridgeGateway, mcpToken: null, notes };
}
