/**
 * 执行层唯一契约（executors 与 runtime 的分界线）。
 *
 * 分层规则（违反任何一条都会被 scripts/test-executor-contract.mjs 拦下）：
 *
 *   1. executor 只 import 本文件（或 node 内置模块），**永不** import
 *      `../core/*`、`../runtime/*` 或其它 executor。第三方服务的存在与否
 *      必须对网关核心完全透明——删掉任何 executor，core 照常收发消息。
 *   2. executor 不感知 HTTP：不碰 req/res、HMAC、幂等表。它收到的 `ctx`
 *      已经由 runtime 鉴权并派生；返回结构化结果，不向上抛异常。
 *   3. executor 的能力由 `actions` 显式声明，runtime 只路由声明过的动作。
 *
 * 将来某 executor 需要独立成进程（多个体、重负载），搬运的只是实现：
 * runtime 对它的调用从函数调用换成 HTTP，`ctx` 形状不变。
 */

export class ExecutorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExecutorError';
    this.code = code;
  }
}

const EXECUTOR_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
// 工具名：统一 chat_* 命名（P3），下划线分词，如 chat_memory_recall。
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;

/** ctx 中 runtime 必须提供的字段；缺任何一个都拒绝执行（fail-closed）。 */
const REQUIRED_CTX = ['sessionKey', 'turnId', 'turnToken'];

/**
 * 工具描述符校验（P3）：executor 除 actions 外还可声明要暴露给模型的工具面。
 * 每个工具必须绑定一个本 executor 已声明的 action；ToolHost 据此把
 * `chat_*` 工具调用路由到 action，MCP 薄壳据此生成 tools/list。
 */
function validateTools(executorName, actions, tools) {
  if (tools === undefined) return [];
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new TypeError(`executor "${executorName}": tools must be a non-empty array when provided`);
  }
  const seen = new Set();
  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object') {
      throw new TypeError(`executor "${executorName}": each tool must be an object`);
    }
    if (typeof tool.name !== 'string' || !TOOL_NAME_RE.test(tool.name)) {
      throw new TypeError(`executor "${executorName}": tool name must match ${TOOL_NAME_RE}, got ${JSON.stringify(tool.name)}`);
    }
    if (seen.has(tool.name)) {
      throw new TypeError(`executor "${executorName}": duplicate tool name "${tool.name}"`);
    }
    seen.add(tool.name);
    if (typeof tool.description !== 'string' || tool.description.length === 0 || tool.description.length > 500) {
      throw new TypeError(`executor "${executorName}": tool "${tool.name}" needs a description (<=500 chars)`);
    }
    if (!tool.action || !actions.includes(tool.action)) {
      throw new TypeError(`executor "${executorName}": tool "${tool.name}" must bind an action declared by this executor`);
    }
    if (!tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) {
      throw new TypeError(`executor "${executorName}": tool "${tool.name}" needs an inputSchema object`);
    }
    return Object.freeze({
      name: tool.name,
      description: tool.description,
      action: tool.action,
      inputSchema: Object.freeze({ ...tool.inputSchema }),
    });
  });
}

export function registerExecutor({ name, actions, call, tools }) {
  if (typeof name !== 'string' || !EXECUTOR_NAME_RE.test(name)) {
    throw new TypeError(`executor name must match ${EXECUTOR_NAME_RE}, got ${JSON.stringify(name)}`);
  }
  if (!Array.isArray(actions) || actions.length === 0 || !actions.every((a) => typeof a === 'string' && a.length > 0)) {
    throw new TypeError(`executor "${name}": actions must be a non-empty array of strings`);
  }
  if (new Set(actions).size !== actions.length) {
    throw new TypeError(`executor "${name}": duplicate action names`);
  }
  if (typeof call !== 'function') {
    throw new TypeError(`executor "${name}": call must be a function`);
  }
  const toolDescriptors = validateTools(name, actions, tools);
  return Object.freeze({ name, actions: Object.freeze([...actions]), call, tools: Object.freeze(toolDescriptors) });
}

export function createExecutorRegistry() {
  /** @type {Map<string, import('./executor-interface.mjs').Executor>} */
  const byName = new Map();
  /** @type {Map<string, string>} action 名 → executor 名 */
  const byAction = new Map();
  /** @type {Map<string, {name, description, action, inputSchema}>} 工具名 → 描述符 */
  const byTool = new Map();

  return {
    add(executor) {
      if (byName.has(executor.name)) {
        throw new ExecutorError('E_INTERNAL', `executor already registered: ${executor.name}`);
      }
      for (const action of executor.actions) {
        const owner = byAction.get(action);
        if (owner) {
          throw new ExecutorError('E_INTERNAL', `action "${action}" already owned by executor "${owner}"`);
        }
      }
      for (const tool of executor.tools ?? []) {
        if (byTool.has(tool.name)) {
          throw new ExecutorError('E_INTERNAL', `tool "${tool.name}" already registered`);
        }
      }
      byName.set(executor.name, executor);
      for (const action of executor.actions) byAction.set(action, executor.name);
      for (const tool of executor.tools ?? []) byTool.set(tool.name, tool);
      return executor;
    },

    has(name) { return byName.has(name); },
    get(name) { return byName.get(name) ?? null; },
    ownerOf(action) { return byAction.get(action) ?? null; },
    list() { return [...byName.values()]; },

    /** 该动作是否有执行者。runtime 据此决定 E_UNSUPPORTED。 */
    supports(action) { return byAction.has(action); },

    /** P3：工具面查询。ToolHost 与 MCP 薄壳都从这里取，不各自维护清单。 */
    actionForTool(tool) { return byTool.get(tool)?.action ?? null; },
    listTools() { return [...byTool.values()].map((tool) => ({ ...tool })); },

    /**
     * 执行一个动作。
     *
     * 失败语义：任何 executor 内部异常都被包装成 `{ok:false, degraded:true}`
     * 返回给 runtime——executor 的问题永远不该炸掉整个 turn。
     * 只有「runtime 自身的错误」（ctx 缺失、动作未注册）才抛 ExecutorError。
     */
    async call(action, ctx) {
      for (const field of REQUIRED_CTX) {
        if (!ctx || typeof ctx[field] !== 'string' || ctx[field].length === 0) {
          throw new ExecutorError('E_INTERNAL', `ctx.${field} is required`);
        }
      }
      const executorName = byAction.get(action);
      if (!executorName) {
        throw new ExecutorError('E_UNSUPPORTED', `no executor for action "${action}"`);
      }
      const executor = byName.get(executorName);
      try {
        const result = await executor.call({ action, ctx });
        if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
          return { ok: false, degraded: true, code: 'E_INTERNAL', message: `executor "${executorName}" returned a non-result` };
        }
        return result;
      } catch (error) {
        return {
          ok: false,
          degraded: true,
          code: typeof error?.code === 'string' ? error.code : 'E_INTERNAL',
          message: String(error?.message ?? error),
        };
      }
    },
  };
}
