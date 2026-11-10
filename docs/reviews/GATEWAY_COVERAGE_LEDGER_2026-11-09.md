# 四仓评审覆盖台账（2026-11-09）

> 口径：`src/` 下全部源码文件逐个判定；`scripts/` 为抽样评估（见 §5），第三方压缩产物不计。
> 判定：**OK** = 读完未发现问题；**RISK(IDs)** = 有登记问题；**部分** = 仅关键路径阅读。
> 问题编号与 `GATEWAY_FULL_REVIEW_2026-11-09.md` 对应。
> 状态（2026-11-09）：台账中的 RISK 项已按 9 个批次修复并通过回归（对照表见评审报告 §11）；本台账保留评审时的判定，不作为当前代码状态。

---

## 1. agent-gateway（src 79 文件 / 18,858 行含 scripts）

### 1.1 入口与共享

| 文件 | 行数 | 判定 |
| --- | --- | --- |
| `src/main.mjs` | 413 | RISK(GW-10) |
| `src/mcp-bus.mjs` | 202 | OK（错误统一映射，行级无背压为已知取舍） |
| `src/shared/http-client.mjs` | 151 | RISK(GW-03) |

### 1.2 core（16）

| 文件 | 行数 | 判定 |
| --- | --- | --- |
| `auth.mjs` | 208 | OK（常量时间比较、先验签后消费 nonce） |
| `config.mjs` | 511 | RISK(GW-02；heartbeat 注释漂移) |
| `contracts.mjs` | 580 | OK（strict schema + 尺寸上限） |
| `idempotency.mjs` | 127 | OK（TTL+LRU、原子写） |
| `metrics.mjs` | 56 | RISK(GW-08) |
| `net.mjs` | 12 | OK |
| `pipeline.mjs` | 415 | RISK(P3：`join=function` 走 `new Function`，依赖 state 目录权限) |
| `prices.mjs` | 243 | OK |
| `registration-ledger.mjs` | 72 | OK（写入侧脱敏） |
| `secrets.mjs` | 133 | RISK(GW-09) |
| `server.mjs` | 1455 | RISK(GW-01, GW-08, GW-11)；health 免鉴权仅回环 |
| `service-registry.mjs` | 844 | RISK(待验证：`httpClients.clear()` 是否泄 socket) |
| `state-store.mjs` | 85 | OK（无 TTL/上限为显式设计） |
| `turn-store.mjs` | 105 | OK（append-only + 轮转） |
| `usage-ledger.mjs` | 968 | RISK(GW-10；`gatewaySeen` 无界) |
| `ws-hub.mjs` | 371 | RISK(GW-05, GW-06, GW-07) |

### 1.3 runtime（10）

| 文件 | 判定 |
| --- | --- |
| `dsh-client.mjs` | RISK(P3：`_authOverrideUsed` 未赋值；stopStream 不清退避定时器) |
| `dsh-gateway.mjs` | RISK(P3：`waiter.turn` 未回填、watching 不回收) |
| `mailbox.mjs` | OK |
| `memory-ingest.mjs` | RISK(GW-14) |
| `pending-forwarder.mjs` | RISK(GW-12) |
| `preset-files.mjs` | RISK(P3：name 校验只在路由层) |
| `prompt-queue.mjs` | RISK(与 GW-04 相关：超时无取消通道) |
| `session-registry.mjs` | OK |
| `tool-host.mjs` | RISK(GW-13) |
| `turn-runner.mjs` | RISK(GW-04；prompt 失败时 waiter 未清理) |

### 1.4 executors（50）

| 文件/组 | 判定 |
| --- | --- |
| `executor-interface.mjs` | OK（REQUIRED_CTX fail-closed） |
| `rolecard-renderer.mjs` | RISK(P3：非 2xx 读 `body.error` 恒 undefined) |
| `web-search.mjs` | RISK(P2：IPv6 私网判定缺口，NAT64/hex 映射未覆盖) |
| `adapter-tools/index.mjs` | OK |
| `adapter-tools/common/crypto.mjs` | OK |
| `adapter-tools/common/catalog.mjs` | OK |
| `adapter-tools/common/session.mjs` | OK |
| `adapter-tools/common/capability.mjs` | OK |
| `adapter-tools/common/manifest.mjs` | OK（与 executor 校验重复，无害） |
| `adapter-tools/common/executor.mjs` | OK（`deliver` 注入缺省保持原行为） |
| `adapter-tools/common/transport.mjs` | RISK(P2：每次新建 client、非 2xx 错误码丢失) |
| `adapter-tools/qq/index.mjs` | OK（37 条与桩一一对应） |
| `adapter-tools/qq/*.mjs`（37 桩） | OK（全部 `passthrough()`，无孤儿） |
| `adapter-tools/wx/index.mjs` | OK（空注册表，装配期显式拒绝） |

