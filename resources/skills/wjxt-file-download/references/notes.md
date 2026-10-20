# edoc2 排查笔记（非可用 API，仅记录）

> 从原技能包迁移，已删掉「agent-browser / PowerShell 执行环境」那一段（应用里不装这个 CLI）。
> 但**保留的是它的做法本身**：请求必须由页面上下文发出 —— 主进程直连拿不到搜索结果，
> 详见下面「请求通道」一节。

## 请求通道：必须由页面上下文发起（2026-09-22 定案）

同一个登录态、同一个 WebCore 接口、同一份表单参数，两条通道的结果**完全不同**：

| 通道 | 实测结果 |
|---|---|
| 主进程 `session.fetch`（显式补 Cookie 头、`Referer: preview.html`） | HTTP 200，`FilesInfo` **恒为空** → 表现为「搜不到任何文件」 |
| 页面上下文 `fetch('WebCore')`（等于用站点自己的 JS 去问它的后端） | 同一关键词**命中 50 条**，字段齐全（`name/path/mtime/ext/size/guid/id/pid`） |

差别在**请求的发起者**：站点把 WebClient 模块的会话上下文绑在页面里 —— SPA 跑完
`SystemManager/GetSystemInitStatus` → `WebClient/GetCurrentUser` 之后，这个上下文才成立；
非浏览器上下文的 fetch 不参与这套绑定，而且返回码仍是 200，极难从响应上看出问题。

因此 MC Tool 用**自己的隐藏窗口**当页面宿主（`src/main/ai/wjxtSkill.ts` 的 `ensureCtxWin`）：
不显示、不进任务栏、`backgroundThrottling: false`，分区与可见窗口一致（`persist:mc-query`），
加载 `/index.html` 让站点 SPA 自己完成握手；之后所有 WebCore 请求都用 `executeJavaScript`
在**该页面里** `fetch(...)`。窗口常驻复用，崩溃 / 超时 / `Failed to fetch` 时丢弃重建；
登录成功或遇到 404 时**重新导航一次**（正是上游对 404 的处置「重新导航首页」）。
页面上下文不可用（窗口加载失败等）才降级到 `session.fetch` —— 降级通道只保证给出
「要重新登录 / 404 / 超时」这类明确结论，**拿不到搜索结果属预期**，日志里会标 `[fallback]`。

下面这些接口在排查过程中实测都不可用，记在这里避免下次重新踩。

## 不可用接口

| 接口 | 实测响应 | 备注 |
|---|---|---|
| `GET /Download?fileId=<guid>` | `{"nResult":601}` | 不要用 |
| `GET /Preview/GetFileDownloadUrl` | 异常或需 token | 不要用 |
| `GET /Preview/GetFileStream` | 异常 | 不要用 |
| `GET /Preview/GetFileDownloadAddress` | 异常 | 不要用 |
| `GET /Preview/GetFileById` | 异常 | 不要用 |

## 有用但易踩的边角

- **`downLoad/GetFile?fileName=<zipName>`**：压缩包下载，DownLoadCheck 流程走完后才能用，单文件场景用不到。
- **RegionHash 双重编码**：服务端可能把 `=` 编码成 `%3D`，原样透传即可，不要再 `decode`。
- **conversionState=5200**：表示 DOC/DOCX 还没生成预览转换；GetOriginFile 不依赖转换状态，仍可下。
- **前端源码可读**：`/download.js`（下载逻辑）、`/search_list.js`（搜索列表逻辑）、`/preview_index.js`（预览逻辑）——遇到诡异行为可以直接翻 JS 看实际请求参数。

## 实测确认（MC Tool，2026-09-22）

**未登录时服务端不是返回 401，而是 302 到 SSO 登录页**：

```
POST https://wj.streamax.com:9443/WebCore
→ HTTP/1.1 302 Found
  Location: /https://wj.streamax.com:9443/sso/auth/goToLoginPage?returnUrl=%2FWebCore
```

