# 四仓全量代码评审报告（2026-11-09）

> 范围：agent-gateway / qq-bridge / memory-mcp / rolecard-mcp
> 性质：只读评审，未修改任何源码、配置或测试
> 方法：契约基线 → 逐文件 → 横切矩阵 → 证据复核
> 配套：`GATEWAY_COVERAGE_LEDGER_2026-11-09.md`（覆盖台账）
> 状态（2026-11-09）：12 项 P1、27 项 P2 与全部 P3 已按主题分 9 批修复并通过回归，逐项对照见 §11；正文保留评审时的原始描述与证据。

---

## 1. 结论摘要

**未发现 P0（可远程直接利用 / 数据必然损坏 / 生产必然不可用）。** 但存在 12 项 P1，其中最值得先看的 5 项如下（3 项落在最近落地的 WS 双栈代码上，2 项是安全 fail-open），都属于「测试全绿但线上会静默出错」的类型：

1. WS `inbound` 帧没有关联 id，ack 只靠 FIFO 匹配 —— 超时后的迟到 ack 会结算到下一请求上，**turnId 记错、该回落 HTTP 的消息不再回落**。
2. WS 动作回投（`action` 帧）没有在途去重，只有「执行完才写 receipts」—— WS 回执超时触发 HTTP 重投时，**同一条消息会发两次**。
3. 桥接与两个 mcp 仓的 WS 客户端都没有握手超时；`ws` 包在 401/握手挂起时不触发 `close`，`socket` 引用又不会被清空 —— **客户端永久停在「连接中」，ws 模式假死、auto 模式永久回落且熔断不打开**。
4. 网关 `replayWindowMs`（以及另外几个 `Number(env.*)` 数值）没有校验：环境变量写成非数字 → `NaN` → **重放时间窗与 nonce 防重放整体失效（fail-open）**。
5. memory-mcp 的 `tools` 面接受模型传入的 `sessionId`，`forget` 不校验归属 —— 一次提示注入即可**跨会话读/写/删记忆**。

另有 5 项 P1 属于存量缺陷：控制台 token 轮换分支因漏导入 `randomBytes` 必然 500；JSON 兜底存储的 `prune` 忽略会话/层级导致跨会话删记忆；`purge` 的删库顺序与自身注释相反（归档重写失败即部分删除）；SQLite 迁移失败被静默降级为空 JSON 库；rolecard 的 `serviceId` 必填与文档相反会导致启动失败。

### Top-10 优先行动

| # | 行动 | 对应问题 | 预估 |
| --- | --- | --- | --- |
| 1 | 补 `randomBytes` 导入 + rotate 空 body 用例 | GW-01 | 0.5h |
| 2 | 数值型环境变量统一校验器（fail-closed） | GW-02 | 2h |
| 3 | `inbound` 帧加 `callId`（ack 回带）；过渡期超时即 `failAllPending` | BR-01 | 4h |
| 4 | `gateway-actions` 加在途 promise 去重（执行前登记 pending） | BR-03 | 3h |
| 5 | 三个 WS 客户端加握手超时 + socket 归属守卫 + 失败计数 | BR-02 / MEM-07 | 3h |
| 6 | mcp `tools` 面固定 `ctx.sessionKey`，`forget` 加归属校验 | MEM-03 | 3h |
| 7 | JSON 兜底 `prune` 按 session+tier 过滤；迁移失败 fail-closed | MEM-01 / MEM-04 | 4h |
| 8 | `purge` 改为「先重写归档、再删库」；归档只按 anchor(session) 匹配 | MEM-02 / MEM-05 | 5h |
| 9 | rolecard `serviceId` 改回可选；`maxChars` 数值校验 | MCP-01 / ROLE-01 | 1h |
| 10 | `http-client` 透传 `signal`；turn 超时向 DSH 发 `session/cancel` | GW-03 / GW-04 | 4h |

---

## 2. 范围、方法与未覆盖面

### 2.1 规模

| 仓库 | 源码文件 | 行数 | 本次逐文件读完 | 测试脚本 |
| --- | --- | --- | --- | --- |
| agent-gateway | 107（含 27 scripts + 2 public） | 18,858 | src 全部 79（core 16 / runtime 10 / executors 50 / 根 3） | 27 中抽读 10 |
| qq-bridge | 74（含 50 scripts） | 19,318 | src 全部 24（含 `bridge.js` 7092 行分段全读） | 50 中抽读 12 |
| memory-mcp | 49（含 23 scripts） | 9,111 | src 全部 26 | 23 中抽读 8 |
| rolecard-mcp | 18（含 10 scripts） | 2,326 | src 全部 8 | 10 中抽读 4 |
| 合计 | 248 | 49,613 | **137 个 src 文件 100%** | 30 个关键用例 |

**未逐行覆盖**：其余测试脚本（按套件结构登记，不逐个判定）、`public/console/vendor/bootstrap.bundle.min.js`（第三方压缩产物）、`*.json` 清单/示例（作为契约基线读取，非代码评审对象）。这不是「全仓 100% 逐文件」，如实标注。

### 2.2 证据等级

