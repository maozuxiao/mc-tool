# MC物料查询桌面端 — 打包与版本号说明

## 1. 版本号来源（必须同步）

| 用途 | 文件 | 字段 | 格式要求 | 说明 |
|------|------|------|----------|------|
| 产品版本 / 自动更新识别 | `package.json` | `version` | SemVer 三段，如 `1.0.1` | `app.getVersion()`、`latest.yml` 均使用此值 |
| Windows 文件版本 / exe 属性 | `electron-builder.yml` | `buildVersion` | 四位，如 `1.0.1.0` | 写入 exe 的「文件版本」属性 |
| 界面显示版本 | `src/renderer/src/store.ts` | `appVersion` | 自动读取 | 启动时从 `window.mcApi.appVersion()` 读取，**无需手动修改** |

> 原则：日常发布只需改 `package.json` 和 `electron-builder.yml` 两处，界面会自动跟随 `package.json`。

## 2. 修改版本号步骤

以发布 `1.0.2` 为例：

```text
1. 打开 desktop-app/package.json
   把 "version": "1.0.1" 改为 "version": "1.0.2"

2. 打开 desktop-app/electron-builder.yml
   把 buildVersion: 1.0.1.0 改为 buildVersion: 1.0.2.0

3. 不需要改 store.ts（已改为自动读取）
```

## 3. 打包命令

在 `desktop-app/` 目录下执行：

```powershell
# Windows 安装包 + 便携包
npm run pack:win

# 全平台
npm run pack:all
```

输出目录：

```text
desktop-app/dist/
├── latest.yml              # 自动更新元数据
├── MC物料查询 Setup 1.0.2.exe   # NSIS 安装包
└── MC物料查询 1.0.2.exe         # 便携版
```

## 4. 更新包放置位置

自动更新源配置在 `src/shared/constants.ts`：

```ts
export const UPDATE_BASE_URL = 'https://github.com/maozuxiao/Streamax/raw/main/assets/MC_Tool'
```

发布新版本时，把 `dist/` 里的以下文件上传到该目录：

```text
assets/MC_Tool/
├── latest.yml                          # 更新元数据（关键，必须上传）
├── MC物料查询 Setup 1.0.2.exe          # NSIS 安装包本体
├── MC物料查询 Setup 1.0.2.exe.blockmap # 增量更新块映射（必须一起上传）
└── MC物料查询 1.0.2.exe                # 便携版（可选，离线分发用）
```

> `latest.yml` + `*.exe` + `*.exe.blockmap` 三者必须一起上传，否则增量更新/完整更新会失败；客户端启动时会读取 `latest.yml` 判断是否需要更新。

> **重要**：`latest.yml` 每次打包都会被重新生成并指向当前版本。若要同时保留多个版本供旧客户端升级，不要互相覆盖，并按需另存历史 `latest.yml`。

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
package.json version:     1.0.1
electron-builder buildVersion: 1.0.1.0
```

打包命令：

```powershell
npm run pack:win
```

### 生成 1.0.2 更新安装包

按常规发布流程，把产品版本与文件版本统一进一位即可。注意 `package.json` 的 `version` 必须为合法 SemVer（三段），不能写成 `1.0.2.0`；文件版本 `buildVersion` 才是四位。

步骤：

```text
1. package.json        -> "version": "1.0.2"
2. electron-builder.yml -> buildVersion: 1.0.2.0
3. npm run pack:win
```

输出示例：

```text
dist/
├── latest.yml
├── MC物料查询 Setup 1.0.2.exe
└── MC物料查询 1.0.2.exe
```

上传时把 `latest.yml` + 两个 exe 一起放到 `assets/MC_Tool/`。客户端（基线 1.0.1）会自动检测到 `1.0.2` 并提示更新。

### 仅改文件版本号（四位）的测试包

如果需要 exe 属性显示为 `1.0.1.1` 之类四位版本，但产品版本仍走 SemVer，可在 `electron-builder.yml` 临时设置 `buildVersion: 1.0.1.1` 并配合 `version: 1.0.2`，再自定义文件名：

```text
nsis.artifactName: MC物料查询-${buildVersion}-Setup.${ext}
```

这样产物文件名为 `MC物料查询-1.0.1.1-Setup.exe`，`latest.yml` 里产品版本仍是 `1.0.2`。仅用于测试，正式发布请改回统一版本号。

### 升级测试包（独立输出目录）

为避免测试包污染正式 `dist/`，可将产物临时输出到独立子目录，打包后再还原输出目录。

**以 1.0.4 升级测试包为例：**

1. 升版本号：
   ```text
   package.json          -> "version": "1.0.4"
   electron-builder.yml  -> buildVersion: 1.0.4.0
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

产物位于 `desktop-app/dist/update test/`：

```text
dist/update test/
├── latest.yml                            # 指向 1.0.4
├── MC物料查询 Setup 1.0.4.exe            # NSIS 安装包
├── MC物料查询 Setup 1.0.4.exe.blockmap   # 增量更新块映射
├── MC物料查询 1.0.4.exe                  # 便携版
└── win-unpacked/                         # 免安装解压版
```

测试方式：把该目录下的 `latest.yml` + `*.exe` + `*.exe.blockmap` 上传到更新服务器目录（`assets/MC_Tool/`），已安装的旧版本（如 1.0.2/1.0.3）客户端即可检测到 1.0.4 升级。

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