因此：① 判据不能等 401，要看 **302 的落点（goToLoginPage / sso/auth）**；
② 如果只是跟着重定向走完，最终会拿到一整页登录 HTML，`JSON.parse` 失败 →
容易被误报成「服务端异常 / 服务端抖动」，把排查方向带偏（1.0.43 已修：见
`src/main/ai/wjxtSkill.ts` 的 `isLoginUrl`（判「最终 URL」）与 `readJson`（判 HTML 兜底））。
另注：Electron 的 `session.fetch` **不支持** `redirect: 'manual'` —— 传了会被 Chromium 直接取消成
`Redirect was cancelled` 请求错误，所以只能跟随重定向 + 看 `res.url` 最终落点。

## edoc2 换票失败的已知限制（2026-10-10 观察，暂未修；1.0.55 从 SKILL.md 迁入）

现象：**OA 已登录、但 edoc2 换票仍失败** —— 隐藏窗口反复停在
`iam…/idp/authCenter/authenticate?…client_id=edoc2&redirect_uri=https://wj.streamax.com:9443/sso/auth/callback&state=…`，
`GetCurrentUser loggedIn=false`（`ErrorCode4`）。本节只记录**已观察到的两条线索**，不是让你去绕开它们：

1. **站点 SSO 链的 `redirect_uri` 新增了 `state` 参数**。
   - 10/07 观测：`…/idp/authCenter/authenticate?…client_id=edoc2&redirect_uri=https://wj.streamax.com:9443/sso/auth/c…`（未见 `state`）
   - 10/10 观测：`…&redirect_uri=https://wj.streamax.com:9443/sso/auth/callback&state=…`
   - 影响面：① `mintAcLoginUrl` 解析 SSO 壳页（1254 字节 HTML）里 JS 跳转地址的正则；
     ② 主进程 `hiddenNavUrl` 的落回站点判据 `isBackOnSite = host==='wj.streamax.com' && !/\/sso\/auth\//`
     —— **新的 `/sso/auth/callback` 仍然含 `/sso/auth/`**，所以真正的回跳（携code 落回站点）
     可能不会被判成「已落回」，从而白等到超时。

2. **扫码成功时 `usk` 只有 `path=/idp`、缺 `path=/` 那一份**。
   - 10/07 成功那次：`[COOKIE] set usk for iam.streamax.com path=/idp` **+ `[COOKIE] replicate usk path=/idp -> / ok`**
   - 10/10 只有前者，没有 `replicate`；而 `replicate` 由 `setCookiesFromHeader` 产生，
     说明两次 `authnEngine` 响应头内容不同（可能与上面新增的 `state` 参数带来的会话初始化差异有关）。

排查时**先看这两条**，不要重新发明轮询/重试策略：应用侧已有覆盖（隐藏窗口 + 纯 HTTP 双通道取 `lck`、
`getStreamaxCookieString` 按域过滤 + 同名去重、IAM 探针三态化），继续加重试只会掩盖真正的会话问题。

## 预览窗白屏 / 降级通道（1.0.47 起已内置处置；1.0.55 从 SKILL.md 迁入）

- **点「预览」打开一个空白窗**：那是**登录态失效**的表现 —— 预览页需要站点自己的会话，未登录时被跳到 SSO 登录页，
  而该页在应用内窗口里渲染为空白。应用已自动处置：先静默自愈（隐藏窗口让站点自己换票）→ 成功自动重载；
  仍失败会弹窗给出「登录文件系统」按钮（走账号密码窗），登录成功后自动重载原页。
  **你要对用户说的**：跟着弹窗点「登录文件系统」登录一次即可；若登录后还白屏，先**重启应用**（会用 OA 会话备份自动恢复），仍不行再用账号密码登录。
