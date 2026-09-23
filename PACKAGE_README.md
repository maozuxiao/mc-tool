# MC物料查询桌面端 — 打包与版本号说明

## 1. 版本号来源（必须同步）

| 用途 | 文件 | 字段 | 格式要求 | 说明 |
|------|------|------|----------|------|
| 产品版本 / 自动更新识别 | `package.json` | `version` | SemVer 三段，如 `1.0.1` | `app.getVersion()`、`latest.yml` 均使用此值 |
| Windows 文件版本 / exe 属性 | `electron-builder.yml` | `buildVersion` | 四位，如 `1.0.1.0` | 写入 exe 的「文件版本」属性 |
| 界面显示版本 | `src/renderer/src/store.ts` | `appVersion` | 自动读取 | 启动时从 `window.mcApi.appVersion()` 读取，**无需手动修改** |

> 原则：日常发布只需改 `package.json` 和 `electron-builder.yml` 两处，界面会自动跟随 `package.json`。

## 2. 修改版本号步骤

以发布 `1.0.46` 为例（仓库根即应用根，路径都以 `mc-tool/` 为基准）：

```text
1. 打开 package.json
   把 "version": "1.0.45" 改为 "version": "1.0.46"

2. 打开 electron-builder.yml
   把 buildVersion: 1.0.45.0 改为 buildVersion: 1.0.46.0

3. 不需要改 store.ts（已改为自动读取）
```

## 3. 打包命令

在**仓库根**（`mc-tool/`）执行：

```powershell
# Windows 安装包 + 便携包
npm run pack:win

# 全平台
npm run pack:all
```

输出目录：

```text
dist/
├── latest.yml                        # 自动更新元数据
├── MC物料查询 Setup <版本>.exe         # NSIS 安装包
├── MC物料查询 Setup <版本>.exe.blockmap# 增量更新块映射
└── MC物料查询 <版本>.exe               # 便携版
```

> 打包发布推荐用根目录的一键脚本 `.\build_now.ps1`（清旧产物 → 类型检查 → 打包；
> 加 `-Publish` 还会上传到 GitHub Releases）——完整流程见 **PUBLISH.md**。

## 4. 更新包放置位置（GitHub Releases）

> 更新源是 **GitHub Releases 附件**——早期那几个版本用的静态目录（`UPDATE_BASE_URL` → `maozuxiao/Streamax` 仓库的 `assets/MC_Tool`）
> 早已弃用；**≤ 1.0.23 的老客户端因把旧地址写死在 exe 里，检测不到新版本**，需手动覆盖安装一次（详见 PUBLISH.md 第三节）。
> 客户端与打包端两处配置必须一致：

| 位置 | 配置 |
|---|---|
| 打包端 | `electron-builder.yml` → `publish: [{ provider: github, owner: maozuxiao, repo: mc-tool }]` |
| 客户端 | `src/main/updater.ts` → `autoUpdater.setFeedURL({ provider: 'github', owner: 'maozuxiao', repo: 'mc-tool' })` |

发布时由 `.\build_now.ps1 -Publish`（需 `GH_TOKEN`）把 `dist/` 里的三个文件作为 Release 附件上传：

```text
latest.yml                          # 更新元数据（关键，必须上传）
MC物料查询 Setup <版本>.exe          # NSIS 安装包本体
MC物料查询 Setup <版本>.exe.blockmap # 增量更新块映射（必须一起上传）
MC物料查询 <版本>.exe                # 便携版（可选，离线分发用）
```

> `latest.yml` + `*.exe` + `*.exe.blockmap` 必须一起上传，否则增量更新/完整更新都会失败；客户端启动 3 秒后读取 `latest.yml` 判断是否需要更新。

> **重要**：`electron-builder` 默认创建的是 **draft（草稿）Release**，草稿状态下客户端**检测不到新版本**，必须手动改成 **Published**（网页或 API，见 PUBLISH.md 第 7 节）。

> 每一版的 Release 各自带自己的 `latest.yml`，天然不会互相覆盖（客户端只读「最新一条已发布 Release」）。

## 5. 任务栏右键 App 名称修改

Windows 任务栏右键菜单第一项（窗口名称）由主窗口 `title` 与 `app.setName()` 共同决定。修改位置：

| 位置 | 文件 | 当前值 | 影响 |
|------|------|--------|------|
| 应用名称 | `src/main/index.ts` | `app.setName('MC物料查询')` | 任务栏 tooltip、进程名 |
| 窗口标题 | `src/main/index.ts` | `title: 'MC物料查询'` | 任务栏右键第一项、窗口标题栏 |
| 开始菜单快捷方式 | `electron-builder.yml` | `shortcutName: MC物料查询` | 开始菜单/桌面快捷方式名称 |
| 安装包显示名 | `electron-builder.yml` | `productName: MC物料查询` | 控制面板/卸载列表显示名 |

## 6. 基线版本与更新包说明

### 当前基线版本

```text
package.json version:          1.0.45
electron-builder buildVersion: 1.0.45.0
```

打包命令：

```powershell
npm run pack:win
```

### 生成 1.0.46 更新安装包

按常规发布流程，把产品版本与文件版本统一进一位即可。注意 `package.json` 的 `version` 必须为合法 SemVer（三段），不能写成 `1.0.46.0`；文件版本 `buildVersion` 才是四位。

