# UI 组件库规格登记（选型已定案）

> 状态：**DECIDED（2026-11-09 定案：原生 JS + Bootstrap 5.3.3 离线 vendored 组件库，零构建链）**｜原登记 2026-11-06
> 背景：本轮控制台全部以纯 API 交付（curl/测试脚本验证），无前端页面。本文档
> 只把「后续 UI 的技术选型方向与组件面」登记在案，保证届时实现风格统一、
> 不因临时选型漂移。**任何依赖安装都推迟到 UI 阶段启动时**。
>
> **定案记录（2026-11-09）**：第一批 UI（dsh-presets / dsh-sessions / dsh-pending
> 三页）落地时定案两件事——
> ① **JS 层延续原生 + 模板函数**：与现有 `public/console/app.js` 风格一致、
> 零运行时框架；§2 的 preact+htm 方案不采用（五页面规模下组件化成本可控）。
> ② **样式与交互组件引入 Bootstrap 5.3.3（非编译、离线 vendored）**：`npm pack`
> 取 dist 两件（`bootstrap.min.css` + `bootstrap.bundle.min.js`）放入
> `public/console/vendor/`，由网关静态服务直接伺服——不进 package.json、
> 不参与构建，内网/离线可用；SHA-256 校验与升级步骤见 `vendor/README.md`。
> 已落地组件：布局（侧栏 + `row`/`col-*` 栅格 + `card`）、控件（`nav-pills` /
> `form-control` / `form-select` / `table` / `badge`）、交互（Toast 全局提示、
> Modal 二次确认 `confirmDialog()`）；`style.css` 只做品牌主题覆盖。
> 业务组件：`PresetList` + `SimPromptEditor`（含备份/还原/防呆提示）、
> `ModelSelector`（含全局副作用提示）、`SessionTable`（活跃度列）、
> `PendingPanel`（age 秒级刷新 + 容量警示 + **应答交互**——审批通过/拒绝双按钮、
> 提问逐题作答，2026-11-09 应答阶段落地）、
> `UsageDashboard`（统计卡 + series 内联 SVG 柱状走势（峰时琥珀/平时品牌蓝） +
> 会话消费排行 + 逐轮明细 + 价目快照 + reset 双确认）+
> `AdapterOverview`（平台汇总徽标 + 流量/消费并排表 + unregistered 幽灵徽标 +
> per-adapter 走势）——2026-11-09 第二批落地，**§3 组件清单全部完成**。
> 防线：`test-console-services` 从 HTML 动态提取全部 `/console/` 静态引用断言 200
> （新增 vendor 资源自动纳入，无需手工维护清单）+ 五模块导航/视图接线断言。

## 1. 目标与约束

1. **最小化**：控制台是运维面板（表格/表单/只读视图），不需要重型框架；
2. **风格统一**：网关控制台与 qq-bridge 控制台（现 `public/console.html`，
   原生 JS）共用同一套组件语义与视觉变量；
3. **无构建链偏好**：现状为零打包（静态 HTML + 原生 ESM），选型优先支持
   `<script type="module">` 直引或单文件 vendored 分发，不引入 bundler；
4. **与协议库对齐**：前端请求统一走 `fetch` 薄封装（operator Cookie 通道 +
   E_* 错误码约定），不发第二次造轮子。

## 2. 选型方向（2026-11-09 已定案，保留候选对比供追溯）

| 候选 | 说明 | 结果 |
|---|---|---|
| **Bootstrap 5.3（vendored）** | 布局栅格 + 控件 + Toast/Modal 交互组件；dist 两件离线内置，零构建链 | ✅ **采用**（样式与交互层） |
| **preact + htm** | ~4KB 运行时，htm 免编译 JSX；可 vendored 单文件引入 | ❌ 不采用（五页面规模下原生够用） |
| petite-vue | 渐进增强现有 DOM，最贴近 console.html 现状 | ❌ 不采用 |
| 纯原生 + 模板函数 | 零依赖延续现状 | ✅ 采用（JS 逻辑层，与 Bootstrap 互补） |

图表（usage series / adapters 消费）倾向 **内联 SVG 手绘柱状/折线**（数据量
小、无需交互缩放），不引入 chart 库。

> vendor 约定：第三方文件一律放 `public/console/vendor/`（离线内置、不进
> package.json、网关静态白名单伺服），来源 / 许可 / SHA-256 / 升级步骤登记在
> `public/console/vendor/README.md`。

## 3. 组件清单（由控制面模块反推）

| 组件 | 服务的端点/模块 |
|---|---|
| `OperatorGate`（登录/登出/会话续期） | `/v1/console/session`（auth） |
| `PresetList` + `SimPromptEditor`（diff 预览/备份还原/防呆提示） | `/v1/console/dsh/presets*` |
| `ModelSelector`（catalog + effort + 副作用提示） | `/v1/console/dsh/model` |
| `SessionTable`（活跃度列） | `/v1/console/dsh/sessions` |
| `PendingPanel`（age 实时化 + 容量警示 + 审批/提问应答交互） | `/v1/console/pending`、`/pending/{eventId}/respond` |
| `UsageDashboard`（summary 卡片 + series 图 + 明细表 + reset 双确认） | `/v1/console/usage*` |
| `AdapterOverview`（流量/消费并排 + per-adapter series） | `/v1/console/adapters*` |

## 4. 约定

- 错误呈现统一消费 `E_*` 错误码（contracts.mjs）+ `error.message`；
- 所有写操作带 `assertConsoleCsrf` 期望的 JSON content-type + 同源 Origin；
- 视觉变量（颜色/间距/字体）登记为 CSS custom properties，两仓各持一份
  同名文件（与 src/shared/ 的依赖版本对齐策略同口径）；
- 定案时机：V2 P4（编排 UI）启动时，本文档随之升级为决策记录。