- **✅ 已复核**：本报告作者在评审期间直接读取代码确认（P1 全部属于此类）。
- **◐ 待复核**：子代理报告、静态阅读合理但未二次确认；表中已标注，不计入 Top-10。
- 每条问题均给 `file:line`；无法定位的降级为「待验证」（见附录）。

### 2.3 判据

以「实现 vs 设计声明」和「实现 vs 自身不变量」为准，不做风格评判。设计声明来源：`docs/design/GATEWAY_V2_REFACTOR.md` §2、`docs/FOLDER_MAP.md`、各仓 README / `config.example.json` / `actions-manifest*` / `gateway-registration.example.json`。

---

## 3. 跨仓契约矩阵

| 契约 | 网关实现 | 桥接实现 | mcp 实现 | 一致性 |
| --- | --- | --- | --- | --- |
| HTTP 签名 | `core/auth.mjs:145` `${ts}\n${nonce}\n${sha256(body)}` | `gateway-client.js:53` 同式 | `service/gateway-v1.js:73` 同式 | ✅ 公式一致 |
| WS 握手签名 | `ws-hub.mjs` 空 body 同式 | `gateway-client.js:70` 同式 | `ws-connector.js` 空 body 同式 | ✅ 公式一致（网关已改 `safeEqualHex`，GW-06） |
| 恒定时间比较 | HTTP ✅ `safeEqualHex`；WS ✅（G-06 已修） | ✅ `timingSafeEqual` | ✅ `timingSafeEqual` | ✅ |
| 时钟窗 / nonce | `intInRange` 校验 + 有界缓存 | 同 | 同（capacity 100k） | ✅（GW-02 已修） |
| `inbound` 帧 | `{v,type,callId,envelope}` → ack 回带 `callId`+`adapterId` | 优先按 callId，无 callId 退回 FIFO | — | ✅（BR-01 已修） |
| `action` 帧 | `callId` 关联，带 `bodyHash` 摘要签名 | 优先用 bodyHash 验签，缺省退回重序列化 | — | ✅（BR-09 已修） |
| `action/result` | 校验 `callId` + `kind` | `{...receipt}` + actionId | — | ✅ |
| `service.call/result` | `ok`+`result` | — | `result: body` | ✅ |
| `tool.call/result` | 要求 `error:{code,message}` | — | 统一 `{code,message}` | ✅（MEM-08 已修） |
| 幂等键 | inbound=`adapterId:platform:kind:id:msgId`（兼容读旧键） | action=`idempotencyKey\|type\|kind:conversationId` | tool=`tool:callId` | ✅（GW-07 / BR-10 已修） |
| 传输三态 | registry `http` / `ws` / `auto` | `http` / `ws` / `auto` | 连接器 `ws` / `auto`（无「强制 ws」） | ✅ 语义不对称已文档化（`GATEWAY_V2_REFACTOR` §2） |
| 降级语义 | WS 失败回落 HTTP（组合根） | `auto` 回落一次 + 熔断；`E_DISABLED` 不重投 | 断线期间 registry 回落 HTTP | ✅（BR-07 已修：建连失败也计熔断） |

---

## 4. 安全与鉴权边界

### P1

**GW-02 `agent-gateway/src/core/config.mjs:491` — 数值型环境变量未校验，NaN 使重放防御 fail-open** ✅
```js
491: replayWindowMs: Number(env.GATEWAY_REPLAY_WINDOW_MS ?? 5 * 60 * 1000),
```
`auth.mjs:139` 的 `Math.abs(now - timestamp) > windowMs` 在 `windowMs=NaN` 时恒 false（时间窗失效）；nonce 过期时间变 `NaN` 后 `prune` 每条都删（缓存恒空）。同类的 `GATEWAY_TURN_TIMEOUT_MS`、`GATEWAY_TOOL_CALL_TIMEOUT_MS`、`GATEWAY_CONSOLE_SESSION_TTL_MS`、`GATEWAY_DSH_TIMEOUT_MS` 也未校验，NaN 会变成 `setTimeout(NaN)` 立即触发。
**建议**：统一 `intInRange(name, min, max)`，非法即抛（与 `GATEWAY_WS_HEARTBEAT_MS` 现有口径一致）。
**回归**：`test-gateway-contracts.mjs` 增加非法值启动失败用例。

**MEM-03 `memory-mcp/src/service/gateway-v1.js:108-133` — tools 面越权：接受模型传入的 sessionId，forget 无归属校验** ✅
```js
111: sessionId: args.sessionId ?? ctx.sessionKey,
130: chat_memory_forget: (args) => { ...memory.forget({ id: args.id, mode: args.mode }) }
```
`/v1/tools/call` 的 args 由模型生成；提示注入可跨会话检索、写入他人会话、按 id 硬删记忆（`mode:'hard'` 物理删除）。`/api/*` 由桥接固定 sessionId，风险等级不同。
**建议**：tools 面忽略 `args.sessionId`（以 `ctx.sessionKey` 为准）；`forget` 先查行归属再删；写操作前置 `platformPolicy`。
**回归**：`test-gateway-v1.mjs` 加「args 传他人 sessionId 不生效」「forget 他人 id 被拒」。

### P2

