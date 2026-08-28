# MC 物料查询桌面端（mc-tool）

企业 OA 物料查询的独立桌面应用。把原来只能在 OA 网页里做的「料号 / BOM / 规格文件查询」搬到本地客户端，支持批量查询、二次筛选排序去重与 CSV 导出，启动即用，不必反复打开浏览器跳转。

- 仓库：https://github.com/maozuxiao/mc-tool
- 技术栈：Electron 33 + electron-vite + React 18 + TypeScript + Zustand，UI 组件库 [`animal-island-ui`](https://www.npmjs.com/package/animal-island-ui)
- 当前版本：`1.0.24`（`package.json` 的 `version` 为准）

---

## 一、项目背景

锐明技术（Streamax）的物料数据存放在企业 OA 系统（`http://oa.streamax.com:8080`）的 MC 模块中。原来要查一个料号，需要在浏览器里登录 OA、进入 MC 页面、逐项点选，存在几个痛点：

1. **入口深、跳转多**：每次查询都要先打开浏览器 → 登录 OA → 进入 MC 模块。
2. **只能单条查**：网页端不支持一次粘贴几十个料号批量查询。
3. **结果不可再加工**：查出来的列表无法二次筛选、排序、去重，导出前还得手工整理。
4. **BOM / 规格文件分散**：看 BOM 层级、下载规格文件要反复切换页面。
5. **登录态易失效**：OA 会话过期后，网页里正在填的查询条件一并丢失。

本项目用 Electron 把这套流程封装成独立桌面应用：**登录一次，长期保持会话**；查询请求由主进程代理并自动携带 OA Cookie，绕开浏览器端的跨域限制；结果在客户端内完成筛选/排序/去重后直接导出 CSV，可直接喂给 Excel 或其他系统。

> 前置条件：使用者需拥有企业 OA 账号，并能通过**企业钉钉扫码**完成登录。

---

## 二、功能特性

| 模块 | 说明 |
|---|---|
| 🔐 **OA 登录** | 企业钉钉扫码登录（IAM 二维码 + 轮询），登录态跨启动保留；会话失效（901）自动 SSO 刷新，失败则引导重新扫码。 |
| 🔍 **物料查询** | 按描述多条件组合查询（`&&` 叠加条件行），支持关键词包含 / 排除、类型筛选、生命周期多选、去重、点击表头排序。 |
| 🔢 **料号查询** | 按完整 / 部分料号精确或模糊查询（独立入口，不与描述条件混用）。 |
| 📋 **批量查询** | 粘贴多个料号（换行 / 空格 / 逗号 / 制表符分隔），逐个精确匹配后合并结果，并单独列出未命中的料号。 |
| 🌳 **BOM 查询** | 按完整料号查物料清单，支持层级展示、组件展开、查看子件 BOM / 规格文件。 |
| 📎 **规格文件查询** | 按料号列出附件并**在应用内下载**（复用已登录会话，不会跳到浏览器提示未登录）。 |
| 📤 **CSV 导出** | 任意结果表一键导出 CSV（含 BOM，便于 Excel 打开）。 |
| 🆕 **自动更新** | 启动 3 秒后后台检查 GitHub Releases，顶部更新条显示下载进度，下载完成后以 NSIS 向导模式非静默安装。 |
| 🌐 **其他** | 中英双语切换；`Ctrl + 滚轮` 缩放、`Ctrl + 0` 复位；输入框历史记录；列宽可拖拽并记忆。 |

---

## 三、如何使用这个 App

### 3.1 安装（首次使用）

1. 到 Releases 页面下载安装包：
   <https://github.com/maozuxiao/mc-tool/releases>
2. 选择 `mc-material-query-setup-<版本号>.exe`（NSIS 安装包）下载。
3. 双击运行 → 安装向导可选择安装目录 → 完成，桌面与开始菜单会生成「MC物料查询」快捷方式。

> 便携版 `MC物料查询 <版本号>.exe` 免安装，双击即用，适合没有管理员权限的场景。
>
> ⚠️ **1.0.23 及更早版本内置的更新地址是旧源，无法自动升级到 1.0.24**。老用户请手动下载 1.0.24 覆盖安装一次，之后即可正常自动更新。

### 3.2 登录

1. 打开应用，若未登录会自动展示**企业钉钉扫码**二维码。
2. 用**企业钉钉手机 App** 扫码并在手机上确认。
3. 界面显示「正在进入工具」→ 扫码成功后 1~4 秒内进入主界面。
4. 登录态会持久化，**下次打开通常无需再扫码**；会话过期或退出登录后需要重新扫码。

扫码异常时的自我修复：
- 二维码有有效期，过期会自动换新码，无需手动点刷新。
- 网络异常（如 IAM 冷启动超时）会提示并自动重拉二维码。
- 点击登录界面的「退出登录」会清空本机 OA 会话备份。

### 3.3 查询操作

主界面分三个结果标签页：**物料结果 / BOM 结果 / 规格文件**。

**① 按描述条件查询**（物料结果）

1. 在搜索条件区输入关键词（如 `电阻`、`0402`）。
2. 点「+」可添加多个条件行，多行之间为「且」关系；拖动行首 `⋮⋮` 手柄可调整顺序。
3. 点「查询」，结果渲染在下方表格。

**② 按料号查询**

1. 在料号输入框填入完整或部分料号。
2. 点「查料号」——仅按料号查询，**不与上方描述条件组合**。

**③ 批量查询**

1. 展开「批量查询」面板，粘贴多个料号（换行 / 空格 / 逗号 / 制表符均可分隔）。
2. 点「批量查询」，逐个精确匹配后合并结果。
3. 未找到的料号会单独提示，方便核对。

**④ BOM 查询**

1. 切到「BOM 结果」标签页，或在物料行点「查看 BOM」。
2. 输入**完整料号**后查询，结果按层级展示，点击展开查看组件、损耗率，并可继续下钻子件。

**⑤ 规格文件查询**

1. 切到「规格文件」标签页，或在物料行点「查看规格文件」。
2. 输入料号查询附件列表，点击链接**在应用内下载**（不会跳浏览器，也不会因未登录失败）。

### 3.4 结果处理

- **筛选**：关键词「包含」「排除」、类型下拉、生命周期多选（量产 / 研发样品 / 预退市 / 退市…）。
- **去重**：勾选「去重」按料号合并重复行。
- **排序**：点击表头切换升序 / 降序。
- **展开**：结果行手风琴式互斥展开查看全部字段；展开状态在切换标签页后保持。
- **导出**：点「导出 CSV」，选择保存位置即可。

### 3.5 其他操作

| 操作 | 说明 |
|---|---|
| 切换语言 | 右上角语言下拉，中 / 英即时切换。 |
| 缩放界面 | `Ctrl + 滚轮` 调整（50%~200%），`Ctrl + 0` 复位。 |
| 调整列宽 | 拖动表头分隔线，列宽记忆在本地。 |
| 检查更新 | 「帮助」菜单 → 「检查更新」，有新版时顶部更新条出现「下载」。 |
| 打开 OA | 点击标题栏图标跳转 `http://oa.streamax.com:8080/ruiming/mc/`。 |
| 退出登录 | 「帮助」菜单 → 「退出登录」，清空本机会话。 |
| 关于 | 「帮助」菜单 → 「关于」，查看版本号与说明。 |

---

## 四、目录结构

```
mc-tool/
├─ src/
│  ├─ main/                     # 主进程（Node 环境）
│  │  ├─ index.ts               # 入口：窗口、OA 登录/SSO/二维码、Cookie 持久化与备份恢复、
│  │  │                         #        HTTP 代理、文件下载、全部 IPC handler、安装更新
│  │  └─ updater.ts             # electron-updater 封装：手动下载策略、版本比较、事件转发
│  ├─ preload/index.ts          # contextBridge 桥接，向渲染层暴露 window.mcApi
│  └─ renderer/                 # 渲染进程（React）
│     ├─ index.html
│     └─ src/
│        ├─ main.tsx            # React 入口（含 ErrorBoundary）
│        ├─ App.tsx             # 根组件：登录态守卫、更新条、主面板
│        ├─ store.ts            # Zustand 全局状态 + 查询/筛选/导出动作
│        ├─ ErrorBoundary.tsx   # 错误边界，异常上报主进程
│        ├─ styles.css / cursor.css
│        ├─ hooks/useColResize.ts   # 列宽拖拽 + 本地持久化
│        ├─ components/
│        │  ├─ QueryPanel.tsx       # 主面板：Tabs、输入、批量、时钟、历史、帮助
│        │  ├─ FilterBar.tsx        # 关键词/类型/生命周期筛选
│        │  ├─ MaterialTable.tsx    # 物料结果表
│        │  ├─ BomTable.tsx         # BOM 结果表
│        │  ├─ FileTable.tsx        # 规格文件表
│        │  ├─ LoginOverlay.tsx     # 钉钉扫码登录层
│        │  ├─ UpdateBar.tsx        # 顶部更新条（检查/下载/安装）
│        │  └─ nookIcon.ts          # NOOK 图标
│        └─ assets/nook.svg
├─ shared/                      # 主进程 / 渲染进程共享（纯逻辑，无副作用）
│  ├─ constants.ts              # OA 地址、组织号、生命周期→样式映射
│  ├─ types.ts                  # 数据类型 + IPC 通道名常量
│  ├─ query.ts                  # URL 构造、结果归一化、批量合并、筛选排序去重、CSV
│  └─ i18n.ts                   # 中英文文案字典
├─ build/                       # 打包资源（图标：icon.png / icon-512.png / icon.svg）
├─ electron.vite.config.ts      # main / preload / renderer 三端构建配置
├─ electron-builder.yml         # 打包与发布配置
├─ tsconfig.json
├─ build_now.ps1                # 一键打包/发布脚本（推荐入口）
├─ __tscheck.ps1                # TypeScript 类型检查
├─ PUBLISH.md                   # 打包 / 发布流程（发布必读）
├─ PACKAGE_README.md            # 版本号规则与打包细节
└─ MC Tool Release Notes.md     # 版本变更记录
```

### 架构要点

- **为什么查询要走主进程代理？** 渲染层是 `file://` 协议，直接请求 OA 无法携带 Cookie。主进程用 Node 原生 `http/https` 发请求，从持久化 partition 里取出 OA Cookie 拼到请求头，并手动跟随 302 重定向链（每跳都带 Cookie，否则 IAM 会认为未登录）。
- **登录态怎么保持？** 主窗口使用持久化 partition `persist:mc-query`；由于 OA 的 `route`/`SESSION` 是 session 级 cookie（跨启动落盘不可靠），主进程额外把 OA 会话 cookie 备份到 `userData/oa-session-backup.json`，启动时若 partition 为空则恢复并补齐过期时间。
- **登录判定以真实探测为准。** `probeOaSession` 的结果（200/ok）是唯一权威；只有网络级错误（如 `-118` 超时）才信任 cookie 兜底，避免携带过期 cookie 被 OA 302 踢回 IAM 却误判为已登录。
- **Cookie 互通**：登录成功后会把全量 streamax cookie 导出到 `~/.cache/oa-mc-cookies.json`，与脚本 `mc_query.js` 共享同一份票据。

---

## 五、开发

```bash
npm install
npm run dev        # 开发模式，支持热重载
```

其他命令：

```bash
npm run build      # 只做构建（输出到 out/）
npm run preview    # 预览构建产物
__tscheck.ps1      # 仅做 TypeScript 类型检查（不产出文件）
```

### 构建产物

`npm run build` 由 electron-vite 分别打包三端，输出到：

```
out/
├─ main/index.js
├─ preload/index.js
└─ renderer/index.html + assets/
```

`package.json` 的 `main` 指向 `out/main/index.js`。

---

## 六、打包

### 用一键脚本（推荐）

```powershell
.\build_now.ps1            # Windows 包（NSIS 安装包 + 便携版）
.\build_now.ps1 -Mac       # macOS DMG
.\build_now.ps1 -All       # 全平台
.\build_now.ps1 -NoClean   # 保留旧的 dist/
.\build_now.ps1 -Publish   # 打包并发布到 GitHub Releases（需先设 GH_TOKEN）
```

脚本会自动切到脚本所在目录（即项目根）、检查并安装依赖、清理旧的 `dist/`、打包后列出产物，任一步失败即中止。

### 直接用 npm

```bash
npm run pack:win   # Windows：NSIS 安装包 + 便携版
npm run pack:mac   # macOS：DMG（需在 macOS 上执行）
npm run pack:all   # 全平台
```

产物输出到 `dist/`（`dist/` 已被 `.gitignore` 忽略，不要提交）：

```
dist/
├─ latest.yml                            # 自动更新元数据
├─ MC物料查询 Setup 1.0.24.exe            # NSIS 安装包
├─ MC物料查询 Setup 1.0.24.exe.blockmap  # 增量更新块映射
└─ MC物料查询 1.0.24.exe                  # 便携版
```

> macOS 交叉编译在 Windows 上不可靠，DMG 请在 macOS 上打包。

---

## 七、发布

完整流程（版本号规则、GitHub Token、发布与回滚）见 **[PUBLISH.md](./PUBLISH.md)**。

简要版：

1. 同步改两个版本号：`package.json` 的 `version`（三段）与 `electron-builder.yml` 的 `buildVersion`（四位）。
2. 追加 `MC Tool Release Notes.md`。
3. 设置 `GH_TOKEN` 后一键完成打包与发布：

   ```powershell
   $env:GH_TOKEN = '你的token'
   .\build_now.ps1 -Publish
   ```

4. 到 GitHub 把生成的 draft Release 改为 Published（**草稿状态下客户端检测不到更新**）。

---

## 八、图标

`build/` 目录存放图标，`icon.ico` / `icon.icns` 因体积原因未入库，由 electron-builder 从 `build/icon.png` 自动转换：

| 平台 | 文件 |
|---|---|
| Windows | `build/icon.ico` |
| macOS | `build/icon.icns` |
| 通用（配置引用） | `build/icon.png` |

图标风格来自 animal-island-ui 的 nook1：
`https://guokaigdg.github.io/animal-island-ui/assets/nook1-Dgog9BV0.svg`
