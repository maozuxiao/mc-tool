---
name: file-office-local
description: MC Tool 内置技能：在本地工作区内读写文件（Markdown/TXT/CSV、Office 三件套、PDF），供 AI Build 模式调用。统一入口 scripts/file_office.js，支持 ping/read/list/search/write 等子命令。所有路径强制限制在 --root 指定的工作区内。
metadata:
  type: skill
  agent_created: true
version: 0.1.0
name_zh: 本地文件读写（Office/PDF）
description_zh: 在指定的工作区目录内读写 Markdown、TXT、CSV、Word、Excel、PPT、PDF，供 AI Build 模式使用
---

# 本地文件读写（file-office-local）

供 MC Tool 的 **AI Build 模式** 调用，让模型能在用户选定的工作区内读写文件。
设计为**独立 Node 进程 + JSON 协议**，与 Electron 主进程解耦：脚本崩溃不影响应用本身。

## 调用方式

```powershell
$NODE = & "$SKILL\scripts\ensure_node.ps1"   # stdout 最后一行即 node.exe 路径
& $NODE "$SKILL\scripts\file_office.js" <command> [args...] --root <工作区目录> --json
```

结果以 `===JSON_BEGIN===` / `===JSON_END===` 包裹输出到 stdout，
标记之外的 stdout 内容视为进度日志（与 `mc_query.js` 协议一致）。

## 命令

| 命令 | 说明 | 状态 |
|------|------|------|
| `ping` | 健康检查，报告各格式依赖的加载状态（不校验 `--root`） | ✅ 可用 |
| `read <path> [--offset N] [--limit N] [--max-bytes N]` | 读取文本/Office/PDF 文件 | ✅ 可用（含 docx/xlsx/pptx/pdf） |
| `write <path> [--content "..."] [--append] [--encoding auto\|utf8\|gbk]` | 写入文本类文件 | ✅ 可用（二进制 Office/PDF 不支持写） |
| `list <dir> [--type file\|dir]` | 列目录 | ✅ 可用 |
| `search <pattern> [--dir <dir>] [--name] [--content] [--max N]` | 按文件名/内容搜索 | ✅ 可用 |
| `cmd <command>` | 执行命令 | ❌ 已取消（不在 Build 模式范围内） |

## 安全约束（重要）

1. **必须传 `--root`**：除 `ping` 外的所有命令都要求指定工作区根目录，
   否则直接报错退出。这是沙箱的唯一边界。
2. **路径越界一律拒绝**：相对路径按 `--root` 解析；解析符号链接后
   仍需落在 `--root` 内。越界返回 `code: PATH_OUTSIDE_ROOT`，进程退出码 2。
3. **内容截断**：单次读取默认上限 200KB（硬上限 2MB），
   避免把大文件整个塞进模型上下文。被截断时返回 `truncated: true`。
4. AI 给出的路径**不可信**（可能来自被读文件里的提示注入），
   因此每个路径都必须在服务端重新校验，不能只靠前端或模型自觉。

## 文本解码

Windows 中文环境常见 GBK 编码的 `.txt` / `.csv`，Node 原生只认 UTF-8。
脚本按以下顺序判定：

1. 识别 BOM（UTF-8 / UTF-16LE / UTF-16BE）
2. 无 BOM 时先按 UTF-8 解码，统计 `U+FFFD` 替换字符比例
3. 比例 > 1% 时改用 `iconv-lite` 按 GBK 解码，取替换字符更少的结果

## 格式支持

| 格式 | 读取 | 写入 |
|------|------|------|
| `.md` `.txt` `.csv` `.json` `.log` `.yml` 等纯文本 | ✅ | ✅（覆盖写 / `--append` 追加） |
| `.docx` | ✅ mammoth 提取文本 | ❌ 二进制格式不支持 |
| `.xlsx` | ✅ exceljs 转 Markdown（公式取 result） | ❌ 二进制格式不支持 |
| `.pptx` | ✅ jszip 提取 `<a:t>` 文本 | ❌ 二进制格式不支持 |
| `.pdf` | ✅ pdfjs-dist（NodeCMapReaderFactory 解决中文丢失） | ❌ 二进制格式不支持 |
| `.doc` `.xls` `.ppt`（老二进制格式） | ❌ 需先转换 | ❌ |

## 依赖说明

所有依赖均为**纯 JavaScript**（已验证打包后 `.node` 原生模块数量为 0），
因此不存在 Electron ABI 不匹配 / node-gyp 重建问题，可直接随 asar 分发。

| 依赖 | 用途 | 备注 |
|------|------|------|
| `exceljs` | xlsx 读写 | |
| `mammoth` | docx → 文本/HTML | |
| `docx` | 生成 docx | |
| `pptxgenjs` | 生成 pptx | |
| `jszip` | docx/pptx 的 XML 层修改 | |
| `pdfjs-dist` | PDF 文本提取 | **固定 3.x**：4.x 的 legacy build 为纯 ESM，CommonJS 无法直接 require |
| `iconv-lite` | GBK 解码 | |

### 打包瘦身

`node_modules` 原始体积约 77MB，其中 `.map`（source map）占 32MB、`@types` 占 2.3MB。
打包时通过 `electron-builder.yml` 的 `filter` 排除这两类运行时无用文件，
降至约 38MB；叠加 `compression: maximum` 后，安装包体积仅增加约 9.6MB。

## 注意事项

- `ensure_node.ps1` 必须保持 **UTF-8 带 BOM**（PowerShell 5.1 按 GBK 解析中文注释会报语法错误）。
- 首次调用可能触发 Node 自举下载（约 1~2 分钟），`ping` 的超时按 180s 设置。
- 脚本以独立进程运行，主进程通过 `spawn` 调用；Windows 上取消时需要
  `taskkill /pid <pid> /t /f` 才能杀掉整个进程树（`child.kill()` 只杀直接子进程）。
