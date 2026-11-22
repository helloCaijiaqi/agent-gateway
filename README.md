# agent-gateway

上下文编排 + DSH 网关。**不是消息中间件**：它是 DSH 的唯一会话/事件消费者，
负责 session 映射、prompt 队列、`events.mux` 消费、turn 收集、审批提问与工具路由。
平台接入（QQ/微信适配器）在各自的仓库里，通过本仓库的 HTTP 契约对接。

## 运行

```bash
npm install
GATEWAY_DATA_PLANE=off npm start    # 默认 off：只起 HTTP，不处理任何业务
GATEWAY_DATA_PLANE=shadow npm start # 影子模式：收下消息、落盘，不碰 DSH
```

配置来源：`.env`（包根，见下）或真实环境变量 `GATEWAY_DATA_PLANE / GATEWAY_HOST / GATEWAY_PORT`，
外加 `state/gateway/` 下的登记：`services/`（**唯一事实源**：消费端 kind=consumer、资源服务
kind=resource，装饰/过滤职责由工具 `role` 声明）、`pipelines.json`（通路/回路编排，按消费端组织，缺失 =
无编排）。`adapters.json` 与 `GATEWAY_ADAPTER_ID / GATEWAY_ADAPTER_PLATFORM / GATEWAY_SECRET`
均已退役——**读到即启动失败**并给出迁移步骤（消费端身份只认登记目录）。

### Windows 一键启动（`start-gateway.bat`）

```bat
start-gateway.bat                :: 启动（崩溃 5 秒自动重启）
start-gateway.bat --check-node   :: 只打印会用的 Node 解释器，不启动
```

脚本职责：探测 Node 22+（顺序：`GATEWAY_NODE` 覆盖 → `C:\DeepSeekHarness\node\node.exe` → PATH → workbuddy runtime）；
每次启动先跑 `scripts/init-env.mjs`（幂等：确保 `state/gateway/operator-token` 与 `state/gateway/mcp-bus.secret`
两份凭据文件存在，缺失则生成（0600），已有有效值不动；同时清理 `.env` 里退役的 token 键）；
然后启动 `src/main.mjs` 并 loop。手工初始化等价于 `npm run env:init`。

### .env 配置层

启动时 `main.mjs` 装载包根 `.env`（路径可用 `GATEWAY_ENV_FILE` 覆盖；文件缺失 = 仅用进程环境变量，不报错）。
语义：**真实环境变量永远优先**（只填充未定义键）、`#` 注释、`export KEY=V` 前缀、引号去壳、坏行告警跳过。
模板见 `.env.example`（QQ 单平台最小集，每键带注释）。

### 密钥落位（三类，都不进 .env）

| 密钥 | 用途 | 落位 |
|---|---|---|
| 消费端（svc-<hash>） | bridge ↔ 网关 HMAC 验签 | `npm run secrets:gen`（默认生成 `svc-<hash>` id）→ `state/gateway/secrets/<id>.secret` + 交接文件 `state/gateway/handoff/<id>.gateway.json`；登记文件 `state/gateway/services/<id>.json`（kind=consumer）引用 `secretFile`，桥接侧只把交接文件复制成 `gateway.json` |
| 登记服务（memory/rolecard MCP） | tool.call 验签（会话缓冲 save / decorator 注入 / 工具面，不存在第二个 ingest token） | 控制台 `POST /v1/console/services` 注册：secret 可留空——网关自动生成（0600 落 `state/gateway/secrets/<id>.secret`，回执一次性明文回显），也可显式提交或用 secretEnv；同时生成 `state/gateway/handoff/<id>.gateway.json`（内嵌同一凭据），复制到服务仓根目录改名 `gateway.json` 即完成交接 |
| operator token / mcp-bus token | 控制台登录 / mcp-bus HMAC | **文件单源**：`state/gateway/operator-token` 与 `state/gateway/mcp-bus.secret`，首跑由 `scripts/init-env.mjs`（bat 自动调用或 `npm run env:init`）生成（0600）；operator 新生成时明文打印一次供登录。`.env` 不承载任何 token——`GATEWAY_OPERATOR_TOKEN` / `GATEWAY_MCP_BUS_TOKEN` 已退役，读到即拒载（env:init 会就地清理残留行） |