| ID | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| GW-06 | `core/ws-hub.mjs:77` | 握手签名 `!==` 比较，非恒定时间；与 HTTP 侧 `safeEqualHex` 口径不一致 | 复用 `safeEqualHex` |
| GW-07 | `core/ws-hub.mjs:231-240` | inbound 帧只校验 platform，不校验 `envelope.adapterId === entry.id`；同平台双适配器可互相「占」幂等键（键不含 adapterId） | 帧内校验 adapterId；幂等键纳入 adapterId |
| GW-08 | `core/server.mjs:1428` + `core/metrics.mjs:14` | 指标标签用原始 pathname，无基数上限；本机进程可循环随机路径撑爆 Map | 路由模板归一 + 标签上限 |
| GW-09 | `core/secrets.mjs:67` | 生成的密钥文件未设 `mode: 0o600`（其它凭据落盘均 0600） | 补 mode + Windows ACL 提示 |
| GW-10 | `main.mjs:314` vs `core/usage-ledger.mjs:104` | 传入 `logger`，账本解构 `log` → 落盘失败完全静默，计费数据悄悄丢失 | 改传 `log`，并暴露 `appendFailures` |
| MEM-09 | `memory-mcp/src/service/ws-connector.js:74` | 共享密钥的签名放 URL query，且未限制目标为回环；帧本身不验签，URL 指错即把写操作暴露给伪网关 | 强制 loopback 或 `wss:`；写操作帧加签 |
| BR-11 | `qq-bridge/src/bridge.js:2295` | 控制台令牌接受 `?token=` 查询串（进浏览器历史/代理日志） | 仅 header / HttpOnly cookie |
| BR-12 | `agent-gateway/public/console/app.js:504,578-581,635-640` | 多处 `innerHTML` 直接插入服务 id / 拒绝原因 / 台账快照，同文件已有 `escapeHtml` 未统一使用 | 统一转义或改 `textContent` |

### P3

- ✅（已修，见 §11）`bridge.js:2153` 启动日志回显控制台令牌前 6 位；`bridge.js:2499` 活动日志写群号/ownerQQ（ACL 未收紧时可读）。
- ✅（已修，见 §11）`agent-gateway` `/v1/health` 免鉴权（仅回环可达）返回 pid/uptime/ws 连接数/服务状态，建议拆「探针 / 详情」两端点。
- ✅（已修，见 §11）`rolecard-mcp/src/http-api.js:82-90` health 暴露当前角色名。

---

## 5. 正确性与边界

### P1

**BR-01 `qq-bridge/src/gateway/gateway-client.js:189-197,328-343` — inbound ack 纯 FIFO，无 callId** ✅
```js
189: function settlePendingInbound(result) {
190:   while (pendingInbound.length > 0) { const entry = pendingInbound.shift(); ... }
...
333: const entry = { resolve, timer: null, dead: false };
334: entry.timer = setTimeout(() => { entry.dead = true; splice(...); resolve({ok:false,...}) }, timeoutMs);
```
网关 ack 慢于 `timeoutMs` 时：A 的迟到 ack 结算 B，B 的 ack 结算 C —— 级联错位。后果：`bridge.js` 把 A 的 turnId 记到 B 上；auto 模式下 B 真实失败却拿到 `ok`，不再回落 HTTP（丢消息）。
**建议**：`inbound` 帧加 `callId`（网关 `ws-hub.mjs:240` 的 ack 回带）；协议未升级前，超时应 `failAllPending`（顺序不可信即整体作废）。
**回归**：`test-gateway-ws.mjs` 加「ack 延迟跨过 timeout」用例。

**BR-02 `gateway-client.js:265-306` — 握手无超时，socket 引用不清空** ✅
`new wsImpl(url)` 未传 `handshakeTimeout`；`onError` 只打日志；`connect()` 首行 `if (... || socket) return`。`ws` 包在 HTTP 401 / 握手挂起时通常不触发 `close`（而是 `unexpected-response`），于是：ws 模式每条消息等满超时后如实失败且永不恢复；auto 模式永久回落 HTTP，`transportState.ws` 恒为 connecting。
**建议**：`{ handshakeTimeout: timeoutMs }` + 连接看门狗（N 秒未 open → `terminate()` 后走退避）+ 所有回调加 `if (sock !== socket) return` 归属守卫。

**BR-03 `qq-bridge/src/gateway/gateway-actions.js:344-359` — 动作在途未去重，WS 超时 + HTTP 重投会双执行** ✅
```js
347: const cached = receipts.get(cacheKey);
352: let receipt;
354: receipt = await execute(envelope);   // 执行完才写 receipts
359: receipts.set(cacheKey, { receipt, at });
```
网关 `callAction` 超时（默认 8s）后回落 `POST /v1/actions`；此时桥接可能仍在 `sendToQQ`（无超时）。重投命中不到缓存 → 第二次执行 → **同一句话发两遍**。
**建议**：执行前 `receipts.set(key, {pending})`，重复请求 `await` 同一个 promise；`ok:false` 的业务失败不缓存（或短 TTL），避免「瞬时失败永久拒重试」。

