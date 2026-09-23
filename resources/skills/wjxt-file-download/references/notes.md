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
6. `WJXT_NO_SESSION` / `NEED_RELOGIN` → 顺序见 SKILL.md「登录态」一节。**备份通道是站点自带的 H5 登录页**
   （`h5.html#login/index`，账号密码），不再是 SSO 页；**不要把地址交给系统浏览器**（不共享登录态）。
6.1 **隐藏窗口被跳到站外（未登录）时，页内相对 `fetch('WebCore')` 必然 `Failed to fetch`** ——
   这是**跨域**（页面已经在 `iam.streamax.com` 上），不是「页面上下文坏了」。
   踩过的坑：把这种失败当成上下文损坏去 `destroy` 窗口 → 「重建 → 又被跳转 → 再失败」的**两秒一轮抖动**，
   日志被刷爆、还不停向 IAM 发起新的 OAuth 跳转（`state=` 每次都变）。现在判据是
   **「窗口当前 URL 是否还在本站域内」**：站外 → 只限速（20s 一次）把窗口拉回首页，不销毁、不重试。
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
