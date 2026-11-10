/**
 * 进程入口 = 组合根（composition root）。
 *
 * 这里是**唯一**允许同时 import core / runtime / executors / context 的地方：
 * 只有它知道「有哪些第三方服务、要装配哪些 section」。
 *
 * 之所以从 `core/server.mjs` 搬出来：分层边界检查要求 `src/core/` 源码里不出现
 * executors/context 的路径与 memory/rolecard 字样——core 只认 HTTP 契约与注入的
 * handler，装配属于本文件。`npm start` 指向这里。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGatewayServer } from './core/server.mjs';
import { configSummary, loadConfig } from './core/config.mjs';
import { createServiceRegistry } from './core/service-registry.mjs';
import { createPipeline } from './core/pipeline.mjs';
import { createTokenLedger as createUsageLedger } from './core/usage-ledger.mjs';
import { resolvePriceTable } from './core/prices.mjs';
import {
  describePreset, readSimPrompt, writeSimPrompt, listPresetBackups, restorePresetBackup,
} from './runtime/preset-files.mjs';
import { createPendingForwarder } from './runtime/pending-forwarder.mjs';
import { PENDING_CAPACITY } from './runtime/dsh-gateway.mjs';
import { deliverAction, deliverActionViaWs, prepareAction } from './executors/adapter-tools/common/transport.mjs';

// DeepSeek provider 明确支持的取值（dsh-llm-deepseek；'off' 虽合法但 QQ 聊天依赖
// 思考，控制台不提供该档）。活 DSH 的 modelCatalog 优先于此兜底。
const FALLBACK_EFFORTS = ['low', 'high', 'max'];

/** 启动时应用控制台保存的模型覆盖（PUT /v1/console/dsh/model 的落盘）。 */
function applyModelOverlay(config, logger) {
  try {
    const file = path.join(config.stateDir, 'model-overlay.json');
    if (!fs.existsSync(file)) return;
    const overlay = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof overlay?.model === 'string' && overlay.model) config.chat.model = overlay.model;
    if (typeof overlay?.reasoningEffort === 'string' && overlay.reasoningEffort) {
      config.chat.reasoningEffort = overlay.reasoningEffort;
    }
    logger(`model overlay applied: ${config.chat.model} effort=${config.chat.reasoningEffort}`);
  } catch (error) {
    logger(`model overlay ignored: ${error?.message ?? error}`);
  }
}

function persistModelOverlay(config, next, logger) {
  const file = path.join(config.stateDir, 'model-overlay.json');
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    logger(`model overlay persist failed: ${error?.message ?? error}`);
    throw error;
  }
}

