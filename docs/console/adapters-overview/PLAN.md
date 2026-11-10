# PLAN：适配器总览（adapters-overview）

> 状态：DONE（2026-11-06）｜ 优先级：P1 ｜ 依赖：auth、usage-billing
>
> 实施记录：server.mjs `GET /v1/console/adapters`（双维度聚合：流量 =
> turn store 扫描（turns/wake/错误码），消费 = ledger.byAdapter() 同源口径）
> 与 `GET /v1/console/adapters/:id/usage`（series 带 adapterId 过滤）。

## 1. 背景与现状

**这是本轮需求的核心目标**：只有网关能统计各适配器的消费与流量——目前这个视图不存在：

- 桥接账本只按 QQ `sessionKey` 记账（`resolveKey` 反查，`qq-bridge/src/bridge.js:2772-2777`），每个桥接实例只能看到自己经手的流量——多适配器（qq / wx，见 `src/executors/adapter-tools/`）在网关侧各自成适配器，桥接账本天然碎片化。
- 网关已有的零散观测：
  - `adapters.json` 注册表：`{ id, secret, callbackBase, platform }`（`src/core/config.mjs:68-97`）；
  - 入站信封带 `adapterId` + `platform`（`src/core/contracts.mjs:130-131`），turn 落盘保留整个 envelope（`turn-runner.mjs:194`）；
  - metrics 计数器按 `platform` 打标签：`gateway_inbound_total`、`gateway_turn_total`（`server.mjs:342`、`turn-runner.mjs:183`）；
  - `/v1/health` 输出网关自身状态（`server.mjs:178`）。
- **小缺口**：`/v1/usage` 输出行目前只有 `platform`，没有 `adapterId`（`server.mjs:381-388`）——虽然 turn record 里有，但行投影漏了。本模块实现时先补这个字段。

## 2. 网关目标态

单页看到每个适配器「是谁、活没活着、烧了多少、跑了多少」：

- **消费**：token 用量与花费（复用 usage-billing 账本，按 `adapterId` 维度聚合）。
- **流量**：入站消息数、turn 数、错误率（`E_DSH_DOWN / E_TIMEOUT / E_ACTION` 分布）、唤醒构成（`wake.kind`）。
- **健康**：基于流量推断（最近 turn 时间、连续错误）+ 注册表静态信息；不主动探测适配器 callbackBase（避免网关→适配器的新依赖；适配器健康上报另立契约）。
- **边界**：只读聚合视图；不做配额/限流（未来按 adapterId 做计费策略时数据已备齐）。

## 3. 目标接口草案

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/console/adapters?window=24h` | `{ ok, adapters: [{ id, platform, registered, lastTurnAt, turns, inbound, errors, errorCodes, tokens, cost, pendingApprovals }] }`；未注册但出现在 turn 记录中的 adapterId 以 `unregistered: true` 列出（防配错密钥的幽灵适配器） |
| `GET` | `/v1/console/adapters/{id}/usage?hours=&buckets=` | 单适配器时间序列（复用 usage-billing 的 series，按 adapterId 过滤） |

## 4. 数据来源

- usage-billing 账本（`src/core/usage-ledger.mjs`）：聚合维度加 `adapterId`——入账点在 turn-runner（取 turn record 的 `envelope.adapterId`），账本采样多存一个字段即可。
- turn-store：turns 数、错误码分布、`lastTurnAt`（`turns.recent` 扫描或账本同源聚合）。
- metrics：`gateway_inbound_total / gateway_turn_total / gateway_wake_total`（platform 标签）读数并入响应（避免前端直连 /v1/metrics 原始格式）。
- `src/core/config.mjs` 的 adapters 注册表：`registered` 标记与静态元数据。
- 前置小改动：`/v1/usage` 行投影补 `adapterId`（`server.mjs:381-388`），供对账期双跑比对。

## 5. 验收标准

- [ ] 两个适配器（qq / wx）同时产生流量时，`GET /v1/console/adapters` 按各自 `adapterId` 正确分账，总花费与 usage/summary 一致（口径对账）。
- [ ] 未在 adapters.json 注册的 adapterId 出现在 turn 记录中 → 以 `unregistered: true` 可见（幽灵适配器可发现）。
- [ ] `errors` 与 `errorCodes` 能区分 E_DSH_DOWN / E_TIMEOUT / E_ACTION（来自 turn result.error.code）。
- [ ] 时间序列接口的桶阶梯与 usage/series 同源（不重复实现）。
- [ ] 适配器离线（长时间无 turn）时 `lastTurnAt` 停留但该行仍返回（不消失）。
- [ ] 未持 operator 凭据 → 401。

## 6. 依赖与优先级

- P1，前置：auth、usage-billing（聚合数据层 + 桶阶梯复用）。
- 实现顺序建议：先补 `/v1/usage` 的 `adapterId` 投影（一行改动，可独立先行）→ usage-billing 账本落地 → 本模块聚合与路由。
- 未来扩展留位：按 adapterId 的配额/限流、计费报表导出——数据层在本模块已备齐，届时只加策略层。

## 7. 桥接侧对称拆除任务

本模块是纯新增（桥接没有对应物），无直接删除项；联动任务：

- [ ] usage-billing 拆除完成后，桥接不再有任何「用量/花费」概念——qq-bridge 仓库 `docs/guides/TOKEN_USAGE_CONSOLE.md`、`GATEWAY_OPS.md` 中「桥接控制台查看用量」的章节改指网关 `/v1/console/adapters`。
- [ ] 多适配器部署文档（未来 wx 桥接接入时）应引用本模块作为流量/消费的统一观测入口，避免新适配器再造账本。

## 8. 多平台扩展（P4.x，2026-11-07 落地）

单消费端（qq-bridge 适配器）时代的「适配器总览」已随 P3 登记目录升格为**消费端统一总览**（网关统筹 qq / wx 等多平台消费端的架构语义）：

- **消费端语义**：消费端 = `adapters.json` 适配器（入站认证载体，`server.mjs` authenticate）∪ 登记目录 `kind=consumer` 服务（编排权限 / 工具 roles 载体）。decorator/filter 登记不并入——它们不承载入站流量。
- **响应新增字段**（只增不改既有语义）：`source: 'adapters.json' | 'registry' | 'both'`（同 id 双来源标注 both，认证仍走 adapters.json）、`name`（登记展示名）、`enabled`、`roles`（该服务登记工具的 roles 聚合）、`platforms`（响应级：按 platform 的用量/花费汇总）。
- **平台维度**：账本采样增 `pf`（`envelope.platform`），`byPlatform()` 聚合与 `series({ platform })` 过滤（usage-billing 侧落地，本模块消费）；旧账本行缺 `pf` 归 `(unknown)`，不迁移。
- **既有缺口修复**：账本 `load()` 重放此前丢失 `aid`——重启后 `byAdapter()` 把旧采样全归 `(unknown)`；重放现保留 `aid/pf`。
- **验收**：`scripts/test-console-services.mjs`（统一总览）+ `scripts/test-usage-billing.mjs`（platform 维度与重放保留）。
