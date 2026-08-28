# 打包与发布指南（PUBLISH）

本仓库已设为 **public**，安装包通过 **GitHub Releases** 公开分发，客户端 `electron-updater` 自动检测并下载更新。

- 仓库：<https://github.com/maozuxiao/mc-tool>
- 更新源配置：`electron-builder.yml` 的 `publish.provider: github`（owner `maozuxiao`，repo `mc-tool`），运行时在 `src/main/updater.ts` 里通过 `autoUpdater.setFeedURL(...)` 对齐同一目标。
- 分发特点：**Release 附件对所有人公开可下载（无需仓库读权限/token）**，因此外部用户也能自动更新。

---

## 零、一图看懂流程

```text
改代码 → 类型检查 → 改版本号(2处) → 写 Release Notes
      → 设 GH_TOKEN → .\build_now.ps1 -Publish
      → GitHub 上把 draft Release 改为 Published
      → 老客户端启动即收到更新提示
```

> 全流程可只用一条命令：`$env:GH_TOKEN='xxx'; .\build_now.ps1 -Publish`
> 脚本会依次完成依赖检查、清理旧产物、打包、发布，任一步失败即中止。

---

## 一、发布一个新版本（以 1.0.25 为例）

### 1. 同步代码并提交

```bash
cd C:\Users\streamax\Documents\GitHub\mc-tool
git pull origin master
# —— 修改代码 ——
git add -A
git commit -m "feat: ..."
git push origin master
```

### 2. 类型检查（建议）

```powershell
.\__tscheck.ps1
```

脚本会切 UTF-8 编码并运行 `tsc --noEmit`，末尾打印 `EXITCODE=0` 即通过。非零说明有类型错误，先修再打包。

### 3. 改版本号（两处必须同步）

| 文件 | 字段 | 格式 | 示例 |
|---|---|---|---|
| `package.json` | `version` | SemVer **三段** | `"1.0.25"` |
| `electron-builder.yml` | `buildVersion` | **四位**文件版本 | `1.0.25.0` |

```jsonc
// package.json
{ "version": "1.0.25" }
```

```yaml
# electron-builder.yml
buildVersion: 1.0.25.0
```

> **两处必须同步**。
> - `version` 决定 `app.getVersion()`、`latest.yml` 里的版本号，以及**客户端判断是否更新的依据**。
> - `buildVersion` 只写入 exe 的「文件版本」属性。
> - 版本号倒退或不一致，客户端会认为「已是最新」而静默跳过更新。
>
> 界面上显示的版本由 `store.ts` 启动时从 `window.mcApi.appVersion()` 读取，**无需手动改**。

### 4. 追加 Release Notes

在 `MC Tool Release Notes.md` 的表格末尾追加一行：

```markdown
| 1.0.25 | 1.0.25.0 | 本次改动说明 |
```

提交版本号与 notes：

```bash
git add -A
git commit -m "chore: bump to 1.0.25"
git push origin master
```

### 5. 本地打包

推荐用一键脚本（自动切到项目根、检查依赖、清理旧产物）：

```powershell
.\build_now.ps1
```

等价的底层命令：

```bash
npm install        # 新克隆或依赖有变时先装
npm run pack:win   # = electron-vite build && electron-builder --win --config electron-builder.yml
```

产物输出到 `dist/`：

```text
dist/
├─ latest.yml                            # 自动更新元数据（关键）
├─ MC物料查询 Setup 1.0.25.exe            # NSIS 安装包
├─ MC物料查询 Setup 1.0.25.exe.blockmap  # 增量更新块映射
└─ MC物料查询 1.0.25.exe                  # 便携版
```

> `dist/` 已被 `.gitignore` 忽略，**不要 commit**。
> 每次打包都会重新生成 `latest.yml` 并指向当前版本。

**本地冒烟验证（强烈建议，发布前做）**：安装 `dist/MC物料查询 Setup 1.0.25.exe` → 扫码登录 → 各标签页查一次 → 导出 CSV → 「帮助 / 检查更新」确认提示「当前已是最新版本」。

### 6. 发布到 GitHub Release

需要一个有**仓库写权限**的 GitHub Token，二选一：

- **Classic PAT**：勾选 `repo` 范围。
- **Fine-grained PAT**：Repository permissions → **Contents** 设为 `Read and write`（GitHub 没有独立的 "Releases" 勾选项，Release 与附件上传都归入 Contents 权限）。