**GW-01 `agent-gateway/src/core/server.mjs:21,591` — rotate 自动生成 token 分支必然 500** ✅
```js
21: import { randomUUID } from 'node:crypto';
591:   : randomBytes(24).toString('base64url');
```
不带 body 调 `POST /v1/console/session/rotate` → ReferenceError → E_INTERNAL。现有测试始终显式传 token，故未暴露。
**建议**：补导入 + 空 body 用例。

**GW-03 `agent-gateway/src/shared/http-client.mjs:39-59,88-92`（qq-bridge 同名副本同样）— signal 被传输层丢弃** ✅
`attempt()` 传入 `signal`，`axiosTransport` 解构里没有它，`instance.request` 也不带。后果：`dsh-client` 的取消契约失效（`retireSession` 的 8s AbortSignal 被 30s axios timeout 取代），关停时请求仍在飞。
**建议**：透传 `signal`（或 `AbortSignal.any` 合并 per-call timeout）；补 abort 用例。

**GW-04 `agent-gateway/src/runtime/turn-runner.mjs:175-206` — turn 超时不取消 DSH 会话** ✅（全仓仅 `dsh-client.mjs:397` 有 `session/cancel`，turn-runner 未调用）
`awaited` 超时返回 `{status:'timeout'}` 后直接落结果，`prompt-queue` 随即放行下一 job → 同会话并发 prompt（正是队列要避免的交错上下文），usage/文本可能串轮。
**建议**：超时分支 `callUnary('session/cancel')` 并等待确认，或 lane 保持 running 直到取消生效。

**MEM-01 `memory-mcp/src/store/json-store.js:149-166` — 兜底后端 prune 忽略 sessionId/tier** ✅
`memory-service.js:41-49` 明确按 `(sessionId, tier, maxEntries)` 调用，而 JSON 实现只看整表长度 → SQLite 不可用降级后，写 A 会话会按最低分删掉 B 会话、甚至长期层。
**建议**：JSON `prune` 与 `sqlite-memory.js` 同语义；`test-store.mjs` 双后端跑同一断言。

**MEM-02 `memory-mcp/src/service/raw-service.js:223-233,327-332` — 删库早于归档重写，与自身注释相反** ✅
`collectVictims` 边扫边 `store.raw.purge(...)`；`rewriteArchivesFor` 在之后执行，失败直接抛出，库里已删、盘上原文还在，`cascadeDerived`/快照失效全部跳过。
**建议**：只 SELECT 定位 → 重写归档 → 再删库+级联；失败写入可重试清单。

**MEM-04 `memory-mcp/src/store/store-api.js:56-65` — 迁移失败被当作「打不开」静默降级空 JSON 库** ✅
`sqlite-store.js` 的 `StoreUnavailableError('迁移失败')` 落入兜底 catch → 服务「看起来健康」，新写入进空 `memory.json`，旧库数据消失。
**建议**：区分「打开/建表失败」与「迁移失败」；后者快速失败或只读禁写。

**MCP-01 `rolecard-mcp/src/service/gateway-v1.js:40` — serviceId 强制必填，与自身注释和 memory-mcp 相反** ✅
`server.mjs:27-28` 注释「可选——不设则只验签名」；`if (!serviceId) throw` 使只配 secret 的部署直接起不来。
**建议**：删除 throw，保留 `if (serviceId && id !== serviceId)`。

### P2

| ID | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| GW-05 | `core/ws-hub.mjs:112-120` | 只发 ping、无 pong 期限；半开连接永久滞留，`isConnected` 恒真 → auto 每条调用等满超时 | 记录 lastFrameAt，连续 N 次无帧即 terminate；修正 config 注释 |
| GW-11 | `core/server.mjs:116-123` | turn/幂等在 `runtime.submit` 之前落盘；submit 同步抛错后重试命中 deduped，消息永久丢失 | try/catch 回滚幂等条目 |
| GW-12 | `runtime/pending-forwarder.mjs:88-91,122-126` | 投递前 `forwarded.add`，失败不重试不回收 → 一次抖动后审批/提问永不再通知 | 失败 delete + 退避重试 |
| GW-13 | `runtime/tool-host.mjs:139-159,167-171` | 每次调用残留 20s 未清理定时器；`suppressed`（回路链 drop）被计为 sent 并触发记忆沉淀 | 保存并 clearTimeout/unref；`!outcome.suppressed` |
| GW-14 | `runtime/memory-ingest.mjs:88-96,120-166` | `retrying` 无上限；`flushSession` 同步抛出可穿出 observe；interval 内重入可双投 | 上限+计数、Promise 包裹、running 互斥 |
| BR-07 | `gateway-client.js:405-411` | `awaitWsOpen` 失败直接走 HTTP，不计入失败 → WS 长期挂掉时熔断永不打开，每条多付一个超时 | 建连失败计入 breaker |
| BR-04 | `bridge.js:3205-3213` | `bootstrapSent` 先置真后 fire-and-forget 投递；失败即永久丢失初始提示词且回 `{ok:true}` | 成功回执后再置位 |
| BR-05 | `bridge.js:1298,1495` | 单一全局 `sendChain` 跨会话头阻塞（语音预算 60s），链上无 `.catch` 复位 | 按会话分链 + 链尾 catch |
| BR-06 | `gateway-actions.js:151-157,318-332` | 清单模式 `send_text` 绕过 4000 字上限；403 折叠成 `E_UNSUPPORTED`；`get_message_images` 回执内联 base64 可超 4MB 帧上限 | 上限下沉 handler；错误码细分；data 字节上限 |
| BR-13 | `bridge.js:4229-4243` | wait 租约被接管后旧循环仍运行 → 双唤醒/双记账 | 循环内每轮校验租约 |
| MEM-05 | `raw-service.js:250,283-300` | 归档按 msgId 跨会话匹配可误删他人同号消息；级联游标用 `createdAt` 单键，同毫秒批量会漏扫 | 归档只按 anchor；复合游标 `(createdAt,id)` |
| MEM-06 | `store/sqlite-store.js:171-186` | `transaction` 不防 async fn，COMMIT 早于异步体 | 检测 Promise 即 ROLLBACK；拒绝嵌套 |
| MEM-07 | `service/ws-connector.js:169-185` | 无握手超时；`socket` 先赋值后 open；stop/start 竞态可双连接 | handshakeTimeout + 归属守卫 + removeAllListeners |
| MEM-08 | `service/ws-connector.js:122-126` | `tool.call` 契约错误回 string error，违反网关 `error:{code,message}` schema → 被降级为「工具不可用」 | 归一为 `{code:'E_SCHEMA',message}` |
| ROLE-01 | `rolecard-mcp/src/service/role-service.js:81-87` | `maxChars` 非数字 → `Math.max(1,NaN)=NaN` → 截断整体失效，人格段无界注入 | `Number.isFinite` 兜底 |
| ROLE-02 | `rolecard-mcp/src/store.js:66-75` | 缓存 key 含 mtime 无界增长；每轮 render 3 次同步 IO | 按 name 存 `{mtime,size,text}`；合并 stat |
| BR-08 | `integrations/snowluma-conn.js:220` | config.json 直接覆写非原子（含 token），写一半即毁配置 | tmp+rename |

