---
name: mc-material-query-local
description: 查询锐明 OA MC 物料系统的本地优化版技能（物料搜索/料号查询/库存/BOM/规格文件下载/物料对比），优先于企业版 mc-material-query 使用。统一入口 scripts/mc_query.js，支持 search/item/batch/bom/spec 五个子命令。当用户需要查料号、查物料库存、查 BOM、下载规格文件、对比物料生命周期风险时使用。鉴权采用 Cookie 缓存 + 直连 HTTP：无需常驻 Chrome，仅会话失效时自动弹窗扫码一次；Node.js 由 scripts/ensure_node.ps1 自动自举。输出：HTML 报告 + 中文摘要。
metadata:
  type: skill
  agent_created: true
version: 2.0.0
name_zh: OA料号库存查询（本地版）
description_zh: 查询锐明 OA MC 物料系统（物料搜索/料号查询/BOM/规格文件/物料对比），本地维护优化版
---

# OA MC 物料查询（本地优化版）

调用锐明 OA 系统 MC 物料搜索 API 查询物料（Cookie 缓存 + Node 直连 HTTP，毫秒级响应）。查询结果输出 **HTML 报告** + 中文摘要；规格文件可下载到用户指定目录。

技术架构（v2.0）：
1. **直连模式（默认）**：脚本用本地缓存的 Cookie（`~/.cache/oa-mc-cookies.json`）直接发 HTTP 请求，**完全不需要 Chrome**；
2. **登录模式（按需）**：无缓存或会话失效时，脚本自动以独立数据目录拉起 Chrome 等待用户扫码，成功后通过 CDP 导出全部 Cookie（含 httpOnly）写入缓存并**自动关闭浏览器**；
3. 之后所有查询回到直连模式。

技能目录：`C:\Users\streamax\.config\opencode\skills\mc-material-query-local`（下文以 `$SKILL` 指代）

> **与企业版的区别**：本技能是基于 OpenCode `mc-material.md` 工作流优化的本地维护版，路径已适配本机。另有一个企业市场安装的 `mc-material-query`（云端托管，脚本路径指向其他机器），**执行查询一律使用本技能，不要用企业版**。

## 核心原则（必须遵守）

1. **不要预启动 Chrome、不要探测 CDP**：直接运行 `mc_query.js` 即可，脚本自己管理鉴权（直连 → 失效才弹窗扫码）。只有脚本输出"请在 Chrome 窗口完成扫码登录"时才告知用户操作并等待。
2. **所有接口请求由 `mc_query.js` 内部直连发出**（自动携带缓存 Cookie）。不要在 shell 里直接 curl 接口（缺登录态）。
3. **用户未明确指定下载目录时，先询问保存位置**，再执行 `--download`。
4. 批量任务逐个串行请求即可，不要并发轰炸接口。
5. 结果输出使用中文、表格化、简洁清晰；生命周期为红色风险级（退市/禁购/禁用）时**必须显著警告**。

## 快速上手

**第一步：Node.js 自举**（已存在则直接返回路径跳过下载；缺失时自动从腾讯云/阿里云镜像下载）：

```powershell
$SKILL = "C:\Users\streamax\.config\opencode\skills\mc-material-query-local"
$NODE = & "$SKILL\scripts\ensure_node.ps1"   # stdout 最后一行即 node.exe 路径
```

本机 PATH 已有 Node ≥ 22 时也可直接用系统 node，但优先使用 ensure_node 返回的路径，保证行为一致。

**第二步：执行查询**：