设置 token 并发布：

```powershell
$env:GH_TOKEN = '你的token'
.\build_now.ps1 -Publish
```

等价的底层命令：

```powershell
npx electron-builder --win --config electron-builder.yml --publish=always
```

> 用 PowerShell 临时环境变量，不要写进文件。`cmd` 环境用 `set GH_TOKEN=...`。
> 脚本在**打包完成后**才校验 `GH_TOKEN`，因此不会白跑一趟打包。

该命令会：

1. 重新构建并打包到 `dist/`；
2. 自动创建 git tag `v1.0.25`；
3. 创建 GitHub Release；
4. 上传 `latest.yml`、安装包、`.blockmap`。

### 7. 把 draft 改为 Published（**必做**）

`electron-builder` 默认创建的是 **draft（草稿）** Release。**草稿状态下客户端自动更新检测不到新版本**，必须手动发布：

- 网页：仓库 → Releases → 对应 Release → Edit → 取消勾选 `Set as a draft` → **Publish release**。
- 或脚本：

```powershell
# publish_release.ps1
$token = '你的token'
$h = @{Authorization="Bearer $token"; "Content-Type"="application/json"}
$rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/maozuxiao/mc-tool/releases' -Headers $h
$v = $rel | Where-Object { $_.tag_name -eq 'v1.0.25' }
$body = @{draft=$false} | ConvertTo-Json
Invoke-RestMethod -Method PATCH -Uri "https://api.github.com/repos/maozuxiao/mc-tool/releases/$($v.id)" -Headers $h -Body $body
```

### 8. 验证更新链路

1. 保留一个**旧版本**的客户端（如 1.0.24）。
2. 启动旧客户端，等待约 3 秒（启动后延迟检查）。
3. 顶部应出现更新条，显示新版本号与「下载」按钮。
4. 点击下载 → 进度条 → 完成后显示「立即更新」。
5. 点击「立即更新」→ 当前 app 退出 → NSIS 安装向导弹出（**非静默**，可见进度、可选目录）→ 完成后 `--force-run` 自动启动新版。
6. 新版本「帮助 / 检查更新」应提示「当前已是最新版本」。

---

## 二、客户端自动更新机制

| 环节 | 实现位置 | 说明 |
|---|---|---|
| 更新源 | `src/main/updater.ts` | `autoUpdater.setFeedURL({ provider:'github', owner:'maozuxiao', repo:'mc-tool' })` |
| 触发时机 | `src/main/updater.ts` | 启动后 `setTimeout(..., 3000)` 自动检查，避免阻塞首屏 |
| 下载策略 | `autoUpdater.autoDownload = false` | **不自动下载**，由用户在更新条点「下载」 |
| 版本比较 | `updater.ts` 的 `update-available` | 逐段比较，服务器版本不高于本地则忽略（防低版本误报） |
| 进度回传 | `download-progress` → `update-progress` | 渲染层 `UpdateBar` 显示百分比 |
| 安装方式 | `src/main/index.ts` 的 `IPC.INSTALL_UPDATE` | 取已下载安装包路径，`spawn(installer, ['--updated','--force-run'])` 启动 NSIS 向导，300ms 后 `app.exit(0)`；找不到包时兜底 `quitAndInstall(false, true)` |
| 错误策略 | `updater.ts` 的 `error` | 更新错误**只写日志不弹 UI**，避免 `latest.yml` 缺失等场景打扰用户 |

日志位置（`updater.ts` 的 `debugLog`，仅打包后写入）：

```
%APPDATA%/mc-material-query/app.log
```

---

## 三、历史包袱：1.0.23 及更早版本

**老版本内置的更新地址写死在 exe 里**，指向旧源（`maozuxiao/Streamax` 仓库的 `assets/MC_Tool` 目录），与新 Release 地址不同，因此 **≤ 1.0.23 的客户端检测不到 1.0.24 及之后的更新**。

处理方式：**让用户手动下载覆盖安装一次** 1.0.24，之后即可正常自动更新。

下载入口（公开，无需登录）：

```
https://github.com/maozuxiao/mc-tool/releases/download/v1.0.24/mc-material-query-setup-1.0.24.exe
```

或到 Releases 页面选择 `mc-material-query-setup-1.0.24.exe`。

> 已安装的 1.0.24 用户无需任何操作。

---

## 四、仅打包不发布 / 测试包