控制台配置范围：**pipelines.json 可写**（`GET/PUT /v1/console/pipelines`，fail-closed 校验 + 热加载）、
**服务登记可写**（`POST /v1/console/services`，kind=consumer 需填 platform；**off 模式也可登记**）、
**GATEWAY_DATA_PLANE 开关可写**（`POST /v1/console/mode`，2026-11-16 起消息面运行时常驻装配、mode 为请求期
活读门禁——切换**即时生效零重启**，并原子写回启动时装载的 env 文件保持重启后不变；切 `on` 的 fail-closed
校验（消费端非空 + 编排键有主 + 步骤名合法）在切换点执行，失败 400 回 UI。`off` 是操作员显式意图，
绝不会被自动翻转）、
**消费端总览只读**（`GET /v1/console/adapters`，只来自登记目录 kind=consumer；改消费端 = 改登记文件，热加载生效）。

### 交接文件（`gateway.json`）

生成密钥 / 注册服务之后，网关会产出一份**可直接复制**的连接配置：

```text
state/gateway/handoff/<svc-id>.gateway.json   ← npm run secrets:gen（默认生成 svc-<hash> id）
state/gateway/handoff/<服务id>.gateway.json   ← 控制台注册响应里的 handoffFile
```

复制到对端仓库根目录并**保持文件名 `gateway.json`**。对端不再从自己的 `config.json` 抄 gateway 段，
也不再读 `*_GATEWAY_*` 环境变量——事实源只有这一份文件。

| 字段 | 含义 |
|---|---|
| `id` | 身份（适配器 id / 登记服务 id），必须与网关侧登记一致 |
| `kind` | `adapter` / `service`（仅供排障，消费方不据此分支） |
| `url` | **网关基址**（不是本服务地址；登记文件里的 `url` 才是服务自身地址） |
| `transport` | `http` / `ws` / `auto` |
| `secretFile` / `secret` | 密钥引用（默认绝对路径）/ 内联明文（`--inline-secret`，跨机复制用） |
| `authNote` | 无凭据时的原因说明（如登记用了 `secretEnv`） |

补生成或轮换后重出：`npm run handoff -- --adapter qq-main`（或 `--service <id>`）；
`--print` 看内容（内联密钥自动打码）、`--force` 覆盖、`--json` 机器可读。
生成物固定落 `state/gateway/handoff/`——**不能放 `services/`**，否则会被登记扫描当成文件名与 id 不符的坏登记。

### 启动顺序（整机）

```text
1. DSH（DeepSeekHarness, :3080）        ← 建会话 fail-closed 依赖它
2. agent-gateway（start-gateway.bat / npm start, :7190）
3. memory-mcp（:7181）与 rolecard-mcp（:7182）← WS 主动连网关，1s→30s 退避，可并行
4. qq-bridge（start.bat / start-all.cmd, :3100）← 最后启动开始收消息
```

gateway 对下游全部是失败重试/重连语义：MCP 晚起只是短暂重连，raw 沉淀失败进指数退避重试队列，不丢数据。

### 工具面注册（`npm run setup:dsh`）

`GATEWAY_TOOLS=on` 时，模型能看到的工具由 DSH 侧的 stdio 薄壳 `src/mcp-bus.mjs` 提供，
它必须在 DSH 的 profile 补丁里登记一条 `dsh-mcp-client` 条目：

```powershell
npm run env:init                     # 生成 operator-token / mcp-bus.secret 凭据文件（幂等）
npm run setup:dsh                    # 写入 ~/.dsh/profiles/web/cordis.patch.yml（幂等、自动备份）
npm run setup:dsh -- --dry-run       # 只看会写入什么
npm run setup:dsh -- --profile headless   # 换 profile；--file 可直接指定路径
```

- 写入的是**独立 marker 块**（`# === agent-gateway MCP BEGIN/END ===`），只管理 `mcp-agent-gateway`
  一条；文件里其它内容（包括别的 MCP 插件条目）**一个字节都不动**——脚本按 latin1 读写以保字节，
  因为该文件里有历史遗留的乱码注释，UTF-8 往返会损坏它们。
