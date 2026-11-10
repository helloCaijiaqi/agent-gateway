# GATEWAY V2 重构计划：消费者 / 装饰器 / 过滤器 / WebSocket

> 状态：P1–P5 已全部落地（2026-11-09） ｜ 本文档是重构总纲，替代「adapter 中心」的旧叙事。
> 旧概念对照：adapters.json → consumers.json（过渡期兼容读）；适配器 → 消费者；
> context-assembler → 装饰器链；GATEWAY_CONTEXT 开关 → 退场。

## 1. 核心概念（v2 词典）

| 概念 | 定义 | 取代 |
|---|---|---|
| **消费者（consumer）** | 网关眼中「消息的去向/来源」。可以是平台（qq-bridge），也可以是一条路由；**网关不知道也不关心谁在消费** | 适配器（定义过窄） |
| **装饰器（decorator）** | 消息工厂：恰好一个消息入口 + 一个出口，出口消息是入口消息的**增强版**（如 memory 拼回忆、rolecard 拼人格） | context-assembler 的 section |
| **过滤器（filter）** | 消息工厂：恰好一个入口 + 一个出口，出口是入口消息、改写后的消息，或**丢弃判定** | 无（新增） |
| **通路（forward）** | 消费者发消息：consumer → 网关 →（过滤器→装饰器链）→ DSH prompt | inbound + context 拼装 |
| **回路（return）** | 消费者收消息：DSH 产出 → 网关 →（回路链）→ 消费者 | turn 结果/出站动作回投 |
| **管线（pipeline）** | 每个消费者可编排的通路/回路步骤序列；先以配置文件表达，后由 UI 编排 | GATEWAY_CONTEXT 单一拼装 |

**生效区间**：装饰器/过滤器只作用于「网关 ↔ DSH」之间的消息。消费者看到的入站信封、
DSH 看到的事件流协议不变。

**工具调用路径不变且必须经网关**：memory/rolecard 本身仍是可调用的 MCP 服务
（`chat_memory_*` 等模型侧工具保留），DSH 经 mcp-bus → 网关 `/v1/tools/call` 调用，
**不允许绕过网关直连**——这条路径是审计与限流的唯一卡点。

## 2. 客户端连接层：WebSocket 为主、HTTP 备用

qq-bridge 通讯频繁（入站、动作回执、状态镜像），HTTP 逐请求 HMAC 握手开销大。
v2 的客户端协议：

- **网关起 WS 端点**（`/v1/ws`）：消费者与装饰器/过滤器服务都以客户端身份连入；
- **握手鉴权**：复用现有 HMAC v1 格式（`ts + "\n" + nonce + "\n" + sha256(body)`，
  握手 body 为空串），query 传 `adapterId/ts/nonce/sign`，nonce 防重放沿用；
- **帧协议**：JSON 文本帧，`{ v:1, type, ... }`；`inbound` → `inbound/ack`；
  网关下行的 `action`（出站投递）与 `service.call`（装饰器/过滤器调用）共用连接；
  心跳 `ping/pong`，断线由客户端重连（幂等键兜底，消息不丢不重）；
- **HTTP 全部保留为备用**：`/v1/inbound`、`/v1/actions` 回投等不动；
  消费者按 `transport` 声明走哪条（`http` / `ws` / `auto`）。

实现约束（2026-11-06 修订）：**协议一律走库，不手写帧**——WS 服务端在
`src/core/ws-hub.mjs` 基于 `ws` 包实现（此前为手写 RFC6455 最小实现，
按「连接协议共有工具库」决定替换，保持 API 面与帧语义不变）；
HTTP 出站一律走 `src/shared/http-client.mjs`（axios 薄封装）。
`test-layering` 对 core 的依赖白名单同步放宽（node:/zod/ws/同目录）。

**落地状态（2026-11-09）**：

- `inbound` 上行：qq-bridge `gateway-client.js` 已实现 WS 连接器（握手签名/重连退避/
  ping-pong/ack FIFO 关联），`transport = http|ws|auto`（默认 http）。语义互斥：
  `ws` = 强制（失败如实失败，不回落，用于验证真链路）；`auto` = WS 优先 + 回落 HTTP
  （连续 3 次失败熔断 2 分钟）；`E_DISABLED`（网关 mode=off）视为网关拒绝，不重投。
