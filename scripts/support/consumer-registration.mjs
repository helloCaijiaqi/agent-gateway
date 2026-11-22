/**
 * 测试夹具：消费端身份只能来自登记目录（kind=consumer）。
 *
 * 网关已退役 env 单适配器三元组与 adapters.json 兼容读取——测试也必须走同一
 * 条路：往临时 stateDir 的 services/<svc-id>.json 写登记文件，再用真实
 * service-registry 装载。禁止在测试里另造一条身份通道（否则改造不彻底，
 * 且测试会替生产掩盖回归）。
 *
 * 用法：
 *   const stateDir = mkdtempSync(path.join(os.tmpdir(), 'gw-test-'));
 *   const consumer = seedConsumer(stateDir, { platform: 'qq', url: 'http://127.0.0.1:3100', secret: SECRET });
 *   const config = loadConfig({ env: { GATEWAY_DATA_PLANE: 'on', ... }, stateDir });
 *   const services = createConsumerRegistry({ stateDir });
 *   const gateway = createGatewayServer({ config, services });
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServiceRegistry } from '../../src/core/service-registry.mjs';

/** 新消费端 id（与生产同一形态：svc-<12 hex>，只标识实例、与平台解耦）。 */
export function newConsumerId() {
  return `svc-${randomBytes(6).toString('hex')}`;
}

function assertSecret(secret, label) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error(`${label}: secret must be a >=16 char string`);
  }
}

function writeRegistration(stateDir, doc) {
  const dir = path.join(stateDir, 'services');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${doc.id}.json`);
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return file;
}

/**
 * 写一份 kind=consumer 登记文件（默认密钥落 secrets/<id>.secret，与生产同形态）。
 * @returns {{id: string, platform: string, callbackBase: string|null, secret: string,
 *            transport: string, timeoutMs: number|undefined, source: 'registry'}}
 */
export function seedConsumer(stateDir, {
  id,
  name = 'test-consumer',
  platform = 'qq',
  url = null,
  transport = 'auto',
  secret,
  enabled = true,
  inlineSecret = false,
  timeoutMs,
} = {}) {
  assertSecret(secret, 'seedConsumer');
  const consumerId = id ?? newConsumerId();
  if (transport === 'http' && !url) throw new Error('seedConsumer: transport "http" requires url');
  const doc = {
    v: 1, id: consumerId, name, kind: 'consumer', transport, platform, enabled,
  };
  if (url) doc.url = url;
  if (timeoutMs !== undefined) doc.timeoutMs = timeoutMs;
  if (inlineSecret) {
    doc.secret = secret;
  } else {
    const secretsDir = path.join(stateDir, 'secrets');
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.writeFileSync(path.join(secretsDir, `${consumerId}.secret`), `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
    doc.secretFile = `secrets/${consumerId}.secret`;
  }
  writeRegistration(stateDir, doc);
  return {
    id: consumerId,
    platform,
    callbackBase: url,
    secret,
    transport,
    timeoutMs,
    source: 'registry',
  };
}

/**
 * 写一份 kind=resource 登记文件（transport 只有 http；url 必填）。
 */
export function seedResource(stateDir, {
  id,
  name = 'test-resource',
  url,
  secret,
  tools,
  memoryService,
  enabled = true,
  timeoutMs,
} = {}) {
  assertSecret(secret, 'seedResource');
  if (!url) throw new Error('seedResource: url is required (resource transport is http-only)');
  const resourceId = id ?? `res-${randomBytes(6).toString('hex')}`;
  const secretsDir = path.join(stateDir, 'secrets');
  fs.mkdirSync(secretsDir, { recursive: true });
  fs.writeFileSync(path.join(secretsDir, `${resourceId}.secret`), `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
  const doc = {
    v: 1, id: resourceId, name, kind: 'resource', transport: 'http', url, enabled,
    secretFile: `secrets/${resourceId}.secret`,
  };
  if (timeoutMs !== undefined) doc.timeoutMs = timeoutMs;
  if (tools !== undefined) doc.tools = tools;
  if (memoryService !== undefined) doc.memoryService = memoryService;
  writeRegistration(stateDir, doc);
  return { id: resourceId, url, secret, tools };
}

/**
 * 用真实 service-registry 装载 stateDir 下 services/ 的登记（reloadMs=0）。
 * @returns {ReturnType<typeof createServiceRegistry>}
 */
export function createConsumerRegistry({ stateDir, pipelinesFile }) {
  if (!stateDir) throw new Error('createConsumerRegistry: stateDir is required');
  return createServiceRegistry({
    pipelinesFile: pipelinesFile ?? path.join(stateDir, 'pipelines.json'),
    stateDir,
    registrations: {
      dir: path.join(stateDir, 'services'),
      ledgerFile: path.join(stateDir, 'registration-ledger.jsonl'),
      reloadMs: 0,
    },
  });
}

/**
 * 凭据文件单源夹具：网关凭据（operator / mcp-bus）只认 <stateDir>/ 下的文件，
 * env 通道已退役——测试也必须走文件，禁止用 env 键造第二条通道。
 */
export function seedBusSecret(stateDir, value = 'bus-secret-0123456789abcdef') {
  assertSecret(value, 'seedBusSecret');
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'mcp-bus.secret');
  fs.writeFileSync(file, `${value}\n`, { encoding: 'utf8', mode: 0o600 });
  return { file, value };
}

export function seedOperatorToken(stateDir, value = 'op-token-0123456789abcdef') {
  if (typeof value !== 'string' || value.length < 16) {
    throw new Error('seedOperatorToken: token must be a >=16 char string');
  }
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'operator-token');
  fs.writeFileSync(file, `${value}\n`, { encoding: 'utf8', mode: 0o600 });
  return { file, value };
}
