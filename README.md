# agent-gateway

上下文编排 + DSH 网关。**不是消息中间件**：它是 DSH 的唯一会话/事件消费者，
负责 session 映射、prompt 队列、`events.mux` 消费、turn 收集、审批提问与工具路由。
平台接入（QQ/微信适配器）在各自的仓库里，通过本仓库的 HTTP 契约对接。

## 运行

```bash
npm install
GATEWAY_MODE=off npm start          # 默认 off：只起 HTTP，不处理任何业务
GATEWAY_MODE=shadow npm start      # 影子模式：收下消息、落盘，不碰 DSH
```

配置来源：环境变量 `GATEWAY_MODE / GATEWAY_HOST / GATEWAY_PORT / GATEWAY_SECRET`
与 `state/gateway/adapters.json`（适配器与密钥登记）。

### 分阶段开关

| 开关 | 取值 | 作用 |
|---|---|---|
| `GATEWAY_CONTEXT` | `off`(默认)/`shadow`/`on` | P2 上下文拼装：off 透传适配器 prompt；shadow 拼装仅供对比；on 用网关拼装替换（失败自动回退）。配套 `GATEWAY_CONTEXT_BUDGET`。（原记忆段/入站 ingest 已删除：记忆收敛为 `chat_memory_*` 工具唯一通路，装饰器式记忆段见 V2 重构 P3） |
| `GATEWAY_TOOLS` | `off`(默认)/`on` | P3 统一工具面：开放 `GET /v1/tools` 与 `POST /v1/tools/call`。必须同时设置 `GATEWAY_MCP_TOKEN`（与 mcp-bus 共享的 HMAC 密钥，≥16 位随机串；也可放 `state/gateway/mcp-bus.secret` 供 setup-dsh 以 `--token-file` 传给薄壳）。配套 `GATEWAY_TOOL_MAX_CALLS_PER_TURN`（默认 30）、`GATEWAY_TOOL_CALL_TIMEOUT_MS`（默认 20000） |
| `GATEWAY_TOOL_SENSITIVE` | `off`(默认)/`on` | 清单驱动工具面的敏感门：适配器清单里 `kind:sensitive` 的动作（如 `set_wake` 唤醒配置）默认**不暴露**给模型，显式 `on` 才进 `chat_<platform>_*` 目录 |
| `GATEWAY_TOOL_MANIFEST_TIMEOUT_MS` | 默认 `5000` | 启动时拉取适配器能力清单（`GET /v1/actions/manifest`）的超时。拉到才装配该平台工具面；拉不到 = 本轮没有该平台工具（记日志、不阻塞启动） |
| `GATEWAY_WEB_SEARCH` | `off`(默认)/`on` | 阶段 3 联网搜索收编：`on` 且能解析到 API key 时装配 `chat_web_search`（内置清单、非适配器来源，DeepSeek 联网搜索与 DSH 同源）。key 发现顺序：`GATEWAY_WEB_SEARCH_KEY` → `GATEWAY_WEB_SEARCH_KEY_FILE`（与 mcp-bus.secret 同模式）→ `DEEPSEEK_API_KEY` → DSH `$DSH_HOME/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`；全落空 = 跳过注册（宁可缺工具）。端点强制 https + 公网地址（SSRF 防护），key 永不落日志/错误信息 |
| `GATEWAY_WEB_SEARCH_TIMEOUT_MS` | 默认 `35000` | 单次搜索上游请求的缺省超时上限（5000–120000）；实际取它与 tool-host 预算的较小者。配套 `GATEWAY_WEB_SEARCH_BASE_URL` / `GATEWAY_WEB_SEARCH_MODEL` 可覆盖端点与模型（默认官方端点 + `deepseek-v4-flash`） |

### WS 通道（V2 主线，`GATEWAY_WS=on` 后生效）

| 变量 | 默认 | 说明 |
|---|---|---|
| `GATEWAY_WS` | `off` | `on` 时在 `GATEWAY_WS_PATH` 上接受适配器/服务长连接；`inbound` 上行与 `service.call`/`tool.call`/`action` 下行走帧，HTTP 端点永久保留为兜底 |
| `GATEWAY_WS_PATH` | `/v1/ws` | 必须以 `/` 开头 |
| `GATEWAY_WS_HEARTBEAT_MS` | `30000` | 5000–300000。每周期 ping 一次；**连续两个周期没有任何入站帧（含 pong）即 terminate**（判定半开连接） |
| `GATEWAY_REPLAY_WINDOW_MS` | `300000` | 1000–3600000。HTTP/WS 签名的时间窗；nonce 缓存与它同寿。非法值启动即失败（不再 NaN 静默放行） |

握手验签公式：`v1=hmac_sha256(secret, ts + "\n" + nonce + "\n" + sha256(body))`，GET 握手 body 为空串。
动作帧在同一公式上多带 `bodyHash`（对 `JSON.stringify(envelope)` 的摘要），验签方不再重新序列化。

