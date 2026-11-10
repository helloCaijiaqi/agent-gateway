# 剩余任务台账（REMAINING TASKS）

> 基线：2026-11-09 检查结果。V2 重构 P1–P5 已全部落地（`docs/design/GATEWAY_V2_REFACTOR.md`
> §4），全量测试 187/187 通过；控制台 7 个模块（auth / dsh-presets / dsh-sessions /
> dsh-pending / usage-billing / adapters-overview / registry-ui）网关侧 API 均 DONE。
>
> 维护口径：每完成一项，把状态改为 DONE（附日期），新增任务项追加条目并保持
> 「现状 / 剩余内容 / 涉及文件 / 前置依赖 / 验收标准 / 优先级」结构，行号引用在
> 改动后随手校正。

## 任务总览

| # | 任务 | 优先级 | 状态 |
|---|---|---|---|
| 1 | 控制台 UI 页面补齐（五模块） | P1 | DONE（2026-11-09，五模块页面全覆盖） |
| 2 | DSH 应答 RPC（审批/提问的应答通道） | P1 | DONE（2026-11-09，附真实 DSH 联调复验遗留项） |
| 3 | 过期文档与注释清理 | P3 | DONE（2026-11-09） |
| — | WX 平台工具面 | 暂缓 | 见「暂缓项」 |

---

## 1. 控制台 UI 页面补齐（五模块）

### 现状

- 五个模块（dsh-presets / dsh-sessions / dsh-pending / usage-billing / adapters-overview）
  的网关侧 API 已实现并通过验收（`docs/console/README.md:18-23` 状态口径注记）。
- 桥接侧旧面板已按 2026-11-06 决定提前拆除，操作者此前只有裸 API 可用。
- 技术选型已定案（2026-11-09）：**JS 层延续原生 + 模板函数；样式与交互组件引入
  Bootstrap 5.3.3（非编译、离线 vendored 至 `public/console/vendor/`，零构建链、
  不进 package.json）**（`docs/design/UI_COMPONENT_SPEC.md` 决策记录；preact+htm
  不采用；SHA-256 与升级步骤见 `vendor/README.md`）。
- **进度（2026-11-09，全部完成）**：第一批三页——`预设提示词`（PresetList +
  SimPromptEditor：编辑/备份/还原/防呆提示）、`模型与会话`（ModelSelector 含全局
  副作用提示 + SessionTable 活跃度列）、`未决提问`（只读 PendingPanel + age 秒级
  刷新 + 容量警示）；顺带修复 `app.js` 编排视图 `consumer.returnEffective`
  未定义变量的既有 bug；样式与布局层落地 Bootstrap 组件（栅格/card/Toast/Modal）。
  第二批两页——`用量计费`（UsageDashboard：统计卡 + series 内联 SVG 柱状走势 +
  会话消费排行 + 逐轮明细 + 价目快照 + reset 双确认）、`消费端总览`
  （AdapterOverview：平台汇总徽标 + 流量/消费并排表 + unregistered 幽灵徽标 +
  per-adapter 走势）。

### 剩余内容

1. [x] 按 UI_COMPONENT_SPEC §3 组件清单逐模块落页面（2026-11-09 全部完成）：
   - [x] `PresetList` + `SimPromptEditor`（编辑/备份/还原/防呆提示——编辑是写
     `agent.cordis.yml` 的 `persona.prefix`，防呆细节见 dsh-presets PLAN §1）；
   - [x] `ModelSelector`（catalog + effort + **全局副作用提示**——`selectModel` 会同时写
     DSH 全局默认，见 `docs/console/README.md` 已知缺口一节）；
   - [x] `SessionTable`（活跃度列）；
   - [x] `PendingPanel`（只读 + age 实时化 + 容量 100 条淘汰警示；应答按钮等任务 2 落地后补）；
   - [x] `UsageDashboard`（summary 卡片 + series 内联 SVG 图 + 会话排行/逐轮明细表
     + reset 双确认——前端两次 Modal + 服务端 `{ confirm: 'reset' }` 幂等字段）；
   - [x] `AdapterOverview`（流量/消费并排 + per-adapter series + 平台维度汇总徽标）。