### 1.5 前端

| 文件 | 判定 |
| --- | --- |
| `public/console/app.js` | RISK(BR-12：多处未转义插值) |
| `public/console/vendor/bootstrap.bundle.min.js` | 不计（第三方压缩产物） |

---

## 2. qq-bridge（src 24 文件 / 19,318 行含 scripts）

| 文件 | 行数 | 判定 |
| --- | --- | --- |
| `src/bridge.js` 1–3600 | — | RISK(BR-04；P3：镜像开关废弃字段、sendChain、token query) |
| `src/bridge.js` 3600–7092 | — | RISK(BR-05, BR-11, BR-13；错误 message 回显路径) |
| `src/gateway/gateway-client.js` | 467 | RISK(BR-01, BR-02, BR-07) |
| `src/gateway/gateway-actions.js` | 430 | RISK(BR-03, BR-06, BR-09, BR-10) |
| `src/gateway/action-handlers.js` | 372 | RISK(P2：403 折叠、错误码不细分) |
| `src/gateway/actions-manifest.js` | 175 | OK |
| `src/gateway/wait-registry.js` | 137 | OK |
| `src/core/session-router.mjs` | 560 | RISK(P2：构造器覆盖 mode 后未重校验 preset；未接入 bridge.js) |
| `src/chat/forward.js` | 190 | OK |
| `src/chat/md-to-plain.js` | 87 | OK |
| `src/chat/qq-model-view.js` | 116 | OK |
| `src/chat/sensitive.js` | 2 | OK |
| `src/chat/sticker-lib.js` | 251 | 部分（id/resId 字符集未过滤，待验证） |
| `src/chat/v2-wait.js` | 15 | OK |
| `src/shared/http-client.js` | 151 | RISK(GW-03 同源：signal 丢弃) |
| `src/ops/state-acl.mjs` | 104 | RISK(P3：中文 Windows 失败检测失效) |
| `src/media/safe-fetch.js` | 341 | OK（SSRF/重定向/限额/超时实现扎实） |
| `src/media/media-normalize.js` | 372 | RISK(P3：同步读写大 buffer、串行 ffmpeg) |
| `src/media/voice-core.js` | 392 | RISK(P3：临时目录只删文件不删目录) |
| `src/media/send-voice-lib.js` | 27 | OK |
| `src/integrations/snowluma-conn.js` | 183 | RISK(BR-08) |
| `src/core/session-router.test.mjs` | 316 | OK（测试文件） |

---

## 3. memory-mcp（src 26 文件 / 9,111 行含 scripts）

| 文件 | 行数 | 判定 |
| --- | --- | --- |
| `src/server.mjs` | 225 | RISK(P3：信号处理器不退出/不关库) |
| `src/http-api.js` | 222 | RISK(P3：close 不销毁 keep-alive；数组入参放行) |
| `src/mcp-memory.js` | 293 | RISK(P3：`slang_discover` messages 无上限) |
| `src/llm-provider.js` | 62 | OK |
| `src/session-id.js` | 72 | OK（平台段校验挡住路径穿越） |
| `src/slang-discover.js` | 156 | RISK(P3：O(n²) + 每候选重扫) |
| `src/service/gateway-v1.js` | 218 | RISK(MEM-03) |
| `src/service/ws-connector.js` | 225 | RISK(MEM-07, MEM-08, MEM-09) |
| `src/service/memory-service.js` | 423 | RISK(P2：consolidate 非原子、UTF-16 截断) |
| `src/service/raw-service.js` | 344 | RISK(MEM-02, MEM-05) |
| `src/service/recall.js` | 271 | RISK(P2：单元素 platforms 忽略、scope 误报) |
| `src/service/head-builder.js` | 208 | RISK(P2：budget=0 时 `clipText` 返回全文，砍正文) |
| `src/service/forgetting.js` | 84 | OK |
| `src/service/relation-service.js` | 157 | OK |
| `src/service/slang-service.js` | 115 | RISK(P2：UTF-16 截断) |
| `src/service/platform-policy.js` | 44 | OK |
| `src/store/store-api.js` | 265 | RISK(MEM-04；双后端 clamp 不一致) |
| `src/store/json-store.js` | 417 | RISK(MEM-01；count 封顶 200) |
| `src/store/sqlite-store.js` | 245 | RISK(MEM-06) |
| `src/store/sqlite-memory.js` | 237 | OK |
| `src/store/sqlite-raw.js` | 193 | OK |
| `src/store/sqlite-relation.js` | 180 | OK |
| `src/store/sqlite-slang.js` | 132 | OK |
| `src/store/sqlite-snapshot.js` | 55 | OK |
| `src/store/sqlite-schema.js` | 231 | OK |
| `src/store/sqlite-text.js` | 24 | OK（FTS 引号 + LIKE 转义完整，无注入点） |

