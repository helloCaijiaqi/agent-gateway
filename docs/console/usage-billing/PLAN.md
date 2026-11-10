# PLAN：用量与计费（usage-billing）

> 状态：DONE（2026-11-06）｜ 优先级：P1 ｜ 依赖：auth（operator 认证）
>
> 实施记录：账本从 qq-bridge token-ledger 迁移为 `src/core/usage-ledger.mjs`
> （ESM，ingestGatewayTurn→ingestTurn + adapterId 维度），turn 终态进程内直调
> 入账（turnId 幂等，无轮询）；价目表 `src/core/prices.mjs` 可经
> GATEWAY_PRICING 覆盖。路由 `/v1/console/usage/{summary|series|recent|prices|
> reset}` 与 `/usage/conversations/:id`（拒绝 x-agent-token）；`/v1/usage` 行
> 投影补 adapterId。验收：scripts/test-usage-billing.mjs。

## 1. 背景与现状

**数据链的倒置（本模块要修正的核心）**

网关本来持有权威数据，桥接却轮询回去自己记账定价：

- 网关 turn 落盘含 provider 原始 usage 桶（`src/runtime/turn-runner.mjs:194-212`，注释明言「provider usage 原样落盘，桥接 token 账本从 /v1/usage 读，不再看 mux」）。
- `/v1/usage` 端点输出 `{ turnId, sessionKey, platform, at, wake, usage }` 行（`src/core/server.mjs:371-391`）。
- 桥接**每 30 秒轮询**该端点（回看 10 分钟窗口、turnId 幂等防重复计费），喂进本地账本并定价（`qq-bridge/src/bridge.js:2779-2816`，账本创建 2768-2777）。

**桥接账本（待上移的实现）**

- 端点：`GET /api/tokens/summary|series|turns|recent`、`POST /api/tokens/reset`，且显式拒绝 `x-agent-token`（跨群花费是管理信息，不能让群里的 AI 读到——`bridge.js:6712-6750`，6717 行双保险）。
- 账本：`src/ops/token-ledger.js`（约 1000 行）——`createTokenLedger`（102）、`ingestGatewayTurn`（474，turnId 幂等）、`ingestEvent/ingestBaseline/ingestSnapshotRecords`（404/504/537，mux/snapshot 时代的旧入口）、`summary`（702）、`conversation`（770）、`series`（803，桶阶梯 `BUCKET_LADDER_MS` 52-60）、`recent`（930）、`stats`（954）、`reset`（970）。
- 性能教训（迁移时必须保留）：summary 被控制台高频拉取，曾因 O(会话数×采样数) 全量重扫拖垮与 QQ 事件共享的事件循环，后改为缓存索引 + 单遍累加（554-556、840-905 注释）。
- 定价表：`src/ops/model-prices.js`——`PRICE_TABLE_VERSION: '2026-11-04'`、按法定节假日峰谷价（CN_HOLIDAYS 28/55/75）、**三分桶计价**：计费输入 = cacheMiss + cacheRead + cacheWrite 分别计价，不能把 cacheRead 并进 input（14-15 行注释）、`resolvePriceTable(cfg.pricing)`（123）。
- 前端面板：`public/console.html:4765-5042`（series 图表 / summary / turns 明细 / recent / reset）。

## 2. 网关目标态

计费全量上移，**轮询链路整体消灭**：

- turn 完成时（`turns.put` 处，turn-runner 进程内）直接入账，不再有任何 HTTP 拉取与回看窗口。
- 账本持久化到网关 `state/`（沿用桥接 TOKEN_USAGE_FILE 的 JSON 落盘 + 压缩语义），索引缓存与桶阶梯逻辑原样迁移。
- 花费在**读取时**按价目表折算（沿用桥接口径，价目表版本化）；定价表随配置可覆盖（对应 `cfg.pricing`）。
- 会话归属简化：网关账本天然以 `sessionKey` 为主键（桥接的 `resolveKey` 反查 Map 不再需要）；顺带记录 `adapterId`（见 adapters-overview）。
- 桥接 mux/snapshot 时代的旧入口（`ingestEvent/ingestBaseline/ingestSnapshotRecords`）**不迁移**，只迁 `ingestGatewayTurn` 语义（更名 `ingestTurn`）。
- `reset` 保留为危险操作：operator 认证 + 二次确认字段。

