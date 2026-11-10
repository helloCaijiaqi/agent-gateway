# 控制台（TODO 占位）

本目录是网关控制台 / 网关 UI 的**功能占位目录**：把 qq-bridge 中所有「读 DSH 数据 / 改 DSH 配置 / 计费与流量统计」的功能整理为功能清单与计划书，作为未来在网关侧实现的 TODO 清单。

**当前目录下没有任何运行时代码**——只有计划书。实现时再往 `src/console/`（或相应模块）落码，并把对应 PLAN.md 的状态从 TODO 改为 IN_PROGRESS / DONE。

## 架构原则

1. **桥接只做平台侧**：qq-bridge 只保留 QQ 平台能力（收发消息、表情、语音、社交状态等）。凡是「获取 DSH 数据 / 修改 DSH 配置 / 计费统计」的代码一律不属于桥接。
2. **DSH 控制面归网关**：预设、会话、模型选择等 DSH 读写由网关统一提供（网关本就持有 DSH 客户端与会话注册表）。
3. **计费与流量归网关**：入站信封带 `adapterId` 与 `platform`（`src/core/contracts.mjs:130-131`），turn 落盘含 `result.usage`（`src/runtime/turn-runner.mjs:194-212`）——按适配器聚合消费/流量的主键在网关侧天然齐备。
4. **控制面走 operator 认证，不走 adapter HMAC**：现状 `/v1/turns`、`/v1/usage` 只有适配器 HMAC 认证，控制台没有网关密钥，只能经桥接代理读取（`src/core/server.mjs:348-349` 的注释就是这个临时形态）。未来控制台直接持 operator 凭据访问网关，桥接代理这条链路随之拆除。

## 模块清单

| 模块 | 功能 | 优先级 | 依赖 | 状态 | 替代的桥接功能 |
|---|---|---|---|---|---|
| [auth](auth/PLAN.md) | operator token + Cookie 登录通道 | P0 | 无 | DONE（2026-11-06） | `/api/console/token`（登录形态参考） |
| [dsh-presets](dsh-presets/PLAN.md) | 预设列表；仿真提示词查看/编辑/备份/恢复 | P1 | auth | DONE（2026-11-06，API 层） | `/api/presets`、`/api/preset/sim-prompt*` |
| [dsh-sessions](dsh-sessions/PLAN.md) | 会话列表；模型目录 / 思考强度查看与设置 | P1 | auth | DONE（2026-11-06，API 层） | `/api/sessions`、`/api/dsh/model`、`/api/dsh/effort` |
| [dsh-pending](dsh-pending/PLAN.md) | DSH 审批 / 提问暂存查看 | P2 | auth | DONE（2026-11-06，两阶段） | `/api/pending` |
| [usage-billing](usage-billing/PLAN.md) | token 用量汇总 / 时间序列 / 会话明细 / 定价表 | P1 | auth | DONE（2026-11-06，API 层；P4.x 增 platform 维度） | `/api/tokens/*` + `src/ops/token-ledger.js` + `src/ops/model-prices.js` |
| [adapters-overview](adapters-overview/PLAN.md) | 按适配器聚合的消费与流量总览 | P1 | auth、usage-billing | DONE（2026-11-06，API 层；P4.x 升格消费端统一总览） | 桥接控制台用量看板的聚合视图部分 |
| [registry-ui](registry-ui/PLAN.md) | 服务注册/卸载/台账审计 + 通路/回路编排界面（P4；P4.x 注入规则引擎；P5 回路引擎接通） | P1 | auth | DONE（2026-11-07，P5 2026-11-09） | 无（新增能力，不替代桥接功能） |

> **状态口径（2026-11-09 更新）**：上表 DONE 指**网关侧 API 已实现并通过验收测试**；
> 控制台 UI（`public/console/`，P4 registry-ui）已**五模块页面全覆盖**：登录、
> 服务注册/编排（含 P4.x 注入规则编辑器）、台账、DSH 三页（预设提示词 /
> 模型与会话 / 未决提问只读），以及用量计费（统计卡 + 内联 SVG 走势 + 会话排行 +
> 逐轮明细 + 价目快照 + reset 双确认）与消费端总览（流量/消费并排 + 平台汇总 +
> per-adapter 走势）。
> 选型定案为「延续原生 JS + Bootstrap 5.3.3 离线 vendored 组件库」（布局栅格/card/
> Toast/Modal；`public/console/vendor/README.md` 登记 SHA-256 与升级步骤，
> `docs/design/UI_COMPONENT_SPEC.md` 为决策记录）；
> `test-console-services` 断言五模块导航/视图接线 + 从 HTML 动态提取全部 `/console/`
> 引用逐个断言 200（新增 vendor 资源自动纳入防线）。
> token 成本分工约束（预设 vs 装饰器 vs once 首轮注入）记录在 usage-billing PLAN §8。

