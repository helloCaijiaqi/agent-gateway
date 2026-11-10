# PLAN：registry-ui（服务注册流程 + 通路/回路编排界面，V2 P4）

> 状态：DONE（2026-11-07）｜ 优先级：P1 ｜ 依赖：[auth](../auth/PLAN.md)（operator 认证，已落地）
>
> 实施记录：`public/console/` 原生 JS 单页三视图（登录/服务/编排/台账，零构建链
> 零新依赖）；`server.mjs` 新增 `/v1/console/services`（注册/卸载/列表/台账）与
> `/v1/console/pipelines`（读写 + fail-closed 校验）两组控制面路由与 `/`、`/console/*`
> 静态处理（GET-only、扩展名白名单、路径穿越防护、console off 整组 404）；
> `service-registry.mjs` 新增 services.json 热加载（`reloadServicesJson`，指纹
> mtime+size 比对）与 `returnPipelines` 回路编排块、`updateConsumerPipeline`（身份
> 门禁 + 形状校验 + 原子落盘 + 热加载）。验收：scripts/test-console-services.mjs。

## 1. 背景与现状（实现前）

- P3 落地了「文件即登记」的磁盘形态：登记目录 `state/gateway/services/<hash>.json`
  + append-only 台账 + 热加载 + 编排权限门禁（service-registry.mjs），但**没有 UI**，
  注册/卸载全靠手工放删文件；编排（services.json `pipelines` 块）同样只能手编。
- operator 认证已就绪（x-operator-token 头 + 登录 Cookie 双通道、CSRF、
  `consoleDisabled`，server.mjs），`/v1/console/*` 已有 dsh-presets 等一批 JSON
  端点——本模块是控制台的第一批页面。
- services.json 的编排块只在启动读一次，UI 改编排需要热加载；登记目录的
  `scanRegistrations(source)` 的 `'operator'` source 正是为本模块预留。
- 回路链（§3.6）：引擎 `runReturn` 于 P5（2026-11-09）接编排为真实执行器
  （与 `runForward` 同构），`returnEffective` 翻面为真实开关。

## 2. 网关目标态

- **登录视图**：operator token 换发 HttpOnly Cookie；会话自检/登出（复用既有
  `/v1/console/session`）。
- **服务注册视图**：注册表单（name/kind/transport/url/timeout/凭据/自有工具
  roles 两层声明）→ 写登记文件即时生效；已注册列表（登记目录 ∪ services.json
  合并视图，含工具面、连接状态、来源文件）；一键卸载；台账审计只读视图。
- **通路/回路编排视图**：按消费端（adapters + 登记 consumer + default）列出
  通路/回路步骤序列；步骤三级解析（内置 protocol → 登记服务 id → 装饰器/过滤器
  工具名）的可用步骤下拉；增删/上下移；保存前 fail-closed 校验；保存即时生效。
- **边界（历史，P4 时点）**：回路初期仅配置 + 校验；P5（2026-11-09）起引擎
  `runReturn` 已接编排，页面与 API 的 `returnEffective` 为真实开关。

## 3. 接口（已落地形态）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/`、`/console/*` | 控制台静态页（GET-only、白名单扩展名、防路径穿越、console off 整组 404） |
| `GET` | `/v1/console/services` | `{ registrationsEnabled, services, registrations, tools }` 合并视图 |
| `POST` | `/v1/console/services` | 注册。body `{ name, kind, transport, url?, timeoutMs?, tools, secret \| secretEnv }`；凭据必填二选一（服务间是 HMAC）；url 回环前置校验；服务端生成 32 位 hash id、写 `<id>.json`（0600）+ secret 独立落 `secrets/<id>.secret`（0600）；`201 { id, active }`（active=false = 装载被拒，见台账） |
| `DELETE` | `/v1/console/services/:id` | 卸载 = 删登记文件 + 配套 secret 文件 + operator 扫描；未知 id 404 |
| `GET` | `/v1/console/services/ledger?limit=` | 台账尾部读取（新在前）+ 坏行计数 |
| `GET` | `/v1/console/pipelines` | per-consumer 通路/回路编排视图 + 可用步骤三级清单 + `pipelineMode` |
| `PUT` | `/v1/console/pipelines/:consumerId` | body `{ forward: [...], return: [...] }`（均可空 = 删除该方向编排）；未知步骤/非消费端 400（写盘前）；通过则原子写 services.json + 热加载即时生效 |

