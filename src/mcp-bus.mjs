/**
 * mcp-bus：网关统一工具面的 MCP stdio 薄壳（P3）。
 *
 * 链路：DSH 的 dsh-mcp-client spawn 本进程 → 模型看到的工具 = 网关
 * GET /v1/tools 的清单 → 每次调用转发到 POST /v1/tools/call。
 * 网关侧是 ToolHost（turnToken 校验、频控、预算）+ memory/rolecard executors。
 *
 * 为什么手写最小 MCP 而不是引 @modelcontextprotocol/sdk：
 *   薄壳只需要 4 个方法（initialize / initialized / tools/list / tools/call），
 *   协议就是 newline-delimited JSON-RPC 2.0。少一个依赖 = 少一份供应链面，
 *   与网关「core 零第三方依赖」的原则一致。协议不兼容时改这 150 行即可。
 *
 * turnToken 的注入：executor 声明的 inputSchema 不含 turnToken（那是传输层
 * 凭据，不是工具语义的一部分）；本壳在 tools/list 时给每个工具追加
 * `turnToken` 必填参数，tools/call 时抽出放进请求体。模型侧看到的即
 * 「每个 chat_* 工具都带 turnToken 参数」——与 bridge 的 agentToken 同模式。
 *
 * 签名：与适配器同一 HMAC 格式（ts \n nonce \n sha256(body)），
 * adapterId 固定 'mcp-bus'，共享密钥 GATEWAY_MCP_TOKEN。
 */
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createHttpClient } from './shared/http-client.mjs';

const TOOLS_CACHE_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = '2024-11-05';

function sha256Hex(body) {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function authHeaders(secret, body) {
  const timestamp = Date.now();
  const nonce = randomBytes(12).toString('hex');
  const signature = createHmac('sha256', secret).update(`${timestamp}\n${nonce}\n${sha256Hex(body)}`, 'utf8').digest('hex');
  return {
    'content-type': 'application/json',
    'x-adapter-id': 'mcp-bus',
    'x-timestamp': String(timestamp),
    'x-nonce': nonce,
    'x-signature': `v1=${signature}`,
  };
}

/** 每个代理工具都带 turnToken（必填）：注入 schema，调用时抽出进请求体。 */
export function withTurnToken(tool) {
  const inputSchema = tool?.inputSchema ?? { type: 'object', properties: {} };
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      ...inputSchema,
      properties: {
        ...(inputSchema.properties ?? {}),
        turnToken: {
          type: 'string',
          description: '会话令牌：取最新提示中的【会话令牌】。每次唤醒都会变化，旧值会被拒绝。',
        },
      },
      required: [...new Set([...(inputSchema.required ?? []), 'turnToken'])],
    },
  };
}

export function createMcpBus({ gatewayUrl, secret, requestTimeoutMs = REQUEST_TIMEOUT_MS, logger = () => {} } = {}) {
  const baseUrl = String(gatewayUrl ?? process.env.GATEWAY_URL ?? 'http://127.0.0.1:7190').replace(/\/+$/, '');
  const sharedSecret = String(secret ?? process.env.GATEWAY_MCP_TOKEN ?? '');
  const http = createHttpClient({
    baseUrl,
    timeoutMs: requestTimeoutMs,
    sign: ({ body }) => authHeaders(sharedSecret, body),
  });
  let toolsCache = { tools: null, at: 0 };

  async function gatewayRequest(method, pathname, body) {
    const res = await http.request(method, pathname, body);
    if (!res.ok) {
      throw new Error(res.status === 0
        ? `gateway ${pathname} (${res.error})`
        : `gateway ${pathname} -> HTTP ${res.status}${res.body?.error ? ` (${res.body.error.code}: ${res.body.error.message})` : ''}`);
    }
    return res.body;
  }

  async function listTools() {
    if (toolsCache.tools && Date.now() - toolsCache.at < TOOLS_CACHE_TTL_MS) return toolsCache.tools;
    const data = await gatewayRequest('GET', '/v1/tools');
    const tools = (Array.isArray(data?.tools) ? data.tools : []).map(withTurnToken);
    toolsCache = { tools, at: Date.now() };
    return tools;
  }

  async function callTool(name, args = {}) {
    const { turnToken, ...rest } = args;
    const body = {
      v: 1,
      callId: `call_${randomUUID()}`,
      tool: name,
      args: rest,
      turnToken: String(turnToken ?? ''),
    };
    return gatewayRequest('POST', '/v1/tools/call', body);
  }

  /** 处理一条 JSON-RPC 请求（一行）。返回响应对象；通知返回 null。 */
  async function handleMessage(message) {
    if (!message || typeof message !== 'object' || typeof message.method !== 'string') {
      return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;
    try {
      if (method === 'initialize') {
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'agent-gateway-mcp-bus', version: '0.1.0' },
          },
        };
      }
      if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
        return null;
      }
      if (method === 'ping') {
        return isNotification ? null : { jsonrpc: '2.0', id, result: {} };
      }
      if (method === 'tools/list') {
        return { jsonrpc: '2.0', id, result: { tools: await listTools() } };
      }
      if (method === 'tools/call') {
        const name = String(params?.name ?? '');
        const args = (params?.arguments && typeof params.arguments === 'object') ? params.arguments : {};
        let payload;
        try {
          payload = await callTool(name, args);
        } catch (error) {
          payload = { ok: false, error: { code: 'E_DSH_DOWN', message: String(error?.message ?? error) } };
        }
        return {
          jsonrpc: '2.0', id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(payload) }],
            isError: payload?.ok !== true,
          },
        };
      }
      return isNotification
        ? null
        : { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    } catch (error) {
      logger(`mcp-bus: ${method} failed: ${error?.message ?? error}`);
      return isNotification
        ? null
        : { jsonrpc: '2.0', id, error: { code: -32603, message: String(error?.message ?? error) } };
    }
  }

  return { handleMessage, listTools, callTool, baseUrl };
}

/** CLI 入口：stdin 逐行读 JSON-RPC，stdout 逐行写响应。 */
export async function main() {
  // 配置来源：命令行（dsh-mcp-client 的 args 字段，setup-dsh.mjs 写入）优先，
  // 环境变量兜底——dsh-mcp-client 不保证透传环境变量，args 是可靠通道。
  const argValue = (name) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const gatewayUrl = argValue('--gateway-url') ?? process.env.GATEWAY_URL;
  const tokenFile = argValue('--token-file') ?? process.env.GATEWAY_MCP_TOKEN_FILE;
  let secret = process.env.GATEWAY_MCP_TOKEN ?? '';
  if (!secret && tokenFile) {
    try { secret = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { /* 下面统一报错 */ }
  }
  if (!secret || secret.length < 16) {
    console.error('[mcp-bus] shared token missing or too short (>=16 chars); pass --token-file <path> or GATEWAY_MCP_TOKEN');
    process.exit(1);
  }
  const bus = createMcpBus({ gatewayUrl, secret, logger: (line) => console.error(`[mcp-bus] ${line}`) });
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      const response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
      process.stdout.write(`${JSON.stringify(response)}\n`);
      return;
    }
    bus.handleMessage(message).then((response) => {
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }, (error) => {
      const response = { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32603, message: String(error?.message ?? error) } };
      process.stdout.write(`${JSON.stringify(response)}\n`);
    });
  });
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`[mcp-bus] fatal: ${error?.stack ?? error}`);
    process.exit(1);
  });
}