- `action` 下行：ws-hub 新增 `callAction`（帧 `{v:1,type:'action',callId,envelope,sign}`，
  回 `action/result`，pendingCalls 按 kind 隔离）。动作帧带**帧级签名**（与
  `POST /v1/actions` 同公式），桥接 `gateway-actions.handleFrame` 验签后复用同一实例执行
  （receipts 幂等共享）。网关侧组合根（`main.mjs`）注入 WS 优先/HTTP 兜底的投递包装，
  失败的语义统一为 degraded。
- 装饰器/过滤器服务：memory-mcp / rolecard-mcp 已实现 `ws-connector.js`（同形副本，
  两仓不引共享包），收 `service.call`/`tool.call` 帧后调 `gateway-v1.invoke`（与 HTTP
  入口同一组处理函数，业务零改动）。帧不带逐帧签名——握手即鉴权（与 action 帧的
  风险级别不同，刻意分层）。
- **部署前提（缺一即 401）**：`GATEWAY_WS=on` + `adapters.json` 已登记该 adapterId +
  secret 两侧一致；`callbackBase` 保留（auto 兜底仍走 `POST /v1/actions`）。

**2026-11-09 评审收口（与实现同步）**：

- `inbound/ack` 新增 **`callId` 回带**：客户端生成 UUID，网关原样回带；客户端按
  `callId` 精确结算，迟到/重复 ack 直接丢弃。旧网关不回带时客户端退回 FIFO（灰度兼容）；
  一旦出现过超时且尚未见过带 callId 的 ack，客户端整体作废剩余请求并回落 HTTP
  （幂等键去重），不再让迟到 ack 结算到下一个请求。
- ack 同时回带 `adapterId`（握手身份）：客户端可发现「ack 来自别的连接 / 别的消费者」。
  入站幂等键扩为 `adapterId:platform:kind:id:msgId`，**兼容读取**旧键（灰度期旧记录仍命中）。
- **连接韧性**：服务端每个心跳周期检查 `lastFrameAt`，连续两个周期无入站帧（含 pong）即
  `terminate`（半开连接不再让 `isConnected` 恒真）；签名比较改为常量时间。
  客户端/两个 mcp 连接器都加 `handshakeTimeoutMs`（默认 10s）看门狗 +
  `unexpected-response`（401/403）收口 + socket 归属守卫，不再永久停在 `connecting`。
- `action` 帧签名增加 **`bodyHash`**（对 `JSON.stringify(envelope)` 的摘要，签名改为对摘要
  计算）：验签方不再重新序列化信封，消除「两端 JSON 逐字节一致」的隐性契约；旧帧不带该
  字段时仍走原逻辑。
- **动作幂等**：桥接侧 `receipts` 改为「执行前登记 promise」——WS 8s 超时后的 HTTP 重投
  await 同一个 promise，不会把同一句话发两遍；幂等键含 `type` 与 `target`；传输类失败
  （`E_PLATFORM`/`E_NETWORK`/`E_TIMEOUT`/`E_INTERNAL`）不缓存，业务失败短 TTL（30s）。
- 运维面：`/v1/health` 公开面只回存活/模式/WS 与开关状态，`?detail=1` 需适配器签名或
  operator 凭据；指标 `route` 标签走白名单模板（未知路径 `/other`）且序列数封顶 2000。
- 桥接控制台令牌改 **Header > Cookie > `?token=`（仅 `GET /` 首次引导，303 后即清 URL）**。

## 3. 装饰器 / 过滤器服务

- **注册**：与消费者同构——向网关注册（先配置文件 `services.json`，后 UI 注册流程），
  网关分配客户端身份（id + 密钥 + WS 连接）；
- **调用形态**：网关把消息推给服务（WS `service.call` 帧，HTTP 备用 POST），
  服务返回 `{ verdict: 'pass' | 'drop', message?, sections? }`——
  decorator 只返回增强内容，filter 返回放行/丢弃；**只有这一个入口一个出口**，
  不像消费者那样提供一堆动作；
- **内置装饰器的归宿**：context-assembler 的 section（persona/memory/snapshot/
  time-slang）逐步改造成服务；**protocol section（turnToken 注入）留在网关内置**，
  永不外委——它是安全凭据，不是内容装饰。**P3 已转正**：内置 persona/snapshot/
  time 随 context-assembler 一并物理删除（`src/context/` 目录不复存在），
  persona 由 rolecard 装饰器服务承载，记忆段由 memory 装饰器承载；
