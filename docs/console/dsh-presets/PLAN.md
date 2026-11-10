# PLAN：DSH 预设管理（dsh-presets）

> 状态：DONE（2026-11-06）｜ 优先级：P1 ｜ 依赖：auth（operator 认证）
>
> 实施记录：`src/runtime/preset-files.mjs`（sim-prompt 读改写、备份/还原、
> 安全不变量防呆）+ server.mjs 路由 `/v1/console/dsh/presets[/:id][/sim-prompt
> [/backups|/restore]]`；错误分类（找不到 404 / 防呆 400 E_POLICY / 其余 500）。
> 验收：scripts/test-console-dsh.mjs。

## 1. 背景与现状

**桥接侧（现有实现）**

- `GET /api/presets`：调 DSH `agentPresets.list` 返回 `{ presets: [{ id, trust }] }`，失败静默返回空列表（`qq-bridge/src/bridge.js:3851-3858`）。
- `GET /api/preset/sim-prompt?preset=`：读 DSH 预设文件 `dsh/agent-presets/<preset>/agent.cordis.yml` 的 `persona.prefix`，返回 `{ content, chars, bytes, warnings, status }`（`bridge.js:4044-4061`）。预设名经 `knownPresetName` 白名单校验。
- `POST /api/preset/sim-prompt`：写回 `persona.prefix`（`bridge.js:4063-4112`）。防呆细节：
  - 内容未变不落盘——避免 YAML 折叠块被规整成全删全加的 diff，保住可复审性（4070-4072）；
  - 写前先备份（`backupPresetFile`）；
  - 安全不变量校验 `presetPromptBlockers`，不满足则拒绝保存（响应含 `requiresRestart: true`）。
- `GET /api/preset/sim-prompt/backups`：列出备份（`bridge.js:4113-4122`）。
- `POST /api/preset/sim-prompt/restore`：还原备份（`bridge.js:4123-4155`）。防呆细节：
  - 只允许还原本预设目录内的备份文件，拒绝路径穿越（4131-4132）；
  - 旧备份也要过安全不变量校验，防止把弱化版提示词写回（4137-4144，不变量**按预设取**）；
  - 还原前再次备份当前版本；同步 source 与 installed 两份文件；提示需重启 DSH 生效（4145-4150）。
- 配套模块：`qq-bridge/src/chat/preset-prompt.js`（读取/提取/校验，纯函数）；`knownPresetName / presetStatus / backupPresetFile / listPresetBackups / atomicWriteText` 在 `bridge.js` 内。
- 前端面板：`public/console.html:2742`（预设列表）、`2925 / 3111 / 3127`（仿真提示词查看/保存/还原）。

**网关侧（已具备的基础）**

- RPC 形状已复核：`agentPresets.list` 是 unary RPC（`src/runtime/dsh-client.mjs:334`；注册表 186 行；旧版门面兼容 640-642 行；`agentPresets/list` 属 null-wrapper 集合 556 行）。
- DSH home 定位已有：`resolveDshHome()`（`dsh-client.mjs:32`）——预设文件读写以此为根。
- 预设 fail-closed 策略已在网关：`session-registry.ensurePresetAllowed`（`src/runtime/session-registry.mjs:61-74`）——控制台改预设与会话创建策略最终收敛在同一处。

## 2. 网关目标态

- **预设列表**：从 DSH 实时读取，不缓存信任状态，`trust` 原样透传。
- **仿真提示词查看/编辑/备份/还原**：迁入网关，**完整保留桥接全部防呆行为**（不变量校验、内容未变不落盘、路径穿越拒绝、双重备份、重启提示）。
- **边界**：
  - 只开放白名单内预设（与 `ensurePresetAllowed` 共用一份清单，避免「控制台能改、会话创建不让用」的分裂）；
  - 编辑写**文件**而非 DSH RPC（DSH 无对应写入接口），必须保留「需重启 DSH 生效」的显式提示；
  - 文件操作限定在 `resolveDshHome()/agent-presets/<白名单预设>/` 子树内。

