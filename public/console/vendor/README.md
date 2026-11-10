# vendor 目录（离线内置前端依赖）

本目录的第三方文件由网关静态服务直接伺服（`/console/vendor/*`），
**不参与构建、不写入 package.json 依赖**，保证内网/离线环境可用。

## Bootstrap 5.3.3

- 来源：`npm pack bootstrap@5.3.3` → `package/dist/css/bootstrap.min.css`、
  `package/dist/js/bootstrap.bundle.min.js`
- 许可：MIT（Copyright 2011-2024 The Bootstrap Authors）
- 文件校验（SHA-256）：

| 文件 | 大小 | SHA-256 |
|---|---|---|
| `bootstrap.min.css` | 227.3 KB | `3C8F27E6009CCFD710A905E6DCF12D0EE3C6F2AC7DA05B0572D3E0D12E736FC8` |
| `bootstrap.bundle.min.js` | 78.8 KB | `0833B2E9C3A26C258476C46266E6877FC75218625162E0460BE9A3A098A61C6C` |

## 升级步骤

```powershell
npm pack bootstrap@<新版本> --pack-destination .tmp-bootstrap
tar -xzf .tmp-bootstrap/bootstrap-<新版本>.tgz -C .tmp-bootstrap
Copy-Item .tmp-bootstrap/package/dist/css/bootstrap.min.css public/console/vendor/
Copy-Item .tmp-bootstrap/package/dist/js/bootstrap.bundle.min.js public/console/vendor/
Get-FileHash public/console/vendor/bootstrap.min.css -Algorithm SHA256   # 更新上表
Remove-Item -Recurse -Force .tmp-bootstrap
```

升级后跑 `npm test`（`test-console-services` 会校验资源可达），并肉眼回归控制台七视图。