- 幂等：块内容一致 → 不改；路径漂移（仓库搬了/node 换了）→ 只替换自己的块；首次写入前自动备份
  （`cordis.patch.yml.bak-<时间戳>`，保留最近 3 份）。
- 安全跳过：检测到手工登记过 `mcp-bus.mjs` 但没有 marker → 不写第二份（两个同名 MCP 会互相覆盖工具），
  只提示；`--force` 才会强行追加。
- **必须重启 DSH 才生效**（DSH 只在启动期读该文件）。网关启动时只做诊断：工具面开启但未注册会打一行
  告警「运行 `npm run setup:dsh` 后重启 DSH」，**不会自动改文件**。
- 环境变量：`GATEWAY_DSH_PATCH_FILE`（直接指定文件）、`GATEWAY_DSH_PROFILE`（默认 `web`）。

### 分阶段开关

| 开关 | 取值 | 作用 |
|---|---|---|
| `GATEWAY_PIPELINES_FILE` | 默认 `state/gateway/pipelines.json` | 通路/回路编排的唯一来源（环境变量只改路径，见下文「编排」） |
| `GATEWAY_TOOLS` | `off`(默认)/`on` | P3 统一工具面：开放 `GET /v1/tools` 与 `POST /v1/tools/call`。需要 `state/gateway/mcp-bus.secret`（与 mcp-bus 共享的 HMAC 密钥文件，≥16 位随机串；`npm run env:init` 生成维护，供 `npm run setup:dsh` 写进 DSH 条目的 `--token-file`）。配套 `GATEWAY_TOOL_MAX_CALLS_PER_TURN`（默认 30）、`GATEWAY_TOOL_CALL_TIMEOUT_MS`（默认 20000） |
| `GATEWAY_TOOL_SENSITIVE` | `off`(默认)/`on` | 清单驱动工具面的敏感门：适配器清单里 `kind:sensitive` 的动作（如 `set_wake` 唤醒配置）默认**不暴露**给模型，显式 `on` 才进 `chat_<platform>_*` 目录 |
| `GATEWAY_TOOL_MANIFEST_TIMEOUT_MS` | 默认 `5000` | 启动时拉取适配器能力清单（`GET /v1/actions/manifest`）的超时。拉到才装配该平台工具面；拉不到 = 本轮没有该平台工具（记日志、不阻塞启动） |
| `GATEWAY_WEB_SEARCH` | `off`(默认)/`on` | 阶段 3 联网搜索收编：`on` 且能解析到 API key 时装配 `chat_web_search`（内置清单、非适配器来源，DeepSeek 联网搜索与 DSH 同源）。key 发现顺序：`GATEWAY_WEB_SEARCH_KEY` → `GATEWAY_WEB_SEARCH_KEY_FILE`（与 mcp-bus.secret 同模式）→ `DEEPSEEK_API_KEY` → DSH `$DSH_HOME/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`；全落空 = 跳过注册（宁可缺工具）。端点强制 https + 公网地址（SSRF 防护），key 永不落日志/错误信息 |
| `GATEWAY_WEB_SEARCH_TIMEOUT_MS` | 默认 `35000` | 单次搜索上游请求的缺省超时上限（5000–120000）；实际取它与 tool-host 预算的较小者。配套 `GATEWAY_WEB_SEARCH_BASE_URL` / `GATEWAY_WEB_SEARCH_MODEL` 可覆盖端点与模型（默认官方端点 + `deepseek-v4-flash`） |

### WS 通道（V2 主线，常驻能力）

> WS 通道自 2026-11-18 起为常驻能力，原 `GATEWAY_WS=off|on` 开关已退役：消费端本就
> WS 优先/HTTP 兜底自协商，开关无独立价值（纯 HTTP 部署形态随之退役）。

| 变量 | 默认 | 说明 |
|---|---|---|
| `GATEWAY_WS_PATH` | `/v1/ws` | 必须以 `/` 开头。在它上面接受适配器/服务长连接；`inbound` 上行与 `tool.call`/`action` 下行走帧（`service.call` 已全链路下线），HTTP 端点永久保留为兜底 |
| `GATEWAY_WS_HEARTBEAT_MS` | `30000` | 5000–300000。每周期 ping 一次；**连续两个周期没有任何入站帧（含 pong）即 terminate**（判定半开连接） |
| `GATEWAY_REPLAY_WINDOW_MS` | `300000` | 1000–3600000。HTTP/WS 签名的时间窗；nonce 缓存与它同寿。非法值启动即失败（不再 NaN 静默放行） |