export async function main() {
  const config = loadConfig();
  const logger = (line) => console.log(`[gateway] ${line}`);
  applyModelOverlay(config, logger);

  let runtime = null;
  // V2 P2：服务登记表在外层声明——createGatewayServer 需要它合并 WS 握手身份
  //（runtime 只在 mode=on 装配，off 模式下服务不受理连接）。
  let serviceRegistry = null;
  // P3 管线引擎同理在外层声明——createGatewayServer 需要（/v1/health 数据源 +
  // P4 编排 UI 的步骤名三级解析校验）。
  let pipeline = null;
  // §6 记忆落库调度器同理在外层声明（server/tool-host 的观察点都要引用）。
  let memoryIngest = null;
  // V2 WS 动作下行：ws-hub 在 createGatewayServer 内建（晚于 executor 装配），
  // 用晚绑定引用注入投递包装——装配顺序不变，测试里 wsHubRef=null 时自动走 HTTP。
  let wsHubRef = null;

  /**
   * 动作投递（HTTP / WS 双栈，组合根注入到 executor 与 pendingForwarder）。
   *
   * 语义（与 docs/design/GATEWAY_V2_REFACTOR.md §2 对齐）：
   *   - GATEWAY_WS=on 且该适配器有 WS 连接 → 先走帧（帧级签名 + callId 关联）；
   *   - WS 不可用/超时/断开/回执不符 → 回落 HTTP POST /v1/actions（永不因传输层
   *     失败而丢失动作；两条路径共用 prepareAction 的回路链拦截结果，不重复执行）；
   *   - GATEWAY_WS=off → 行为与旧版完全一致（纯 HTTP）。
   */
  const deliverActionWithWs = async ({ adapter, action, entry, ctx, timeoutMs, returnPipeline = null }) => {
    const prepared = await prepareAction({ adapter, action, entry, ctx, timeoutMs, returnPipeline });
    if (prepared.ok !== true || prepared.suppressed) return prepared;
    const hub = wsHubRef;
    if (config.ws?.mode === 'on' && hub && hub.isConnected(adapter.id)) {
      const viaWs = await deliverActionViaWs({
        wsHub: hub,
        adapter,
        envelope: prepared.envelope,
        timeoutMs: prepared.timeoutMs,
      });
      if (viaWs.ok) return viaWs;
      logger(`action ws delivery failed (${adapter.id}): ${viaWs.code ?? 'E_PLATFORM'} ${viaWs.message ?? ''} — falling back to HTTP`);
    }
    return deliverAction({ adapter, action, entry, ctx, timeoutMs, prepared });
  };

  if (config.mode === 'on') {
    const [{ DshClient }, { createSessionRegistry }, { createPromptQueue },
      { createDshGateway }, { createTurnRunner }, { createToolHost }, { createMailbox },
      { createExecutorRegistry },
      { createWebSearchExecutor },
      { createAdapterToolsExecutor, fetchAdapterManifest },
      { createMemoryIngest }, { createHttpClient }] = await Promise.all([
      import('./runtime/dsh-client.mjs'),
      import('./runtime/session-registry.mjs'),
      import('./runtime/prompt-queue.mjs'),
      import('./runtime/dsh-gateway.mjs'),
      import('./runtime/turn-runner.mjs'),
      import('./runtime/tool-host.mjs'),
      import('./runtime/mailbox.mjs'),
      import('./executors/executor-interface.mjs'),
      import('./executors/web-search.mjs'),
      import('./executors/adapter-tools/index.mjs'),
      import('./runtime/memory-ingest.mjs'),
      import('./shared/http-client.mjs'),
    ]);
    const dsh = new DshClient({ ...config.dsh, logger });
    const registry = createSessionRegistry({ dsh, chat: config.chat, file: config.sessionsFile, logger });
    const queue = createPromptQueue({ logger });
    // pending 平台转发（docs/console/dsh-pending/PLAN.md 第二阶段）：off 时
    // forwarder 不装配（onPending 传 null，pending 仅控制台只读可见）。
    const pendingForwarder = config.pendingForward.mode === 'on'
      ? createPendingForwarder({
        deliver: deliverActionWithWs,
        adapters: config.adapters.filter((entry) => entry.callbackBase),
        registry,
        timeoutMs: config.pendingForward.timeoutMs,
        logger,
      })
      : null;
    const dshGateway = createDshGateway({
      dsh, turnTimeoutMs: config.chat.turnTimeoutMs, logger,
      onPending: pendingForwarder ? (entry) => pendingForwarder.forward(entry) : null,
    });
    const executorRegistry = createExecutorRegistry();
    // ── §6 记忆落库调度器（双向自动沉淀，默认 off）────────────────────────────
    // 入站（server.handleInbound）+ 出站（tool-host 发送成功点）→ 按会话/时间窗
    // 聚合 → 逐条 POST memory-mcp /api/memory/ingest（raw 全量落地；会话纪元模型
    // 下长期记忆只由摘要与 record 产生，聊天消息不再进 memory 表）；幂等由服务端
    // raw 表 UNIQUE(session_id, msg_id) 裁决；失败重试本地缓冲，绝不阻塞主链路。
    // 出站投递走统一 HTTP 客户端（x-mcp-token 通道，非登记 HMAC 通道）。
    if (config.memoryIngest.mode === 'on') {
      const memoryHttp = createHttpClient({ baseUrl: config.memoryIngest.url, timeoutMs: 5000, logger });
      memoryIngest = createMemoryIngest({
        deliver: async (record) => {
          const result = await memoryHttp.post('/api/memory/ingest', {
            sessionId: record.sessionId,
            msgId: record.msgId,
            text: record.text,
            senderId: record.senderId,
            kind: record.kind,
            createdAt: record.createdAt,
          }, { headers: { 'x-mcp-token': config.memoryIngest.token } });
          if (!result.ok) throw new Error(result.error ?? `HTTP ${result.status}`);
        },
        windowMs: config.memoryIngest.windowMs,
        maxBatch: config.memoryIngest.maxBatch,
        logger,
      });
      memoryIngest.start();
      logger(`memory ingest ready: url=${config.memoryIngest.url} windowMs=${config.memoryIngest.windowMs} batch=${config.memoryIngest.maxBatch}`);
    }
    // 出站动作只有一条路径：模型 → adapter-tools → 适配器 /v1/actions。
    // （platform-actions 已删除：它唯一的用途是回合文本自动投递。）
    // P3 统一工具面：off 时不装（/v1/tools 拿到空清单、tools/call 返回 503）。
    // V2 P3：memory/rolecard 的 chat_memory_* / chat_role_* 工具面改由服务登记
    // 文件声明、经 ToolHost 服务执行器动态路由到所属服务——内置 memory-tools /
    // rolecard-tools executor 已随 P3 转正退役。
    let toolHost = null;
    if (config.tools.mode === 'on') {
      // 清单驱动工具面（adapter-tools）：向每个配了 callbackBase 的适配器拉清单，
      // 统一装配成单个 executor（目录命名空间 chat_<platform>_*）。清单的 enabled 字段
      // 由适配器现算（实现 + 开关），因此工具面里不会出现「注册了但必失败」的动作。
      // 单个适配器失败 = 该平台没有工具面（记日志，不阻塞启动）；全部失败 = 不注册。
      // 新平台接入只动 adapter-tools/（平台子文件夹 + index.mjs 注册表一行），本文件不再改。
      const fetched = [];
      for (const adapter of config.adapters.filter((entry) => entry.callbackBase)) {
        try {
          fetched.push({
            adapter,
            manifest: await fetchAdapterManifest({
              adapter,
              timeoutMs: config.tools.manifestTimeoutMs,
              logger,
            }),
          });
        } catch (error) {
          logger(`adapter tools skipped (${adapter.id}): ${error?.message ?? error}`);
        }
      }
      if (fetched.length > 0) {
        const adapterTools = createAdapterToolsExecutor({
          adapters: fetched,
          logger,
          // 投递载体：WS 优先 / HTTP 兜底（GATEWAY_WS=off 时等价于 deliverAction）。
          deliver: deliverActionWithWs,
          // P5 回路链：发送动作外发文本在 POST /v1/actions 前过 returnPipelines
          //（deliverAction 拦截点：drop 拦截 / 改写 / fail-safe 原文照发）。
          // pipeline 为 null（GATEWAY_PIPELINE=off 回滚）时钩子缺省不拦截。
          returnPipeline: pipeline
            ? async ({ consumerId, sessionKey, turnId, text }) => {
                const result = await pipeline.runReturn({ consumerId, sessionKey, turnId, text });
                if (result.ok === false) {
                  logger(`return pipeline error (${consumerId}): ${result.error ?? 'unknown'} — deliver original`);
                  return { verdict: 'pass', text };
                }
                if (result.verdict === 'drop') {
                  logger(`return pipeline (${consumerId}) dropped outbound text (${text.length}c)${result.reason ? `: ${result.reason}` : ''}`);
                } else if (result.text !== text) {
                  logger(`return pipeline (${consumerId}) rewrote outbound text: ${text.length}c -> ${result.text.length}c`);
                }
                return { verdict: result.verdict, text: result.text, degraded: result.degraded };
              }
            : null,
        });
        executorRegistry.add(adapterTools);
        logger(`adapter tools ready: ${adapterTools.tools.length} tools across ${fetched.length} adapter(s)`);
      }
      // 阶段 3：联网搜索收编（内置清单能力，非适配器来源）。凭据缺失 = 跳过注册
      // （宁可缺工具），模型工具面不会出现一个必然失败的 chat_web_search。
      if (config.webSearch.mode === 'on') {
        try {
          const webSearchExecutor = createWebSearchExecutor({
            timeoutMs: config.webSearch.timeoutMs,
            logger,
          });
          executorRegistry.add(webSearchExecutor);
          logger('web-search ready: chat_web_search (provider=deepseek, built-in manifest)');
        } catch (error) {
          logger(`web-search skipped: ${error?.message ?? error}`);
        }
      }
      // V2 P3 服务执行器：登记工具（chat_memory_* 等）按登记路由到所属服务。
      // 每次调用现读登记表（不缓存）——热加载注册/卸载即刻生效，无需重启。
      const serviceTools = serviceRegistry
        ? {
          resolveTool: (name) => serviceRegistry.registeredTools().find((tool) => tool.name === name) ?? null,
          listTools: () => serviceRegistry.registeredTools().map(({ serviceId, name, description, inputSchema }) => ({
            serviceId, name, description, inputSchema,
          })),
          call: (serviceId, request) => serviceRegistry.callServiceTool(serviceId, request),
        }
        : null;
      toolHost = createToolHost({
        executorRegistry,
        serviceTools,
        memoryIngest,
        logger,
        maxCallsPerTurn: config.tools.maxCallsPerTurn,
        callTimeoutMs: config.tools.callTimeoutMs,
      });
      logger(`tool host ready: ${toolHost.listTools().map((tool) => tool.name).join(', ')}`);
    }
    // ── V2 P3 管线（拼装唯一路径；GATEWAY_PIPELINE=off = prompt 透传）──────────
    // 内置步骤只剩 protocol（会话令牌强制殿后注入，安全凭据永不外委）。
    // persona/记忆等装饰能力由登记的装饰器服务承载（管线步骤写装饰器角色的
    // 工具名，如 chat_role_render / chat_memory_recall）；快照/时间段等旧内置
    // section 已随 P3 转正退役，同类能力由外部装饰器服务按需补齐。
    if (config.pipeline.mode === 'on' || config.tools.mode === 'on') {
      // 外部装饰器/过滤器服务登记（登记目录）：目录缺失 = 只有内置步骤，不算错。
      // V2 P3：登记装载（登记目录 + 台账 + 热加载）随 registry 启用——工具面
      // 动态路由（GATEWAY_TOOLS=on）也依赖它，所以两个开关任一开启即装配。
      serviceRegistry = createServiceRegistry({
        pipelinesFile: config.pipeline.file,
        stateDir: config.stateDir,
        reservedIds: config.adapters.map((entry) => entry.id),
        // 既有消费端（过渡期身份来源）：登记目录 kind=consumer 的服务注册后
        // 同样拥有编排权限（P3 门禁见 service-registry.pipelineFor）。
        consumerIds: config.adapters.map((entry) => entry.id),
        defaultTimeoutMs: config.pipeline.stepTimeoutMs,
        registrations: config.registrations,
        logger,
      });
      logger(`service registry ready: services=${serviceRegistry.services().length} `
        + `registrations=[${serviceRegistry.registrations().map((r) => r.id).join(', ') || '-'}] `
        + `dir=${config.registrations.dir} reloadMs=${config.registrations.reloadMs}`);
    }
    if (config.pipeline.mode === 'on') {
      // 内置步骤（不变量 §5.2）：protocol 只补会话令牌行——消息本体由管线 text
      // 承载；令牌是安全凭据，由 pipeline.mjs 强制殿后且不可被编排移除。
      pipeline = createPipeline({
        registry: serviceRegistry,
        builtinSteps: {
          protocol: {
            name: 'protocol',
            priority: 100,
            build: ({ deps }) => (deps?.turnToken ? { text: protocolTokenLine(deps.turnToken) } : null),
          },
        },
        budgetChars: config.pipeline.budgetChars,
        logger,
      });
      // 编排错误挡在启动阶段（fail-closed）：步骤名必须内置或已登记；
      // 编排权限（P3）：管线键必须对应消费端身份（登记 consumer 或既有 adapter）。
      pipeline.validate(config.adapters.map((entry) => entry.id));
      serviceRegistry.assertPipelinePermissions();
      logger(`pipeline ready: budget=${config.pipeline.budgetChars} file=${config.pipeline.file} pipelines=[${serviceRegistry.pipelineKeys().join(', ')}]`);
    } else {
      // 回滚通道（GATEWAY_PIPELINE=off）：prompt 原样透传（P3 起无旧 assembler，
      // 装饰能力随管线一起停用——回滚 = 回到「适配器说什么就发什么」）。
      logger('pipeline OFF: prompt passthrough (rollback channel; decorators disabled)');
    }
    // P4 会话状态：off 时不装 mailbox（/v1/state* 已在路由层 503）。
    let mailbox = null;
    if (config.state.mode === 'on') {
      mailbox = createMailbox({ file: config.state.file, logger });
      logger(`mailbox ready: file=${config.state.file}`);
    }
    // usage-billing：账本进程内直挂 turn 终态（无轮询），价目表随 config.pricing 可覆盖。
    const usageLedger = createUsageLedger({
      file: path.join(config.stateDir, 'usage-ledger.jsonl'),
      priceTable: resolvePriceTable(config.pricing),
      // 选项名是 log（不是 logger）：写错的话账本的所有告警都被静默丢弃，
      // 且 createTokenLedger 的默认值是空函数，不会报错。
      log: logger,
    });
    const runner = createTurnRunner({
      config, dsh, registry, gateway: dshGateway, queue, executorRegistry,
      pipeline, toolHost, mailbox, logger,
      ledger: usageLedger,
    });
    runtime = {
      submit: (record) => runner.submit(record),
      // 退出前把 mailbox 的去抖写落盘：state-store 默认 200ms 合并写，直接
      // process.exit() 会丢掉最后一批游标/水位镜像（P4 里这些是权威副本）。
      stop: async () => {
        await runner.stop();
        // 记忆落库：停掉兜底轮询并把缓冲/重试队列冲干净再退出（丢最后一批 =
        // 那批消息的记忆缺口，幂等语义下重放也补不回来）。
        memoryIngest?.stop();
        await memoryIngest?.flushAll();
        // pending 转发的重试定时器：不清的话关停后还会再投一次（且挂住事件循环）。
        pendingForwarder?.close();
        mailbox?.close();
      },
      status: () => runner.status(),
      get connected() { return dsh.connected; },
      // P3：core 只做转发路由，工具 handler 由 runtime 注入（core 不知道工具存在）。
      toolCall: (parsed) => (toolHost
        ? toolHost.handle(parsed)
        : Promise.resolve({ ok: false, error: { code: 'E_DISABLED', message: 'tool host not assembled' } })),
      toolList: () => toolHost?.listTools() ?? [],
      toolStatus: () => toolHost?.status() ?? { liveTurns: 0, tools: [] },
      // P4：状态查询/更新同样走注入（mailbox 持有持久化，runtime 暴露读视图）。
      stateGet: (sessionKey) => mailbox?.snapshot(sessionKey) ?? null,
      stateList: () => mailbox?.list() ?? [],
      stateUpdate: (parsed) => (mailbox
        ? Promise.resolve(mailbox.update(parsed))
        : Promise.resolve({ ok: false, error: { code: 'E_DISABLED', message: 'mailbox not assembled' } })),
      stateStats: () => mailbox?.stats() ?? { sessions: 0 },
      // 控制台 DSH 面（docs/console/dsh-presets、dsh-sessions）：core 只认注入
      // 的 handler；清单/目录走活 DSH，chat 是 registry 正在用的同一对象引用
      // （PUT 改它即对下一轮 inbound 生效，registry 每 turn 都会重新 selectModel）。
      consoleDsh: (() => {
        let modelEpoch = 0;
        return {
          presetsList: (signal) => dsh.listPresets(signal),
          modelCatalog: (signal) => dsh.modelCatalog(signal),
          chat: config.chat,
          registry,
          fallbackEfforts: FALLBACK_EFFORTS,
          get epoch() { return modelEpoch; },
          persistModelOverlay: (next) => {
            persistModelOverlay(config, next, logger);
            modelEpoch += 1;
          },
        };
      })(),
      presetFiles: { describePreset, readSimPrompt, writeSimPrompt, listPresetBackups, restorePresetBackup },
      // pending 查看（docs/console/dsh-pending）：只读快照 + 容量 + 转发状态；
      // respond 是应答阶段装配——操作者显式处置才调 $events/result，成功才出列，
      // 失败保留条目以便重试（红线：无任何自动应答路径）。
      pending: {
        list: (filter) => dshGateway.listPending(filter),
        capacity: PENDING_CAPACITY,
        forward: pendingForwarder ? pendingForwarder.stats() : { mode: 'off' },
        respond: async (eventId, outcome, { signal } = {}) => {
          const entry = dshGateway.pendingEntry(eventId);
          if (!entry) return null;
          if (!entry.clientId) {
            throw new Error('pending entry has no $events clientId (cannot respond)');
          }
          await dsh.respondEvent({ clientId: entry.clientId, eventId: entry.eventId, outcome }, signal);
          dshGateway.removePending(eventId);
          return entry;
        },
        entry: (eventId) => dshGateway.pendingEntry(eventId),
      },
      // V2 P2：/v1/health 的 pipeline 块数据源（管线 off 时为 null，health 显式 mode:off）。
      pipelineStatus: pipeline ? () => pipeline.status() : null,
      usageLedger,
    };
    dshGateway.start();
    logger(`runtime assembled: preset=${config.chat.preset} model=${config.chat.provider}/${config.chat.model} whitelisted=${config.conversations.length}`);
  }

  const gateway = createGatewayServer({ config, logger, runtime, services: serviceRegistry, pipeline, memoryIngest });
  // 装配顺序：registry 先于 ws-hub 建（ws-hub 握手要合并服务身份），这里回挂
  // 连接面——service.call 的 WS 通道由它提供（HTTP 备用不依赖 ws-hub）。
  serviceRegistry?.attachWs(gateway.ws);
  // 动作下行同理：executor 装配早于 ws-hub，晚绑定引用在这里补上（listen 之后
  // 才会有连接，因此不存在「装配完成前漏投」的窗口）。
  wsHubRef = gateway.ws ?? null;
  await gateway.listen();
  logger(`ready: ${JSON.stringify(configSummary(config))}`);
  const shutdown = (signal) => {
    logger(`received ${signal}, shutting down`);
    serviceRegistry?.stop(); // 登记热加载轮询（unref 过，防御性显式清理）
    gateway.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`[gateway] fatal: ${error?.stack ?? error}`);
    process.exit(1);
  });
}