- **搜索返回里带 `⚠ …降级通道…` 的 note**：说明当前登录态异常，本次结果来自主进程直连的兜底通道，
  **实测该通道结果常为空或不完整**。汇报时必须明说「结果可能不全、建议先登录文件系统后重搜」，
  **不要**把这批结果当完整清单，也不要据此断言「只有这些文件」；确有必要时先引导用户登录再重搜一次。

## 「最新版本」类问题的失误复盘（1.0.55，用户实测）

一次真实失误：问「AD Plus2.0 最新通用版本」时，把**一次检索结果的一个切片**当成**全量版本清单**，
在没验证 V2.2.1 是不是最高的情况下直接断言「最新就是 V2.2.1」，而实际存在更高的 V2.4.6。
失误链：① 只用产品名检索，没补版本号模式；② 技能里写着「要最新用 `sort:'time'`」却没用了，
拿返回清单内部的 `modifyTime` 两两比较；③ 明知 `total` 远大于返回条数却没翻页；
④ 把「没看到」说成「不存在」；⑤ 拿 `modifyTime` 当版本新旧依据（老版本被重新上传也会比新版本「更新」）；
⑥ 只在「货运 / Standard Software / ADPlus2.0」一条分支里判断（漏了 `IPC Version`、归档、海外共享）；
⑦ 没有交叉验证。用户提示「目录下有 2.4.6」后改搜版本号模式，第一个结果就命中 ——
**第一轮缺的不是数据，是检索维度**。

据此在 SKILL.md 新增「回答『最新 / 唯一 / 全部 / 最高版本』类问题前的硬性检查项」5 条
（条数对 total / 两种互补检索 / 版本号判新旧 / 结论带范围限定 / 主动找反例跨分支；
**这 5 条后来被整段替换为「版本查询方法论」SOP，见下一节**），
并把 SKILL.md 里「modifyTime 与 lastVerNumStr 并列」的措辞统一改为「版本号才是版本序」。
教训：**检索是相关度采样，不是枚举** —— 它只回答「哪些文件跟这词像」，不回答「一共有哪些版本」。

## 第二次同型失误（2026-10-20 用户二次复盘；skill 2.2.0 重写方法论）

上一条修完之后，同一个问题**又错了一次**，错法完全相同：这次断言「最高 V2.4.1」，
而真实情况是 **V2.5.1 才是当前最新通用版**（`版本火车V2.5.1-Standard Version V2.5.1`，folderId 1168556）。
V2.4.1 也只是**又一次采样的最大值**。

责任划分（用户明确纠正过，不要写反）：
- **不是文件系统的问题，也不是检索通道的问题** —— 库里有 V2.5.1，只是没被检索到；
- 是**推理方式**的问题：把「相关度采样的一次结果」当成了「全集」，并且**没有单独做版本号维度的检索**；
- 换句话说：上一版的 5 条检查项只做到了「查得更认真」，没解决「采样 ≠ 枚举」这个根因。

重写为「版本查询方法论」后新增的四条硬事实（都实测过，别再用旧理解覆盖）：

| 事实 | 实测证据 |
|---|---|
| `filepath` 不是检索字段 | `query: filepath:(版本火车V2.5.1)` → `total 0`；`filepath:(ADPlus2.0)` → 同样 0。只能从结果里反向读 `folderPath`，或点 `folderUrl` 浏览目录树 |
| `total`/`hasMore` 是**召回集**范围 | 两次检索都 `total 50 / count 50 / hasMore=false`，据此断言「最高 V2.4.1」，而 V2.5.1 早已存在 |
| `sort:'time'` 只在召回集内排序 | V2.5.1 的 ReleaseNote 修改时间（2026-10-14）最新，却完全没进召回集，排序再准也排不出来 |
| 目录名与文件名用词不一致 | 目录 `版本火车V2.5.1-Standard Version V2.5.1` 里是 `火车V2.5.1-ADplus2.0-ReleaseNote-中文-260930.docx`（少「版本」二字），所以关键词必须带**版本号本体** |