### P3（择要）

- `bridge.js:1828` P4 镜像开关依赖已声明废弃的 `gateway.mode/state` 字段 → 普通配置下镜像静默 no-op。
- `bridge.js:2127-2130` 两个 `setInterval` 无 unref/teardown；退出钩子与模块级 `SIGINT` 重复注册（`8086` 直接 `process.exit`）。
- `memory-mcp/src/server.mjs:216-225` 注册 SIGINT/SIGTERM 后只 stop 连接器 → 启用 WS 后 Ctrl-C 不再退出、库不 close。
- `memory-mcp/src/slang-discover.js:126-162` O(n²) 去重 + 每候选重扫，`messages` 无上限，可卡死 stdio。
- `rolecard-mcp/src/role-card.js:119` `GEN1_ROLE_LINE_RE` 是死契约（导出无使用）。
- `qq-bridge/src/ops/state-acl.mjs:94` 失败检测依赖英文 `access is denied`，中文 Windows 失效。

---

## 6. 性能、资源与可维护性

| 主题 | 观察 | 建议 |
| --- | --- | --- |
| `bridge.js` 7092 行单体 | 配置、控制台路由、动作执行、媒体、唤醒、状态全在一个文件；退出/启动路径重复注册信号处理器 | 拆 `console/`、`actions/`、`wake/`、`state/` 四个模块；单一退出钩子（close → flush → releaseLock → exit） |
| 全局 `sendChain` | 跨会话串行，语音 60s 预算放大头阻塞 | 按 `key` 分链 |
| 表情发送热路径 | 每条都 `syncStickerLibrary(true)` + `writeFileSync` | in-flight 复用 + 最小刷新间隔 |
| 每动作新建 HTTP 客户端 | `transport.mjs:103` 每次 `createHttpClient`，无 keep-alive 复用 | 按 `adapter.id` 缓存 client |
| 控制台轮询 | `/api/status` 每次同步读整个活动日志 | 内存环形缓冲 |
| mcp 连接器 | 帧无大小/并发上限（`rolecard` 同步文件 IO 串行阻塞） | 帧上限 + 在途计数 + `E_BUSY` |
| SQLite | `transaction` 无 async 防护（MEM-06）；连接/语句生命周期测试薄弱 | 加 `inTransaction` 标记与并发用例 |
| 指标 | 标签基数无界（GW-08） | 路由模板化 |

---

## 7. 问题总表

等级定义：P0 可远程利用/必然损坏/必然不可用；P1 有明确触发条件的正确性缺陷或高风险契约不一致；P2 韧性/性能/资源债务；P3 文档、命名、观测性。

