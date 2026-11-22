#!/usr/bin/env node
/**
 * handoff：为「已经存在」的适配器或登记服务重新生成可复制的 gateway.json。
 *
 * 什么时候用：
 *   - 登记是手写文件（没走控制台），需要补一份交接文件；
 *   - 换了网关端口 / 换了密钥，需要按现状重出一份；
 *   - 想核对目标仓那份 gateway.json 是否过期。
 *
 * 与 gen-secret 的分工：gen-secret 只负责「新生成密钥 + 出交接文件」；
 * 本脚本只读现有登记/适配器配置，不生成、不轮换任何密钥。
 *
 * 用法：
 *   npm run handoff -- --adapter qq-main
 *   npm run handoff -- --service <登记 id> --force
 *   npm run handoff -- --adapter qq-main --gateway-url http://127.0.0.1:7190 --print
 *   npm run handoff -- --adapter wx-main --inline-secret      # 跨机复制
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const {
  buildHandoffDocument, handoffPath, resolveGatewayBaseUrl, writeHandoff,
} = await import(new URL('../src/core/gateway-json.mjs', import.meta.url).href);

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** state 目录：默认 <pkg>/state/gateway；--state 覆盖（测试/多实例部署用）。 */
function stateDirOf(args) {
  return args.state ? path.resolve(args.state) : path.join(PACKAGE_ROOT, 'state', 'gateway');
}

function servicesDirOf(stateDir) {
  return process.env.GATEWAY_SERVICES_DIR
    ? path.resolve(process.env.GATEWAY_SERVICES_DIR)
    : path.join(stateDir, 'services');
}

function usage() {
  return [
    '用法: npm run handoff -- (--adapter <id> | --service <id>) [选项]',
    '',
    '  --adapter <id>    --service 的历史别名（读 state/gateway/services/<id>.json）',
    '  --service <id>    读 state/gateway/services/<id>.json（登记文件）',
    '  --state <dir>     state 目录（默认 <pkg>/state/gateway；测试/多实例用）',
    '  --gateway-url <u> 网关基址（默认取 GATEWAY_HOST/GATEWAY_PORT，否则 127.0.0.1:7190）',
    '  --inline-secret   内联明文密钥（跨机复制用；默认写 secretFile 引用）',
    '  --force           覆盖已存在的交接文件（内容不同才需要）',
    '  --print           打印交接文件内容（默认只打印路径；内联密钥默认打码）',
    '  --show-secret     配合 --print 时显示完整内联密钥（谨慎）',
    '  --json            机器可读输出',
  ].join('\n');
}

