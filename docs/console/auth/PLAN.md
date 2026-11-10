# PLAN：operator 认证（操作者 token + Cookie 登录通道）

> 状态：DONE（2026-11-06）｜ 优先级：P0（所有控制面模块的前置） ｜ 依赖：无
>
> 实施记录：server.mjs 内实现 `verifyOperator`（x-operator-token 头 + 签名
> Cookie 双通道）、`assertConsoleCsrf`（写操作 JSON + 同源校验）、
> `POST /v1/console/session` 登录换发 Cookie、登出吊销集合；token 三态解析
> （env > state/operator-token 文件 > 自动生成持久化，写盘失败 fail-closed）。
> 验收：scripts/test-console-auth.mjs。

## 1. 背景与现状

**网关侧（目标仓库）**

- 现有认证只有适配器 HMAC：`src/core/auth.mjs`（`signRequest` / `verifyRequest` / `verifyWithKeyring`，49/111/161 行），凭据来自 `adapters.json`（`src/core/config.mjs:68-97`）。这条通道面向**适配器进程**，无法承载浏览器控制台。
- 控制台类端点 `/v1/turns`、`/v1/usage` 目前只能走 adapter HMAC，因此现状是桥接代理读取：

```348:349:agent-gateway/src/core/server.mjs
      // 控制台用：turn 列表（不带正文，正文从不落盘）与 token 用量。
      // 适配器 HMAC：控制台自己没有网关密钥，经桥接代理读取。
```

- 网关监听与鉴权入口在 `src/core/server.mjs`（请求处理与 `authenticate(req, rawBody)`）。
- **现有网络边界是回环-only**：非回环来源一律 403（`server.mjs:173-176`）——这决定了近期部署假设（控制台与网关同机，或经本机反向代理）；若未来需要远程访问，operator 认证就是硬前提。
- 端点鉴权现状：`/v1/health` 不鉴权但受回环边界保护（178 行）；`/v1/metrics` 要求 adapter HMAC（208-209 行）。

**桥接侧（参考实现，可借鉴的防呆与决策）**

- 控制台凭据 `consoleToken`：`config.json` 手动配置，或启动时自动生成 192bit 随机值并持久化到 `state/console-token`（`qq-bridge/src/bridge.js:215-217`、`3498-3511`）。
- **失败关闭**：令牌为空直接拒绝启动，不允许静默开放无鉴权管理 API（`bridge.js:3504-3509`）。
- 请求凭据：`?token=` 查询参数或 `x-console-token` 头；定长比较 + `crypto.timingSafeEqual` 防时延逐字节试探（`bridge.js:3654-3664`）。
- 令牌管理端点：`POST /api/console/token`（手动设置 / 随机重新生成，写入 config 与 state，`bridge.js:4584-4613`）。
- CSRF：所有写操作强制 `application/json` 且 Origin 必须来自本机页面（`bridge.js:3710-3713`）。
- 监听回环：`consolePort` 默认 3100，仅 127.0.0.1（`bridge.js:3498`、`7658-7661`）。

## 2. 网关目标态

为网关新增**操作者（operator）认证通道**，与 adapter HMAC 并存、互不影响：

- **两种凭据形态**：
  - 长期 operator token（`x-operator-token` 头）：给 CLI / 脚本 / 未来 UI 的服务端代理用；
  - 短期会话 Cookie（登录换发）：给浏览器 UI 用，HttpOnly + SameSite=Strict，带过期时间。
- **凭据解析**：`config.operatorToken`（手动配置）或 `state/operator-token`（自动生成并持久化），语义与桥接 `consoleToken` 一致；令牌格式约束沿用桥接（16–128 位，`[A-Za-z0-9_-]`）。
- **失败关闭**：网关启用控制台功能时若凭据为空，拒绝启动相关路由（或拒绝启动进程，与桥接 3509 同语义）。
- **回环边界的关系**：保留现有 loopback-only 外壳（`server.mjs:173-176`）作为纵深防御；operator 认证叠加其上。若未来放开远程访问，必须同时启用 operator 认证且回环放开改为显式配置项（默认关闭）。
- **边界**：operator 凭据只放行控制面端点（本目录各模块的 `/v1/console/*`，以及 `/v1/turns`、`/v1/usage` 的双通道扩展）；`/v1/inbound`、`/v1/tools/call`、`/v1/actions` 回调等数据面端点**只认 adapter HMAC**。
- **会话存储**：优先无状态签名 Cookie（用 operator 密钥派生 HMAC 签名 + 过期时间戳），不引入会话库；如需主动吊销列表再退化为内存 Map + TTL（容量受限，参照 `dsh-gateway.mjs` 的 `PENDING_CAPACITY` 模式）。