握手验签公式：`v1=hmac_sha256(secret, ts + "\n" + nonce + "\n" + sha256(body))`，GET 握手 body 为空串。
动作帧在同一公式上多带 `bodyHash`（对 `JSON.stringify(envelope)` 的摘要），验签方不再重新序列化。

运维端点：`GET /v1/health` 公开面只回 `ok/version/mode/turns/ws/tools/pipeline` 的开关与计数；
`?detail=1` 才回 pid/uptime/适配器回投地址与编排装载结果，且需要适配器签名或 operator 凭据
（能力清单不进静态快照：它随运行时 `actions-manifest` 变化）。
`GET /v1/metrics` 需要签名；指标 `route` 标签按白名单模板收敛（未知路径记 `/other`），序列总数封顶 2000。

清单驱动工具面（P2）：`GATEWAY_TOOLS=on` 时网关向每个配了 `callbackBase` 的适配器拉取能力清单，按清单生成 `chat_<platform>_<action>` 工具（投递类动作 `send_text/reply/mark_read` 等仍归 platform-actions，不进工具面）。新增能力 = 适配器清单加条目 + 适配器写 handler，网关侧零改动。

代码组织（决策 11/12）：`src/executors/adapter-tools/{common,qq,wx}`——
`common/` 是装配机器（清单拉取校验、目录/Schema 生成、信封组装、回执校验、kind 分档预算、默认透传、覆盖完整性双向孤儿检测），**禁止出现任何平台业务字样**（静态检查钉住）；`qq/`、`wx/` 每个平台子目录与该平台清单 1:1（每条清单条目一个宿主模块，简单能力 = 几行的声明式桩 `passthrough(type)`，复杂能力在模块里写 `handle`）。多适配器并存时共用**单个** executor（registry 按 action 全局路由，同名 type 跨清单重复是正常形态），工具名 `chat_<platform>_*` 全局唯一、平台选择权在工具名前缀（tool-host 随 ctx 下发 `tool`），目录合并冲突（同平台两份清单）显式拒绝装配。新适配器 = 新平台子文件夹 + 平台注册表 + `adapter-tools/index.mjs` 一行，`common/` 永不为单个平台改动。

### 消费端登记（`state/gateway/services/<id>.json`，kind=consumer）

**消费端唯一事实源是登记目录**：qq-bridge 这类与网关有直接消息往来的服务，与 memory/rolecard
等资源服务同用 `state/gateway/services/` 登记。`adapters.json` 与 `GATEWAY_ADAPTER_ID /
GATEWAY_ADAPTER_PLATFORM / GATEWAY_SECRET` 已**整体退役**：读到任意一项即启动失败，
错误文案给出逐条迁移步骤（见下）。

用户操作（多消费端收编后，以 qq-bridge 为例）：

1. 生成密钥与登记条目：`npm run secrets:gen`（不传 `--id`，默认生成 **`svc-<hash>`
   形态 id**——id 只标识「这个注册的服务实例」，与平台解耦；`qq-main` 这类与平台名
   混义的 id 不再新发）。产出 `state/gateway/services/<id>.json` 登记条目 +
   `<id>.secret` 密钥 + 交接文件 `state/gateway/handoff/<id>.gateway.json`。
2. 写登记文件 `state/gateway/services/<id>.json`（或用上一步产物）：

   ```json
   {
     "v": 1, "id": "svc-1d8d4f0086c1", "name": "qq-bridge", "kind": "consumer",
     "transport": "auto", "url": "http://127.0.0.1:3100", "platform": "qq",
     "secretFile": "secrets/svc-1d8d4f0086c1.secret"
   }
   ```

   也可走控制台「服务登记」表单（kind 选 consumer，platform 必填，id 自动生成，secret 可留空自动生成）。
3. `pipelines.json` 用该 `svc-<id>` 做编排键（登记 consumer 自动拥有编排权）。
4. 桥接侧只读复制交接文件为 `gateway.json`（协议零改动；`id`/`secret` 必须与登记
   文件配对一致）。