### 4.1 只出本地包

```powershell
.\build_now.ps1          # Windows
.\build_now.ps1 -All     # 全平台
```

等价命令 `npm run pack:win` / `npm run pack:all`。不加 `-Publish` 就不会碰 GitHub。

脚本参数速查：

| 参数 | 作用 |
|---|---|
| *(无)* | 打 Windows 包（NSIS + 便携版） |
| `-Mac` | 打 macOS DMG |
| `-All` | 打全平台 |
| `-NoClean` | 保留旧的 `dist/`，不清理 |
| `-Publish` | 打包后发布到 GitHub Releases（需 `GH_TOKEN`） |

### 4.2 输出到独立目录（避免污染正式 dist/）

临时修改 `electron-builder.yml`：

```yaml
directories:
  output: dist/update test
```

打包后**记得还原**为 `output: dist`。

产物在 `dist/update test/`，测试时把该目录的 `latest.yml` + `*.exe` + `*.exe.blockmap` 手动上传到 Release 即可让旧客户端检测到。

### 4.3 只想测 exe 文件版本（不改产品版本）

`electron-builder.yml` 里自定义产物名：

```yaml
nsis:
  artifactName: MC物料查询-${buildVersion}-Setup.${ext}
```

产物为 `MC物料查询-1.0.25.0-Setup.exe`，但 `latest.yml` 里产品版本仍是 `1.0.25`。仅用于测试，正式发布请改回统一命名。

---

## 五、macOS 打包

```bash
npm run pack:mac
```

- 产物：`dist/MC物料查询-1.0.25-<arch>.dmg`（命名来自 `mac.artifactName`）。
- **签名与公证**：当前 `electron-builder.yml` 未配置 `identity` / `notarize`，打出的 DMG 未签名，macOS 会拦截（Gatekeeper）。若要正式分发 macOS 版，需补 Apple Developer 证书与公证配置。
- **不建议在 Windows 上交叉编译 DMG**，请在 macOS 上执行。

---

## 六、常见问题排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 客户端一直检测不到新版本 | Release 仍是 **draft** | 到 GitHub 把 Release 改为 Published |
| 客户端提示「已是最新」但版本号不对 | `package.json` 的 `version` 与 `buildVersion` 不同步，或版本倒退 | 确认两处版本号一致且单调递增 |
| 发布时报 401 / 404 | `GH_TOKEN` 无效或权限不足 | 重签 token，确认 Contents 为 Read and write |
| 发布时报 tag 已存在 | 同名 tag 已建过 | 删除远程 tag 与 Release 后重发，或升版本号 |
| 更新下载到一半失败 | 网络中断 / 附件未上传完整 | 重新点「检查更新」重试；确认 `.blockmap` 与 exe 均已上传 |
| 更新条不显示但确实有新版本 | 更新错误**只写日志不弹 UI** | 查看 `%APPDATA%/mc-material-query/app.log` |
| 老版本（≤1.0.23）收不到更新 | 内置旧更新源，写死在 exe 中 | 手动下载 1.0.24 覆盖安装一次 |
| 打包报图标错误 | `build/icon.ico` / `icon.icns` 未入库（被 `.gitignore` 排除） | 从 `build/icon.png` 用 `sharp` 自行生成，或让 electron-builder 自动转换 |

---

## 七、安全提醒

- GitHub Token 具备仓库写权限，**不要**写进代码、日志或聊天记录。优先用本机临时环境变量，用完可在 GitHub 撤销（已发布的 Release / tag 不受影响）。
- 日常 git 操作推荐用 **SSH**，免 token：

  ```bash
  git remote set-url origin git@github.com:maozuxiao/mc-tool.git
  ```

- 若必须用长期 token，建议 **fine-grained token** 且只授权 `mc-tool` 仓库的 Contents 读写，最小化权限。
- 仓库为 public，**源码与配置对所有人可见**，切勿提交任何内部地址凭据、token 或个人信息。

---

## 八、相关文档

| 文档 | 内容 |
|---|---|
| [README.md](./README.md) | 项目背景、功能、使用方法、开发与打包入口 |
| [PACKAGE_README.md](./PACKAGE_README.md) | 版本号规则、打包细节、任务栏名称等 UI 定制 |
| [MC Tool Release Notes.md](./MC Tool Release Notes.md) | 逐版本变更记录（发布前追加一行） |