| ID | 等级 | 位置 | 一句话 | 复核 |
| --- | --- | --- | --- | --- |
| BR-01 | P1 | qq-bridge `gateway-client.js:189-343` | inbound ack FIFO，无 callId，迟到 ack 错配 | ✅ |
| BR-02 | P1 | qq-bridge `gateway-client.js:265-306` | 握手无超时，socket 不清空，连接永久假死 | ✅ |
| BR-03 | P1 | qq-bridge `gateway-actions.js:344-359` | 动作在途无去重，WS+HTTP 双执行 | ✅ |
| GW-01 | P1 | agent-gateway `core/server.mjs:591` | rotate 漏导入 randomBytes，必然 500 | ✅ |
| GW-02 | P1 | agent-gateway `core/config.mjs:491` | 数值 env 无校验，NaN 使重放窗失效 | ✅ |
| GW-03 | P1 | agent-gateway `shared/http-client.mjs:39-92` | signal 被丢弃，取消/关停失效 | ✅ |
| GW-04 | P1 | agent-gateway `runtime/turn-runner.mjs:175` | turn 超时不 cancel，下一 job 并发 | ✅ |
| MEM-01 | P1 | memory-mcp `store/json-store.js:149` | JSON prune 忽略 session/tier，跨会话删记忆 | ✅ |
| MEM-02 | P1 | memory-mcp `service/raw-service.js:223-332` | 先删库后重写归档，失败即部分删除 | ✅ |
| MEM-03 | P1 | memory-mcp `service/gateway-v1.js:108-133` | tools 面跨会话读写删记忆 | ✅ |
| MEM-04 | P1 | memory-mcp `store/store-api.js:56` | 迁移失败静默降级空 JSON 库 | ✅ |
| MCP-01 | P1 | rolecard-mcp `service/gateway-v1.js:40` | serviceId 必填与注释相反，启动失败 | ✅ |
| GW-05 | P2 | `core/ws-hub.mjs:112` | 无 pong 期限，半开连接滞留 | ✅ |
| GW-06 | P2 | `core/ws-hub.mjs:77` | 握手非恒定时间比较 | ✅ |
| GW-07 | P2 | `core/ws-hub.mjs:231` | inbound 不校验 adapterId | ✅ |
| GW-08 | P2 | `core/server.mjs:1428` | 指标标签基数无界 | ✅ |
| GW-09 | P2 | `core/secrets.mjs:67` | 密钥文件未 0600 | ✅ |
| GW-10 | P2 | `main.mjs:314` | 账本 logger 参数名错位，失败静默 | ✅ |
| GW-11 | P2 | `core/server.mjs:116` | 幂等先落盘，submit 同步失败即永久丢消息 | ✅ |
| GW-12 | P2 | `runtime/pending-forwarder.mjs:88` | 先标记后投递，失败不重试 | ✅ |
| GW-13 | P2 | `runtime/tool-host.mjs:139-171` | 定时器残留；suppressed 计为 sent | ✅ |
| GW-14 | P2 | `runtime/memory-ingest.mjs:88-166` | 重试表无界、同步抛出、重入双投 | ✅ |
| BR-04 | P2 | `bridge.js:3205` | bootstrapSent 先置真，投递失败即永久丢失 | ✅ |
| BR-05 | P2 | `bridge.js:1298` | 全局 sendChain 头阻塞 | ✅ |
| BR-06 | P2 | `gateway-actions.js:151,318` | 长度上限/403 折叠/base64 回执超限 | ✅ |
| BR-07 | P2 | `gateway-client.js:405` | 建连失败不计熔断 | ✅ |
| BR-08 | P2 | `snowluma-conn.js:220` | 配置非原子写 | ✅ |
| BR-09 | P2 | `gateway-actions.js:333` | 帧验签依赖重序列化 | ✅ |
| BR-10 | P2 | `gateway-actions.js:346` | 幂等键不含 type/target | ✅ |
| BR-11 | P2 | `bridge.js:2295` | 令牌走查询串 | ✅ |
| BR-12 | P2 | `public/console/app.js:504` | 未转义插值（存储型 XSS 面） | ✅ |
| BR-13 | P2 | `bridge.js:4229` | wait 租约接管后旧循环仍在跑 | ✅ |
| MEM-05 | P2 | `raw-service.js:250,283` | 归档 msgId 跨会话误删；级联漏扫 | ✅ |
| MEM-06 | P2 | `sqlite-store.js:171` | transaction 不防 async | ✅ |
| MEM-07 | P2 | `ws-connector.js:169` | 握手无超时 + stop/start 竞态 | ✅ |
| MEM-08 | P2 | `ws-connector.js:122` | tool.call 错误形状违约 | ✅ |
| MEM-09 | P2 | `ws-connector.js:74` | secret 派生签名进 URL，未限回环 | ✅ |
| ROLE-01 | P2 | `role-service.js:81` | maxChars NaN 使截断失效 | ✅ |
| ROLE-02 | P2 | `store.js:66` | 缓存无界 + 热路径同步 IO | ✅ |

P3 条目见各章正文，不单列总表（避免灌水）。

---

## 8. 优先行动路线

**0–2 周（P1，先堵静默错误）**
1. GW-01、GW-02（半小时级，立即做）。
2. BR-01 协议加 callId + 过渡期 failAllPending；BR-03 在途去重 —— 这两条直接决定 WS 主线能否上线。
3. BR-02 + MEM-07 三个 WS 客户端握手超时与归属守卫。
4. MEM-03 tools 越权；MEM-01/MEM-04 存储兜底与迁移失败。
5. MEM-02/MEM-05 删除顺序与归档匹配（数据不可逆，优先）。
6. MCP-01、GW-03、GW-04。