因此 SKILL.md 里那套「硬性检查项」被**整段替换**为 SOP（Step 1 取锚点 → Step 2 版本号独立检索并翻到
`hasMore=false` → Step 3 产品维度收集候选版本号 → Step 4 对最高版本向上试一档 → Step 5 用 `folderPath`
核对产品线归属 → Step 6 能浏览就别搜），并配「结论措辞规范」三档：SOP 走完才允许写
「本次检索范围内最高为 X」；缺维度时**第一句先写「待核实」**；用户报出更高版本号时立刻以用户事实为准。

一句话总结（用户原话）：**「文件系统没有问题，是我把一次相关度采样的结果当成了全集，而且没有做版本号维度的独立检索。」**

## 上游技能包实测对齐（2026-09-22，用 agent-browser 在本机跑通）

拿上游 `wjxt-file-download-master` 包用 `agent-browser` 完整跑了一遍（open → search → fetch_urls → download → 校验），
用来校准本应用的实现：

| 项 | 上游实跑结果 | 对本实现的含义 |
|---|---|---|
| 查询串 | `(filename:(kw) OR filecontent:(kw))`，**无**范围前缀 | **带** `(filepath:(1) OR masterfilepath:(1))` 前缀时同一关键词是 0 条；本实现已把「无前缀」设为首选 |
| 结果字段 | `name / path / mtime / ext / size / guid / id / pid`（+ 可选 `ver / creator / editor`） | 本实现已补齐这些字段（`mtime` 转成可读时间） |
| 下载直链 | 落在**区域主机**（实测 `wjhw.streamax.com:9443`，另有 `wjcq`），URL 自带签名 token | 下载走会话跟随重定向即可，不需要跨域 cookie |
| 下载校验 | 文件头（PK/PDF/OLE2）+ 精确字节数；拿到 HTML 判为 token 过期 | 本实现已加 `validateFileHeader` 与 `sizes` 校验 |
| 上游脚本分工 | `search_edoc2.ps1` 搜索 → `fetch_urls.ps1` 取原始文件 URL → `download.ps1` 下载+校验 | 对应本应用的 `wjxt_search` → `wjxtResolveOriginUrl` → `wjxt_download` |
| **`relativePath` 真实路径名** | 增强脚本用它显示路径（`pathEl.textContent = raw.relativePath`），字段就在搜索结果行里 | 本实现取为 `folderPath`，作为「目录」列的**链接文字**（`path` 只是数字 id 串，用户看不懂） |
| `navigateToFolder(folderId)` | `location.hash = '#doc/enterprise/' + folderId` | 与本实现的 `folderUrl` 一致（已互证） |
| 文件预览入口 | `window.open('/preview.html?fileid=' + fileGuid)` | 本实现给每个结果带 `previewUrl`（点开在应用内预览/下载） |

另外复用了既有「锐明文档站增强搜索（wj.streamax.com）」脚本 1.5.0 的几处已验证技巧（该脚本自带能力探测，
相关字段/排序都是在真站上探过可用的）：

| 技巧 | 说明 | 本实现对应 |
|---|---|---|
| `esEscape` | Lucene 特殊字符反斜杠转义 | `esEscape()` |
| `caseVariants` + `*词*` | **keyword 字段通配符大小写敏感**（实测 `*RED*` 匹配不到 `Red.png`），故 contains 查询要 OR 大小写变体 | `mode: 'contains'` 内部自动生成 |
| `sortClause` | `[{modifyTime:{order:'desc'}}]` / `size` / `filename` 服务端排序 | `sort: 'time' \| 'size' \| 'name'` |
| `from` 分页 | `from` + `size`，配合 `hasMore` | `from` 参数 + 返回 `hasMore` |
| 字段表 `FIELD_DEFS` | 可用 ES 字段：`filename / filecontent / extName / creatorName / modifyTime / filepath` | 写进 `query` 参数说明 |
| `modifyTime:[a TO b]` | 时间区间查询语法 | 写进 `query` 参数说明 |