登记即生效（热加载）：HTTP `/v1/inbound` 验签（`expectedPlatform` 来自 `platform`
声明）、WS 握手、动作下行（`url` 即 callbackBase）、adapter-tools 清单拉取、编排
门禁全部打通；登记卸载/停用即刻撤销编排权。

**同平台多账号（如 QQ 多开）**：为每个账号重复上述步骤（每次生成新的 `svc-<hash>`
id 与密钥），一个平台允许多个 enabled 消费端。会话键为 4 段
`platform:consumerId:kind:id`（如 `qq:svc-1d8d4f0086c1:group:123`）——**会话绑消费
端**：同一个群在两个账号下是两个独立会话（记忆/once 规则/白名单互不串号），模型
发送动作按会话键第 2 段路由到对应账号（同平台共享一套 `chat_<platform>_*` 工具，
模型视角不变）。白名单规则 `qq:group:*` 平台级匹配所有账号，`consumer:<svc-id>:qq:group:*`
细粒度限定单账号。存量 3 段会话键/可读 id（qq-main）兼容读取 + 启动迁移告警。

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | consumer 新登记强制 `svc-<hash>`（`^[a-z0-9][a-z0-9-]{0,63}$`）；入站请求头 `x-adapter-id` 必须与它一致 |
| `kind` | 是 | `consumer`（消费端）/ `resource`（资源服务；装饰/过滤由工具 `role` 声明） |
| `platform` | consumer 必填 | `qq` / `wx`；动作会话定位 + 入站验签；**同平台可多账号**（每账号一份登记、各自 svc- id） |
| `url` | consumer 语义 = callbackBase | 消费端 HTTP 根地址（动作下行 POST `<url>/v1/actions` 与清单 GET `<url>/v1/actions/manifest`）；WS-only 消费者可缺省 |
| `secret` / `secretFile` / `secretEnv` | 是 | 三选一，≥16 位随机串；`secretFile` 相对 `state/gateway/` |
| `transport` | 否 | `ws`（长连）/ `http` / `auto`（WS 优先、HTTP 兜底） |
| `memoryService` | 否 | 记忆服务能力声明：`{"saveTool": "chat_memory_save"}`（权威形态）或 `true`（旧布尔，按内置缺省工具处理 + 迁移告警） |
| `enabled` | 否 | `false` 时条目不生效 |

旧的 `adapters.json` 条目（`callbackBase`/`enabled` 等）字段与登记字段一一对应：迁移时
`callbackBase` → `url`、`secretFile` → `secrets/<id>.secret` 引用。登记 consumer 不支持
`kind: "route"` 路由形态（用 `GATEWAY_CONVERSATIONS` 白名单裁决），`kind` 只接受
`consumer` / `resource`。

**工具面不在这份登记里声明**：唯一事实源是消费端自己的 `GET /v1/actions/manifest`
（`wired` + `payloadSchema` + `kind`），网关按「内置平台能力注册表 × 清单」生成
`chat_<platform>_*` 工具。新增能力 = 消费端清单加条目 + 消费端写 handler，网关侧零改动；
`scripts/test-adapter-conformance.mjs` 会按真实 handler 能力逐个真投一次，漂移即失败。
`wait / set_wake / noop` 是模型侧语义（网关自消费），不应出现在消费端清单的可执行动作里。

消费端回执必须是 `{v:1, actionId, ok}` 且 `actionId` 与请求一致，否则按 `E_PLATFORM` 降级——
一个回 `{}` 的消费端不会被当成「发送成功」。

### 编排（`state/gateway/pipelines.json`）

只有消费端拥有编排权限：键必须是登记目录里 `kind=consumer` 的服务 id（或 `default`
兜底键），其它键在启动装载、热加载、控制台写入三处都 fail-closed。

```json
{
  "pipelines": {
    "svc-1d8d4f0086c1": [
      { "step": "chat_memory_get", "once": true, "join": "prefix" },
      { "step": "chat_role_render", "join": "prefix" }
    ]
  },
  "returnPipelines": {
    "svc-1d8d4f0086c1": [{ "step": "chat_sensitivity_filter" }]
  }
}
```

