# PLAN：DSH 会话与模型（dsh-sessions）

> 状态：DONE（2026-11-06）｜ 优先级：P1 ｜ 依赖：auth（operator 认证）
>
> 实施记录：dsh-client 增 `modelCatalog()`；session-registry 增 `list()` 快照；
> server.mjs 路由 `GET /v1/console/dsh/model`（活 DSH 目录优先，失败回退
> FALLBACK_EFFORTS 白名单 + selectModel 全局副作用提示）与
> `PUT /v1/console/dsh/model`（effort 白名单校验，overlay 原子落盘
> state/model-overlay.json，main.mjs 启动时应用）；`GET /v1/console/dsh/sessions`
> 带 lastTurnAt 活跃度（turn store 扫描）。验收：scripts/test-console-dsh.mjs。

## 1. 背景与现状

**桥接侧（现有实现）**

- `GET /api/sessions`：遍历桥接本地 `state.sessions` 返回 `{ sessions: [{ key, sessionId, owner }] }`（`qq-bridge/src/bridge.js:4413-4420`）。**网关模式下这是过时视图**：会话真源在网关 `session-registry`，桥接这份只是旧映射。
- `GET /api/dsh/model`：返回 provider/model/当前思考强度 + 档位清单（`bridge.js:4479-4525`）。档位优先取 DSH 实际公布的能力（`session/modelCatalog` RPC，失败退回内置 `REASONING_EFFORT_OPTIONS` 白名单并标 `catalogSource: 'fallback'`，重复失败只记一次日志 4503-4510）。响应带 `globalSideEffect: true`——明确告知管理员 `selectModel` 会同时写会话级与 DSH 全局默认（`~/.dsh/settings.yaml` 的 agent-default-model）（4520-4522）。
- `POST /api/dsh/effort`：写 `config.json` 的 `dsh.reasoningEffort` 并递增 `modelSelectionEpoch`（`bridge.js:4526-4542`；epoch 定义 578 行，消费点 1011 行），让**已在运行的会话**在下一条消息重新 `selectModel`，无需重启桥接或 DSH。
- `selectModel` 应用：每会话去重一次（`bridge.js:8549-8565`），先规范化（provider/model/effort 白名单，1011 行附近），再调 DSH RPC。
- 模型目录 RPC 的版本坑位（重要实测记录）：`session/modelCatalog` 是 0.1.5 形状，**不能走基类门面** `api.sessions.modelCatalog`（桥接钉住的 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2` 没有该方法，会抛错静默退档），必须 `api.callUnary('session.modelCatalog', {})`（`bridge.js:2710-2719`）。
- 前端面板：`public/console.html:2952`（模型/强度）、`2994`（会话列表）、`3150`（改强度）。

**网关侧（已具备的基础）**

- 会话真源：`src/runtime/session-registry.mjs`（`load/persist` 31/44 行，`create` 93 行，会话映射已持久化）。
- 模型应用：`session-registry.applyModel`（75-92 行）——建会话时应用 config 里的 provider/model/effort。
- `selectModel` RPC 已封装：`dsh-client.mjs:352-354`（`session.selectModel`，unary）。
- **缺口**：网关 `dsh-client` 没有 `session/modelCatalog` 封装（RPC 清单见 7-8 行注释）——需按桥接实测形状补齐（见第 4 节）。

## 2. 网关目标态

- **会话列表**：以网关 registry 为真源，合并 turn-store 的最近活跃时间，替代桥接本地视图。
- **模型目录 / 思考强度**：查看（含 DSH 公布档位，失败退回内置白名单）+ 设置。设置后对**活跃会话**生效沿用 epoch 思路：registry 为每个会话记录「已应用的模型签名」，设置时递增 epoch，下一条消息入站时按需重新 `selectModel`（无需重启、无需逐会话立即触达）。
- **边界与必须保留的提示**：
  - `globalSideEffect: true` 警示必须保留（`selectModel` 写 DSH 全局默认，影响 Web GUI 新会话）；
  - 档位只允许 DSH 公布的 `efforts.id` ∩ 内置白名单（防止传非法值让每个会话的 selectModel 每次失败——桥接 1011 行的教训）；
  - provider/model 变更属于会话创建策略，与 `ensurePresetAllowed` 同属 fail-closed 管控，改完必须落盘并在 `/v1/health` 可观测。

## 3. 目标接口草案

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/console/dsh/sessions?limit=` | `{ ok, sessions: [{ sessionKey, sessionId, platform, adapterId, createdAt, lastTurnAt, owner? }] }`；`lastTurnAt` 取自 turn-store |
| `GET` | `/v1/console/dsh/model` | `{ ok, provider, model, reasoningEffort, options, labels, default, providerDefault, catalogSource, globalSideEffect: true }` |
| `PUT` | `/v1/console/dsh/model` | `{ provider?, model, reasoningEffort }` → 校验档位 → 写 config → epoch+1 → `{ ok, epoch }`；非法值 400 `E_POLICY` |