## 预览 / 下载两条链接（应用侧约定，2026-09-22）

技能返回的 `previewUrl` / `downloadUrl` 是**由应用自己解释**的地址：

- `previewUrl` = `…/preview.html?fileid=<guid>` → 渲染层在**应用内窗口**打开站点原生预览页，**不下载**；
- `downloadUrl` = 同一个地址 + `mcdl=1&name=<原始文件名>` → 渲染层判定为「下载」，走主进程
  `mc-wjxt-download`（按 `fileGuid` 换 `GetOriginFile` 直链 → 弹「另存为」→ 写盘）。

两条链接背后都是**流式下载**（先弹「另存为」，选完位置就边下边写 `xxx.part`，完成后改名；
失败 / 取消自动清理半截文件），所以 20MB 的 PDF 也不会再「等整份下完才出现保存框」。

**踩过的坑**：渲染层那条「规格文件下载」判据里 `/[?&]fileId=/i` 是**大小写不敏感**的，
把 `fileid=` 也当成了 `fileId=` —— 于是点「预览」直接弹「保存规格文件」对话框，
默认文件名取自**链接文案**（「下载」）、保存类型「所有文件」，落盘得到一个**没有后缀**的文件。
现在：判据改大小写敏感，且 wjxt 链接在更前面单独分流。

## 「未登录」的真实形态（2026-09-22 实测，最容易被误判的一条）

服务端**未登录时返回的是 HTTP 200 + 合法 JSON**，不是 401/302/HTML：

```json
{"url":"https://wj.streamax.com:9443/sso/auth/goToLoginPage",
 "returnUrl":"/WebCore","defaultUrl":"/index.html","errorCode":"ErrorCode4"}
```

站点自己的判据在 `/scripts/app/main.js` 的 `$.ajaxSetup.dataFilter` 里：
`errorCode == 'ErrorCode4'` → `window.top.location.href = url + '?returnUrl=' + …`（跳登录页）。

**只按「是不是 JSON / 是不是 HTML」判读会把这条信封当成「搜索结果 0 条」** —— 历史上「无报错但 0 条」
有一半是这个原因（另一半是查询串带了范围前缀，见下文）。现已按 `errorCode` / `url` 判据识别为
`WJXT_NO_SESSION`。

**页面上下文复核（2026-09-22，用应用分区的只读副本 + 隐藏窗口探针）**：未登录时，
在**页面上下文**里发同一个搜索同样拿到 **HTTP 200 + 同一份 `ErrorCode4` 信封**
（不是 0 条、不是 404）。也就是说：**判定登录态只能看信封里的 `errorCode`**，
看「条数」或「状态码」都会被骗 —— 尤其别把它当成「库里没这个文件」。

同一时间抓到的分区 cookie 只有 `checkToken` + `LtpaToken`（应用给 OA/SSO 用的票），
**没有 edoc2 自己的会话** —— 所以「应用已完成钉钉鉴权」并不等于 edoc2 已登录。

登录自愈顺序（都不打扰用户，只有全部失败才弹可见窗口）：

1. **静默 SSO**：GET `/sso/auth/goToLoginPage?returnUrl=/index.html` 并跟随重定向；
2. **隐藏窗口预热**：`show: false`（`backgroundThrottling: false`）的窗口加载 `/index.html`，
   让站点 SPA 自己完成握手 —— **会话仍有效时**这一步能悄悄恢复。
   注意这个窗口同时就是**搜索请求的宿主**（见「请求通道」一节），不再只是预热用完即弃；
   登录成功后会让它重新导航一次，用新会话重新绑定页面上下文；
3. 每步之后都用 `GetCurrentUser` 复查；仍失败才弹可见登录窗口。