---

## 4. rolecard-mcp（src 8 文件 / 2,326 行含 scripts）

| 文件 | 行数 | 判定 |
| --- | --- | --- |
| `src/server.mjs` | 124 | RISK(P3：注释与实现不符、退出不关 server) |
| `src/http-api.js` | 124 | RISK(P3：错误统一 400、health 暴露 current) |
| `src/mcp-rolecard.js` | 41 | OK（zod 挡住 maxChars 类型） |
| `src/role-card.js` | 111 | RISK(P3：GEN1 常量死契约) |
| `src/store.js` | 124 | RISK(ROLE-02；tmp 名无随机、不清理) |
| `src/service/gateway-v1.js` | 169 | RISK(MCP-01；与 memory-mcp 漂移 3 处) |
| `src/service/role-service.js` | 84 | RISK(ROLE-01；占位符预留 12 实为 7) |
| `src/service/ws-connector.js` | 225 | RISK(MEM-07 同源：无握手超时、帧无上限) |

**同形副本对比结论**：`ws-connector.js` 两仓零漂移（仅 JSDoc 一句差异）；`gateway-v1.js` 有 3 处实质漂移 —— serviceId 必填性（MCP-01）、构造校验时机（fail-fast vs fail-late）、tools 是否传 `ctx.sessionKey`（rolecard 未传，未来需要会话上下文时会静默 no-op）。

---

## 5. scripts 抽样（说明：未逐文件判定）

| 仓 | 总数 | 已读 | 说明 |
| --- | --- | --- | --- |
| agent-gateway | 27 | 10 | 读 `test-ws-hub`、`test-pipeline`、`test-gateway-contracts`、`test-executor-contract`、`test-layering`、`test-console-auth`、`test-adapter-conformance`、`test-actions-manifest`、`test-web-search`、`test-usage-billing` |
| qq-bridge | 50 | 12 | 读 `test-gateway-ws`、`test-gateway-contracts`、`test-action-layer`、`test-audit-security`、`test-wait-registry`、`test-wait-pushback`、`test-wake-synthetic`、`test-media-normalize`、`test-voice`、`privacy-scan`、`verify-decouple`、`audit-bridge-harness` |
| memory-mcp | 23 | 8 | 读 `test-gateway-v1`、`test-store`、`test-schema-migration`、`test-ingest-idempotent`、`test-platform-isolation`、`test-raw-archive`、`test-ws-connector`、`test-interfaces` |
| rolecard-mcp | 10 | 4 | 读 `test-gateway-v1`、`test-rolecard`、`test-ws-connector`、`test-interfaces` |

未读测试脚本按套件结构登记（`test:*` 脚本集中于契约、状态、语音、控制台四类），未逐项给判定 —— 报告中所有「测试缺口」结论均基于已读脚本的断言范围，而非未读脚本。

---

## 6. 覆盖统计

| 分类 | 数量 | 状态 |
| --- | --- | --- |
| src 源码文件 | 137 | 100% 逐文件判定 |
| 测试脚本 | 110 | 抽样 34（关键契约与安全用例） |
| 前端第三方产物 | 2 | 不计 |
| 配置/清单/示例 | 12 | 作为契约基线读取 |
| **合计** | **261（含重复口径）** | — |

*本台账不含任何真实令牌、QQ 号、群号或本机绝对路径。*