安全约定：全部走 `verifyOperator`；写操作 `assertConsoleCsrf`（JSON + 同源
Origin）；secret 永不回显、不进登记文件与台账（`redactRegistration` 写入侧脱敏）。

## 4. 数据来源

- `src/core/service-registry.mjs`：登记目录/装载校验（`parseServiceRegistration`
  契约、`assertLoopbackUrl` 回环）、编排形状校验（`buildPipelineEntries`）、
  消费端身份集、台账（`registration-ledger.mjs`，append-only JSONL）。
- `src/core/contracts.mjs`：`newRegistrationId`（随机 UUIDv4 去 `-`）、
  `parseServiceRegistration`。
- services.json 新增 `returnPipelines` 块（形状同 `pipelines`；通路/回路分账，
  对既有部署向后兼容）。
- 前端 `public/console/`（index.html + style.css + app.js），原生 JS 零依赖，
  暗色控制台风格，窄屏单列退化。

## 5. 验收标准（scripts/test-console-services.mjs）

- [x] 静态页 GET-only、扩展名白名单、路径穿越 404；`GATEWAY_CONSOLE=off` 整组 404。
- [x] 无 operator 凭据 401；registry 未装配（双开关全 off）503。
- [x] 注册流：非法输入（凭据缺省/双给、非回环 url、kind 词典外）全部 400 且不落盘；合法注册写 `<id>.json` + `secrets/<id>.secret`，登记文件与台账均无明文 secret；台账 `register(source=operator)`。
- [x] 编排 PUT：未知步骤/非消费端键 400 且不写盘；合法保存后 `registry.pipelineFor` 立即反映新编排（热加载）；services.json 保留 services 数组、`pipelines`/`returnPipelines` 分块；清空编排 = 删键 = 透传。
- [x] 卸载：登记文件与配套 secret 删除、consumer 身份消失即编排撤销、台账 `unregister(source=operator)`；未知 id 404。
- [x] 全量回归 169/169（npm test）。

## 6. 依赖与优先级

- 依赖 auth（P0，已落地）；与 dsh-presets 等其余 console 模块并列，无相互依赖。
- 引擎侧回路执行（`runReturn` 接编排）是下一期任务：数据结构与校验已就位，
  届时仅扩展 pipeline.mjs 的 runReturn 与出站链装配。

## 7. 桥接侧对称拆除任务

- 无（本模块是纯新增能力，不替代任何桥接功能）。
- 未来桥接控制台若需入口，可直接链接网关 `/console/`（operator token 同源登录）。

## 8. P4.x 注入规则引擎（2026-11-07 落地）

编排从「纯字符串步骤数组」升级为「字符串或规则对象」双形态（纯字符串数组完全向后兼容），UI 编排页每步骤带规则编辑器：

**条目对象形状**（services.json `pipelines` / `returnPipelines`，多字段即拒）：

```json
{ "step": "card", "once": true, "join": "prefix", "text": "角色卡文本" }
{ "step": "svc", "join": "regex", "pattern": "\\d{11}", "replacement": "[手机号:{extra}]" }
{ "step": "svc", "join": "function", "fn": "return extra ? extra + '\\n\\n' + message : message;" }
```