运维端点：`GET /v1/health` 公开面只回 `ok/version/mode/turns/ws/tools/pipeline` 的开关与计数；
`?detail=1` 才回 pid/uptime/适配器能力与回投地址，且需要适配器签名或 operator 凭据。
`GET /v1/metrics` 需要签名；指标 `route` 标签按白名单模板收敛（未知路径记 `/other`），序列总数封顶 2000。

清单驱动工具面（P2）：`GATEWAY_TOOLS=on` 时网关向每个配了 `callbackBase` 的适配器拉取能力清单，按清单生成 `chat_<platform>_<action>` 工具（投递类动作 `send_text/reply/mark_read` 等仍归 platform-actions，不进工具面）。新增能力 = 适配器清单加条目 + 适配器写 handler，网关侧零改动。

代码组织（决策 11/12）：`src/executors/adapter-tools/{common,qq,wx}`——
`common/` 是装配机器（清单拉取校验、目录/Schema 生成、信封组装、回执校验、kind 分档预算、默认透传、覆盖完整性双向孤儿检测），**禁止出现任何平台业务字样**（静态检查钉住）；`qq/`、`wx/` 每个平台子目录与该平台清单 1:1（每条清单条目一个宿主模块，简单能力 = 几行的声明式桩 `passthrough(type)`，复杂能力在模块里写 `handle`）。多适配器并存时共用**单个** executor（registry 按 action 全局路由，同名 type 跨清单重复是正常形态），工具名 `chat_<platform>_*` 全局唯一、平台选择权在工具名前缀（tool-host 随 ctx 下发 `tool`），目录合并冲突（同平台两份清单）显式拒绝装配。新适配器 = 新平台子文件夹 + 平台注册表 + `adapter-tools/index.mjs` 一行，`common/` 永不为单个平台改动。

### 适配器登记（`state/gateway/adapters.json`）

```json
{
  "adapters": [
    { "id": "qq-main", "platform": "qq", "secretFile": "qq-main.secret",
      "callbackBase": "http://127.0.0.1:3100",
      "capabilities": ["send_text", "reply", "mark_read"] },
    { "id": "wx-main", "platform": "wx", "enabled": false, "secretFile": "wx-main.secret",
      "callbackBase": "http://127.0.0.1:7192",
      "capabilities": ["send_text", "reply", "send_media", "send_file"] }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | `^[a-z0-9][a-z0-9-]{0,63}$`；入站请求头 `x-adapter-id` 必须与它一致 |
| `platform` | 是 | `qq` / `wx`；出站动作按它路由，**同一平台只能登记一个**（否则启动失败） |
| `secret` / `secretFile` / `secretEnv` | 是 | 三选一，≥16 位随机串；`secretFile` 相对 `state/gateway/` |
| `callbackBase` | 否 | 适配器 HTTP 根地址；缺省表示动作不回投（文本仍走适配器自己的 mux） |
| `capabilities` | 否 | 可投递动作子集；缺省 = 不限制。声明后网关在调用前门控，能力外动作直接 `E_UNSUPPORTED` |
| `enabled` | 否 | `false` 时该适配器不注册（等价于临时 `GATEWAY_DISABLED_ADAPTERS=wx-main`）；只接受布尔 |

`wait / set_wake / noop` 是模型侧语义，不属于适配器能力，写进 `capabilities` 会启动失败。
能力列表必须与适配器**真正实现**的动作一致：qq-bridge 目前实现 `send_text/reply/mark_read`
（清单里的 `wait` 也已接线，但它是读类语义，不计入 `capabilities`），
wx-adapter 实现 `send_text/reply/send_media/send_file`——多声明一个，模型就会以为能戳一戳。
`scripts/test-adapter-conformance.mjs` 会读 `adapters.example.json` 并按其中的列表逐个真投一次，
示例与实现漂移即测试失败。

适配器回执必须是 `{v:1, actionId, ok}` 且 `actionId` 与请求一致，否则按 `E_PLATFORM` 降级——
一个回 `{}` 的适配器不会被当成「发送成功」。示例见 `adapters.example.json`。

### 唤醒事件（`kind:'event'` + `wake`）

适配器的「等待新消息 / 定时冒泡」不需要用阻塞式工具调用表达：登记后立即回执，事件到达时投一张
`kind:'event'` 的入站信封——**不带 `prompt.text`**，只带 `wake` 标记与 `snapshot`，prompt 由网关
按快照合成（`gateway_wake_total{kind,status}` 计数，`/v1/turns/:id` 的 `result.wake` 记录这轮
是谁叫醒的）。两类唤醒共用这条通道：

- `wake:{kind:'wait', status:'arrived', baselineSeq, satisfiedSeq}`：qa 桥接的 `chat_qq_wait`——
  登记 → 新消息到达 → 网关新 turn；
- `wake:{kind:'proactive', status:'arrived'}`：适配器侧定时器（冒泡 / 主动机会）——合成 prompt
  会明确告诉模型「这不是有人点名你」（可主动开话题，也可沉默）。

wake-synthetic 起，**网关路由的会话没有本地 prompt 回退**：适配器投递失败 = 本轮唤醒失败
（回滚唤醒记账，下次再来），不会再落回本地 DSH 提交——同一张事件绝不变成两轮。
幂等键落在合成消息 id（`wait-<ts>-<n>` / `wake-<ts>-<n>`）上，重投不会开第二个 turn。

## 布局

```text
src/main.mjs                 进程入口 + 组合根：唯一同时 import core/runtime/executors/context 的地方
src/core/                    网关本义：鉴权、分发、幂等、索引——不知道任何第三方服务
  contracts.mjs              线缆契约（zod 严格 schema + 动作 payload 规则 + toolCall/toolResult）
  auth.mjs                   HMAC 双向鉴权（先验签名再消费 nonce）
  idempotency.mjs            幂等键存储（LRU + TTL + 原子落盘）
  turn-store.mjs             turn 索引（append-only JSONL）
  metrics.mjs                计数与耗时直方图
  config.mjs                 fail-closed 配置加载
  server.mjs                 HTTP 服务（/v1/health /v1/inbound /v1/turns/:id /v1/metrics
                                       /v1/tools /v1/tools/call——后者只是转发路由，handler 由 runtime 注入）
  net.mjs                    回环地址判定