- **GATEWAY_CONTEXT 开关退场（P3 已退场）**：`off/shadow/on` 由管线编排取代
  （没有装饰器 = 不拼装；灰度 = 管线里放 shadow 步骤记录 diff）。P3 起读到
  `GATEWAY_CONTEXT` 环境变量 = 配置过期，启动直接报错（fail-closed）。

**P2 落地语义（2026-11-06，与上文规格的差异以本段为准）**：

1. **接管与回滚**：`GATEWAY_PIPELINE` 默认 `on`（接管拼装；空编排 = prompt 透传 +
   protocol 令牌强制注入）。**P3 转正后回滚语义收窄**：`off` = prompt 原样透传
   （旧 assembler 已删除，装饰能力随管线一起停用）；`GATEWAY_CONTEXT` 开关退役，
   设置即启动报错。
2. **内置步骤也须列入编排**：persona/snapshot/time 不再「无条件注入」——它们只是
   内置步骤类型，出现在 `pipelines` 序列里才执行；只有 protocol 例外，强制注入且
   不可被编排移除（安全凭据，不变量 §5.2）。管线模式下 protocol 只补
   `【会话令牌】` 行（消息本体由管线 text 承载），与旧 assembler 的「protocol 渲染
   消息」不同。
3. **输出形状**：最终 prompt = 消息本体 + sections（priority 降序、name 升序），
   `\n\n` 分隔；预算超限整段丢弃最低优先级 section（消息本体永不参与裁剪），
   丢弃记入 `dropped`——与旧 assembler 算法一致，P3 shadow 对账可比。
4. **fail-safe 方向**：外部步骤超时/抛错/非法响应一律 degraded **放行**（宁放行
   不误杀）；verdict=drop 短路，turn 按「无消息」处理（幂等键已在入站落盘）；
   引擎级失败（配置错误）回退适配器 prompt 并记 `context:fallback`（与旧标记相同）。
5. **transport**：ws（ws-hub `callService`，callId 请求-响应关联，连接断开/超时
   以 ContractError 拒绝）；http 备用 = 网关 `POST <url>/v1/service/call`（签名与
   入站 HMAC v1 同格式，url 仅允许回环）；auto = 有 WS 连接走 WS、否则回落 HTTP。
   test-layering 对 core 的依赖白名单相应放宽 `../shared/`（http-client 中立工具层）。
   连接器细节（2026-11-09 收口）：`service.call`/`tool.call` 帧免逐帧签名（握手即
   鉴权）；`tool.call` 的契约错误统一回 `{code,message}`（不再是裸字符串，网关侧
   才能按 schema 解析）；握手 10s 看门狗 + 401 收口 + 1s→30s 退避重连；服务端
   连续两个心跳周期无入站帧即 terminate（半开连接不再被误判为可用）。
6. **回路链（P5 已接通）**：`runReturn` 与 `runForward` 共用同一套步骤循环
   （`runChain` 方向参数化），作用于**发送动作的外发文本**——落点在
   `deliverAction`（`POST /v1/actions` 前，出站唯一真路径；回合文本不自动投递的
   不变量不破）。语义：`filter` 判 `drop` = 拦截投递（动作不发、按成功回执）；
   decorator 改写 / join 规则（once/prefix/suffix/regex/function/本地静态，与
   P4.x 通路同构）= 替换 `payload.text`；链失败 fail-safe 保留原文照发。
   契约：`serviceCallRequest` 增 `direction: 'forward'|'return'`（缺省 forward）；
   `returnPipelines` fail-closed 拒绝 protocol（令牌只在入站有意义）。
   `GATEWAY_PIPELINE=off` 时双向透传（同一回滚开关）。验收
   `scripts/test-return-pipeline.mjs`（engine + transport 端到端）。

