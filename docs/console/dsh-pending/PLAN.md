# PLAN：DSH 审批 / 提问查看（dsh-pending）

> 状态：DONE（只读查看 + 平台转发 2026-11-06；应答阶段 2026-11-09）｜ 优先级：P2 ｜ 依赖：auth（operator 认证）
>
> 实施记录（2026-11-06）：
> - 只读查看：`GET /v1/console/pending?sessionKey=&kind=&limit=`（server.mjs），
>   数据源 `dshGateway.listPending()`，sessionKey 经 `registry.sessionKeyOf()` 反查，
>   无映射标 `mapped:false`；响应含 `total/capacity/forward`。
> - 平台转发：`GATEWAY_PENDING_FORWARD=on`（默认 off）装配 `src/runtime/pending-forwarder.mjs`，
>   经 dsh-gateway 的 `onPending` 出口把 question/approval 翻译成出站动作
>   `ask`/`approve`（deliverAction 注入，只回投原会话，通知性质、不自动应答）。
> - 桥接侧：actions-manifest.json 登记并接线 `ask`/`approve`（action-handlers.js
>   格式化文本后走既有 send-message 通道）；网关 qq 平台目录同步 1:1 宿主模块。
>
> 实施记录（2026-11-09，应答阶段）：
> - **参数形状来源**：快照仓 `qqbridge-snapshot/20261106-171804` 保留的桥接实现
>   （与真实 DSH 0.1.5-rc.1 对接过，与网关 dsh-client 协议基线同源）——
>   `dsh-client.js:622 respond`（`$events/result` unary，`{ clientId, eventId, outcome }`，
>   `result.ok` 校验）与 `bridge.js:10772-10834`（审批 outcome
>   `{ kind:'result', value:'allowed-once'|'rejected' }`；提问
>   `{ kind:'result', value:{ answers:[{ id, selected, custom? }] } }`，questions 为
>   `{ id, question, options:[{label}] }` 对象）。原「须实测目标 DSH 版本」的前置
>   以此证据闭合；真实 DSH 环境的端到端放行/拒绝复验登记为遗留项（见 REMAINING_TASKS）。
> - `dsh-client.respondEvent`（`$events/result`）：清单留位就此兑现；
> - `dsh-gateway`：暂存条目补 `clientId`（$events 寻址），新增 `pendingEntry`（peek）
>   与 `removePending`（应答成功才出列，失败保留可重试）；
> - `main.mjs` runtime.pending 装配 `entry`/`respond`（红线：只有 operator 显式处置
>   才调 RPC，无任何自动应答路径）；
> - `POST /v1/console/pending/{eventId}/respond`（operator + JSON CSRF）：审批
>   `{ decision:'approve'|'deny' }`、提问 `{ answers:[...] }`，kind 与 body 形状
>   fail-closed 互验；未知/已淘汰 → 404 E_SCHEMA；DSH 拒绝 → 502 E_DSH_DOWN；
> - 控制台 pending 页：审批「通过（allowed-once）/拒绝」双按钮（Modal 确认）、
>   提问逐题作答（选项下拉或自定义文本）；顺带修复 questions 被当字符串渲染的
>   `[object Object]` 缺陷。验收：`scripts/test-console-pending.mjs`（8 用例）。

## 1. 背景与现状

**桥接侧（现有实现）**

- 端点 `GET /api/pending`：遍历本地 `pending` Map，返回 `{ key, kind, sessionId, toolName?, reason?, approvalId?, questions? }` 列表（`qq-bridge/src/bridge.js:4422-4435`）。
- 数据喂入：桥接直连 DSH mux 时由事件帧填充 `pending = new Map()`（`bridge.js:7687`，写入点 `bridge.js:12095`）。
- **网关模式下恒空**：`gateway.mode=on` 时桥接不消费 mux（`bridge.js:703-704` 注释），该端点对操作者已失去意义——这正是功能归属错位的实证。
- 前端面板：`public/console.html:3017`（`await api('/api/pending')`）。

**网关侧（已具备的暂存）**

- `src/runtime/dsh-gateway.mjs` 维护 pending 暂存：`pending` Map，键为 `eventId`，容量 `PENDING_CAPACITY = 100`、溢出淘汰最旧（`dsh-gateway.mjs:14、19-20、31-37`）。
- 两类事件在 `onFrame` 中记录（`dsh-gateway.mjs:62-75`）：
  - `question/requested`：`{ kind:'question', eventId, sessionId, questions, at }`
  - `approval/requested`：`{ kind:'approval', eventId, sessionId, toolName, callId, reason, at }`
- 已有读取口：`pendingFor(sessionId)`、`pendingCount()`（`dsh-gateway.mjs:118-123`）；turn 结果把它们并入 `degraded` 字段（`turn-runner.mjs:179`），`status()` 暴露 `pendingQuestions`（`turn-runner.mjs:252`）。
- 文件头注释明确 P1 只记录、不自动应答（`dsh-gateway.mjs:8-10`）。

## 2. 网关目标态

