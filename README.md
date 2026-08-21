# MC物料查询桌面应用

基于 Electron + React + TypeScript 重写的 MC 物料查询桌面端，前置条件为用户登录企业 OA（`http://oa.streamax.com:8080`）。

## 功能

- 🔐 **真实 OA 登录**：独立登录窗口加载 OA 登录页（支持验证码 / SSO / 企业钉钉扫码），登录态 Cookie 持久化（跨启动保留）。
- 🔍 **物料查询**：料号模糊 / 精确搜索、多条件 `&&` 组合、关键词筛选（包含 / 排除 / 类型 / 生命周期多选 / 去重 / 排序）、CSV 导出。
- 📋 **批量查询**：粘贴多个料号（换行 / 空格 / 逗号 / 制表符分隔），逐个精确匹配并合并结果。
- 🌳 **BOM 查询**：按完整料号查询物料清单，支持组件级展开、查看子件 BOM / 规格文件。
- 📎 **规格文件查询**：按料号查询附件并内联打开。
- 🆕 **自动更新**：从 GitHub 拉取更新包（`https://github.com/maozuxiao/Streamax/blob/main/assets/MC_Tool`），发现新版本后提示重启安装。
- 🌐 中英双语界面。

## 技术栈

- Electron 33 + electron-vite
- React 18 + TypeScript
- Zustand 状态管理
- electron-builder（NSIS / DMG 双平台）

## 开发

```bash
npm install
npm run dev        # 启动开发模式（热重载）
```

## 打包

```bash
npm run pack:win   # 生成 Windows 安装包 (NSIS)
npm run pack:mac   # 生成 macOS DMG
npm run pack:all   # 同时打包双平台
```

打包产物在 `dist/` 目录。

## 发布更新

将新版本安装包与 `latest.yml` 上传至：

```
https://github.com/maozuxiao/Streamax/blob/main/assets/MC_Tool
```

应用启动后会自动检测并下载更新。

## 目录结构

```
desktop-app/
├─ electron/
│  ├─ main/index.ts        # 主进程：窗口、登录、Cookie、自动更新
│  └─ preload/index.ts     # 安全 IPC 桥接
├─ renderer/               # React 渲染进程
│  ├─ src/store.ts         # Zustand 状态 + 查询动作
│  ├─ src/components/      # UI 组件
│  └─ index.html
├─ shared/                 # 主/渲染进程共享（常量、类型、查询逻辑、i18n）
├─ electron.vite.config.ts
├─ electron-builder.yml
└─ package.json
```

## 图标

将应用图标放入 `build/` 目录：
- Windows：`build/icon.ico`
- macOS：`build/icon.icns`
- 通用：`build/icon.png`

默认使用 nook1 图标风格。图标源：`https://guokaigdg.github.io/animal-island-ui/assets/nook1-Dgog9BV0.svg`
