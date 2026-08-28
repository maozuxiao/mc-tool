# 发布指南（PUBLISH）

本仓库已设为 **public**，安装包通过 **GitHub Releases** 公开分发，客户端（`electron-updater`）自动检测并下载更新。

> 源码公开，安装包对任何人可下载；仓库地址：https://github.com/maozuxiao/mc-tool

---

## 一、发布一个新版本（例：1.0.25）

在本地克隆目录操作（如 `C:\Users\streamax\Documents\GitHub\mc-tool`）。

### 1. 同步并改代码
```bash
cd <克隆目录>
git pull origin master
# —— 修改代码 ——
git add -A
git commit -m "feat: ..."
git push origin master
```

### 2. 改版本号（两处必须同步）
| 文件 | 字段 | 示例 |
|------|------|------|
| `package.json` | `"version"` | `"1.0.25"` |
| `electron-builder.yml` | `buildVersion` | `1.0.25.0` |

> 两者的版本必须一致对应。`buildVersion` 是四位文件版本，供 `electron-updater` 比对；不一致会导致客户端认为「已是最新」而跳过更新。

### 3. 写 Release Notes（可选但建议）
在 `MC Tool Release Notes.md` 表格末尾追加一行。

提交版本号 / notes 改动并 push：
```bash
git add -A && git commit -m "chore: bump to 1.0.25" && git push origin master
```

### 4. 打包
```bash
npm install        # 若是新克隆/依赖有变，先装依赖
npm run pack:win   # 生成 dist/（安装包 + latest.yml + blockmap）
```
> `dist/` 已被 `.gitignore` 忽略，**不要** commit 它；每次本地打包即可。

### 5. 发布到 GitHub Release
需要一个有 **Repo 写权限** 的 GitHub token。两种任选：

- **Classic PAT**：勾选 `repo` 范围。
- **Fine-grained PAT**：在「Repository permissions → **Contents**」设为 `Read and write`（GitHub 没有独立的 “Releases” 勾选项，Release 与附件上传均归入 Contents 权限，勾上即可）。

设置好 token 后发布：
```bash
set GH_TOKEN=你的token
npx electron-builder --win --config electron-builder.yml --publish=always
```
该命令会：自动创建 git tag `v1.0.25`、创建 Release、上传 `dist/` 下的安装包与 `latest.yml`。

> ⚠️ `--publish=always` 默认创建的是 **草稿（draft）Release**。草稿状态下协作者可见，但**客户端自动更新要求 Release 已发布（非 draft）**。发布后请把 draft 改为 published（见下方「发布草稿」）。

---

## 二、把草稿 Release 改为已发布

`electron-builder` 默认产出 draft，需手动发布。用 GitHub 网页：进入仓库 → Releases → 对应 Release → Edit → 取消 “Set as a draft” → Publish；或用 API（需 token）：

```powershell
# publish_release.ps1
$token = '你的token'
$h = @{Authorization="Bearer $token"; "Content-Type"="application/json"}
$rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/maozuxiao/mc-tool/releases' -Headers $h
$v = $rel | Where-Object { $_.tag_name -eq 'v1.0.25' }
$body = @{draft=$false} | ConvertTo-Json
Invoke-RestMethod -Method PATCH -Uri "https://api.github.com/repos/maozuxiao/mc-tool/releases/$($v.id)" -Headers $h -Body $body
```

---

## 三、客户端自动更新说明

- 更新源：`electron-updater` 的 `provider: 'github'`（owner `maozuxiao`，repo `mc-tool`），自动从 `vX.Y.Z` 的 Release 拉取 `latest.yml` 与增量包。
- **≤ 1.0.23 的老版本**：其内置更新地址是旧源（写死在 exe 中），无法检测到新 Release，**需手动下载覆盖安装一次**；之后（≥1.0.24）即可正常自动更新。
- 下载入口（公开）：`https://github.com/maozuxiao/mc-tool/releases/download/v1.0.24/mc-material-query-setup-1.0.24.exe`

---

## 四、安全提醒

- GitHub token 有仓库写权限，请勿明文发到聊天/日志/代码里。优先在本机用 `set GH_TOKEN=...` 临时环境变量，用完可考虑撤销（已发布的 Release / tag 不受影响）。
- 推荐用 **SSH** 做日常 git 操作（免 token）：生成 key 并加到 GitHub → `git remote set-url origin git@github.com:maozuxiao/mc-tool.git`。
- 若改用长期 token，建议用 **fine-grained token** 并仅授权 `mc-tool` 仓库的 Contents 读写，最小化权限。