```powershell
# 1. 物料描述搜索（支持 && 多条件）
& $NODE "$SKILL\scripts\mc_query.js" search "X3N&&0404"
& $NODE "$SKILL\scripts\mc_query.js" search "X3N&&0404&&不带logo"

# 2. 单料号查询（精确匹配，无结果自动回退 ITEM_DESC 模糊匹配）
& $NODE "$SKILL\scripts\mc_query.js" item 1261090100121

# 3. 批量料号查询（逐个精确 + 模糊回退，报告未查到的料号）
& $NODE "$SKILL\scripts\mc_query.js" batch 5154021100086 1260060100012 1260010000352

# 4. BOM 查询（父项物料信息 + 子项明细，按层级展示）
& $NODE "$SKILL\scripts\mc_query.js" bom 5154021100047

# 5. 规格文件查询（文件列表 + 下载链接）
& $NODE "$SKILL\scripts\mc_query.js" spec 1210030000165

# 6. 规格文件查询并下载到用户指定目录
& $NODE "$SKILL\scripts\mc_query.js" spec 1210030000165 --download --out "<用户指定目录>"
```

可选参数：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--out <目录>` | HTML 报告 / 下载文件输出目录 | 当前工作目录 |
| `--org <ID>` | 组织 ID | `102` |
| `--download` | spec 专用：同时下载规格文件到 `输出目录/spec_files/` | 不下载 |

输出文件（按子命令）：

| 子命令 | 输出文件 |
|--------|----------|
| `search` / `item` | `material_query_result.html` |
| `batch` | `material_batch_result.html` |
| `bom` | `bom_result.html` |
| `spec` | `spec_file_result.html`（加 `--download` 时另存文件到 `spec_files/`） |

## 前置条件

- **Node.js（自动自举）**：无需预装，`ensure_node.ps1` 会检查/下载到 `$env:USERPROFILE\.qwenworkcn\binaries\node\versions\22.22.2\`（Node 22+ 内置 WebSocket 与 fetch）
- **Chrome**（仅登录时需要）：`C:\Program Files\Google\Chrome\Application\chrome.exe`（以实际安装路径为准）；脚本自动以 `--no-proxy-server --remote-debugging-port=9222 --user-data-dir=%USERPROFILE%\.cache\chrome-oa-mc` 拉起，无需手动启动
- **OA 账号**：`http://oa.streamax.com:8080/`（经 IAM SSO 统一认证，扫码登录）

## 鉴权流程（v2.0，全自动）

1. **直连优先**：脚本读取 `~/.cache/oa-mc-cookies.json`，有效则直接 HTTP 查询（约 1~2 秒完成），全程无浏览器、无弹窗。
2. **会话失效自动重登**：检测到重定向到 `iam.streamax.com` 或返回 HTML 时，脚本自动拉起 Chrome（独立数据目录）并提示"请在 Chrome 窗口完成 OA 扫码登录"，每 3 秒轮询（最长 180 秒）。
3. **Cookie 自动捕获**：登录成功后通过 CDP `Storage.getCookies` 导出全部 streamax.com Cookie（含 httpOnly）写入缓存文件；若浏览器是本脚本拉起的，导出后自动关闭。
4. **失败兜底**：重新登录后仍失效 → 输出 `[FATAL] 登录后会话仍无效`，此时检查内网网络。
5. 注意：用户在自己日常浏览器里登录**不会**同步到独立 profile，必须在脚本弹出的那个 Chrome 窗口内完成扫码。

### 会话保活（可选）

OA 服务端会话有闲置超时。如需长时间免扫码，可用计划任务定期跑一次轻量查询保活：

```powershell
# 示例：每 20 分钟查一次（schtasks 创建），保持服务端 session 不过期
schtasks /Create /TN "OA-MC-KeepAlive" /SC MINUTE /MO 20 /TR "node C:\Users\streamax\.config\opencode\skills\mc-material-query-local\scripts\mc_query.js item 1210030000162 --json"
```

## 本地 AHD/IPC 摄像机可售清单（离线数据）

数据来源：GitHub `zvcii8/AHD-Camera-Sales-List`（AHD摄像机可售清单.html），已蒸馏为本地 JSON：
`$SKILL\data\camera_sales_list.json`（2409 条：AHD 1626 + IPC 783）。

**用途**：快速检索 AHD/IPC 摄像机料号、型号、镜头、分辨率、LOGO、描述等**静态信息**，无需联网。

**查询脚本**：`python "$SKILL\scripts\camera_list_query.py" <子命令> [参数] --json`