**重要实测结论（2026-09-22）**：edoc2 的登录页 `/sso/auth/goToLoginPage` **不会自动完成登录** ——
分区里即便有 `LtpaToken`（给 OA 用的 SSO 票）也照样返回 `ErrorCode4`；
隐藏窗口跑完只多出 `copy`/`cut` 两个 SPA 自己的 cookie，会话依然没有。
也就是说：**首次使用或会话彻底过期时，必须由人工在该登录页扫码一次**（工具无法代扫）。
因此可见登录窗口直接落在 SSO 登录页上，并且**登录成功后会自动关闭**
（主进程每 2s 用 `GetCurrentUser` 复查，最多等 3 分钟）。

## 搜索效率（一段真实日志的教训）

从应用 `wjxt.log` 统计的一段真实使用记录：模型为找一个文件发了 **88 次 `wjxt_search`**，
其中 **74 次返回 0 条**（40 多个关键词轮着试），回复周期极长。据此做了两件事：

1. **把「换个写法再试」收进工具内部**：`wjxt_search` 一次调用按策略链
   「原模式 → `contains` 子串 → 拆词 OR → 带范围前缀」依次尝试，命中即停，
   返回里给出 `strategy` 与 `note`（「原查询没命中，已自动改用 X 命中 N 条」）。
   拆词兜底按长度取前 3 个 token：实测完整长名 `HY_ADPLUS2.0_M0010_V3_2.4.6_RC26042090` 直接查常 0 条，
   而拆出 `RC26042090` / `ADPLUS2` / `M0010` 命中率高得多。
2. **流程上给硬预算**（写进 SKILL.md）：看到 `note` 就直接用结果；最多再调 1 次；
   要「最新」用 `sort: 'time'`；拿到清单一次性给全结论，不要「我再补两轮查询」。

另外实测：**`contains`（`*片段*`）对含数字/标点的长片段不敏感**（如 `M0010_V3_2.4.6` 返回 0），
查这类内容要用 `mode: 'word'` 或只给一个有区分度的短片段。

### 服务端排序会静默返回空集（2026-09-22 实测，踩过一整轮）

同一关键词、同一会话、同一时刻：

| searchXml.sort | 结果 |
|---|---|
| `[{_score:{order:'desc'}}]` | **命中 26 条**（`RC26042090`）/ 50 条（`ADPLUS`） |
| `[{modifyTime:{order:'desc'}}]` | **0 条**（HTTP 200、`result:0`、`FilesInfo` 为空、无任何报错） |

当时模型按提示「要最新就用 `sort:'time'`」每次都带上时间排序，于是一整轮查询全是 0 条，
还被错误地解释成「文件不存在 / 没有权限」。上游「增强搜索」脚本里正有一个 `sortTime` 能力探测
（不支持就退回相关度排序），照搬 `sortClause` 时漏掉了这层判定。

现实现：非 score 排序先按服务端排序试一次；**0 条立刻用相关度排序重跑同一查询**，
命中后把该排序键记为「服务端不支持」，结果在**本地**排序，并在返回的 `note` 里说明
（`sortMode` 形如 `local:time`）。之后同一进程内直接用「相关度 + 本地排序」。

## 排查清单

1. 响应 `request invalid!` → 大概率 Referer 不对，必须带 `preview.html` Referer
2. `nResult=601` → 登录态/token 失效，需要重新登录（在应用内）
3. `nResult=5` → DownLoadCheck 不支持此类型，改用 GetOriginFile
4. 下载文件是 HTML → token 过期，重新调 GetPreviewPara 拿新 URL；MC Tool 已把「收到 HTML 页面」
   直接判为登录态失效（`downloadBufferViaSession`）
5. **WebCore POST 返回 404 + 空 body** → 不是登录过期（未登录是 302 到 SSO 登录页，两者形态不同）。
   站点前端的启动序列是 `POST WebCore {SystemManager/GetSystemInitStatus}` →
   `POST WebCore {WebClient/GetCurrentUser}` → 业务请求（源码见 `/scripts/app/main.js`；
   它的 `$.ajaxSetup` 还专门把 404 静默掉），原技能包的处置「重新导航一次首页」本质就是补这两步。
   MC Tool 现在的 `wjxtWarmUp` 就是「确保隐藏窗口已把首页跑完」，遇到 404 时 **强制重新导航一次**
   再重试一次；持续 404 才说明服务端/网关真的不可用。