## 4. 数据来源

- `src/runtime/session-registry.mjs`：会话列表与映射；新增「按签名去重应用模型」的 epoch 机制（落盘沿用现有 persist）。
- `src/runtime/dsh-client.mjs`：
  - `session.selectModel`（352-354，现成）；
  - **新增** `session.modelCatalog` unary 封装——形状按桥接实测（`qq-bridge/src/bridge.js:2710-2719`）：`callUnary('session.modelCatalog', {})`，响应含 `groups[].models[].reasoning.efforts[]`（id/name/description）与 `defaultEffort`；**不得**走旧版门面 `api.sessions.modelCatalog`（版本坑位注释一并迁移）。
- `src/core/config.mjs`：`chat` 段的 provider/model/effort 默认值（session-registry 现有消费的同一来源）。
- `src/core/turn-store.mjs`：`lastTurnAt` 聚合。
- 建议落点：`session-registry` 扩展 + `src/core/server.mjs` 路由；目录解析失败的去重日志沿用桥接 4503-4510 模式。

## 5. 验收标准

- [ ] `GET /v1/console/dsh/sessions` 与 registry 持久化文件一致；`lastTurnAt` 与 turn-store 对得上。
- [ ] `GET /v1/console/dsh/model`：DSH 可达时 `catalogSource: 'dsh'` 且档位来自实际公布能力；不可达时 `catalogSource: 'fallback'` 且重复失败只记一条日志。
- [ ] `PUT /v1/console/dsh/model`：非法 effort/model 返回 400 且文件未被改动；合法值落盘 + epoch 递增；下一个入站 turn 触发受影响会话的重新 `selectModel`（同签名不重复调 RPC）。
- [ ] 响应恒带 `globalSideEffect: true`，UI 必须展示该警示（验收含文案检查项）。
- [ ] 未持 operator 凭据 → 401。
- [ ] 既有灰度回归：建会话流程（`ensurePresetAllowed` → `create` → `applyModel`）行为不变。

## 6. 依赖与优先级

- P1，前置：auth。
- 与 dsh-presets 同批实现 `session.modelCatalog` RPC 补齐（网关 dsh-client 控制面 RPC 缺口）。
- epoch 机制与桥接 `modelSelectionEpoch`（`bridge.js:578`）语义对齐，但落点在网关 registry——因为「下一条消息重新 selectModel」的执行方是网关 turn-runner / registry，桥接不再参与。

## 7. 桥接侧对称拆除任务

> **状态更新（2026-11-06）**：本节的**控制台面**部分已提前执行完毕（管理决策：DSH 控制面彻底删除）：
> `/api/sessions`、`/api/dsh/model`、`/api/dsh/effort` 端点与对应前端面板已删；
> `fetchModelCatalog`、`modelCatalogInFlight/modelCatalogErrorLogged`、`settingFromDshNamespace` 已删；
> 模式真源收敛为本地 `state/mode.json`（不再读写 DSH settings 的 `qq-mode` 命名空间）。
> **仍保留**（回滚形态活代码，随本地 DSH 驱动退役时再拆）：`modelSelectionEpoch` 应用链、
> `ensureSession`、`selectModel`（`gateway.mode=off` 本地会话创建仍在用；`modelSelectionEpoch`
> 现仅由回滚路径消费，无控制台热切换入口）。

网关实现并验证后，在 qq-bridge 一次性执行（须在桥接本地 DSH 模式退役后——`selectModel` 应用点 `bridge.js:8549-8565` 与 `ensureSession` 在本地模式下仍是活代码）：

- [ ] 删除端点：`GET /api/sessions`（`bridge.js:4413-4420`）、`GET /api/dsh/model`（4479-4525）、`POST /api/dsh/effort`（4526-4542）。
- [ ] 删除机制代码：`modelSelectionEpoch` 及其消费点（`bridge.js:578`、`1011` 附近、`4537-4538`）、`fetchModelCatalog` 与 `modelCatalogInFlight / modelCatalogErrorLogged`（`bridge.js:576-580`、`2710-2719`、`4488-4510`）。
- [ ] 拆除/收缩 `selectModel` 应用链：`bridge.js:8549-8565`（仅当本地模式退役；`ensureSession` 主体随 DSH 驱动归属一并处理）。
- [ ] 核对后删除 `src/chat/qq-model-view.js`（若其唯一职责是面向 QQ 控制台的 DSH 模型视图；若有平台侧用途则保留并去耦）。
- [ ] 删除前端面板：`public/console.html:2952、2994、3150` 所在的会话/模型区块（删除前全文检索 `/api/sessions`、`/api/dsh/` 引用）。
- [ ] 文档同步：`qq-bridge/docs/guides/DSH_SETUP.md`、`DSH_020_ADAPTATION.md`、`DSH_021_ADAPTATION.md` 中涉及模型选择/会话列表控制台的章节改指网关。