| 子命令 | 说明 | 返回 |
|--------|------|------|
| `item <料号>` | 按料号精确查询（无结果自动回退包含匹配） | `{itemNumber, found, rows}` |
| `search <关键词>` | 型号/描述模糊搜索，支持 `&&` 多条件 | `{query, rows}` |
| `imx307 <料号>` | 查询 IMX307 替代料号映射 | `{itemNumber, found, rows}` |
| `stats` | 统计（总数/分类/型号分布/IMX307映射数） | `{total, categories, models}` |

记录字段：`cat`(AHD/IPC)、`m`(型号)、`t`(类型)、`p`(料号)、`r`(分辨率)、`s`(制式)、`l`(镜头)、`i`(红外)、`g`(LOGO)、`st`(清单状态)、`c`(型号编码)、`cn`(中文描述)、`en`(英文描述)。

> **重要**：本清单的 `st`（可售/状态）与 MC 服务器生命周期**可能不一致**（清单可能滞后）。
> **生命周期、库存等动态数据一律以 MC 服务器查询（`mc_query.js`）为准**，本地清单仅用于料号/型号/描述检索与候选筛选。

## IMX307 替代料号（本地静态数据 + 自动提示）

数据来源：`E:\毛祖潇的知识库\产品资料\产品线\摄像机\AHD\IMX307替代料号明细_260529.xlsx`，已梳理为本地 JSON：
`$SKILL\data\imx307_replacement.json`（438 条映射：IMX307 方案料号 → F355 等替代料号）。

**自动提示规则（两个查询入口均已实现）**：
- `mc_query.js`（MC 服务器查询）与 `camera_list_query.py`（本地清单查询）的 `item`/`search`/`batch` 结果中，
  若某行物料描述含 **IMX307**，自动附加 `imx307_replacement` 字段：
  - 命中映射表 → 数组含替代料号（`replacement`、`replacement_desc`、`lifecycle`、`model`）
  - 未命中映射表 → 空数组 `[]`（表示已检查但无替代记录，需提示用户确认）
- agent 收到含 IMX307 的结果时，**必须**向用户提示替代料号并告知客户（如"该料号为 IMX307 方案，建议改用替代料号 XXX（F355方案）"）。
- 也可用 `imx307 <料号>` 子命令单独查询替代映射。
- 替代料号的**生命周期/库存仍以 MC 服务器查询为准**（映射表 `lifecycle` 字段为 Excel 静态数据，可能滞后）。

## 查询类型

| 场景 | API method | 查询参数 | 说明 |
|------|-----------|----------|------|
| 物料描述搜索 | `wuliao` | `q.ITEM_DESC` | 多条件按顺序用 `&&` 拼接 |
| 料号精确查询 | `wuliao` | `q.ITEM_NUMBER` | 无结果自动回退 `q.ITEM_DESC` 模糊匹配 |
| 批量料号 | `wuliao` | 逐个 `q.ITEM_NUMBER` | 汇总结果并报告未查到的料号 |
| BOM 查询 | `bom` | `q.ASSEMBLY_ITEM_NUMBER` | 父项（装配件）完整料号 |
| 规格文件 | `specificationFile` | `q.itemNumber` | 驼峰命名，无需组织 ID |

## 物料对比

用户给出两个及以上料号要求对比时：用 `batch` 逐个查询后，在回复中以表格对比——料号、描述、类型（采购/制造）、生命周期（带风险标记）、库存、各仓数量、K3 编码、有无规格文件。生命周期为红色级别（退市/禁购/禁用）必须加明显警告。可按用户要求增加维度，如 BOM 差异：分别拉取两个料号的 BOM 后对比子项差异集合。

## 生命周期分级（输出必须带颜色标记）

- **绿色/正常**：量产、批量-推荐
- **黄色/关注**：研发样品、未承样、预退市、逐步淘汰、批量-不推荐
- **红色/风险**：退市、禁购、禁用 —— 查询与对比中必须显著提示

## API 参考

**Base URL**：`http://oa.streamax.com:8080/ruiming/mc/materiel_ui/materielSearch.do`（ORIGIN：`http://oa.streamax.com:8080`）