function fail(message, code = 1) {
  console.error(`handoff: ${message}`);
  console.error(usage());
  process.exit(code);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (['force', 'print', 'json', 'help', 'inline-secret', 'show-secret'].includes(key)) {
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

function readJson(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label} 不存在：${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${file} (${error?.message ?? error})`);
  }
}

function readAdapter(id, stateDir) {
  // adapters.json 已整体退役：--adapter 保留为历史别名，实际读登记文件。
  if (fs.existsSync(path.join(stateDir, 'adapters.json'))) {
    throw new Error('adapters.json 已退役（读到即拒载）：请迁移到 state/gateway/services/<id>.json '
      + '后删除该文件，再执行 --service <id>');
  }
  return readService(id, stateDir);
}

function readService(id, stateDir) {
  const file = path.join(servicesDirOf(stateDir), `${id}.json`);
  return readJson(file, '登记文件');
}

/**
 * 凭据解析（只读，不生成）：
 *   secretFile 存在 → 用绝对路径引用（默认形态）；
 *   secret 内联 → 直接内联（登记本来就存了明文，复制过去不新增暴露面）；
 *   secretEnv → 网关进程可能持有该值，但**默认不写进文件**（那等于把环境变量的
 *   秘密固化成磁盘明文）；只有显式 --inline-secret 且环境里确实有值时才内联。
 */
function resolveAuth(entry, { inlineSecret, stateDir }) {
  if (entry.secretFile) {
    const filePath = path.resolve(stateDir, entry.secretFile);
    if (!fs.existsSync(filePath)) throw new Error(`secretFile 指向的文件不存在：${filePath}`);
    return { secretFile: filePath };
  }
  if (typeof entry.secret === 'string' && entry.secret.trim()) {
    return { secret: entry.secret.trim() };
  }
  if (entry.secretEnv) {
    const value = process.env[entry.secretEnv];
    if (inlineSecret && typeof value === 'string' && value.trim().length >= 16) {
      return { secret: value.trim() };
    }
    return {
      authNote: `登记使用 secretEnv=${entry.secretEnv}（网关不落明文）：请在目标仓 gateway.json 里补 secret，`
        + '或用 --inline-secret 在网关侧环境已注入该变量时内联生成。',
    };
  }
  return { authNote: '登记未声明凭据（secret / secretFile / secretEnv 均缺失），目标侧无法完成签名。' };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}

const targetKind = args.adapter ? 'adapter' : (args.service ? 'service' : null);
if (!targetKind) fail('必须指定 --adapter <id> 或 --service <id>');
if (args.adapter && args.service) fail('--adapter 与 --service 只能选一个');
const targetId = String(args.adapter ?? args.service);

let payload;
const stateDir = stateDirOf(args);
try {
  const entry = targetKind === 'adapter' ? readAdapter(targetId, stateDir) : readService(targetId, stateDir);
  const auth = resolveAuth(entry, { inlineSecret: args['inline-secret'] === true, stateDir });
  const doc = buildHandoffDocument({
    kind: targetKind,
    id: targetId,
    url: args['gateway-url'] ?? resolveGatewayBaseUrl({
      host: process.env.GATEWAY_HOST,
      port: process.env.GATEWAY_PORT,
    }),
    transport: 'auto',
    ...auth,
    // secretEnv 走不动时把原因带进文件，对端启动报错时能直接看到症结。
    ...(auth.authNote ? { authNote: auth.authNote } : {}),
  });
  const written = writeHandoff({ stateDir, doc, force: args.force === true });
  payload = {
    ok: true,
    kind: targetKind,
    id: targetId,
    file: written.filePath,
    written: written.written,
    sha256: written.sha256,
    auth: doc.secret ? 'inline' : (doc.secretFile ? 'secretFile' : 'missing'),
    doc,
  };
} catch (error) {
  const message = String(error?.message ?? error);
  if (args.json === true) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else fail(message);
  process.exit(1);
}

if (args.json === true) {
  const printable = args['show-secret'] === true
    ? payload
    : { ...payload, doc: payload.doc.secret ? { ...payload.doc, secret: '***' } : payload.doc };
  console.log(JSON.stringify(printable, null, 2));
  process.exit(0);
}

console.log(`交接文件: ${payload.file}${payload.written ? '' : '（内容一致，未改动）'}`);
console.log(`认证形态: ${payload.auth}${payload.auth === 'inline' ? '（明文，跨机复制）' : payload.auth === 'secretFile' ? '（引用网关侧密钥文件）' : '（缺凭据，见 authNote）'}`);
console.log(`指纹:     sha256:${payload.sha256}…`);
console.log('');
console.log('下一步: 复制到目标仓库根目录并保持文件名 gateway.json，重启目标进程。');
console.log(`        目标仓那份可用 npm run handoff -- ${targetKind === 'adapter' ? '--adapter' : '--service'} ${targetId} --print 对照`);

if (args.print === true) {
  const shown = payload.doc.secret && args['show-secret'] !== true
    ? { ...payload.doc, secret: `${String(payload.doc.secret).slice(0, 4)}…${String(payload.doc.secret).slice(-4)}` }
    : payload.doc;
  console.log('');
  console.log(JSON.stringify(shown, null, 2));
  if (handoffPath({ stateDir, id: targetId }) !== payload.file) {
    console.log('（路径异常：交接文件未落在 handoff/ 下，请检查 state 目录）');
  }
}