优先级含义：P0 = 其他模块的前置，必须先落；P1 = 核心价值（DSH 管控 + 计费上移）；P2 = 观测增强。

## 统一模板

每份 `PLAN.md` 按同一结构撰写，便于实现与对称拆除：

1. **背景与现状**——桥接来源：端点 + 文件：行号（精确到可定位）
2. **网关目标态**——功能描述与边界
3. **目标接口草案**——方法 + 路径 + 关键请求/响应字段（文字级草案，不含实现）
4. **数据来源**——对应网关现有模块 / 存储，不引入新基础设施
5. **验收标准**——可逐条检查
6. **依赖与优先级**
7. **桥接侧对称拆除任务**——要删的桥接端点、前端面板（`public/console.html` 行号）、模块文件；未来网关实现完成后一次性对称改动

接口草案遵守网关既有约定：`/v1/*` 路径风格、`E_*` 错误码（`src/core/contracts.mjs`）、HMAC 幂等头语义沿用；控制面端点一律走 operator 认证。

## 已知缺口（与模块归属无关的现状问题）

- **群回复不算应答**：`question/requested`、`approval/requested` 在 `src/runtime/dsh-gateway.mjs` 暂存，且平台转发已通——`GATEWAY_PENDING_FORWARD=on` 时 `src/runtime/pending-forwarder.mjs` 把条目翻译成出站动作 `ask`/`approve` 投回原会话（通知性质，桥接动作清单已接线 ask/approve），群里能看见 agent 在等输入。**控制台应答通道已通（2026-11-09，dsh-pending PLAN 应答阶段）**：operator 在 pending 页可直接审批「通过（allowed-once）/拒绝」或逐题作答，经 dsh-client `respondEvent`（`$events/result`）回流 DSH。剩余缺口：**QQ 里的回复不会被当作应答**——该可选扩展须先设计会话级安全策略（另行立项）；真实 DSH 环境的应答端到端复验登记在 `docs/REMAINING_TASKS.md` 任务 2 遗留项。
- **`selectModel` 的全局副作用**：DSH 的 `session.selectModel` 会同时写会话级与 DSH 全局默认（`~/.dsh/settings.yaml` 的 agent-default-model），桥接控制台用 `globalSideEffect: true` 字段提示管理员（`bridge.js:4520-4522`）。dsh-sessions 模块必须保留同等提示。
- **仿真提示词编辑是写文件**：`/api/preset/sim-prompt` 直接改 `dsh/agent-presets/*/agent.cordis.yml` 的 `persona.prefix`，含「内容未变不落盘」「备份/恢复」等细节（`bridge.js:4063-4123`）。dsh-presets 模块迁移时需保留这些防呆行为。

## 与 qq-bridge 的关系

桥接侧对称拆除**不在本目录范围内**——各项拆除任务写在各 PLAN.md 第 7 节，等网关侧实现并验证后，在 qq-bridge 仓库一次性执行（删端点、删前端面板、删配套模块，并同步 `docs/` 与自测清单）。

> **状态更新（2026-11-06）**：出于「网关模式下桥接不得直连 DSH」的硬要求，桥接侧的
> DSH 控制面已**提前拆除**（不等网关替代实现）：`/api/presets`、`/api/preset/sim-prompt*`、
> `/api/sessions`、`/api/pending`、`/api/dsh/model|effort`、后台提醒直推、黑话学习全链路、
> 以及 web-search 的 DSH 凭据兜底均已删除；各 PLAN.md 第 7 节已标注执行状态与保留项。
> 网关侧实现这些模块时，可参考各 PLAN.md 第 1 节记录的旧行为（作为目标态的规格来源）。