6. `WJXT_NO_SESSION` / `NEED_RELOGIN` → 顺序见 SKILL.md「登录态」一节。**登录入口有两个**，由用户自己选：
   ① 站点自带的 H5 登录页（`h5.html#login/index`，账号密码，不经 IAM）；
   ② IAM AC 登录页（`iam.streamax.com/ac/#/index?lck=…&entityId=edoc2`，扫码或密码）。
   **不要把地址交给系统浏览器**（不共享登录态）；`lck` 是一次性的，由应用现取，不要写死。
6.0 **（2026-10-02 实测）扫码入口的 `lck` 只能在浏览器上下文里拿到**：主进程裸 fetch 跟随
   `/sso/auth/goToLoginPage` 只停在 `iam/idp/authCenter/authenticate?…client_id=edoc2`（无 `lck`）；
   而用共享分区的**隐藏窗口**加载同一地址约 2 秒后，会精准落在
   `iam.streamax.com/ac/#/index?lck=context_oauth2_…&entityId=edoc2&theme=…` —— 即用户扫码那个页面。
   所以「现取扫码地址」的实现必须是隐藏窗口（见 `index.ts` 的 `hiddenNavUrl` / `wjxtSkill.wjxtQrLoginUrl`）。
6.0.1 **「记住账号密码 / 自动续登」已移除（1.0.48）**：站点没有让第三方保存口令的接口（那是浏览器行为），
   原实现是在 H5 页注入脚本抓用户输入的账号密码再加密落盘 —— 越权且脆弱（页面结构一变就抓不到，
   于是用户根本看不到保存提示）。现在：不保存、不读取、不自动填表；遗留的 `wjxt-login.json` 启动时删除。
6.1 **隐藏窗口被跳到站外（未登录）时，页内相对 `fetch('WebCore')` 必然 `Failed to fetch`** ——
   这是**跨域**（页面已经在 `iam.streamax.com` 上），不是「页面上下文坏了」。
   踩过的坑：把这种失败当成上下文损坏去 `destroy` 窗口 → 「重建 → 又被跳转 → 再失败」的**两秒一轮抖动**，
   日志被刷爆、还不停向 IAM 发起新的 OAuth 跳转（`state=` 每次都变）。现在判据是
   **「窗口当前 URL 是否还在本站域内」**：站外 → 只限速（20s 一次）把窗口拉回首页，不销毁、不重试。
6.15 **「OA 能用」≠「edoc2 能换票」（2026-09-23 实测，真实分区副本）**：

| 检查 | 结果 |
|---|---|
| `iam.streamax.com` cookie | `route / SESSION / usk / REQID / j_lang` **都在** |
| `oa.streamax.com:8080` cookie | **0 个** |
| `wj.streamax.com` cookie | 1 个（`checkToken`） |
| edoc2 `WebCore GetCurrentUser` | `{"errorCode":"4","errorMsg":"Token失效"}` |
| 窗口加载 `index.html` | 跳到 `iam.streamax.com/ac/#/index?lck=…&entityId=edoc2`，页面渲染「用户登录 / 扫码 / 密码」 |

结论：edoc2 的 OAuth2 换票依赖 **IAM 的「AC 登录态」**，而它当前不成立（即便 IAM 侧的
`route/SESSION/usk` cookie 还在 —— 那些可能只够 OA 侧的应用级 SSO）。
**不要**用「OA 物料查询正常」推断「edoc2 应该能换票」，也不要反过来用「IAM 页显示登录界面」
推断「整个 IAM 都失效了」—— 两者用的不是同一份会话。这正是备份通道（H5 账号密码，绕过 IAM）存在的理由。