## 3. 目标接口草案

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/console/dsh/presets` | `{ ok, presets: [{ id, trust, editable }] }`；`editable` = 是否在白名单内 |
| `GET` | `/v1/console/dsh/presets/{id}/sim-prompt` | `{ ok, content, chars, bytes, warnings, status }` |
| `PUT` | `/v1/console/dsh/presets/{id}/sim-prompt` | `{ content }` → `{ ok, changed, backup, requiresRestart }`；不变量不过返回 400 `E_POLICY` |
| `GET` | `/v1/console/dsh/presets/{id}/sim-prompt/backups` | `{ ok, backups: [{ file, at, size }] }` |
| `POST` | `/v1/console/dsh/presets/{id}/sim-prompt/restore` | `{ file? }`（缺省还原最新）→ `{ ok, restoredFrom, requiresRestart }` |

## 4. 数据来源

- `src/runtime/dsh-client.mjs`：`agentPresets.list` RPC（现成）。
- `resolveDshHome()`（`dsh-client.mjs:32`）：预设文件根目录。
- 预设解析/提取/不变量校验：从 `qq-bridge/src/chat/preset-prompt.js` 迁移（纯函数，可直接搬）。
- 白名单：与 `session-registry.ensurePresetAllowed` 共享配置项（`src/core/config.mjs`）。
- 建议落点：`src/runtime/preset-files.mjs`（文件读写与校验，纯函数化便于测试）+ `src/core/server.mjs` 路由。
- 不新增依赖；原子写沿用桥接 `atomicWriteText` 的临时文件 + rename 语义。

## 5. 验收标准

- [ ] `GET /v1/console/dsh/presets` 与 `agentPresets.list` 一致；DSH 不可达时返回 5xx `E_DSH_DOWN`，**不静默返回空列表**（桥接 3856 的静默吞错不迁移）。
- [ ] 保存：内容未变时 `changed: false` 且文件 mtime 不变；变化时先产生备份；不变量不满足时 400 且文件未被改动。
- [ ] 还原：非白名单路径（含 `..`、绝对路径、其他预设目录）一律 400；不变量不过的旧备份拒绝还原；还原前自动备份当前版本。
- [ ] 文件实际被改动时响应带 `requiresRestart: true`。
- [ ] 所有写操作限定在 `resolveDshHome()/agent-presets/<白名单>/` 内（用解析后的真实路径断言）。
- [ ] 未持 operator 凭据 → 401。

## 6. 依赖与优先级

- P1，前置：auth。
- 顺序建议：先落文件层（preset-files 迁移 + 单测），再挂路由。
- 与 dsh-sessions 的关系：`session.modelCatalog` RPC（dsh-sessions 需要）与 `agentPresets.list` 同属「网关 dsh-client 补齐控制面 RPC」，可同批实现。

## 7. 桥接侧对称拆除任务

> **状态更新（2026-11-06）**：本节的桥接侧拆除**已提前执行完毕**（管理决策：DSH 控制面彻底删除，
> 不等网关替代实现）。端点、`src/chat/preset-prompt.js`、helper/常量、前端面板均已删除，
> 测试与文档同步更新。回滚形态（`gateway.mode=off`）不再提供预设/仿真提示词控制台。

网关实现并验证后，在 qq-bridge 一次性执行（须在桥接本地 DSH 模式退役、MCP_TOOLS 过渡结束后，见 `qq-bridge/docs/guides/PLATFORM_DECOUPLE.md` 的灰度状态）：

- [ ] 删除端点：`GET /api/presets`（`bridge.js:3851-3858`）、`GET/POST /api/preset/sim-prompt`（4044-4112）、`GET /api/preset/sim-prompt/backups`（4113-4122）、`POST /api/preset/sim-prompt/restore`（4123-4155）。
- [ ] 删除/迁移配套：`src/chat/preset-prompt.js`（逻辑迁网关后删除）；`knownPresetName / presetStatus / backupPresetFile / listPresetBackups / presetSourceYaml / installedPresetYaml / PRESET_NAMES / PRESET_BACKUP_DIR` 等 helper 与常量（`bridge.js` 内，删除前全文检索引用）。
- [ ] 删除前端面板：`public/console.html:2742、2925、3111、3127` 所在的预设/仿真提示词区块（删除前全文检索 `/api/presets` 与 `/api/preset/sim-prompt` 引用）。
- [ ] `dsh-presets` 相关文档（`qq-bridge/docs/guides/SECURITY_BASELINE.md` 中涉及仿真提示词不变量的章节）改指网关实现。