## 4. 分阶段实施

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P1 消费者抽象 + WS 通道** | adapters.json 增 `kind(platform/route)` 与 `transport`；`ws-hub.mjs`（握手鉴权 + inbound 帧 + 心跳 + 指标）；HTTP 全兼容；`GATEWAY_WS` 开关默认 off。2026-11-06：ws-hub 已替换为 `ws` 包实现（API 面不变），HTTP 出站统一 `src/shared/http-client.mjs`（axios 薄封装），两仓依赖版本对齐 | **已落地** |
| **P2 管线引擎** | `services.json` + 装饰器/过滤器注册与调用契约；管线配置（per-consumer 通路/回路步骤）；接替 context-assembler 的拼装职责。2026-11-06 落地：`service-registry.mjs`（services.json：服务 id + HMAC + transport ws/http/auto + per-consumer `pipelines` 编排块）；`pipeline.mjs`（通路引擎：drop 短路、fail-safe degraded、预算整段裁剪、protocol 强制注入不可移除、runReturn 占位）；ws-hub `callService`（callId 请求-响应关联）+ HTTP 备用 `POST <url>/v1/service/call`；persona/snapshot/time 为**内置步骤**（须列入编排才执行），GATEWAY_PIPELINE 默认 on 接管拼装，off 回退 GATEWAY_CONTEXT 旧路径；契约 `serviceCallRequest/Result`（contracts.mjs）。见 §3 末「P2 落地语义」 | **已落地** |
| **P3 memory/rolecard 迁移** | 两个 mcp 服务以装饰器身份注册（保留工具面）；GATEWAY_CONTEXT 退场；shadow 对账。记忆落库统一管线见 §6。2026-11-07 落地：**自主登记目录**（`state/gateway/services/<hash>.json`，id=32 位随机 hash 确认对象唯一性 + name 展示名 + 工具级 roles 两层声明 + append-only 台账 + 热加载 + 编排权限门禁——注册 kind=consumer 即拥有编排、卸载即撤销）；**工具动态路由**（`/v1/tools` 合并登记工具面，`/v1/tools/call` 按登记路由，turnToken 留在网关不下放，内置 memory/rolecard executor 退役）；**服务侧端点**（memory-mcp/rolecard-mcp 各加 `POST /v1/service/call` + `/v1/tools/call`，HMAC 与网关出站签名同公式）；**转正收尾**（`GATEWAY_CONTEXT` 物理删除——`src/context/` 目录、config 块、turn-runner 旧分支全删，读到该 env 启动即拒；内置 persona/snapshot/time 退役，内置只剩 protocol；`verify:shadow` 改为管线级 kind=shadow 对账 3/3 零行为变化；回滚通道 = `GATEWAY_PIPELINE=off` prompt 透传）；**记忆落库调度器**（`memory-ingest.mjs`：入站 server.handleInbound + 出站 tool-host 发送成功点双向观察，按会话/时间窗聚合（`GATEWAY_MEMORY_INGEST` 默认 off），逐条 POST `/api/memory/record` 同写入口径（x-mcp-token 通道），失败指数退避本地缓冲、超限丢弃，退出前 flushAll 冲净） | **已落地** |
| **P4 UI** | 注册流程 + 通路/回路编排界面（依赖 docs/console 的 operator 认证）。2026-11-07 落地：`public/console/` 原生 JS 单页（登录/服务注册/通路·回路编排/台账审计，零构建链零新依赖）；`/v1/console/services`（文件即登记：注册=写 `<hash>.json` + secret 独立落盘 0600，卸载=删文件，operator 扫描即时生效并落台账）与 `/v1/console/pipelines`（fail-closed 校验 + services.json 原子写 + `reloadServicesJson` 热加载即时生效）两组控制面路由 + `/`、`/console/*` 静态处理（防路径穿越、console off 整组 404）；service-registry 新增 services.json 热加载与 `returnPipelines` 回路编排块。回路引擎执行仍占位（`returnEffective:false` 标注「已配置未生效」），`runReturn` 接编排为下一期。验收 scripts/test-console-services.mjs，全量 169/169。2026-11-07 P4.x 扩展：**注入规则引擎**——编排条目双形态（字符串或规则对象 `step/once/join/text/pattern/fn`，本地静态供料步骤 + once 仅首轮注入 + prefix/suffix/regex/function 拼接规则，自定义函数保存期 fail-closed 编译/试运行校验、运行期 fail-safe；装饰器契约不降级，ctx 透传 `firstTurn` 供加工型自治，详见 registry-ui PLAN §8）；**多平台数据面**——usage-ledger 增 `pf`（platform）维度与 `byPlatform()`、`/v1/console/adapters` 升格消费端统一总览（`source: adapters.json|registry|both` + roles 聚合）；cached tokens 价目本就支持（cacheHit/cacheMiss 分价读取时折算）。全量 180/180 | **已落地** |
| **P5 回路引擎执行** | 2026-11-09 落地：`runReturn` 重定义为与 `runForward` 同构的链执行器（`runChain` 方向参数化抽取——once/join 规则/预算裁剪/fail-safe 全复用）；落点 `deliverAction`（发送动作外发文本过 `returnPipelines`：filter drop 拦截投递按成功回执、改写替换 `payload.text`，回合文本不自动投递不变量不破）；契约 `serviceCallRequest` 增 `direction`（缺省 forward）；`returnPipelines` 拒 protocol（装载/热加载/编排写入三处 fail-closed）；UI/API `returnEffective` 翻面（真实开关）。验收 `scripts/test-return-pipeline.mjs` + console 翻面断言，全量 187/187 | **已落地** |