2. [x] 选型定案后把 `UI_COMPONENT_SPEC.md` 升级为决策记录（2026-11-09，原生 JS +
   Bootstrap 5.3.3 vendored）。
3. [x] token 成本分工展示口径按 usage-billing PLAN §8——会话排行/逐轮明细的
   缓存命中率列使「预设 vs 装饰器 vs once 首轮注入」的成本收益在账面可见。

### 涉及文件

- 新增：`public/console/` 下各模块页面（沿用现有单页结构与 `fetch` 薄封装）。
- 参考：`docs/console/<module>/PLAN.md`（各模块目标接口一节）、`docs/design/UI_COMPONENT_SPEC.md`。

### 前置依赖

- 无硬依赖。**任何依赖安装推迟到 UI 阶段启动时**（UI_COMPONENT_SPEC 约束，无构建链偏好）。

### 验收标准

- [x] 五个模块各有一个可用页面，走 operator Cookie 通道（复用 `OperatorGate`）。
      —— 5/5 全覆盖（2026-11-09：presets / sessions / pending / usage / adapters）。
- [x] 错误呈现统一消费 `E_*` 错误码 + `error.message`；写操作带 JSON content-type + 同源 Origin。
- [x] `selectModel` 页面有全局副作用提示；sim-prompt 编辑有「内容未变不落盘」+ 备份/恢复。
- [x] usage/adapters 图表为内联 SVG，不引入 chart 库（UsageDashboard + per-adapter 走势）。
- [x] `npm test` 全量通过（187/187）；`test-console-services` 静态引用断言已升级为
  **从 HTML 动态提取全部 `/console/` 引用逐个断言 200**（新增 vendor 资源自动纳入防线，
  不改用例数）+ 五模块导航/视图接线断言。

---

## 2. DSH 应答 RPC（审批/提问的应答通道）

### 现状（2026-11-09 已落地）

- DSH 的 `question/requested` / `approval/requested` 事件已在网关暂存
  （pending Map，容量 100 溢出淘汰最旧、不持久化），两条「看见」通道不变：
  控制台 `GET /v1/console/pending` 与平台转发 `GATEWAY_PENDING_FORWARD=on`
  → `ask`/`approve` 出站动作（通知性质）。
- **应答通道已通**：`dsh-client.respondEvent`（`$events/result` unary，
  `{ clientId, eventId, outcome }`）→ `POST /v1/console/pending/{eventId}/respond`
  （operator + JSON CSRF）→ 应答成功条目出列、失败保留可重试；控制台 pending 页
  审批「通过（allowed-once）/拒绝」、提问逐题作答。
- **参数形状证据**（原「须实测目标 DSH 版本」前置的闭合方式）：快照仓
  `qqbridge-snapshot/20261106-171804` 保留的桥接实现与真实 DSH 0.1.5-rc.1 对接过、
  与网关 dsh-client 协议基线同源——`dsh-client.js:622 respond`（`$events/result`
  形状与 `result.ok` 校验）+ `bridge.js:10772-10834`（outcome 值与 questions 对象形状）。
- **红线保持**：应答仅由 operator 显式处置触发，无任何自动应答路径；
  平台转发行为不变。

### 剩余内容

1. [x] **dsh-client 补应答方法**：`respondEvent`（`$events/result` unary），参数形状
   取自快照仓桥接实测实现（见现状）。
2. [x] **控制台端点**：`POST /v1/console/pending/{eventId}/respond`，body 为
   `{ decision }`（审批）或 `{ answers }`（提问），kind 与 body 形状 fail-closed
   互验；前置 `verifyOperator` + `assertConsoleCsrf`。
3. [x] **暂存联动**：暂存条目补 `clientId`；`pendingEntry`（peek）+
   `removePending`（应答成功才出列，失败保留可重试）。
4. [x] **控制台 UI**：pending 页审批双按钮（Modal 确认）+ 提问逐题作答
   （选项下拉或自定义文本）；顺带修复 questions 被当字符串渲染的缺陷。
