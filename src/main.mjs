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
import { loadEnvInto } from './core/env-file.mjs';
import { checkRegistration, resolveDshPatchFile } from './core/dsh-patch.mjs';
import { createServiceRegistry, selectMemoryService } from './core/service-registry.mjs';

// memoryService 布尔旧形态的存量缺省 save 工具（兼容缺省只在此组合根存在；
// 权威形态 = 登记文件 memoryService: { saveTool }，网关 core 无工具名字面量）。
const LEGACY_MEMORY_SAVE_TOOL = 'chat_memory_save';
import { createPipeline, protocolTokenLine } from './core/pipeline.mjs';
import { createTurnStore } from './core/turn-store.mjs';
import { createTokenLedger as createUsageLedger } from './core/usage-ledger.mjs';
import { resolvePriceTable } from './core/prices.mjs';
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
  // .env 装载先于 loadConfig：退役键（GATEWAY_OPERATOR_TOKEN / GATEWAY_MCP_BUS_TOKEN
  // 等残留）的 fail-closed 校验在 loadConfig 里，若后装载则用户 .env 里有残留仍会
  // 先报错。真实环境变量优先（loadEnvInto 只填未定义键），路径可用 GATEWAY_ENV_FILE
  // 覆盖，默认包根 .env。凭据本身是文件单源（operator-token / mcp-bus.secret）。
  const envFile = process.env.GATEWAY_ENV_FILE
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  const envResult = loadEnvInto(process.env, envFile, { logger: (l) => console.warn(`[gateway] ${l}`) });
  const config = loadConfig();
  const logger = (line) => console.log(`[gateway] ${line}`);
  logger(envResult.missing
    ? `env-file 未提供（${envFile}），仅用进程环境变量`
    : `env-file 已装载 ${envResult.loaded} 项（跳过已定义 ${envResult.skipped} 项）: ${envFile}`);
  applyModelOverlay(config, logger);
  // DSH 注册诊断（只读）：工具面开着但 DSH profile 里没有 mcp-bus 条目时，模型看到的
  // 工具清单永远到不了网关。这里只告警不写文件——安装是显式动作（npm run setup:dsh），
  // 因为 DSH 只在启动期读补丁，且那是另一个应用的配置文件。
  if (config.tools?.mode === 'on') {
    const dshPatchFile = resolveDshPatchFile({
      file: process.env.GATEWAY_DSH_PATCH_FILE,
      profile: process.env.GATEWAY_DSH_PROFILE || 'web',
    });
    const registration = checkRegistration(dshPatchFile);
    if (!registration.registered) {
      logger(`警告：DSH 未注册 mcp-bus（${registration.reason}）: ${dshPatchFile}`);
      logger('      工具面当前不可用；运行 `npm run setup:dsh` 后重启 DSH 即可。');
    }
  }

  let runtime = null;
  // V2 P2：服务登记表在外层声明——createGatewayServer 需要它合并 WS 握手身份
  //（runtime 只在 mode=on 装配，off 模式下服务不受理连接）。
  let serviceRegistry = null;
  // P3 管线引擎同理在外层声明——createGatewayServer 需要（/v1/health 数据源 +
  // P4 编排 UI 的步骤名三级解析校验）。
  let pipeline = null;
  // §6 会话缓冲管理器（session-save）同理在外层声明（server/tool-host 的观察点都要引用）。
  let sessionSave = null;
  // V2 WS 动作下行：ws-hub 在 createGatewayServer 内建（晚于 executor 装配），
  // 用晚绑定引用注入投递包装——装配顺序不变，测试里 wsHubRef=null 时自动走 HTTP。
  let wsHubRef = null;

  // ── 服务登记（登记目录 + 台账 + 热加载）────────────────────────────────────
  // 消费端身份的唯一事实源：HTTP 入站验签、WS 握手身份、动作下行、清单拉取、
  // 编排权限门禁全部从这一份视图取。因此只要登记目录已配置就装配——不依附
  // mode/pipeline/tools/memorySave 任何开关：
  //   - mode≠off：入站验签/WS 握手/动作下行都要用（缺了会被 401）；
  //   - mode=off：控制台的登记/卸载/总览仍需它（否则「off 起控制台注册第一个
  //     消费端」的自举路径不通）。入站/WS 在 off 下另有 mode 门禁 503，装配
  //     registry 不改变回滚语义。
  if (config.registrations) {
    serviceRegistry = createServiceRegistry({
      pipelinesFile: config.pipeline.file,
      stateDir: config.stateDir,
      defaultTimeoutMs: config.pipeline.stepTimeoutMs,
      registrations: config.registrations,
      logger,
    });
    logger(`service registry ready: services=${serviceRegistry.services().length} `
      + `registrations=[${serviceRegistry.registrations().map((r) => r.id).join(', ') || '-'}] `
      + `consumers=[${serviceRegistry.consumers().map((c) => c.id).join(', ') || '-'}] `
      + `dir=${config.registrations.dir} reloadMs=${config.registrations.reloadMs}`);
  }

  /**
   * 动作投递（WS 优先 / HTTP 兜底，组合根注入到 executor 与 pendingForwarder）。
   *
   * 语义（与 docs/design/GATEWAY_V2_REFACTOR.md §2 对齐；2026-11-18 起 WS 通道
   * 常驻，GATEWAY_WS 开关已退役，本函数是唯一投递路径）：
   *   - 该适配器有 WS 连接 → 先走帧（帧级签名 + callId 关联）；
   *   - WS 不可用/超时/断开/回执不符 → 回落 HTTP POST /v1/actions（永不因传输层
   *     失败而丢失动作；两条路径共用 prepareAction 的回路链拦截结果，不重复执行）。
   */
  const deliverActionWithWs = async ({ adapter, action, entry, ctx, timeoutMs, returnPipeline = null }) => {
    const prepared = await prepareAction({ adapter, action, entry, ctx, timeoutMs, returnPipeline });
    if (prepared.ok !== true || prepared.suppressed) return prepared;
    const hub = wsHubRef;
    if (hub && hub.isConnected(adapter.id)) {
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

  // ── 消息面运行时：常驻装配（2026-11-16 起）──────────────────────────────────
  // 不再按 mode==='on' 条件装配：mode 已收敛为纯请求期活读门禁（inbound/WS 帧/
  // actions 各路由现场判 config.mode），控制台开关切换即时生效、零重启。off 下
  // 这套运行时空转（DSH 未连接即无任何 IO），装配开销可忽略。控制台切换端点
  // （POST /v1/console/mode）承担原启动期的 fail-closed 校验（消费端非空、
  // 编排键有主、pipeline.validate）。
  {
    const [{ DshClient }, { createSessionRegistry, FALLBACK_PRESET }, { createPromptQueue },
      { createDshGateway }, { createTurnRunner }, { createToolHost }, { createMailbox },
      { createExecutorRegistry },
      { createWebSearchExecutor },
      { createMediaSendExecutor },
      { createAdapterToolsExecutor, fetchAdapterManifest },
      { createSessionSave }] = await Promise.all([
      import('./runtime/dsh-client.mjs'),
      import('./runtime/session-registry.mjs'),
      import('./runtime/prompt-queue.mjs'),
      import('./runtime/dsh-gateway.mjs'),
      import('./runtime/turn-runner.mjs'),
      import('./runtime/tool-host.mjs'),
      import('./runtime/mailbox.mjs'),
      import('./executors/executor-interface.mjs'),
      import('./executors/web-search.mjs'),
      import('./executors/media-send.mjs'),
      import('./executors/adapter-tools/index.mjs'),
      import('./runtime/memory-ingest.mjs'), // createSessionSave：会话缓冲管理器
    ]);
    const dsh = new DshClient({ ...config.dsh, logger });
    // preset 声明来自适配器登记文件（平台知识归适配器）：热注册后即时生效，
    // 网关这边不留任何「qq→某预设」的映射表。
    //
    // 三段会话键（无消费端段）按平台回退：装载器保证「一个平台同时只有一个
    // enabled 的动作接收者」，所以按平台反查至多命中一份声明；多份 = 歧义，不猜。
    const presetsFor = ({ platform, consumerId }) => {
      if (!serviceRegistry) return null;
      if (consumerId) {
        const direct = serviceRegistry.resolveService?.(consumerId);
        if (direct?.presets) return direct.presets;
      }
      if (!platform) return null;
      const candidates = serviceRegistry.services()
        .filter((entry) => entry.kind === 'consumer' && entry.platform === platform && entry.presets);
      return candidates.length === 1 ? candidates[0].presets : null;
    };
    const registry = createSessionRegistry({
      dsh, chat: config.chat, file: config.sessionsFile, logger, presetsFor,
    });
    const queue = createPromptQueue({ logger });
    // pending 平台转发（docs/console/dsh-pending/PLAN.md 第二阶段）：off 时
    // forwarder 不装配（onPending 传 null，pending 仅控制台只读可见）。
    // 消费端清单取登记视图的启动快照：热注册的消费端要重启才参与 pending 转发
    //（转发器持有固定清单，避免每次 pending 都重建）。
    const pendingForwarder = config.pendingForward.mode === 'on'
      ? createPendingForwarder({
        deliver: deliverActionWithWs,
        adapters: serviceRegistry?.consumers().filter((entry) => entry.callbackBase) ?? [],
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
    // ── §6 会话缓冲管理器（session-save，默认 off）────────────────────────────
    // tool.call 统一改造：会话缓冲上移网关——入站（server.handleInbound）+ 出站
    // （tool-host 发送成功点）追加进 <stateDir>/session-buffer/<sessionKey>.jsonl
    // （逐条持久化，崩溃恢复），空闲超时/触顶分段/关停补发时经 tool.call
    // chat_memory_save 整段落地。幂等由服务端 raw UNIQUE(session_id, msg_id)
    // 裁决；失败退避重试、缓冲保留，绝不阻塞主链路。
    if (config.memorySave.mode === 'on') {
      if (config.memorySave.retired?.length) {
        logger(`警告：${config.memorySave.retired.join(' / ')} 已退役（配置更名为 GATEWAY_MEMORY_SAVE*），当前值被忽略`);
      }
      // 目标服务选路（selectMemoryService 二级，2026-11-22 env 显式指定退役）：
      // 唯一声明 memoryService 的登记服务 > 多声明取字典序首个 + 一次性告警。
      // saveTool 按登记能力对象声明动态调用（权威形态 {"saveTool": "..."}）；
      // 布尔旧形态按存量缺省工具处理（LEGACY_MEMORY_SAVE_TOOL，一次性迁移告警）
      // ——网关 src/core 不含具体工具名字面量，字面量只在此处作为兼容缺省存在。
      // 登记可热加载，所以每次 save 现算，不缓存——services() 只是小数组映射。
      let warnedMissing = false;
      const resolveMemoryRoute = () => {
        const route = selectMemoryService(serviceRegistry?.services?.() ?? [], {
          defaultSaveTool: LEGACY_MEMORY_SAVE_TOOL,
          warn: (message) => logger(`警告：${message}`),
        });
        if ((!route?.id || !route?.saveTool) && !warnedMissing) {
          warnedMissing = true;
          logger('警告：未找到可用的记忆登记服务（无 memoryService 声明——在控制台编辑登记声明 memoryService），save 进入退避重试');
        }
        if (route?.id && route?.saveTool) warnedMissing = false;
        return route;
      };
      // 实时媒体登记旁路（媒体管道 v2）：收到含占位符的消息时立即把指导清单
      // 推给 memory 的 chat_media_record（id 幂等 + 三源落盘），让当轮检索可用。
      // 失败静默——save 时 ensureAssets 兜底重试。未装配 memory 服务时 no-op。
      const mediaRecorderRoute = () => resolveMemoryRoute();
      const recordMediaManifest = async (sessionKey, media) => {
        const route = mediaRecorderRoute();
        if (!route?.id) throw new Error('memory service unavailable');
        await serviceRegistry.callServiceTool(route.id, {
          tool: 'chat_media_record',
          args: { sessionId: sessionKey, media },
          sessionKey,
        });
      };
      sessionSave = createSessionSave({
        deliver: async (payload) => {
          const route = resolveMemoryRoute();
          if (!route?.id || !route?.saveTool) {
            throw new Error('memory service unavailable（未找到 memoryService 声明的登记服务或 saveTool）');
          }
          await serviceRegistry.callServiceTool(route.id, {
            tool: route.saveTool,
            args: {
              sessionKey: payload.sessionKey,
              messages: payload.messages,
              partial: payload.partial === true,
            },
            sessionKey: payload.sessionKey,
          });
        },
        mediaRecorder: recordMediaManifest,
        bufferDir: config.memorySave.bufferDir,
        idleMs: config.memorySave.idleMs,
        maxMessages: config.memorySave.maxMessages,
        maxChars: config.memorySave.maxChars,
        logger,
      });
      sessionSave.start();
      const target = 'auto(memoryService 声明)';
      logger(`session-save ready: service=${target} bufferDir=${config.memorySave.bufferDir} `
        + `idleMs=${config.memorySave.idleMs} maxMessages=${config.memorySave.maxMessages} maxChars=${config.memorySave.maxChars}`);
    }
    // 出站动作只有一条路径：模型 → adapter-tools → 适配器 /v1/actions。
    // （platform-actions 已删除：它唯一的用途是回合文本自动投递。）
    // P3 统一工具面：off 时不装（/v1/tools 拿到空清单、tools/call 返回 503）。
    // V2 P3：memory/rolecard 的 chat_memory_* / chat_role_* 工具面改由服务登记
    // 文件声明、经 ToolHost 服务执行器动态路由到所属服务——内置 memory-tools /
    // rolecard-tools executor 已随 P3 转正退役。
    let toolHost = null;
    if (config.tools.mode === 'on') {
      // 清单驱动工具面（adapter-tools）：向每个配了 callbackBase 的消费端拉清单，
      // 统一装配成单个 executor（目录命名空间 chat_<platform>_*）。清单的 enabled 字段
      // 由消费端现算（实现 + 开关），因此工具面里不会出现「注册了但必失败」的动作。
      // 消费端来源 = 登记视图（kind=consumer 且启用）。
      // 单个消费端失败 = 该平台没有工具面（记日志，不阻塞启动）；全部失败 = 不注册。
      // 新平台接入只动 adapter-tools/（平台子文件夹 + index.mjs 注册表一行），本文件不再改。
      const fetched = [];
      for (const adapter of (serviceRegistry?.consumers?.() ?? []).filter((entry) => entry.callbackBase)) {
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
          // 投递载体：WS 优先 / HTTP 兜底（WS 通道常驻，无传输层开关）。
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
      // 多媒体记忆层发送适配（2026-11-24）：chat_media_send 内置工具——平台无关的
      // 媒体引用 → qq 格式转换器（resId 收藏通道/send_image 段/send_voice）→ deliver。
      // memory 未装配 chat_media_get 时跳过注册（宁可缺工具，不放必然失败的占位）。
      {
        const resolveMemoryService = () => {
          const tool = serviceRegistry?.registeredTools?.().find((item) => item.name === 'chat_media_get');
          return tool?.serviceId ?? null;
        };
        if (resolveMemoryService()) {
          const mediaSendExecutor = createMediaSendExecutor({
            adapters: fetched ?? [],
            deliver: deliverActionWithWs,
            resolveMemoryService,
            callServiceTool: (serviceId, request) => serviceRegistry.callServiceTool(serviceId, request),
            logger,
          });
          executorRegistry.add(mediaSendExecutor);
          logger('media-send ready: chat_media_send (built-in adapter)');
        } else {
          logger('media-send skipped: memory-mcp 未装配 chat_media_get');
        }
      }
      // V2 P3 服务执行器：登记工具（chat_memory_* 等）按登记路由到所属服务。
      // 每次调用现读登记表（不缓存）——热加载注册/卸载即刻生效，无需重启。
      const serviceTools = serviceRegistry
        ? {
          resolveTool: (name) => serviceRegistry.registeredTools().find((tool) => tool.name === name) ?? null,
          listTools: () => serviceRegistry.registeredTools().map(({ serviceId, name, description, inputSchema, role, isAgentTool }) => ({
            serviceId, name, description, inputSchema,
            // 2026-11-22 修复：role 必须透传——tool-host 的模型面要按角色过滤
            //（decorator 是管线内部步骤，出现在模型面只会诱发探索式死循环）。
            role,
            // isAgentTool 白名单透传：true 才进 /v1/tools 模型清单，缺省仅网关本地。
            isAgentTool,
          })),
          call: (serviceId, request) => serviceRegistry.callServiceTool(serviceId, request),
        }
        : null;
      toolHost = createToolHost({
        executorRegistry,
        serviceTools,
        memoryIngest: sessionSave,
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
      // 步骤名校验与编排权限校验已从启动期挪到切换点（POST /v1/console/mode
      // 切 on 时执行同一套校验链）——off 启动/零消费端启动不再被编排问题拦住。
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
    // turn 索引：runner（写终态、启动时播种首轮判定）与 HTTP 端点（列表/详情）
    // 必须共用同一实例——同一文件建两份会各写各的内存缓冲并互相覆盖轮转。
    const turnStore = createTurnStore({ file: config.turnsFile, logger });
    const runner = createTurnRunner({
      config, dsh, registry, gateway: dshGateway, queue, executorRegistry,
      pipeline, toolHost, mailbox, logger,
      ledger: usageLedger,
      turns: turnStore,
      // 回合结束 → ws 下行（给适配器释放唤醒防重入标志）。wsHubRef 晚绑定：
      // hub 在 createGatewayServer 内建（晚于此处装配），闭包运行时才解引用。
      notifyTurnEnded: ({ adapterId, payload }) => { wsHubRef?.sendTo?.(adapterId, payload); },
    });
    runtime = {
      submit: (record) => runner.submit(record),
      // HTTP 端点（/v1/turns、控制台列表）复用 runner 的 turn 索引实例。
      turns: turnStore,
      // 退出前把 mailbox 的去抖写落盘：state-store 默认 200ms 合并写，直接
      // process.exit() 会丢掉最后一批游标/水位镜像（P4 里这些是权威副本）。
      stop: async () => {
        await runner.stop();
        // 记忆落库：停掉兜底轮询并把缓冲/重试队列冲干净再退出（丢最后一批 =
        // 那批消息的记忆缺口，幂等语义下重放也补不回来）。
        // 会话缓冲：停掉定时器并关停补发（整段 chat_memory_save）再退出——
        // 丢最后一批 = 那批消息的记忆缺口；flushAll 失败的缓冲留在磁盘，
        // 重启后 recoverFromDisk 恢复定时器继续补发。
        sessionSave?.stop();
        await sessionSave?.flushAll();
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
      // 预设文件层（sim-prompt 编辑/备份/还原）随预设所有权迁到桥接（2026-11-16），
      // runtime 不再注入 presetFiles；控制台的预设面只回显活 DSH 清单。
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
      // 角色卡管理面（2026-11-20，控制台「角色卡」视图的后端）：core 只认注入的
      // handler。owner = 登记里声明了 chat_role_switch 的 resource 服务（唯一管理
      // 写工具，2026-11-21 起 admin_* 全部收敛）；retireAll 供「一键应用（切角色）」
      // 联动——system 内容突变，存量 DSH 会话必须整体退役，下回合全新开始。
      rolecardAdmin: {
        call: (tool, args = {}) => {
          const list = serviceRegistry?.registrations?.() ?? [];
          // 2026-11-21 审计修复：owner 只认 enabled 的 resource 服务——disabled/
          // 停用登记不应被选中（切卡动作打到死服务只会 502）。
          const owner = list.find((r) => r.kind === 'resource' && r.enabled !== false
            && Array.isArray(r.tools) && r.tools.includes('chat_role_switch'))?.id ?? null;
          if (!owner) throw new Error('没有登记 chat_role_switch 的角色卡服务');
          return serviceRegistry.callServiceTool(owner, { tool, args, sessionKey: 'console:rolecard-admin' });
        },
        retireAllSessions: () => registry.retireAll(),
      },
      // V2 P2：/v1/health 的 pipeline 块数据源（管线 off 时为 null，health 显式 mode:off）。
      pipelineStatus: pipeline ? () => pipeline.status() : null,
      usageLedger,
    };
    dshGateway.start();
    // 预设由适配器声明（registration.presets）：启动日志只回显「谁声明了什么」，
    // 网关自己不再持有平台→预设的映射，出问题时看适配器登记文件即可。
    const presetMap = (serviceRegistry?.services() ?? [])
      .filter((entry) => entry.kind === 'consumer' && entry.presets)
      .map((entry) => `${entry.id}:`
        + Object.entries(entry.presets).map(([platform, preset]) => `${platform}=${preset}`).join(','))
      .join(' ') || '(适配器未声明)';
    if (process.env.GATEWAY_CONVERSATIONS) {
      // 变量留着不改不会拦消息，但会让人以为白名单还在网关——把话说死。
      logger('⚠️ GATEWAY_CONVERSATIONS 已废弃且被忽略：号码白名单由适配器负责'
        + '（qq-bridge 的 allow/deny），不在白名单的消息在适配器侧就被拦下');
    }
    logger(`runtime assembled: presets=${presetMap} fallback=${FALLBACK_PRESET}`
      + ` model=${config.chat.provider}/${config.chat.model}`);
    // DSH 侧孤儿会话墓碑 drain（2026-11-23）：上次退役失败/手动编辑遗留的
    // sessionId 在这里统一 retireSession（清 inbox->cancel->archive）。DSH 未
    // 就绪时 registry 内部按墓碑保留重试，不阻塞启动。
    registry.drainTombstones().then(({ drained, remaining }) => {
      if (drained > 0 || remaining > 0) {
        logger(`session-registry: 启动墓碑 drain 完成 — 清理 ${drained}，保留 ${remaining}`);
      }
    }).catch((error) => logger(`session-registry: 启动墓碑 drain 异常：${error?.message ?? error}`));
  }

  // 常驻装配下的可见性：mode≠off 但零消费端 = 消息面武装了也没人能进来
  //（入站 401），显式告警把「黑洞」变显式状态；切 on 的 fail-closed 在控制台端点。
  if (config.mode !== 'off' && (serviceRegistry?.consumers().length ?? 0) === 0) {
    logger('警告：GATEWAY_DATA_PLANE=' + config.mode + ' 但登记目录没有消费端——消息面空转，'
      + '控制台注册消费端（或 npm run secrets:gen）后热加载即自动生效');
  }

  const gateway = createGatewayServer({
    config, logger, runtime, services: serviceRegistry, pipeline, memoryIngest: sessionSave,
    turns: runtime?.turns ?? null,
    // 模式开关的持久化目标：启动时实际装载的 env 文件（GATEWAY_ENV_FILE 或包根 .env）。
    envFile,
  });
  // 装配顺序：registry 先于 ws-hub 建（ws-hub 握手要合并服务身份），这里回挂
  // 连接面——tool.call 的 WS 通道由它提供（HTTP 备用不依赖 ws-hub）。
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