## 3. 目标接口草案

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/v1/console/session` | 登录。请求体 `{ token }`（即长期 operator token）；成功 `Set-Cookie: console_session=<签名值>; HttpOnly; SameSite=Strict; Max-Age=43200`，响应 `{ ok, expiresAt }`；失败 401 `E_AUTH` |
| `GET` | `/v1/console/session` | 会话自检。`200 { ok, expiresAt }` 或 401 |
| `DELETE` | `/v1/console/session` | 登出（吊销当前会话，若采用无状态签名则改为维护吊销集合） |
| `POST` | `/v1/console/session/rotate` | 更换长期 operator token（写 config/state 并让旧会话失效） |

**中间件约定**（文字级）：

- `verifyOperator(req)`：依次尝试 `x-operator-token` 头与 `console_session` Cookie；定长比较 + `timingSafeEqual`；Cookie 需验签 + 未过期。
- 控制面路由统一前置 `verifyOperator`；`/v1/turns`、`/v1/usage` 改为「adapter HMAC **或** operator 二选一」，并更新 `server.mjs:348-349` 的注释（经桥接代理的临时形态就此终结）。
- CSRF：写操作要求 `Content-Type: application/json` 且（带 Origin 时）Origin 与 Host 同源——沿用桥接 3710-3713 的策略；`SameSite=Strict` 兜底。

## 4. 数据来源

- `src/core/config.mjs`：新增 operator 凭据解析（镜像 `resolveSecret` 的 `secret / secretFile / secretEnv` 三态，68-97 行附近），默认文件 `state/operator-token`。
- `src/core/auth.mjs`：新增 `verifyOperator` / 会话签发校验（与 `signRequest` 并列，不复用适配器密钥）。
- `src/core/server.mjs`：登录/登出路由注册 + 控制面路由挂中间件。
- `src/core/metrics.mjs`：`console_auth_total{result=ok|invalid|expired}` 观测。
- 不新增依赖、不引入会话数据库。

## 5. 验收标准

- [ ] 未配置 operator 凭据时启用控制台路由 → 启动失败（fail-closed），错误信息明确指出凭据来源（config / state 文件）。
- [ ] 回环-only 边界行为不变（非回环来源仍 403），operator 认证叠加其上生效。
- [ ] `x-operator-token` 与登录 Cookie 两条通道均能通过 `GET /v1/console/session` 自检；错误凭据 401，且比较耗时与错误位置无关（timingSafeEqual）。
- [ ] Cookie 具备 `HttpOnly; SameSite=Strict`，过期后 401；`DELETE /v1/console/session` 后旧 Cookie 失效。
- [ ] 跨站 POST（无 JSON / 异源 Origin）被 403 拒绝。
- [ ] 适配器 HMAC 通道回归：`/v1/inbound`、`/v1/tools/call`、`/v1/actions` 行为与密钥完全不受影响（现有测试全绿）。
- [ ] `/v1/turns`、`/v1/usage` 在不持适配器密钥、仅持 operator 凭据时可访问（即浏览器直连网关成为可能）。
- [ ] `console_auth_total` 指标能区分 ok / invalid / expired。

## 6. 依赖与优先级

- P0，无前置。本目录其余 5 个模块（dsh-presets / dsh-sessions / dsh-pending / usage-billing / adapters-overview）全部依赖本模块。
- 实现落点建议：`src/core/auth.mjs`（凭据与会话）+ `src/core/server.mjs`（路由）；未来 UI 静态资源（如 `public/`）另立任务。

## 7. 桥接侧对称拆除任务

本模块本身**不直接产生桥接删除项**（桥接控制台仍管理 QQ 平台侧功能，其 `consoleToken` 机制保留）。联动项：

- [ ] 桥接 `POST /api/console/token`（`bridge.js:4584-4613`）**保留**，但其注释/文档中「控制台经桥接代理读取网关数据」的职责描述在 usage-billing、dsh-sessions 拆除后同步移除。
- [ ] `qq-bridge/src/bridge.js:348-349`（server.mjs 侧）注释更新属于网关本模块验收项。
- [ ] 未来桥接控制台瘦身时，`docs/guides/CONSOLE-UI-TESTING.md`、`docs/guides/TOKEN_USAGE_CONSOLE.md`（qq-bridge 仓库）中涉及网关代理读取的章节需一并修订。