**1 个月（P2，按主题成批）**
- 连接韧性批：GW-05、BR-07、MEM-06、GW-12、GW-13。
- 契约一致批：MEM-08、BR-06、BR-09、BR-10、GW-07。
- 资源与性能批：BR-05、GW-08、ROLE-02、MEM-09、BASE64 回执上限。
- 运维安全批：GW-09、BR-11、BR-12、GW-06。

**持续观察（P3）**
- 文档与注释漂移（heartbeat 注释、rolecard 注释、`handleFrame` 陈旧 JSDoc）。
- 退出路径统一（memory SIGINT 不退出、bridge 重复信号处理器）。
- 临时目录与 `/tmp` 残留清理。

---

## 9. 测试覆盖缺口与文档漂移

### 9.1 覆盖缺口（按风险排序）

1. **WS 语义边界**：ack 乱序/迟到、握手挂起、`awaitWsOpen` 失败时的熔断、`close()` 期间在途 ack、半开连接（pong 缺失）、4MB 帧超限、`sendTo` 失败。
   ✅ 已补：callId 乱序/迟到（`test-gateway-ws.mjs`）、握手看门狗（bridge + 两仓连接器）、半开 terminate（`test-ws-hub.mjs`）、建连失败计熔断、无 callId 旧网关兼容。
2. **动作双入口**：`gateway-actions.handleFrame`（WS 帧）无任何断言；HTTP 与 WS 同 `idempotencyKey` 并发、帧验签的序列化敏感性、nonce 复用拒绝均无测试。
   ✅ 已补：并发同 key 只执行一次、bodyHash 新旧两条验签路径 + 篡改拒绝、业务失败短 TTL/传输失败不缓存、回执体积与文本上限。
3. **配置 fail-closed**：`GATEWAY_REPLAY_WINDOW_MS` 等 NaN/越界无用例；mcp 侧 `*_GATEWAY_TRANSPORT` 非法值、只配 secret 的启动路径无用例。
   ✅ 已补：`intInRange` 统一校验（非法值启动即失败）；两仓 `*_GATEWAY_TRANSPORT` 非法值 fail-closed、WS_URL 缺 id/secret 启动失败。
4. **双后端一致性**：JSON fallback 的 `prune` 作用域、`count>200`、非法 `limit`、`transaction` 原子性均无测试。
   ✅ 已补：prune 的 session/tier 范围、`transaction` 拒绝 async（json/sqlite 双后端跑同一用例）。
5. **隐私删除路径**：归档重写失败的中间态、同 msgId 跨会话、同毫秒批量级联漏扫无用例。
   ✅ 已补：归档目录不可读时 purge 抛错且库行保留、跨会话同 msgId 只删目标会话、复合键游标。
6. **取消语义**：turn 超时是否 `session/cancel`、下一 job 是否延迟、`http-client` abort 生效无用例。
   ✅ 已补：turn 超时发 `session/cancel`（`test-runtime-turn.mjs`）、`AbortSignal` 透传（`test-http-client.mjs`）。
7. **控制台鉴权矩阵**：逐路由 × 无 token/错 token/空 `x-agent-token` 的断言缺失；`/v1/actions` 未签名应 401 无断言。
   ◐ 部分：桥接控制台已补「Header 定长比较、查询串令牌 401、Cookie 引导」，网关侧逐路由矩阵仍建议随发布前总检补。

### 9.2 文档漂移

| 文档 | 漂移点 | 现状（2026-11-09） |
| --- | --- | --- |
| `core/config.mjs:230` 注释 | 声称「窗口内没收到帧才发 ping」，实现是无条件定时发送 | ✅ 已改为与实现一致：每周期 ping，连续两周期无入站帧即 terminate |
| `memory-mcp/src/service/ws-connector.js:49` JSDoc | 引用不存在的 `handleFrame`（应为 `invoke`） | ✅ 两份连接器 JSDoc 均已修正并补 `handshakeTimeoutMs` |
| `rolecard-mcp/src/server.mjs:27-28` | 注释称 `gatewayId` 可选，实现强制必填 | ✅ 实现已改为可选（与 memory-mcp 同口径） |
| `rolecard-mcp/src/role-card.js:119` | 注释称二代会兜底过滤，实际常量未使用 | ✅ 注释改为「仅控制台提示，不参与过滤」 |
| `raw-service.js:310-315` 注释 | 声称「先重写归档再删库」，实现相反 | ✅ 实现已按注释顺序重排（失败即整单抛错） |
| `GATEWAY_V2_REFACTOR.md` §2 | 已补落地状态，但未记录「ack 无 callId / 客户端 FIFO」这一实现约束 | ✅ §2 已补 2026-11-09 收口（callId/bodyHash/幂等/健康/指标/令牌） |

---

## 10. 附录：待验证项