| 方法 | method 参数 | 关键查询参数 | 说明 |
|------|------------|-------------|------|
| 物料搜索 | `wuliao` | `q.ITEM_NUMBER` 或 `q.ITEM_DESC` | 支持模糊搜索、`&&` 多条件 |
| BOM 查询 | `bom` | `q.ASSEMBLY_ITEM_NUMBER` | 需完整料号（已抓包验证） |
| 规格文件 | `specificationFile` | `q.itemNumber` | **驼峰命名，且无需 `q.ORGANIZATION_ID`** |
| 规格文件下载 | `specificationFileDownload` | `fileId` + `fileName` | URL 从列表返回的 `fileName` 锚点 href 解析 |

通用参数：`q.ORGANIZATION_ID=102`（规格文件接口不需要）、`__seq={时间戳}`（防缓存）。

示例：

```
?method=wuliao&q.ORGANIZATION_ID=102&q.ITEM_DESC=X3N&&0404
?method=wuliao&q.ORGANIZATION_ID=102&q.ITEM_NUMBER=5196009100055
?method=bom&q.ORGANIZATION_ID=102&q.ASSEMBLY_ITEM_NUMBER=5196009100055
?method=specificationFile&q.itemNumber=1210030000165
?method=specificationFileDownload&fileId=18863752&fileName=xxx.pdf
```

### 返回数据结构

`wuliao` / `bom` 返回 `{columns, datas}`：`datas` 是行数组，每行为 `{col, value}` 列数组，需按 `col` 折叠成对象。

物料行关键字段：`ITEM_NUMBER` 料号、`ITEM_DESC` 描述、`ITEM_TYPE` 类型（采购/制造）、`INV_STATUS_NAME` 生命周期、`ON_HAND_QTY` 库存、`K3_ITEM_NUMBER`、`DEVELOPMENT_SUB`/`TRACK_SUB`/`PRODUCT_ORDER_SUB`/`UPDATE_ORDER_SUB`（各仓数量）。

BOM 行额外字段：`BOM_LEVEL` 层级、`COMPONENT_ITEM` 组件料号、`COMPONENT_ITEM_DESC` 组件描述、`PRIMARY_UOM_CODE` 单位、`LOSS_RATE` 损耗率、`INVERSE_QUANTITY` 单位用量、`COMPONENT_REFERENCE_DESIGNATOR` 位号、`COMPONENT_REMARKS` 备注、`HAS_FILE` 附件 HTML、`ASSEMBLY_ITEM_DESC` 父项描述。

`specificationFile` 返回 `{datas: [{itemNumber, itemDes, fileName}]}`：`fileName` 是 HTML 锚点字符串（`<a href="...method=specificationFileDownload&fileId=<ID>&fileName=<文件名>">文件名</a>`），脚本已解析为纯文件名 + 完整下载 URL；为空表示无附件。常见类型：PDF（规格书）、DWG（图纸）。

## 规格文件下载流程

1. 先 `spec <料号>` 拿到附件列表；**用户未指定目录时先询问保存位置**。
2. `--download --out <目录>` 由脚本直连下载（携带缓存 Cookie），存到 `<目录>/spec_files/`。
3. 文件名保留服务器原始文件名；同一料号多个附件默认全部下载，或按用户指示筛选。
4. 下载后校验每个文件存在且大小 > 0，向用户报告完整路径和大小。

## 注意事项

- 接口均为 HTTP 明文，仅在用户内网环境使用。
- Cookie 缓存文件 `~/.cache/oa-mc-cookies.json` 含登录凭据，不要提交到仓库或外发。
- 查询结果默认输出 **HTML 报告**（不生成 JSON/Word/Excel/CSV 文件），聊天回复中另给中文表格摘要。
- `ensure_node.ps1` 必须保持 **UTF-8 带 BOM**（PowerShell 5.1 按 GBK 解析中文注释会报语法错误）；执行须用 PowerShell 工具，不要从 cmd/批处理调用，批处理中也不要出现中文（GBK 编码坑）。