- `once`：仅会话首轮执行（首轮判定归网关——turn-runner 维护 `promptedSessions` 集合：启动按内存 turn store 播种 + prompt 送达后标记；非首轮整个步骤跳过、不调服务）。重启后旧会话历史可能不可见 → 可能再判首轮重复注入，尽力而为语义。
- `join`：`prefix | suffix | regex | function`。静态条目（带 `text`）缺省 `suffix`；外部装饰器配置 join 时其产出（message 优先，缺省 sections 文本）视为 extra，引擎接管拼接（prefix/suffix 以 `\n\n` 分隔、regex 以 `{extra}` 占位、function 调 `(message, extra) => string`），sections 不再重复收集。未配置 join 保持现行为（message 改写 / sections 追加）。
- **本地静态供料步骤**（条目带 `text`）：内容直接落编排配置、零服务调用；step 名仅为标识、不做三级解析。
- **自定义函数**：函数体字符串经 `new Function('message','extra', body)` 执行。**安全前提：operator 可信 + 回环-only 外壳**。保存/装载期 fail-closed（可编译 + 含 return + 试运行返回 string，regex 同口径可编译）；运行期异常/返回非 string 一律 fail-safe degraded 保留原文。函数应保持纯同步轻量（同步执行无超时手段）。
- **装饰器分层契约（架构决策）**：装饰器定义不降级——契约仍是「消息进消息出」。供料型（只产内容，拼接归编排规则）与加工型（读 ctx `firstTurn` 自治决定注入时机）并存；首轮时 `serviceCallRequest` 带 `firstTurn: true`（contracts schema 已扩）。
- **ctx 透传链**：turn-runner `isFirstTurnOfSession` → pipeline.runForward → serviceCallRequest.firstTurn。
- **UI**：步骤卡片展开「规则」面板——once 胶囊开关、注入模式分段选择器（默认/前缀/后缀/正则/函数）、正则与函数编辑器（本地校验徽标，与服务端保存校验镜像）、本地静态文本步骤（「+ 本地文本」按钮）、测试消息本地预览（与引擎 applyJoin 同构，浏览器端即时执行）。
- **验收**：`scripts/test-pipeline.mjs`（rules 组：装载 fail-closed、once 跳过与 ctx 透传、四种拼接、装饰器 join 接管、运行期 fail-safe、runner 首轮判定）+ `scripts/test-console-services.mjs`（P4.x 双形态保存/回读/落盘）。全量回归 180/180。

## 9. P5 回路引擎接通（2026-11-09 落地）——「已配置未生效」标注退役

- **引擎**：`runReturn` 从占位恒透传重定义为与 `runForward` 同构的链执行器（`pipeline.mjs` 抽取 `runChain` 方向参数化——once/join 规则/预算裁剪/fail-safe 与通路全复用）。编排来源 `pipelineForReturn(consumerId)`（精确键 → `default` 回退 → 空 = 透传）。
- **落点**：出站唯一真路径 = 模型发送工具 → tool-host → adapter-tools `deliverAction`（`POST /v1/actions` 前）——回路链在 `deliverAction` 拦截：`filter` 判 `drop` = 拦截投递（动作不发、按成功回执，模型侧视为已发送）；decorator 改写 / join 规则 = 替换 `payload.text`；链失败/钩子异常 = 保留原文照发。**回合文本不自动投递的不变量不破**（回路只作用于显式发送动作）。`ask`/`approve` 等 text-bearing 动作同链覆盖（pending-forwarder 同一投递路径）。注意：平台宿主自带 `capability.handle` 的出站行为不走 `deliverAction`，不受回路编排约束。
- **契约**：`serviceCallRequest` 增 `direction: 'forward'|'return'`（缺省 forward，既有服务无感）；`returnPipelines` 拒 protocol——装载/热加载/编排写入（`updateConsumerPipeline`）三处 fail-closed，启动期 `pipeline.validate` 同步拒内置步骤。
- **UI/API 翻面**：`/v1/console/pipelines` GET/PUT 的 `returnEffective` 改取引擎真实开关（`GATEWAY_PIPELINE=off` 时 false，徽标回「已配置未生效」）；编排页回路行 `effective` 读 API 字段；视图说明文案更新。
- **验收**：`scripts/test-return-pipeline.mjs`（engine 级 drop/改写/once/静态/default 回退 + transport 级假适配器拦截端到端）+ `scripts/test-console-services.mjs` 翻面断言。全量回归 **187/187**（test 脚本纳入新文件）。