## 5. 不变量（重构期间任何阶段都不许破坏）

1. 文本不自动投递：模型发言必须走发送工具（adapter-tools → 消费者动作）；
2. turnToken 每 turn 铸造、经 protocol section 下发、ToolHost 反查——安全链不外委；
3. 幂等键语义不变：入站 `platform:kind:id:messageId`，动作回执 `actionId` 一致性；
4. 回环-only 外壳 + HMAC 是唯一信任来源，WS 握手沿用同一套签名格式；
5. `src/core/` 不出现平台/服务名（test-layering 钉住），装配只在 `src/main.mjs`。

## 6. 记忆落库统一管线（P3 的记忆侧规格，2026-11-06 登记）

> 背景：P2 阶段的上下文记忆客户端（head/tail/ingest 单条写入）已删除——
> 记忆收敛为 `chat_memory_*` 工具唯一通路。本节是 V2 P3 重建记忆能力时的
> 目标态规格，来自产品决策，实现时不得偏离。

1. **记忆段注入改为装饰器**：不再有网关内置 memory-section。记忆回忆段由
   memory 装饰器服务在管线里填装（§3 装饰器契约，一个入口一个出口）；
   GATEWAY_CONTEXT 开关已随 P3 转正退场（读取即启动报错）。
2. **记忆点写入 = 模型主动保存，唯一写入语义**：模型经网关
   （mcp-bus → `/v1/tools/call` → memory-tools）保存受关注的记忆点；
   memory-mcp 侧负责**自动判定该记忆点是新增还是修改既有条目**（幂等 id /
   语义去重由服务端裁决），网关不介入判定逻辑。
3. **消息全量落库（双向、批量、分层）**：入站消息**与**桥接发送的消息都要
   落入记忆系统；不再逐条即时写入，改为**按层次分批落地**（如按会话/时间窗
   分层聚合后批量提交），由管线侧调度。
4. **同一落地方式**：批量落库必须与模型主动保存走**同一条写入口径**
   （同一 memory-mcp 写接口、同一幂等/去重语义）——不允许为批量路径另开
   旁路写法，保证「自动沉淀」与「主动保存」在服务端视角不可区分。
5. **通路纪律不变**：一切 memory-mcp 访问仍经网关（§1 工具调用路径不变），
   批量管线是网关侧的调度器，不是绕过网关的直连。

> **P3 落地注记（2026-11-07）**：调度器 = `src/runtime/memory-ingest.mjs`。
> 观察点：入站 `server.handleInbound`（HTTP `/v1/inbound` 与 WS inbound 帧的
> 唯一汇聚点，覆盖 shadow/unrouted/queued 等不触发 turn 的消息）；出站
> `tool-host` 的 SEND_ACTIONS 成功回执点（只沉淀真正发出去的文本）。聚合：
> 按会话缓冲，`GATEWAY_MEMORY_INGEST_WINDOW_MS`（默认 30s）到期或
> `GATEWAY_MEMORY_INGEST_BATCH`（默认 50）攒满冲刷。投递：逐条 POST 记忆
> 服务 `/api/memory/record`（`GATEWAY_MEMORY_INGEST` on 时必配 token 三态），
> 失败指数退避本地缓冲、超过上限丢弃并计数——落库是旁路，绝不阻塞消息主链路，
> 退出前 flushAll 冲净。
