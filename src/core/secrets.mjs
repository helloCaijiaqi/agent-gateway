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
 * @param {string} [options.gatewayUrl]
 */
export function buildConfigSnippets({
  kind = 'adapter',
  id,
  platform,
  secret,
  callbackBase,
  gatewayUrl = 'http://127.0.0.1:7190',
} = {}) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new TypeError(`secret must be a string of at least ${MIN_SECRET_LENGTH} characters`);
  }

  if (kind === 'mcp-bus') {
    return {
      consumerEntry: null,
      handoff: null,
      mcpToken: {
        // 文件单源：env 通道（GATEWAY_MCP_BUS_TOKEN 及旧名）已退役——网关与
        // 薄壳读同一份 state/gateway/mcp-bus.secret（npm run env:init 生成维护）。
        file: 'state/gateway/mcp-bus.secret',
        value: secret,
        note: 'mcp-bus 不进 adapters.json；npm run setup:dsh 写入的 DSH 条目以 --token-file 指向 state/gateway/mcp-bus.secret，网关侧读同一份文件。',
      },
      notes: [
        `写入网关侧密钥文件：Set-Content state/gateway/mcp-bus.secret '${secret}'（或 npm run env:init 生成）`,
        '然后运行 npm run setup:dsh 把 mcp-bus 注册进 DSH（幂等，需重启 DSH 生效）',
      ],
    };
  }

  const resolvedPlatform = platform ?? (kind === 'wx' ? 'wx' : 'qq');
  const resolvedCallbackBase = callbackBase ?? (resolvedPlatform === 'wx'
    ? 'http://127.0.0.1:7192'
    : 'http://127.0.0.1:3100');

  // 消费端登记条目（登记目录 = 唯一事实源；adapters.json 已退役，读到即拒载）：
  // id 用 svc-<hash>（与平台解耦，同平台多账号互不冲突），url = callbackBase，
  // platform 必填（动作会话定位 + 入站验签）。
  const consumerEntry = {
    v: 1,
    id,
    name: id,
    kind: 'consumer',
    transport: 'auto',
    url: resolvedCallbackBase,
    platform: resolvedPlatform,
    secretFile: `${id}.secret`,
    ...(kind === 'wx' ? { enabled: false } : {}),
  };

  // 对端不再把网关段抄进自己的 config.json：改由 gen-secret 生成交接文件
  // （state/gateway/handoff/<id>.gateway.json），复制到目标仓库根目录即可。
  const handoff = {
    fileName: 'gateway.json',
    copyFrom: `handoff/${id}.gateway.json`,
    note: '已生成交接文件（含 id、网关地址、secretFile 绝对路径）；复制到目标仓库根目录并保持文件名 gateway.json。'
      + '目标侧不再从 config.json / 环境变量读网关连接信息。',
  };

  const notes = [
    `消费端登记条目写入 state/gateway/services/${id}.json（登记目录 = 唯一事实源，热加载生效；secretFile 相对 state/gateway 目录）。`,
    `交接文件：state/gateway/handoff/${id}.gateway.json → 复制到目标仓库根目录并命名为 gateway.json（跨机用 npm run secrets:gen -- --inline-secret）。`,
    '同平台多账号：重复运行本脚本（不传 --id，每次生成新的 svc- hash）+ 各自登记文件即可，互不冲突。',
  ];
  if (kind === 'wx') {
    notes.push('wx 条目默认 enabled:false 灰度：先以禁用状态登记，验证 /v1/health 可见后再翻转。');
    notes.push('微信适配器侧同样只读 gateway.json，不再使用等价环境变量。');
  }
  return { consumerEntry, handoff, mcpToken: null, notes };
}