控制台只读查看 DSH 未决的提问与审批，替代桥接 `/api/pending`（在网关模式下桥接本来就收不到这些事件）：

- **范围（第一阶段，只读）**：按会话/类型列出未决 question / approval；展示等待时长（age）；标注容量淘汰风险（接近 100 条时提示「最旧条目将被淘汰」）。
- **会话映射**：暂存里只有 DSH `sessionId`，需要经 `session-registry` 反查 `sessionKey`（`platform:kind:id`），无映射的条目显示 `sessionId` 原值并标 `unmapped`。
- **边界（第一阶段不做）**：
  - 不自动应答、不代操作者批准工具调用；
  - **不转发到 QQ**——见下文已知缺口。

**已知缺口（记录在案）**：网关模式下 `question/requested`、`approval/requested` 只在网关暂存，桥接动作清单（`qq-bridge/src/gateway/action-handlers.js`）没有 ask/approve 类动作，群里收不到 agent 主动提问。第一阶段先让操作者在控制台看见；「转发到平台 / 应答回流」作为可选第二阶段（见第 3 节末尾），实现时需要同时设计桥接侧新动作与安全策略（哪个会话的 AI 能看到哪个 pending）。

## 3. 目标接口草案

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/console/pending?sessionKey=&kind=&limit=` | 列出未决条目。响应 `{ ok, pending: [{ eventId, kind, sessionId, sessionKey, mapped, toolName?, callId?, reason?, questions?, at, ageMs }], total, capacity }`。过滤参数均可选；`limit` 默认 100 |

应答阶段（2026-11-09 落地，形状即下方草案）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/v1/console/pending/{eventId}/respond` | `{ decision: 'approve' \| 'deny' }`（审批）或 `{ answers: [{ id, selected?, custom? }] }`（提问）。dsh-client `respondEvent` 走 `$events/result`（参数形状见顶部实施记录）；operator 显式处置才触发，未知 eventId → 404 |

## 4. 数据来源

- `src/runtime/dsh-gateway.mjs`：pending Map（唯一数据源，新增按列表导出的方法，如 `listPending(filter)`）。
- `src/runtime/session-registry.mjs`：`sessionId → sessionKey` 反查（registry 已持有正向映射，新增反向索引即可，不落盘）。
- `src/core/server.mjs`：注册 `/v1/console/pending` 路由，前置 `verifyOperator`（auth 模块）。
- 不新增存储；容量与淘汰策略沿用 `dsh-gateway.mjs` 现状（100 条），不持久化——进程重启即清空，这与「暂存等待人工处置」的语义一致。

## 5. 验收标准

- [ ] DSH 发出 `approval/requested` 后，`GET /v1/console/pending` 能看到该条目，含 `toolName/callId/reason/ageMs`，且 `sessionKey` 正确映射（无映射时标 `unmapped`）。
- [ ] `kind=sessionKey` 过滤生效；`limit` 生效。
- [ ] 超过 100 条时最旧条目被淘汰，响应 `total` 与淘汰行为一致。
- [ ] 未持 operator 凭据访问 → 401（auth 模块统一行为）。
- [ ] 网关重启后 pending 清空（文档化行为，不算 bug）。
- [x] 只读查看阶段无任何应答端点（防止误实现自动批准）；应答阶段落地后红线仍成立：
  应答仅由 operator 显式处置触发（`POST /respond`，operator + JSON CSRF），无任何自动应答路径。

## 6. 依赖与优先级

- P2，前置：auth。
- 实现落点建议：`src/runtime/dsh-gateway.mjs`（导出列表方法）+ `src/core/server.mjs`（路由）；`session-registry` 反查索引。
- 与「转发 QQ」缺口的关系：本模块实现后缺口缩小为「操作者可见但平台用户不可见」；彻底关闭缺口需第二阶段（跨仓改动，见第 3、7 节）。

## 7. 桥接侧对称拆除任务

> **状态更新（2026-11-06）**：控制台查看面已提前删除（管理决策：DSH 控制面彻底删除）——
> `GET /api/pending` 端点与前端「挂起审批/提问」面板已删。`pending` Map 及 mux 事件写入点
> **保留**：它是回滚形态（`gateway.mode=off`）下本地审批/提问应答（`api.respond`）的数据源，
> 待本地 DSH 驱动退役时随 `PLATFORM_DECOUPLE.md` 一并拆除。

网关第一阶段（只读查看）上线并验证后，在 qq-bridge 一次性执行：

- [ ] 删除端点 `GET /api/pending`（`src/bridge.js:4422-4435`）。
- [ ] 删除喂入逻辑：`pending` Map 及其 mux 事件写入点（`src/bridge.js:7687`、`12095` 附近；拆除时以「question/approval 事件帧」全文检索确认完整范围）。
- [ ] 删除前端面板：`public/console.html:3017` 所在的挂起审批/提问区块（含渲染函数，删除前全文检索 `/api/pending` 引用）。
- [ ] 若第二阶段（控制台应答 / 转发 QQ）实现，则反向新增桥接动作（如 `ask_user`、`approve_tool`），届时另立契约文档，不在本清单内。