## 3. 目标接口草案

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/console/usage/summary?limit=` | 总额/总会话数/按会话花费排行（桥接 summary 702 口径） |
| `GET` | `/v1/console/usage/series?hours=&buckets=` | 时间序列（桶阶梯自动选粒度） |
| `GET` | `/v1/console/usage/conversations/{sessionKey}?limit=` | 单会话逐轮明细（conversation 770 口径） |
| `GET` | `/v1/console/usage/recent?limit=` | 最近采样 |
| `GET` | `/v1/console/usage/prices` | `{ version, symbol, models, peakWindows }` 有效价目快照 |
| `POST` | `/v1/console/usage/reset` | `{ confirm: 'reset' }` 必填；清空账本并记审计日志 |

## 4. 数据来源

- 入账点：`src/runtime/turn-runner.mjs` 的 `turns.put`（194-212）——turn 到达终态即 `ledger.ingestTurn({ sessionKey, turnId, at, usage, model, provider, adapterId })`；turnId 幂等沿用。
- 账本实现：`src/ops/token-ledger.js` 的 summary/series/conversation/recent/stats/reset + 桶阶梯 + 索引缓存迁为网关模块（建议 `src/core/usage-ledger.mjs`）。
- 定价表：`src/ops/model-prices.js` 全量迁入（含峰谷/节假日与三分桶注释），配置项 `pricing` 进 `src/core/config.mjs`。
- 持久化：网关 `stateDir`（与 adapters.json、turn 落盘同目录）。
- model/provider 取值：桥接轮询时用 `cfg.dsh.model/provider` 填充——上移后从网关自己的会话配置取（与 dsh-sessions 模块的 config 消费同源）。

## 5. 验收标准

- [ ] 同一 turn 在网关重启/重复落盘后不重复计费（turnId 幂等回归）。
- [ ] summary/series/conversation/recent 数值与桥接旧账本对同一批 turn record 的计算结果一致（对账测试：迁移期双跑比对，差异仅允许来自旧入口的 mux/snapshot 采样）。
- [ ] 三分桶计价正确：cacheRead 不并入 inputTokens 计价（用构造用例断言）。
- [ ] 高频拉取 summary（≥1 次/秒）不影响 turn 主路径延迟（索引缓存生效的依据：无全量重扫）。
- [ ] `POST /v1/console/usage/reset` 缺 `confirm` 字段时 400；成功后账本清空且审计日志记录操作时间。
- [ ] 网关侧不再出现对 `/v1/usage` 的轮询客户端；桥接轮询代码拆除后账本数据不中断（先上线网关账本，后拆桥接）。
- [ ] 未持 operator 凭据 → 401；`x-agent-token` 头出现时同样 403（语义对标桥接 6717）。

## 6. 依赖与优先级

- P1，前置：auth。
- adapters-overview 依赖本模块的账本聚合层（同一份采样数据，多一个维度）。
- 上线顺序必须先于桥接侧拆除：网关账本上线 → 对账期（双跑比对）→ 拆桥接轮询与端点。

## 7. 桥接侧对称拆除任务

网关账本对账通过后，在 qq-bridge 一次性执行：

- [ ] 删除轮询链路：`USAGE_POLL_MS / usagePollAt / pullGatewayUsage / startGatewayUsagePoll`（`bridge.js:2779-2816`）及启动/停止挂钩。
- [ ] 删除账本创建：`createTokenLedger` 实例化与 `resolvePriceTable(cfg.pricing)`（`bridge.js:2764-2777`）。
- [ ] 删除端点：`/api/tokens/*`（`bridge.js:6712-6750`）。
- [ ] 删除模块：`src/ops/token-ledger.js`、`src/ops/model-prices.js`（逻辑已迁网关）。
- [ ] 删除配置：`cfg.pricing`、`TOKEN_USAGE_FILE` 常量与 `state/` 下的旧账本文件（保留一个版本的备份再删）。
- [ ] 删除前端面板：`public/console.html:4765-5042` 的用量图表区块（网关 UI 上线后）。
- [ ] 文档同步：`qq-bridge/docs/guides/TOKEN_USAGE_CONSOLE.md` 改指网关控制台。
- [ ] `server.mjs`（网关）第 348-349 行「控制台经桥接代理读取」注释随之删除（auth 模块验收项的收尾）。

## 8. 多平台扩展（P4.x，2026-11-07 落地）与 token 成本口径

- **platform 维度**：`ingestTurn` 增 `platform`（turn-runner 入账点取 `envelope.platform` 透传），采样/落盘行带 `pf` 字段（照 `aid` 先例）；`byPlatform()` 聚合与 `series({ platform })` 过滤落地。旧账本行缺 `pf` 归 `(unknown)`，不迁移。重启重放保留 `aid/pf`（顺带修复此前 `load()` 丢 `aid` 的缺口）。
- **cached tokens 价目（已支持，口径记录）**：账本桶本就分 `cacheMiss / cacheHit / cacheWrite / output`，价目表 `off: { cacheHit, cacheMiss, ... }` 分价（如 deepseek-v4-pro：cacheHit 0.15 vs cacheMiss 4.5，约 1/30），读取时经 `priceUsage` 折算、summary 带 `cacheHitRate`——预设 persona / once 首轮注入进缓存前缀的成本收益在账面天然可见，无需额外改造。
- **token 成本分工约束（架构决策记录，与 registry-ui 规则引擎配套）**：
  - 稳定大内容（角色卡/固定人设）→ **DSH 预设**：进 system 稳定前缀，多轮命中缓存，近一次性成本；
  - 动态小上下文（时间/记忆快照）→ **装饰器每轮注入**：内容本就每轮变，无缓存损失；
  - 大内容 per-consumer 差异化 → **装饰器 `once` 规则**（P4.x）：首轮注入进会话历史，此后随前缀命中缓存，成本与预设持平（落点是 user message 而非 system，首轮多付一次全价）；
  - 反模式：大内容装饰器**每轮**注入——每轮全价 + 历史累积 N 份副本随缓存价反复摊销，与预设方式差约两个数量级。
