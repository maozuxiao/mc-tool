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
& $NODE "$SKILL\scripts\file_office.js" <command> [args...] --root <主工作区目录> --extra-root <别名>|<目录> [--extra-root ...] --json
```

## 多根 / 别名前缀

Build 模式支持**多个已授权目录**（主工作区 + 额外目录白名单 + 会话内 `open_folder` 打开的目录）：

- `--root <目录>`：主工作区根（别名为空）。裸相对路径（如 `report.xlsx`）相对它解析。
- `--extra-root <别名>|<目录>`：额外目录，**可重复**。模型用 `别名/路径` 引用其中文件，如 `shared/report.xlsx`。
- 路径解析顺序：先看是否 `别名/子路径` 形式 → 命中对应根；否则回退主根；若只有一个根则用它；多个根且无主根时必须带别名前缀，否则报 `AMBIGUOUS_ROOT`。
- 用户已给出完整绝对路径（含盘符，如 `E:/销售相关/PI/Murat/`）时，必须原样完整传入，禁止截断成 `murat`、`order_summary` 等别名——别名只在 `open_folder` 返回后才有效。
- 别名可恰好等于目录本身（无斜杠），如 `open_folder` 返回的 `shared` 即代表该根目录。

结果以 `===JSON_BEGIN===` / `===JSON_END===` 包裹输出到 stdout，
标记之外的 stdout 内容视为进度日志（与 `mc_query.js` 协议一致）。

## 命令

| 命令 | 说明 | 状态 |
|------|------|------|
| `ping` | 健康检查，报告各格式依赖的加载状态（不校验 `--root`） | ✅ 可用 |
| `read <path> [--offset N] [--limit N] [--max-bytes N]` | 读取文本/Office/PDF 文件 | ✅ 可用（含 docx/xls/xlsx/pptx/pdf） |
| `read_batch <path1> [path2 ...] [--path <p> ...]` | 一次读取多个文件（最多 12 个），只消耗 1 次工具调用 | ✅ 可用（每个文件返回 {ok, relative, format, text, truncated}） |
| `write <path> [--content "..."] [--append] [--update] [--force]` | 写文本类 / 生成或原地修改电子表格（xlsx/xls） | ✅ 可用；xlsx/xls 可生成，或 `--update` 在原表上原地新增/修改/标记颜色（保留原工作表名与样式）；已有文件禁止用无 `--update` 的 write 重建 |
| `list <dir> [--type file\|dir]` | 列目录 | ✅ 可用 |
| `search <pattern> [<dir>] [--name-only] [--regex] [--glob <文件名通配>] [--ext <ext,...>] [--depth N] [--max-results N]` | 类 FileLocatorPro 保底搜索：正则/通配符/文件类型过滤 | ✅ 可用；用 `--regex` 并把多个料号用 `\|` 连成一条正则（如 `5190012100066\|1260030100035`）时，每个料号最多返回一条命中（按首次出现）并带 `matched` 字段，便于逐码判断「是否有记录」，不会因为大文件里某码命中很多行而把其他码挤出结果 |
| `cmd <command>` | 执行命令 | ❌ 已取消（不在 Build 模式范围内） |

## 安全约束（重要）

1. **必须至少传 `--root` 或 `--extra-root` 之一**：除 `ping` 外的所有命令都要求
   指定至少一个可访问目录（主工作区或额外目录），否则直接报错退出。这是沙箱的唯一边界。
2. **路径越界一律拒绝**：相对路径按命中的根解析；解析符号链接后
   仍需落在该根内。越界返回 `code: PATH_OUTSIDE_ROOT`，进程退出码 2。
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
| `.xlsx` | ✅ exceljs 转 Markdown（公式取 result） | ✅ 生成 / `--update` 原地修改（保留样式）；新建用 `write`、改已有用 `write --update`，禁止无 `--update` 重建 |
| `.pptx` | ✅ jszip 提取 `<a:t>` 文本 | ❌ 二进制格式不支持 |
| `.pdf` | ✅ pdfjs-dist（NodeCMapReaderFactory 解决中文丢失） | ❌ 二进制格式不支持 |
| `.xls` | ✅ SheetJS(xlsx) 读取（老版 BIFF 二进制格式） | ❌ 二进制格式不支持 |
| `.doc` `.ppt`（老二进制格式） | ❌ 需先转换 | ❌ |

## 单元格填充色（背景色）

写入电子表格时可为单元格设置背景色（填充），适用于「按条件标记行/单元格」等场景。

- **新建表格（xlsx / xls）**：content 用 JSON 二维数组 / 对象数组，单元格值写成对象 `{ "value": "文本", "fill": "green" }` 即可上色（普通标量写法不受任何影响）。
- **回填已有表格（update=true，仅 xlsx 可靠保样式）**：同样可用 `{ "value": "文本", "fill": "yellow" }` 给具体单元格上色；但只要用户说「当前行」/「这一行」/「整行」标色，就必须用保留键 `"__rowFill": "green"` 控制整行颜色，脚本会自动把 A 列到工作表最右列所有单元格填满该色，并覆盖该行原有的旧填充色（`__rowFill` 不会被当作普通列写入）。严禁添加「行色」列、或在单元格里写 `🟢`/`🟡` 文本来表示颜色。存在多个查询/判断路径时，按「任一命中即绿，全部未命中才黄」统一整行颜色：例如「Murat记录」和「Order summary记录」两列，只要任一列不是「无」/「无记录」，该行就必须整体标绿；只有两列都是「无」/「无记录」时才整体标黄。禁止把一行拆成几段分别上色。示例：
  ```json
  {
    "key": "物料代码",
    "rows": [
      { "物料代码": "5190012100066", "Murat(PI文件夹)": "有：...", "Order summary(出货记录)": "有：...", "__rowFill": "green" },
      { "物料代码": "5110064100006", "Murat(PI文件夹)": "无", "Order summary(出货记录)": "无", "__rowFill": "yellow" }
    ]
  }
  ```
- **严禁重建已有文件**：对已存在的表格做任何改动（新增/修改/标记颜色）都必须用 `write --update`，在**原表**上原地处理；切勿用无 `--update` 的 `write` 重新生成整个文件——那样会丢失原工作表名（如 Sheet2）以及字体、列宽、合并单元格等全部样式，且可能丢数据。确需覆盖重建时由用户明确要求并加 `--force`。
- **颜色取值**：
  - 名称：`green` / `lightgreen` / `yellow` / `lightyellow` / `red` / `lightred` / `blue` / `lightblue` / `gray`(grey) / `orange` / `white`
  - 或十六进制 `#RRGGBB`（也可带 Alpha 写成 `FFRRGGBB`）
- 未识别的颜色会被**忽略且不上色**，并在返回里附 `unsupportedFills` 与 `supportedFills`，便于模型提示用户改用支持的颜色。
- 注意：`.xls` 的 `update` 走 SheetJS 旧实现（不保留原表样式），新建/回填的填充色为尽力支持；需要精确样式时请使用 `.xlsx`。

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
| `xlsx` | 读取老版 `.xls`（SheetJS 社区版，纯 JS） | exceljs 已覆盖 .xlsx，此库专补 .xls |
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