步骤：

```text
1. package.json         -> "version": "1.0.46"
2. electron-builder.yml -> buildVersion: 1.0.46.0
3. npm run pack:win
```

输出示例：

```text
dist/
├── latest.yml
├── MC物料查询 Setup 1.0.46.exe
├── MC物料查询 Setup 1.0.46.exe.blockmap
└── MC物料查询 1.0.46.exe
```

发布时用 `.\build_now.ps1 -Publish` 把 `latest.yml` + 两个 exe + blockmap 上传为该版本的 Release 附件，
再把 draft 改为 **Published**；客户端（如 1.0.45）启动后即会检测到 `1.0.46` 并提示更新。

### 仅改文件版本号（四位）的测试包

如果需要 exe 属性显示为 `1.0.1.1` 之类四位版本，但产品版本仍走 SemVer，可在 `electron-builder.yml` 临时设置 `buildVersion: 1.0.1.1` 并配合 `version: 1.0.2`，再自定义文件名：

```text
nsis.artifactName: MC物料查询-${buildVersion}-Setup.${ext}
```

这样产物文件名为 `MC物料查询-1.0.1.1-Setup.exe`，`latest.yml` 里产品版本仍是 `1.0.2`。仅用于测试，正式发布请改回统一版本号。

### 升级测试包（独立输出目录）

为避免测试包污染正式 `dist/`，可将产物临时输出到独立子目录，打包后再还原输出目录。

**以 1.0.46 升级测试包为例：**

1. 升版本号：
   ```text
   package.json          -> "version": "1.0.46"
   electron-builder.yml  -> buildVersion: 1.0.46.0
   ```

2. 临时把输出目录改为独立文件夹（改完记得还原）：
   ```yaml
   # electron-builder.yml
   directories:
     output: dist/update test
   ```

3. 打包：
   ```powershell
   npm run pack:win
   ```

4. 打包后把 `electron-builder.yml` 的 `output` 还原回 `dist`。

产物位于 `dist/update test/`：

```text
dist/update test/
├── latest.yml                            # 指向 1.0.46
├── MC物料查询 Setup 1.0.46.exe            # NSIS 安装包
├── MC物料查询 Setup 1.0.46.exe.blockmap   # 增量更新块映射
├── MC物料查询 1.0.46.exe                  # 便携版
└── win-unpacked/                         # 免安装解压版
```

测试方式：把该目录下的 `latest.yml` + `*.exe` + `*.exe.blockmap` 作为**草稿 Release** 的附件上传（`gh release create --draft`，
或直接 `.\build_now.ps1 -Publish` 后先别发布），已安装的旧版本（如 1.0.43/1.0.45）客户端即可检测到 1.0.46 升级；
验证完记得清理该草稿 Release（草稿不会被客户端看到，正式发布前不要把测试包设为 Published）。

### 更新进度优化（1.0.3 起）

1.0.3 起更新流程加入可视化进度：

- 主进程通过 `download-progress` 事件实时回传下载百分比；
- 渲染端 `UpdateBar` 用 animal-island-ui 的 `Progress` 组件显示「正在下载更新（XX%）」进度条；
- 下载完成后进度置 100% 并显示「安装」按钮，点击即重启安装；
- 修复了更新错误事件 channel 不一致（`update-error`）的 bug；
- 手动「检查更新」：无更新/版本相同 → 提示「当前已是最新版本」；有更新 → 提示「发现新版本 X」，顶部更新条显示「下载」按钮，点击后再下载。

**交互细节（1.0.3 多轮打磨）：**
- 头部「语言/帮助」两个 Select 文字为棕色 `rgb(121,79,39)`，「帮助」加粗；「退出登录」按钮文字纯白。
- 自动检测 / 手动检查有更新时，顶部 UpdateBar 显示「下载」按钮；点击后开始下载并显示 Progress 进度条。
- 手动「检查更新」有更新时，弹窗「检测到新版本 X，是否立即下载更新包？」，确认即开始下载（顶部 UpdateBar 显示进度）。
- 下载完成后 UpdateBar 显示「立即更新」按钮；点击后**当前 app 立即退出**，并以 **NSIS 向导模式**（非静默）弹出安装界面，用户可见安装过程、可选择目录、完成后自动启动新版本。
  - 实现：取 `electron-updater` 已下载的安装包路径，直接 `spawn(installer, ['--updated', '--force-run'])` 启动 NSIS 安装向导（不加 `/S`，确保非静默），随后 `app.exit(0)` 关闭旧版本；`--force-run` 保证安装完成后自动重启 app。
- 检测失败时 UpdateBar 显示红色错误提示（网络不通 / 服务器文件缺失），不再静默。

涉及文件：`src/main/updater.ts`、`src/preload/index.ts`、`src/renderer/src/App.tsx`、`src/renderer/src/store.ts`、`src/renderer/src/components/UpdateBar.tsx`、`src/renderer/src/components/QueryPanel.tsx`、`src/main/index.ts`、`shared/i18n.ts`、`src/renderer/src/styles.css`。

### 版本历史

版本历史已分离到独立文件 **`MC Tool Release Notes.md`**，请从该文件查看与维护。