5. [ ] **遗留项（真实 DSH 联调复验）**：在真实 DSH 环境端到端复验一次——审批
   approve/deny 后 DSH 侧工具调用确实放行/拒绝、提问 answers 后 turn 继续；
   离线测试已覆盖协议形状与路由矩阵，此项只验真实链路。
6. **可选扩展（另行立项）**：桥接反向新增 `ask_user` / `approve_tool` 类动作，让
   QQ 群回复也能成为应答。前置：先设计会话级安全策略（哪个会话的用户有权应答哪个
   DSH 会话的 pending；沿用「只回投原会话」边界）。

### 涉及文件

- `src/runtime/dsh-client.mjs`（respondEvent + RPC 清单注释）。
- `src/runtime/dsh-gateway.mjs`（clientId 入暂存 + pendingEntry/removePending）。
- `src/main.mjs`（runtime.pending 装配 entry/respond）。
- `src/core/server.mjs`（respond 路由，operator 认证 + CSRF）。
- `public/console/`（pending 页应答交互）。
- `docs/console/dsh-pending/PLAN.md`（应答阶段实施记录 + §3 落地）。

### 前置依赖

- ~~外部依赖：目标 DSH 版本实际暴露 approval/question 应答 RPC~~ 已闭合（快照仓
  实测实现为参数形状证据；遗留项 5 做真实环境复验）。
- 红线：不自动应答、不代操作者批准（dsh-pending PLAN §2 边界）；只有 operator 显式
  处置才触发应答调用。

### 验收标准

- [ ] （遗留项 5）真实 DSH 环境：operator 应答 approve/deny 后，DSH 侧工具调用被
      放行/拒绝，pending Map 中该条目消失。
- [ ] （遗留项 5）真实 DSH 环境：对 question 应答 `{ answers: [...] }` 后，DSH 会话
      收到答案并继续 turn。
- [x] 未知 `eventId` / 已淘汰条目 → `E_*` 错误码（404 E_SCHEMA），不抛 500。
- [x] 未持 operator 凭据 → 401（auth 模块统一行为）。
- [x] 平台转发（ask/approve 通知）行为不变，不因应答通道引入自动批准路径。
- [x] `npm test` 全量通过（含 respondEvent 单测 + respond 路由矩阵用例）。

---

## 3. 过期文档与注释清理

### 现状

以下描述与代码现状脱节（功能已落地，文档/注释仍标「占位/缺口」）：

- `docs/console/README.md:52`：已知缺口「提问/审批到不了 QQ」——pending-forwarder
  第二阶段平台转发已于 2026-11-06 落地（`GATEWAY_PENDING_FORWARD` + `ask`/`approve`
  宿主模块），该段描述过时。
- `src/core/service-registry.mjs:260、695`：注释仍写「引擎侧 runReturn 仍占位透传——
  配置未生效」；P5 回路引擎执行已于 2026-11-09 落地（`returnEffective` 已翻面为真实开关）。

### 剩余内容

1. 改写 `docs/console/README.md` 已知缺口一节：平台转发已通，剩余缺口收敛为
   「群回复不算应答」（指向本台账任务 2）。
2. 更正 `src/core/service-registry.mjs` 两处 runReturn 注释（纯注释改动，不动逻辑）。

### 涉及文件

- `docs/console/README.md`
- `src/core/service-registry.mjs`（仅注释行）

### 前置依赖

- 无。可随时执行，建议与任务 2 合并一次提交。

### 验收标准

- [x] 全仓检索 `runReturn` 不再出现「占位透传/未生效」表述（残留命中均为 V2 重构各阶段的历史落地记录与台账自身描述）。
- [x] `docs/console/README.md` 缺口描述与 `pending-forwarder.mjs` 现状一致。
- [x] `npm test` 全量通过（187/187，注释改动不破坏 layering 等静态检查）。

---

## 暂缓项

- **WX 平台工具面**：暂不立项——先调通 QQ 平台后再考虑（2026-11-09 决定）。
  前置条件：wx-adapter 仓库侧产出能力清单（actions-manifest）；在那之前
  `src/executors/adapter-tools/wx/index.mjs` 的 `CAPABILITIES` 保持为空、装配显式拒绝
  （宁可缺工具，不暴露半套目录）。