- `pipelines` = 通路（入站 → 网关 → 过滤器/装饰器链 → DSH prompt）；`returnPipelines` = 回路
  （DSH 产出/发送动作 → 网关回路链 → 消费者），回路**禁止** `protocol` 步骤。
- 文件缺失 = 无编排（不报错，消息原样透传）；出现旧 `services` 键或旧 env
  `GATEWAY_SERVICES_FILE` 会直接启动失败并给出迁移提示。
- 编排只影响「消息怎么加工」，服务身份/工具面/role（单值三选一）由登记目录决定，两者不混在同一份文件。
- 步骤解析两级：内置 `protocol` → decorator/filter 角色的登记工具名；**服务 id 直接当步骤不再合法**（写盘前即报迁移错）。

### 会话缓冲与记忆 save（`GATEWAY_MEMORY_SAVE=on`）

会话缓冲上移网关：入站消息与「发送成功」的出站文本逐条追加持久化到
`state/gateway/session-buffer/<sessionKey>.jsonl`，在空闲超时 / 触顶分段 / 进程关停时，
把**整段缓冲**经登记的 `tool.call` 通道（`chat_memory_save`）一次性交给记忆服务落地：

```text
入站 / 出站 ──► session-save 缓冲（JSONL 逐条落盘·去重）──► tool.call chat_memory_save（整段·单事务）──► raw/别名/摘要/画像/关系/纪元
```

- **落地时机完全由网关裁决**：`GATEWAY_MEMORY_SAVE_IDLE_MS`（默认 1h，会话静默即收尾 save）、
  `_MAX_MESSAGES`（默认 200）/ `_MAX_CHARS`（默认 20000，触顶提前分段 `partial:true`）、
  进程关停补发（flushAll）。记忆侧不做 TTL 兜底、没有内部摘要调度器。
- **崩溃恢复**：网关重启扫描残留缓冲（JSONL 行粒度持久化，撕裂行跳过并计数），加载进内存
  并恢复空闲定时器继续补发。
- **失败退避重试**：save 失败缓冲保留（内存 + 磁盘），指数退避封顶 10 分钟无限重试；
  真正的幂等裁决在服务端 raw 表 `UNIQUE(session_id, msg_id)` + 摘要窗口哈希。
- **不需要额外地址或 token**：`GATEWAY_MEMORY_INGEST*` 全家已退役（更名
  `GATEWAY_MEMORY_SAVE*`）——仍设置时启动只打一行告警并忽略（存量 `.env` 不会升级即挂）。
- **目标服务识别**：`selectMemoryService` 三级选路——显式 `GATEWAY_MEMORY_SERVICE` >
  唯一声明 `memoryService: true` 的登记服务 > 多声明按 id 字典序取首个 + 一次性告警。
  不再看 `chat_memory_record` 工具标记。没有候选时 save 进退避重试、只告警一次，不阻断启动。
- save payload：`{sessionKey, messages:[{msgId, senderId?, name?, nickname?, card?, text, createdAt?, kind?}], partial?}`——
  `sender.names = {nickname, card}`（桥接入站契约新增；`name` 保留兼容 = card||nickname），
  记忆服务据此登记 subject 别名索引（群名片 → 会话内、昵称 → 全局）。

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

src/executors/               可插拔模块
  executor-interface.mjs     执行层唯一契约；executor 只允许 import 它与 node 内置
  web-search.mjs             内置 chat_web_search（清单外来源，key 发现与 SSRF 防护）
  rolecard-renderer.mjs      角色卡渲染（供 rolecard 服务的渲染输出复用）
  adapter-tools/             清单驱动工具面：{common,qq,wx}，见上文「代码组织」

src/shared/                  跨层基础设施
  http-client.mjs            带超时/重试的 HTTP 客户端

（记忆/角色卡工具不再由本仓内置：memory-mcp、rolecard-mcp 以登记服务身份
 自带 `chat_memory_*` / `chat_role_*` 工具，经 tool.call 下发——service.call 已全链路下线，
 tool.call 是唯一服务间信封：HTTP `/v1/tools/call` + WS `tool.call` 帧，
 decorator/filter 步骤的 `args` 恒为 `{}`，行为由单值 role 与 `context{senderId?, text?}` 决定。）