6.17 **登录态判据必须「结构化」，否则会把能用的会话误报成未登录（2026-09-23 真实事故）**：
旧实现是全文正则 `/"errorCode"\s*:/.test(body)`。某次 `GetCurrentUser` 回了 **37KB 的 text/plain**
（`len=37144`，不是登录信封），正文里含 `errorCode` 字样 → 被判成「未登录」，
日志里于是先出现 `[warmup] recheck#1 loggedIn=false` 与「需要用户手动登录」，
**紧接着那次检索其实成功命中 10 条**（`[search] strategy=word hit 10/10`），还顺手弹了登录窗与隐藏 bootstrap 窗。
现在：
- 只对**解析出来的 JSON 顶层字段**判：`errorCode` ∈ {`ErrorCode4`, `4`+失效类 errorMsg}、`url` 指向登录页、`islogin:false`；
- **解析不出判据 → 返回「未知」(null)**，绝不把「不知道」说成「未登录」；
- `nResult:601` 同理移到解析后判，不再对长正文做正则。
已用日志里真实出现过的 7 种响应体做过用例（含 37KB text/plain、Token失效信封、预览假成功信封、正常用户对象）。

6.18 **`LtpaToken` 在，edoc2 就能用（不需要 IAM AC 登录）**：2026-09-23 06:04 的日志显示，
应用**重启后从 `oa-session-backup.json` 恢复了 OA 会话**（`[oaCookie] inject http wj.streamax.com:9443 +12 cookies`），
分区里重新有了 `LtpaToken@.streamax.com` / `usk` / `SESSION`，edoc2 检索随即成功（`cookies=10`）。
也就是说：**出现「edoc2 未登录」时，先让用户重启应用（或重新完成一次 OA 登录）往往就够了**，
H5 账号密码通道是再往后的兜底。

6.2 **未登录时 `Preview/GetPreviewPara` 会回 HTTP 200 + 约 430 字节的小信封**
   `{"status":"error","errorCode":0,"data":{"fileId":0,…,"fileUrl":null,…}}` ——
   `errorCode` 是数字 0，既不是 `ErrorCode4` 也不是 HTTP 401/302，只看状态码/长度会误判成
   「文件被移动/删除」。现在取不到 `fileUrl` 时会**先 `GetCurrentUser` 复核登录态**：
   未登录 → 报 `WJXT_NO_SESSION`（弹登录入口），确实登录着才报 `WJXT_NO_FILE_URL`。
6.5 `WJXT_NO_FILE_URL` → `GetPreviewPara` 回了 200 但**没有 `data.fileUrl`**：这是「会话半建立」的形态 ——
   分区里少了站点自己种的 `token` / `browserPlatform` 等 cookie（日志里 `cookies=` 数量会明显偏少，
   实测一次是 4、正常是 7~8），此时该接口会回一个约 400 字节的小信封。MC Tool 会自动**重新导航
   隐藏窗口再取一次**（实测第二次就成功）；日志里会留下 `[preview] no fileUrl: … body=…` 与
   `no fileUrl -> reload page context then retry once`。
7. **无报错但 0 条** → 别急着下「文件不存在」或「服务端挂了」的结论。三种常见成因：
   ① **请求通道不对**（主进程 fetch 恒空，见「请求通道」一节）—— 日志行前缀可区分：
   `[page]` 才是页面上下文，`[main]` / `[fallback]` 说明走了降级通道，此时 0 条属预期；
   ② 首选查询里的范围前缀条件 `(filepath:(1) OR masterfilepath:(1))` 在当前部署/账号范围下是空集
   （MC Tool 会自动去掉该条件再搜一次，见 `wjxtSearch` 的 relaxedQuery）；③ 响应结构变化导致结果数组
   取空（已做多路径兜底）。后两种都会把服务端原始返回写进 `wjxt.log` 的 `[search] EMPTY:` 行，
   据此区分「查询条件/权限」与「解析取空」。