| # | 待验证 | 方法 |
| --- | --- | --- |
| 1 | 半开连接是否让 `isConnected` 长期为真 | 建连后 `tcpkill`/断网，观察 `/v1/health.ws.clients` 与一次 `callAction` 耗时 |
| 2 | `httpClients.clear()` 是否泄漏 socket | 反复触发登记 reload，观察 `process._getActiveHandles()` |
| 3 | WS 4MB 帧 vs HTTP 256KB 上限的落差影响 | 1MB 信封走 WS，观察 `turns.jsonl` 单行体积与轮转频率 |
| 4 | `state-acl` 在中文 Windows 的失败检出 | `icacls` 制造 DACL 异常后跑 `hardenDir` |
| 5 | 网关 `usage-ledger` 写盘失败是否真的无日志 | 置只读后 `ingestTurn`，确认无 `[gateway]` 日志 |
| 6 | 动作 `idempotencyKey` 回退值是否造成跨会话碰撞 | 构造 `ctx.idempotencyKey` 缺省，同回合两会话同类型动作 |
| 7 | `console/app.js` XSS 是否可被服务 id 注入触发 | 注册一个 name 含 `<img onerror>` 的服务，观察台账/服务页 |

## 11. 修复状态（2026-11-09 批次收口）

按主题分 9 批推进，每项都配了回归用例；四个仓的既有套件全绿。

| 批次 | 覆盖条目 | 关键改动 | 用例 |
| --- | --- | --- | --- |
| ws-transport | BR-01/02/07、GW-05/06/07、MEM-07/09 | ack 回带 `callId`/`adapterId`、幂等键按消费者隔离（兼容旧键）、半开连接 terminate、常量时间比较、握手看门狗与 socket 归属守卫 | `test-ws-hub.mjs` +3、`test-gateway-ws.mjs` +5、两仓 `test-ws-connector.mjs` +1 |
| action-idempotency | BR-03/06/09/10、MEM-08 | 执行前登记 promise、幂等键含 type/target、失败分档缓存、`bodyHash` 验签、文本 4000 字与回执 512KB 上限、403→`E_FORBIDDEN` | `test-gateway-ws.mjs` +5、`test-ws-hub.mjs` +1 |
| config-authz | GW-01/02/09、MEM-03/04、MCP-01 | `intInRange` fail-closed、`randomBytes` 导入、密钥 0600、迁移失败 fail-fast（保留 `backend=json` 逃生口）、工具面固定 `ctx.sessionKey` + forget 归属、rolecard `serviceId` 可选 | 契约 health/rotate、`test-store.mjs` +2、gateway-v1 用例 |
| lifecycle-resilience | GW-04/11/12/13/14、BR-04/05/08/13 | 超时 `session/cancel`、submit 失败回滚幂等、pending 转发退避重试、定时器清理、suppressed 不计 sent、按会话发送链、bootstrap 投递成功才置真、wait 租约接管退出、配置原子写 | `test-runtime-turn.mjs` +2、`test-tool-host.mjs` +1、`test-pending-forwarder.mjs`、`test-http-client.mjs`、`test-lifecycle.mjs` |
| storage-integrity | MEM-01/02/05/06、ROLE-01/02 | prune 按 session/tier 圈定、先归档后删库、`(createdAt,id)` 复合游标、跨会话 msgId 只删本会话、transaction 拒绝 async、`maxChars` 非法值回退、缓存上限 64 | `test-store.mjs` +2、`test-raw-archive.mjs` +2、`test-rolecard.mjs` +2 |
| observability-security | GW-08/10、BR-11/12 | 指标序列封顶 + route 标签白名单、`log:` 参数名修正、令牌 Header>Cookie>引导、健康公开面最小化（`?detail=1` 需凭据）、rolecard health 不回角色名 | `test-metrics.mjs`、契约 health、`test-audit-bridge.mjs` 引导/查询串用例 |
| p3-cleanup | P3 全部 | 退出统一关库关服务、tmp 残留清理、ffmpeg 并发闸门、activity 尾部缓存、`slang` O(n·L²)、`icacls` 本地化识别、session-router 标注 NOT WIRED | `test-lifecycle.mjs` +1、媒体/语音/黑话套件 |
| docs-sync | §2、README、本报告 | 协议约束（callId/bodyHash/幂等/健康/指标）、WS 环境变量表、控制台令牌传递方式、状态表 | 本文档 |

**验证基线**（2026-11-09 全量复跑，逐仓顺序执行）：agent-gateway `npm test` **213/213**；memory-mcp `npm test` **184/184**（18 个脚本）；rolecard-mcp `npm test` **47/47**（6 个脚本）；qq-bridge `test:gateway` **44/44**、`test:audit` **23/23**、`test:token`/`test:hardening`/`test-md`/`test-wait`/`test:initial-prompt`/`test:regressions`/`test:media-normalize`/`test:issues`/`test-vision`/`test-forward`/`test-stickers`/`test-voice`/`test-encoding` 全通过、`verify:decouple` 16/16、`privacy-scan` 188 文件干净。

**环境依赖（非回归）**：`test-console`（需 :3100 上运行中的桥接实例）与 `test:console-ui`（需 Playwright + 浏览器）不在任何 CI 聚合链里，本轮无对应环境，未执行。

**仍未做**：进程级实机联调（需真实网关实例与登记 secret）；控制台逐路由鉴权矩阵（见 9.1 第 7 条）；`GATEWAY_WS` 灰度期建议先 `transport=ws` 验证真链路，再切 `auto`。

---

*评审执行：2026-11-09；本报告不含任何真实令牌、QQ 号、群号或本机绝对路径。*