src/runtime/                 执行层：turn 编排引擎
  turn-runner.mjs            turn 生命周期（每轮铸造 turnToken 并登记进 ToolHost）
  tool-host.mjs              P3 统一工具枢纽：turnToken 反查活跃 turn、频控、预算、统一结果形状
  （session-registry / dsh-gateway / prompt-queue / dsh-client）

src/executors/               可插拔模块：每个第三方服务一个文件
  executor-interface.mjs     执行层唯一契约；executor 只允许 import 它与 node 内置
  memory-tools.mjs           P3：chat_memory_recall/record/forget（memory-mcp，自带熔断）
  rolecard-tools.mjs         P3：chat_role_list/get/sections/render（只读；写工具不挂会话）

src/context/                 上下文组装
  （context-assembler + sections/：persona / memory / snapshot / time / protocol）

src/mcp-bus.mjs              P3 MCP stdio 薄壳：零依赖最小 JSON-RPC；工具清单从网关拉取，
                             调用转发 /v1/tools/call；给每个工具注入必填 turnToken 参数。
                             DSH 侧由 qq-bridge scripts/setup-dsh.mjs（GATEWAY_TOOLS=on）登记。

依赖单向：core ← runtime ← `src/main.mjs`；executors 与 context 只依赖各自接口契约。
`src/core/` 里不出现外围模块路径与具体平台/服务名，由 `scripts/test-layering.mjs` 钉住。
```

## 工具调用链路（P3）

```text
DSH agent ──stdio── dsh-mcp-client ──spawn── mcp-bus（MCP server）
    │                                              │ HMAC（GATEWAY_MCP_TOKEN）
    └── model 每轮从提示词拿【会话令牌】             ▼
        并作为 turnToken 参数回传        POST /v1/tools/call → ToolHost
                                          │ turnToken 反查活跃 turn + 频控 + 预算
                                          ▼
                                     executor registry（memory-tools / rolecard-tools / adapter-tools）
```

安全要点：turnToken 每 turn 铸造、turn 结束即焚；「来自回环」不是信任凭据，
mcp-bus 走与适配器同一套 HMAC 签名格式（adapterId 固定 `mcp-bus`）。

契约与适配器侧实现的一致性由 `npm test`（含与 qq-bridge 适配器客户端的
签名互认段）钉住；设计文档见 `qq-bridge/docs/design/AGENT_GATEWAY.md`。

## 控制台（规划中，占位）

DSH 控制面（预设 / 会话 / 模型）与计费、流量统计**规划由网关统一提供**，
桥接只保留平台侧能力。功能清单与各模块计划书见 **`docs/console/README.md`**
（auth / dsh-presets / dsh-sessions / dsh-pending / usage-billing / adapters-overview，
均为 TODO 占位文档，尚未实现）；实现前，相关数据仍由 qq-bridge 控制台经适配器
凭据代理读取（`/v1/turns`、`/v1/usage`）。

## V2 重构（进行中）

架构升级总纲见 **`docs/design/GATEWAY_V2_REFACTOR.md`**：适配器泛化为
**消费者**（平台或路由）、memory/rolecard 重定义为**装饰器/过滤器**消息工厂
（通路/回路管线，接替 context-assembler）、客户端协议改 **WebSocket 长连接**
（HTTP 备用）。P1（消费者抽象 + `/v1/ws` 通道，`GATEWAY_WS` 开关默认 off）
已落地；P2 管线引擎、P3 memory/rolecard 迁移、P4 编排 UI 依次排队。

## 验收与演练

```bash
npm test                 # 契约/执行层/运行时/上下文/工具/状态/双适配器/分层边界
npm run verify:shadow    # context=shadow 与 off 的实际 prompt 逐字节一致（影子期零行为变化）
npm run verify:rollback  # 四道闸门（mode/白名单/适配器登记/子开关）关闭即回旧行为
```

运维、迁移与排障见 `qq-bridge/docs/guides/GATEWAY_OPS.md`；每次上线的演练结果记入
`qq-bridge/docs/design/ROLLBACK_LOG.md`。