src/mcp-bus.mjs              P3 MCP stdio 薄壳：零依赖最小 JSON-RPC；工具清单从网关拉取，
                             调用转发 /v1/tools/call；给每个工具注入必填 turnToken 参数。
                             DSH 侧由本仓 npm run setup:dsh 登记（GATEWAY_TOOLS=on 时；需重启 DSH 生效）。

依赖单向：core ← runtime ← `src/main.mjs`；executors 与 context 只依赖各自接口契约。
`src/core/` 里不出现外围模块路径与具体平台/服务名，由 `scripts/test-layering.mjs` 钉住。
```

## 工具调用链路（P3）

```text
DSH agent ──stdio── dsh-mcp-client ──spawn── mcp-bus（MCP server）
    │                                              │ HMAC（mcp-bus.secret 文件单源）
    └── model 每轮从提示词拿【会话令牌】             ▼
        并作为 turnToken 参数回传        POST /v1/tools/call → ToolHost
                                          │ turnToken 反查活跃 turn + 频控 + 预算
                                          ▼
                                     executor registry（adapter-tools / web-search / 登记服务工具）
```

安全要点：turnToken 每 turn 铸造、turn 结束即焚；「来自回环」不是信任凭据，
mcp-bus 走与适配器同一套 HMAC 签名格式（adapterId 固定 `mcp-bus`）。

契约与适配器侧实现的一致性由 `npm test`（含与 qq-bridge 适配器客户端的
签名互认段）钉住；设计文档见 `qq-bridge/docs/design/AGENT_GATEWAY.md`。

## 控制台

`GATEWAY_CONSOLE=on`（默认开）时提供浏览器控制面，登录凭据是 operator token（见「密钥落位」）。
前端在 `public/console/`，后端路由 `/v1/console/*`：

| 路由 | 能力 |
|---|---|
| `/v1/console/pipelines` | 通路/回路编排读写（按消费端保存，fail-closed 校验 + 热加载） |
| `/v1/console/services` | 服务登记（secret 可留空自动生成 → 0600 落 `state/gateway/secrets/<id>.secret`，自动生成值仅在注册回执一次性回显） |
| `/v1/console/adapters` | 消费端总览（只读：登记来源/平台/回投地址/最近动作） |
| `/v1/console/dsh` | DSH 预设、会话列表与详情（待审批提问在此处理） |
| `/v1/console/pending` | 待确认动作/关系（`relation_pending` 等） |
| `/v1/console/usage` | 用量与计费汇总 |
| `/v1/console/session` | 控制台自身登录态 |

消费端增删改 = 编辑 `state/gateway/services/`（登记热加载）或控制台登记表单。
消费端身份没有第二条通道：`adapters.json` 与 env 三元组读到即拒载，迁移步骤见启动错误文案。

## V2 重构（已落地）

架构升级总纲见 `docs/design/GATEWAY_V2_REFACTOR.md`（该目录只留本地，不入远端仓库）：

- **P1 消费者抽象 + `/v1/ws` 长连接**：适配器泛化为消费端，HTTP 永久保留为兜底；
- **P2 管线引擎**：通路/回路编排收敛到 `pipelines.json`（按消费端组织、fail-closed 权限、
  热加载），`context-assembler` 与 `GATEWAY_CONTEXT` 开关一并退役；
- **P3 memory/rolecard 迁移**：由内置 executor 改为登记服务自带的 `chat_memory_*` /
  `chat_role_*` 工具 + 装饰器/过滤器步骤（召回块注入、会话纪元去重）；
- **P4 编排 UI**：控制台可读写编排与服务登记（见上节）。

## 验收与演练

```bash
npm test                 # 契约/执行层/运行时/上下文/工具/状态/双适配器/分层边界
npm run smoke:e2e        # 端到端冒烟：注册 → 缓冲落盘 → save 事务 → get 新纪元注入 → filter 改写/丢弃 → 崩溃恢复
npm run verify:shadow    # context=shadow 与 off 的实际 prompt 逐字节一致（影子期零行为变化）
npm run verify:rollback  # 四道闸门（mode/白名单/适配器登记/子开关）关闭即回旧行为
```

运维、迁移与排障见 `qq-bridge/docs/guides/GATEWAY_OPS.md`；每次上线的演练结果记入
`qq-bridge/docs/design/ROLLBACK_LOG.md`。
