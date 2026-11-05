# 打包与发布指南（PUBLISH）

本仓库已设为 **public**，安装包通过 **GitHub Releases** 公开分发，客户端 `electron-updater` 自动检测并下载更新。

- 仓库：<https://github.com/maozuxiao/mc-tool>
- 更新源配置：`electron-builder.yml` 的 `publish.provider: github`（owner `maozuxiao`，repo `mc-tool`），运行时在 `src/main/updater.ts` 里通过 `autoUpdater.setFeedURL(...)` 对齐同一目标。
- 分发特点：**Release 附件对所有人公开可下载（无需仓库读权限/token）**，因此外部用户也能自动更新。

---

## 零、一图看懂流程

```text
改代码 → 类型检查 → 改版本号(2处) → 写 Release Notes
      → 设 GH_TOKEN → .\build_now.ps1 -Publish
      → GitHub 上把 draft Release 改为 Published
      → 老客户端启动即收到更新提示
```

> 全流程可只用一条命令：`$env:GH_TOKEN='xxx'; .\build_now.ps1 -Publish`
> 脚本会依次完成依赖检查、清理旧产物、打包、发布，任一步失败即中止。

---

## 一、发布一个新版本（以 1.0.50 为例）

### 1. 同步代码并提交

```bash
cd C:\Users\streamax\Documents\GitHub\mc-tool
git pull origin master
# —— 修改代码 ——
git add -A
git commit -m "feat: ..."
git push origin master
```

### 2. 类型检查（建议）

```powershell
.\__tscheck.ps1
```

脚本会切 UTF-8 编码并运行 `tsc --noEmit`，末尾打印 `EXITCODE=0` 即通过。非零说明有类型错误，先修再打包。

### 3. 改版本号（两处必须同步）

| 文件 | 字段 | 格式 | 示例 |
|---|---|---|---|
| `package.json` | `version` | SemVer **三段** | `"1.0.50"` |
| `electron-builder.yml` | `buildVersion` | **四位**文件版本 | `1.0.50.0` |

```jsonc
// package.json
{ "version": "1.0.50" }
```

```yaml
# electron-builder.yml
buildVersion: 1.0.50.0
```

> **两处必须同步**。
> - `version` 决定 `app.getVersion()`、`latest.yml` 里的版本号，以及**客户端判断是否更新的依据**。
> - `buildVersion` 只写入 exe 的「文件版本」属性。
> - 版本号倒退或不一致，客户端会认为「已是最新」而静默跳过更新。
>
> 界面上显示的版本由 `store.ts` 启动时从 `window.mcApi.appVersion()` 读取，**无需手动改**。

### 4. 追加 Release Notes

在 `MC Tool Release Notes.md` 的表格末尾追加一行：

```markdown
| 1.0.50 | 1.0.50.0 | 本次改动说明 |
```

提交版本号与 notes：

```bash
git add -A
git commit -m "chore: bump to 1.0.50"
git push origin master
```

### 5. 本地打包

推荐用一键脚本（自动切到项目根、检查依赖、清理旧产物）：

```powershell
.\build_now.ps1
```

> 新增/升级过依赖（如 1.0.43 引入的 `naive-icons`）时，先跑一次 `npm install` 让 `node_modules` 与
> `package-lock.json` 对齐 —— 依赖变动的提交必须**同时包含 `package.json` 与 `package-lock.json`**，
> 否则别人克隆后装不出同样的依赖树。

等价的底层命令：

```bash
npm install        # 新克隆或依赖有变时先装
npm run pack:win   # = electron-vite build && electron-builder --win --config electron-builder.yml
```

产物输出到 `dist/`：

```text
dist/
├─ latest.yml                            # 自动更新元数据（关键）
├─ MC物料查询 Setup 1.0.50.exe            # NSIS 安装包
├─ MC物料查询 Setup 1.0.50.exe.blockmap  # 增量更新块映射
└─ MC物料查询 1.0.50.exe                  # 便携版
```

> `dist/` 已被 `.gitignore` 忽略，**不要 commit**。
> 每次打包都会重新生成 `latest.yml` 并指向当前版本。

**本地冒烟验证（强烈建议，发布前做）**：安装 `dist/MC物料查询 Setup <版本>.exe` → 扫码登录 → 各标签页查一次 → 导出 CSV →「帮助 / 检查更新」确认提示「当前已是最新版本」。

> **AI 助手相关也要过一遍**（改动多、最容易带出问题）：
> 1. AI 助手 → 三种模式下拉切换正常；Build 模式能打开 Skills 面板；
> 2. 勾选「MC 查询」→ 查一次料号，看工具卡片与结果表；
> 3. 勾选「鸿翼文件查询下载」→ 搜一次文件，点**预览**（应在应用内窗口打开）与**下载**（应弹「另存为」、文件名带后缀、下载中有百分比）；登录态缺失时确认会自动弹出**【登录文件系统（账号密码）】H5 窗口**（不是 SSO 白屏页），输账号密码登录后窗口自动关闭并跳回首页，再次查询即成功；
> 4. 规格文件表点一次下载，确认「先弹框、再边下边写」（选完位置文件即开始变大，不再等整份下完）；
> 5. 随便点几个链接/按钮，确认鼠标是**手型**（光标主题在 1.0.43 调整过）。
> 6. Skills 面板底部点「🩺 诊断」：结论与明细都应是**界面语言**（切到英文界面应全英文）；英文界面下面板宽高自适应、底栏 `🗃️/📂/🩺` 三个按钮一行放得下、技能列表独立滚动（不再挤成一小条）。
> 7. 问一次「帮我找 XX 文件」：**第一次工具调用应是 `wjxt_search`**（不应先出现 `file_search`）；若只给文件名、没说在哪，模型应先问「是找公司内容库里的，还是你本机上的？」。
> 8. 挑一个会跑多轮工具的提问（例如让 AI 连续读几个文件），在它「思考中 / 正在读文件」时点 **停止**：应当**当轮立即停下**、不再启动下一个工具；同时 `userData/debug-ai.log` 里应出现 `[AI] stop …` 紧跟 `[AI] aborted …`（只有 stop 没有 aborted = 没停住，需排查）。
> 9. MCP（1.0.46）：Skills 面板 →「🔌 MCP 服务」→ 点「填入示例」导入 tech-agent 服务（或手工登记 `node src/index.js`，工作目录指向技能 runtime 目录）→「准备依赖」→「测试连接」应列出 `chat_tech_agent` / `status_tech_agent` / `mcp_auth_tech_agent` / `reset_tech_agent` 四个工具；勾选对应技能后模型可调用（未登录会走 `mcp_auth` 拉起 Chrome 扫码），取消勾选即收回；应用退出后任务管理器中无残留 node 子进程。
> 10. **Word 生成 / 翻译（1.0.46，必须在安装版里测）**：让 AI 生成一个 `.docx`（或直接 `file_write` 写 `.docx`，内容给 Markdown），确认产出是**真文档**：文件头应为 `PK`、Word/WPS 能直接打开、表格与标题样式都在；再让 AI「把一份中文 docx 翻成土耳其语（保持原格式）」验证 `translate_docx`。
>     **为什么单列一条**：技能依赖随包分发，而 `electron-builder.yml` 的 `filter` 曾把 `docx` 排除 —— **开发目录正常、安装版报「生成 docx 需要 docx 依赖，但未安装」**（1.0.46 踩过）。遇到该报错先查 `resources/skills/file-office-local/node_modules/` 与 `electron-builder.yml` 的 filter；单机应急只需把仓库里的 `docx` 目录补进去（其余运行时依赖 xml / xml-js / jszip / nanoid / hash.js 都在）。
> 11. **新增内置技能必须同时改打包配置（1.0.48 踩过）**：内置技能不在 `out/**` 编译产物里，靠 `electron-builder.yml` 的 `extraResources` 逐条拷进安装包。**只把技能放进 `resources/skills/` 是不够的** —— 开发目录能勾选、安装版里则完全看不到。每次新增内置技能后：① 在 `extraResources` 补一条 `from: resources/skills/<技能目录> / to: skills/<技能目录>`；② 在**安装版**里打开 Skills 面板确认新技能出现且能勾选、能正常作答（1.0.48 的 `ceiba2-api-qa` 就是这样漏配的）。
> 12. **料号切换标注（1.0.48）**：勾选「MC 查询」→ 查 `5154021100047`，返回里应带 `pn_switch`（`role:old`、新料号 `5154021100364`、截止日 2026-10-31），气泡/表格下方应能看到提示；查 `5154021100364` 则应提示「替代 5154021100047」。若没有，检查安装版 `resources/skills/mc-material-query-local/data/pn_switchover.json` 是否存在。
> 13. **预览窗白屏引导（1.0.48）**：在文件系统**未登录**（或等它过期）时让 AI 搜一个文件并点**预览** —— 应先在应用内窗口尝试静默自愈，仍失败则弹出「文件系统登录态已失效」对话框（含「登录文件系统」按钮），点它走 H5 账号密码窗，登录成功后原预览页**自动重新加载**；不应再停在一片空白的 Loading 页。
> 14. **技能参考文档要能读（1.0.48）**：勾选「Ceiba2 API 报错排查」，问一句「查一下 `error_codes.md` 里 204 是什么意思」。工具调用应该用**绝对路径**（`…\resources\skills\ceiba2-api-qa\references\error_codes.md`）并成功返回内容；若仍报 `PATH_NOT_FOUND`，说明系统提示里的【技能目录】没注入成功（查 `skillRegistry.ts` 的 `routeHint()` 是否命中该技能）。
>     **为什么单列一条**：技能自带的参考文档不在工作区里，而 SKILL.md 里通常按**相对路径**写（`references/xxx.md`）—— 文件工具的相对路径按「当前工作区根」解析，必然找不到（1.0.48 用户实测）。修法见 Release Notes 1.0.48 第 ⑥ 条：系统提示注入技能目录绝对路径 + 文件工具在 `PATH_NOT_FOUND` 时兜底回一条绝对路径提示。
> 15. **鸿翼登录方式可选（1.0.48）**：让文件系统会话失效（或等到过期）后让 AI 搜一次文件 —— 回复里应**询问**你选「账号密码登录」还是「扫码登录」并给出**两个链接**；点「账号密码」应打开 H5 页、点「扫码」应打开 `iam.streamax.com/ac/#/index?lck=…&entityId=edoc2`；登录成功后该窗口应**自动关闭**，再说一句「已登录」即可重试成功。
>     **为什么单列一条**：`lck` 是一次性的（由隐藏窗口现取），路径写死就会失效；且不能弹完窗就完事 —— 还要求登完自动关窗。
> 16. **不再出现「记住账号密码」（1.0.48）**：整个登录过程（H5 或扫码）**都不应**再弹出保存口令的对话框；全仓也不该再有 `wjxt-login.json`。若看到，说明旧代码没被覆盖。
> 17. **下载/预览是两个链接（1.0.48）**：搜一个文件，结果表最后一列必须是 `[预览](…) / [下载](…)` 两个**独立**链接（外加目录链接），不能是合并的「下载/预览」；若模型仍合并，检查 `wjxtSkill.ts` 里 `WJXT_SEARCH_TOOL_DEFINITION` 开头的链接规则是否被覆盖。
> 18. **鸿翼登录自愈与链接形态（1.0.49）**：让文件系统登录态**单独**失效（退出 OA 登录后**不要重新扫码**，直接检索）—— 期望：多数情况下**不弹任何询问**，`wjxt.log` 里出现 `[heal] hidden-window SSO ticket exchange start` → `[heal] probe#N loggedIn=true` → `[search] sso self-heal ok -> retry search once`，随后直接给出结果；若 IAM 会话也已过期，回复里应是两个 **Markdown 可点文字链接**（`[账号密码登录](…)` / `[扫码登录](…)`，取不到二维码页时是 `[SSO 登录](…)`，**不是裸 URL**），点开后窗口顶部有蓝色提示条、登录成功后先显示「✅ 登录成功，正在返回应用…」再自动关窗。
>     **为什么单列一条**：隐藏窗口原先等固定 2.5~3.5 秒就被销毁，跳转链断在 IAM 授权页（票换不成），用户只能手动点链接才通；而**退出后重新登录一次 OA 会让常驻隐藏窗口顺手把票换完**，于是「看起来正常」却根本测不到这条分支（1.0.49 提测时连续两轮都如此）。必须「退出后不重新登录」才能复现。
> 19. **冷启动扫码后鸿翼直接可用（1.0.50 · 鉴权修复的核心验证）**：清空分区 cookie（停应用后删 `%APPDATA%\mc-material-query\Partitions\mc-query\Network\Cookies`、`oa-session-backup.json`、`oa-login-pref.json`、`~\.cache\oa-mc-cookies.json`）→ 启动 → 扫码。期望：`[QR-POLL] authExecute success` 之后**不弹任何登录入口**，AI 直接 `GetCurrentUser loggedIn=true` 并给出结果；`[iamKeepalive] iamSessionAlive=true`（若仍为 false 说明 cookie 去重没生效）；`[backup] saved N OA session cookies` 里的 N 应与 cookie 总数一致（不再出现同名重复项）。
> 20. **AI 回复的字体与目录链接（1.0.50）**：① 问一句会带文件名的检索（如 `A8 PRO 认证`）—— **回复里的文件名/目录路径应与正文同字体**（不再出现「一段话两种字体」，行内 code 不再是等宽），只有真正的代码块仍是等宽深底；② **开头「资料分布在以下 N 个目录」这类归纳表里的目录也必须点得开**（此前只有下方结果表的目录列有链接，归纳表是纯文本 —— 本版起工具返回 `folders[]`，提示词亦已加硬规则）。
> 21. **内置技能 Tech-agent 的依赖安装（1.0.50）**：MCP 服务面板里登记 `Tech-agent-mcp`、**绑定技能选 `Tech-agent-skill`**、**「工作目录」留空**（本版起由绑定技能自动推断，不必手填绝对路径）→ 点「一键准备依赖」→ 装完点「测试连接」，应列出 `chat_tech_agent` / `status_tech_agent` / `mcp_auth_tech_agent` / `reset_tech_agent` 四个工具。
>     **为什么必须在安装版验**：dev 模式下工作目录指向**仓库**目录、**可写**，会走「原地安装」分支；只有安装版（`Program Files` 下**只读**）才会触发本版的「复制到 userData 可写副本 + 自动切换登记 cwd」逻辑。安装版期望日志：`[install] 工作目录只读，已复制到可写副本：…`，依赖落在 `%APPDATA%\mc-material-query\mcp\<服务id>\runtime\node_modules`。同时确认**没有**下载 Chromium（本版已设 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`）。
> 22. **AI 回复图片预览（1.0.51）**：问一个会返回大图的问题（知识库/ 检索类，技术图纸 / 线束图最好）→ ① 气泡内的图应**自适应气泡宽度、不横向溢出**（默认无滚动条）；② 点击弹出大图，**滚轮缩放**（以中心为锚点）、放大后可**按住拖动**、**双击**复位，顶部显示缩放比例；③ 同一消息有多张图时`←/→` 与两侧按钮能**翻上一张/下一张**；④ `ESC` /「取消」/「确定」/ 点遮罩**四种方式都能关闭**（「确定」必须真的有反应 —— 库的 `onOk` 与 `onClose` 是两个独立回调，不接 `onOk` 按钮点了没反应）；⑤ **透明底图片不应出现白色方块**。
> 23. **鸿翼登录与「停止」按钮（1.0.51）**：① 冷启动 → 扫码 OA → 直接问一句企业内容库检索，**全程应零介入**（隐藏窗口自动换票，日志出现 `GetCurrentUser loggedIn=true` 与 `[search] … hit N/N`）；② 若edoc2 未登录，日志应出现 `[page] channel tripped …` 并在 30 秒内**不再刷屏** `executeJavaScript failed`，恢复后出现 `channel recovered`；③ **在 `wjxt_search` 执行中点「停止」应立刻停住**（日志出现 `[cancel] … -> AbortError`），且气泡显示「已停止」而**不是**一段检索失败建议；④ 断VPN 时提问，AI 应**只给「账号密码登录」一个入口**并说明内网未连通（不该再给必然白屏的 SSO 入口）；日志出现 `[iamReach] Chromium -> iam.streamax.com UNREACHABLE …` 即符合预期。
> 24. **会话多选与模式持久化（1.0.51）**：① 侧栏头部点「多选」→ 列表出现复选框、顶部有「全选」、底部有批量条；勾选若干条后点「删除所选」应弹**二次确认**；② **「当前会话」与「已勾选」视觉必须可区分**（当前会话有左侧主色竖条，已勾选是浅色底 + 描边）；多选态下**不显示**单条删除图标；③ 切到 Build 模式发一条消息 → **重启应用** → 点开该会话，工具栏应仍是 **Build**（模式与技能勾选都按会话持久化）。
> 25. **MCP 依赖装到 userData、不再被更新抹掉（1.0.52，本版核心）**：MCP 服务面板里登记 `Tech-agent-mcp`、绑定技能选 `Tech-agent-skill`、**「工作目录」留空** → 点「一键准备依赖」→ 安装版日志应出现 `[install] 工作目录位于安装内容内（或只读），已复制到可写副本：%APPDATA%\mc-material-query\mcp\<服务id>\runtime`，且**登记项的 cwd 应被改写成该副本路径**（打开 `%APPDATA%\mc-material-query\mcp-servers.json` 确认 `cwd` 不再是空串，且 `command` / `args` / `env` / `skillKey` **四个字段都还在**——1.0.52 前这里会被清空）。
>     **随后必须验「更新后不用重装」**：记下副本里的 `node_modules` 路径 → 重装一次应用（覆盖安装）→ 重新打开 MCP 面板点「测试连接」，应**直接连上、列出 4 个工具**，且**不再提示准备依赖**。若仍提示，说明依赖又装进了安装目录。
>     **反向对照（必须验，否则会踩回归）**：`file-office-local` 是**随包分发 node_modules** 的内置技能（见 electron-builder.yml），它**必须原地使用、不得迁移**——测试该技能的文件读写能力应正常，且日志里**不应**出现「已复制到可写副本」。
> 26. **MCP 徽标与写盘失败（1.0.52）**：① 登记一个**未准备依赖**的 MCP 服务 → 面板徽标应**直接显示需要安装**（1.0.52 前恒显示「不需要」，要点「测试连接」报错才看出来）；② 把 `mcp-servers.json` 改成非法 JSON → 重启应用，**应提示解析失败并留下 `.corrupt-<时间戳>` 备份文件**，而不是悄悄按空库处理（否则你改个名字就会把原配置全覆盖掉）。
> 27. **切回窗口即检测会话（1.0.53，本版核心）**：启动并扫码登录 → 把窗口切到后台放着不动（或先在 Console 里执行 `await window.mcApi.clearLogin()` 把会话清掉）→ **Alt+Tab / 点任务栏图标切回**。期望：立即回到扫码页；`%APPDATA%\mc-material-query\debug-login.log` 出现 `[SESSION] window focus -> check session`（确认 focus 触发了检测）；若随后出现 `[LOGIN-VIEW] skip (already shown), reason=expired`，说明幂等在挡重复通知 —— **来回切走切回多次，正在展示的二维码不应被刷新**（这正是本版要防的回归）。
>     **为什么单列一条**：这条路径此前**完全没有检测入口**（唯一入口是托盘唤起），只能靠「切回后发一次查询报错」间接发现，因此它在日常使用中一直是静默的 —— 必须真的切窗口才测得到。
> 28. **最小化 / 收进托盘时不打扰（1.0.53 反向对照）**：把窗口**最小化**或收进托盘后让会话过期 —— 心跳检测失败**不应**把界面切回扫码页、也不应弹任何东西；再把窗口唤回（托盘单击或点任务栏图标）时才回到扫码页。
>     **为什么单列一条**：1.0.53 给心跳加了「失败即回扫码页」，判据是「窗口可见**且聚焦**」（`isWindowActivelyVisible()`）—— 若这条判据被写松（例如去掉 `isFocused()`），后台驻留一晚会莫名其妙把登录层糊在用户脸上。
> 29. **查询 loading 与「翻译物料描述」（1.0.54）**：① 点「批量查询」粘贴多个料号开查 —— **只有批量查询按钮转圈**并显示「查询中 n/m」（其他查询按钮不转）；② 结果出来后点「翻译物料描述」：按钮进入 loading 并显示「翻译中 n/m」，表格描述逐批变英文，原文在悬停提示里；翻译中**再次点击按钮**应弹「是否取消剩余翻译」—— 点**确定**应很快停下并提示「已取消剩余翻译（已完成 N 条）」，点**取消**应继续翻完；③ 点「显示原文 / 显示译文」可来回切；点「导出 CSV」，**导出的描述应与当前显示一致**（显译文态导出英文）；④ 切到「BOM 结果」页，同样有翻译按钮与切换，导出 CSV 同样跟随；⑤ 未配置 API Key 时点翻译应提示「请先在 AI 助手面板配置 API Key」。
>     **为什么单列一条**：取消语义做过两轮修正（第一轮按钮被 `disabled` 挡住点不动；第二轮只在批次间检查标志、在途批次要等整个跑完）—— 必须真的点一次取消确认「立刻停」。
> 30. **AI 物料模式直接下载规格文件（1.0.54）**：AI 助手切到**物料**模式，说「把 XXXXXXXX 料号的规格书下载到桌面」—— 模型应先 `mc_query spec` 取链接、再 `file_download` 下载，桌面出现文件；下载中 / 完成后消息里应能看到实际保存路径。
> 31. **同名文件被占用时下载不再报错（1.0.54）**：先在桌面放一个与某规格文件同名的 PDF 并**用阅读器打开它**（占用状态），再去「规格文件」页点该文件下载，选桌面保存 —— 应**不报错**，自动存为「名称(1).pdf」并提示实际保存路径。
> 32. **半窗口与缩放下的下拉（1.0.54）**：把窗口拖到约半屏宽 → ① AI 助手点模式下拉与模型下拉：面板**不超出窗口右缘**（内容完整可见）、**不盖住右侧「配置」按钮**；② 英文界面打开生命周期下拉：各选项（如 Purchase Blocked / Mass Production）**完整显示不截断**，悬停有完整文案；③ 点下拉选项时**焦点不跳、页面不滚**（可在关键词输入框里先点一下再试）。
> 33. **BOM 重查后筛选常驻（1.0.54）**：查料号 A 的 BOM → 关键词筛「电源」→ 再查料号 B 的 BOM —— 筛选条件应**仍然生效**（无需删除重输）；排序后再改排除词，排除也应生效。
> 34. **MCP 一键准备依赖全自动（1.0.55，本版核心，必须在安装版实测）**：Skills 面板 →「🔌 MCP 服务」→「填入示例（tech-agent-skill）」→「导入」（示例自带 `skillKey: builtin:tech-agent-skill`、cwd 留空，**不需要手工填任何路径**）→ 点「准备依赖」。期望：自动定位随包 runtime → 复制到 `%APPDATA%\mc-material-query\mcp\<服务id>\runtime` → 自举 Node 22（首次联网下载，约 1~2 分钟）→ `npm install`（npmmirror 镜像、跳过 Chromium 下载）→ 提示安装完成；随后「测试连接」应列出 4 个工具。日志（`%APPDATA%\mc-material-query\mcp\<服务id>.log`）应含 `[install] start cwd=…\resources\skills\tech-agent-skill\runtime\mcp-dingtalk-v1-template` 与 `[install] 工作目录位于安装内容内（或只读），已复制到可写副本：…`。
>     **反向对照（存量数据自愈）**：手工把某条登记的 cwd 改成一个**不存在**的路径（模拟旧版示例导入的坏数据）→ 点「测试连接」或「准备依赖」—— **不应**再报「工作目录不存在」，日志应出现 `[cwd] 登记的 cwd 不存在，本次回退到技能自带 runtime：…`，且安装后登记的 cwd 被纠正为副本路径。
> 35. **鸿翼「最新版本」类问题按 SOP 检索（1.0.55）**：勾选「鸿翼文件查询下载」→ 问「AD Plus2.0 目前最新的通用版本是多少」。期望：① **跑过一轮版本号维度的独立检索**（工具卡片里应看到 `query: filename:(V2.5.1 AND 产品词)` 之类，或直接搜 `V2.5` / `V2.6` / `ReleaseNote`），不是只在产品名检索结果里挑版本号；② 对候选最高版本**向上试过一档**（V2.5.1 → V2.5.2 / V2.6）；③ 每个候选都核过 `folderPath`，排除了客户定制目录与其他产品线同名版本；④ 版本新旧**只按版本号**判定，不拿 `modifyTime` 当版本序；⑤ 结论带「本次检索范围内」限定，**禁止**「最新就是 Vx.y.z」这种全称断言；缺维度时**第一句应是「待核实」**。已知锚点：`版本火车V2.5.1-Standard Version V2.5.1`（folderId 1168556）存在于库中但**很难被产品名检索召回** —— 若模型答「最高 V2.4.x」，说明又在拿采样当全集。另可顺手确认工具说明里那条限制：`query: filepath:(版本火车V2.5.1)` 应返回 0 条（目录名不是检索字段）。
> 36. **会话检测改三态（1.0.55）**：登录后把窗口切后台放着 → 制造一次网络抖动（例如临时禁用网卡 2~3 秒，或让探测走到超时）→ 再切回窗口。期望：**不弹登录页**（`debug-login.log` 里是 `[SESSION] check inconclusive (source=focus, network), keep current state`）；只有真的退出登录（明确 invalid）才回扫码页。另验启动期：已登录状态下重启应用，**不应再闪一下登录页**（此前 `isOALoggedin()` 启发式在 `oa.host` 下取不到 `LtpaToken` 恒 false）。
> 37. **thinking 模型多轮工具调用（1.0.56，本版核心，必须在安装版实测）**：AI 助手选 `deepseek-v4.1-flash`（OpenCode Go）→ **新建会话** → Build 模式让它做一件必然调工具的事（如「查 1261020100224 的规格书」）。期望：模型发起 tool_call → 工具返回后**第二轮请求不再报** `Upstream request failed: [invalid_request_error] The reasoning_content in the thinking mode must be passed back to the API`（1.0.55 及更早必现）。日志可自证：`userData\debug-ai.log` 里应有 `[AI] round 1: reasoning=N chars, passback=yes` 与下一轮 `[AI] round 2: history carries reasoning_content x1`；若只有 `no reasoning_content in stream` 却仍 400，说明上游换了字段名（把原始 SSE 帧留档）。另验：老会话（1.0.55 之前建的）追问时若仍报该 400，应看到中文提示「请点新对话重开一个会话」，而不是上游英文原文。
> 38. **模型清单缓存与预设（1.0.56）**：AI 助手「配置」→ 选 OpenCode Go → 点「获取模型」（应拉到 30+ 个）→ **重启应用** → 再展开模型下拉：上次拉到的清单应还在（不再是只剩预设那十几个）。缓存文件：`userData\ai-models-cache.json`（键为 `providerId::baseUrl`，`fetchedAt` 7 天内有效）。再验失效：填一个新 API Key 保存 → 缓存应被清掉（下拉回到预设）；改 Base URL 后旧缓存也不应再出现。顺手确认预设默认值已是 `deepseek-v4.1-flash`（1.0.55 及更早的 `deepseek-v4-flash` 在 Go / Zen 实时清单里都不存在，用它发第一条消息必 503 `Endpoint is unavailable`），且品牌区 tooltip 只剩「打开 OA 工作台（应用内免登录打开）」一行、不再提 Ctrl / ⌘。
> 39. **MCP 干净机器四步跑通（1.0.57，本版核心，必须在**没装过任何东西**的机器实测）**：`🔌 MCP 服务` → 填入示例 → 导入 → 准备依赖 → 测试连接。期望：① 全过程**不需要手工建** `C:\Users\<用户>\.dingding-mcp\config.json`；② 「准备依赖」的日志里出现 `[config] 已自动生成本机配置 → C:\Users\<用户>\AppData\Roaming\mc-material-query\mcp\tech-agent-config.json`（该文件随即存在，且不含 cookie）；③ 「测试连接」返回 `连接成功，共 4 个工具：chat_tech_agent, status_tech_agent, mcp_auth_tech_agent, reset_tech_agent`，徽标变「已连接 · 4 个工具」；④ 勾选技能发一句会调工具的话 → 首次提示扫码 → 扫码后自动继续。**回退验证**：故意删掉上面那个 config.json，再点「测试连接」，应自动重建并连上（日志同样有 `[config] …`）；把 `mcp-servers.json` 里该服务的 `env` 整段删掉（模拟 1.0.55/1.0.56 的老登记），再点「测试连接」—— 应自动补上 `DINGDING_CONFIG_PATH` 并连上。**失败时**：卡片要显示具体原因（如 `进程退出（code=1）。配置文件不存在: …`），不再只是一句「MCP 进程已退出」。
> 40. **扫码登录后鸿翼会话自动同步 + 登出即时出码（1.0.58 / 1.0.59，本版核心）**：退出登录（或首次启动）→ 钉钉扫码登录 → 进入主界面后**立刻**让 AI 查一份鸿翼文件（如「查 RC22061770 的版本」）。期望：**一次成功，不再提示点击链接登录 / 退出重登**。日志自证：`userData\debug-login.log` 中登录落地（`[QR-POLL] completeOaSso.ok=true`）之后紧接 `[login-sync] edoc2=ok`；`userData\wjxt.log` 中应有 `[sync] oa-login: edoc2 before=… after=true`。**对照项**：① 重启后 `[startup] total cookies: …` 名单里 `checkToken` / `copy` / `cut` / `u_loginoutguid` **不应再出现两份**（host-only 与 domain 各一份是 1.0.57 及更早的老毛病，会让 edoc2 换票取到旧票）；② `oa-session-backup.json` 里**只应有** `oa.streamax.com` 与 `streamax.com` 的 cookie，不应出现 `wj.` / `iam.`（实测 1.0.58 登录后只备份 1 颗 —— 即根域 `LtpaToken`，属预期收窄）；③ 点「退出登录」后：文案应是「已退出登录，请重新扫码登录」（不再是「登录未完成」），二维码**不应出现空白期**（旧码保留到新码到位）。**实测基线（2026-10-26 dev，登录后 2.5s 点登出）**：`07:33:40.265 [COOKIE_CLEAR] logged out: cleared 13/13 OA + wjxt + IAM cookies` → `.366 [QR-WARM] after logout ok in 99ms` → `.367 [LOGIN-VIEW] reason=logout, forced` → `.459 [QR-START] loginPage … lck=context_oauth2_20173` → `.549 getAuthQr status=200`，**登出到出码 284ms**，全程无 `retryable` / 无 `clearIam` / 无第二次 QR-START；若真走了半登录态清理，应看到 `[QR-START] clearIam then refetch … lck=…` 后**同一轮就出码**。另需确认：退出后**不会**自己回到工具里（IAM 已一并清除，实测 `13/13` 全清后仍能 90ms 拿到新 lck，说明登录页 GET 会自己重新种 IAM）；④ IAM 探针：`[iamKeepalive]` 在会话有效时应判 `iamSessionAlive=true by=body:ssoShim+code`（此前长期 `null by=status=200:unknown`，实测 1.0.58 已变 true），此时 AI 回复里的「SSO 登录」入口点开应能走完换票，而不是停在 `idp/authCenter/authenticate` 白屏；⑤ **免登录恢复（已实测通过 2026-10-26 07:39）**：登录后关闭应用再启动，应看到 `[probeOaSession] 901 (reauth)` → `[restore] restored 1/1 OA session cookies` → `[probeOaSession] status=200 … -> true (ok)` → `[restore] after restore probe ok=true` → `[startup] restoredOk=true, isOALoggedin = true`，**不需扫码**；同时 `[startup] total cookies: 2, streamax: 2 (checkToken@wj.streamax.com, LtpaToken@.streamax.com)` —— 只两颗且无同名重复，说明 ② 的收窄与去重都生效（若仍要求扫码，说明 OA 还依赖备份里没覆盖的 cookie，需放宽 `backupOaSession` 的域过滤）；⑥ **focus 不重复自愈**：登录层已显示时窗口 focus 应只留一行 `[SESSION] session invalid (…) but login view already shown -> skip silent SSO heal`，不应再出现连续 16 次 `probeOaSession` 的 7 秒探针风暴；⑦ **Chromium 到 IAM 不通时的 HTTP 兜底**（2026-10-27，对应 2026-10-26 23:21 现场）：若日志出现 `[iamReach] Chromium -> iam.streamax.com UNREACHABLE … did-fail-load -118`（同一时刻 `[main] POST https://wj.streamax.com:9443/WebCore` 却 200），登录后同步应自动回退纯 HTTP 换票，日志依次为 `[sync] oa-login: hidden window did not establish session, http fallback` → `[wjxtSsoHttp] shim hop1 -> …/sso/auth/callback?code=…` → `[wjxtSsoHttp] jump.html needs JS -> hand to hidden window: …/jump.html?token=… bodyHead=…` → `[sync] oa-login: edoc2 before=false after=true`；**`/jump.html` 不得再被当作「已落地」**（此前纯 HTTP 跟到 jump.html 就 return，实测 `[heal] http probe#1~#3 loggedIn=false` 且 cookie 仍只有 `copy,cut`）；⑧ **二维码过期自动换新**：不扫码时约 3 分钟后会收到 `code=4005 二维码已失效`，界面应自动重拉新码（1.2 秒后），不应再停在死码上（2026-10-26 13:54 / 22:58 两次实测各挂了数小时）。
> 41. **登录引导的可观测性（1.0.65，本版核心）**：制造「OA 有效但 edoc2 掉线」的状态 —— 最省事的路径就是 2026-10-27 05:46 那条现场：启动后直接点开一份需要登录的鸿翼文件预览。期望日志按序出现 `[wjxt] preview window landed on login page -> silent heal: …` → `[wjxtBootstrap] hidden window done loaded=… onsite=false land=…/authCenter/authenticate` → `[wjxt] preview login prompt -> user (heal failed, landed=…)`。**四个分支逐个验**：① 点「稍后再说」→ 紧跟 `[wjxt] preview login prompt dismissed -> AI prompt throttled 10min`；随后让 AI 查鸿翼文件，日志应为 `[wjxt] login prompt suppressed (reason=…, throttled Ns ago)` —— 这属**预期**（用户已知情，不重复打扰）；② 点「登录文件系统」→ 应出现 `[wjxt] preview h5 login ok|failed`，且**不应**出现 `preview login prompt dismissed` 那行（1.0.64 会在弹窗前就写节流，即使选了登录也会把 AI 链路压 10 分钟）；③ 承接 ② 若 `h5 login failed`，再让 AI 查文件仍报未登录时**应仍能**弹出「企业内容库需要重新登录」（登录失败不写节流即为此）；④ 弹窗期间把预览窗关掉 → 应为 `accepted but window gone -> abort`，不与「用户拒绝」混为一谈。**顺带核对登录层归属**：`[QR-WARM] after logout ok in …` 前后那两条 `[QR-START] redirect 302` 是**预热**发出的，真正的前端拉码应以 `[QR-START] step1: fetch login page` 为起点且晚于 `[LOGIN-VIEW]`（实测间隔约 8ms）；别再把预热那两条误读成「前端先拉码、主进程后通知」。**为什么单列**：这条引导是 1.0.64 起用户唯一能被拉到登录的气口，此前两个分支一个无日志、一个会误伤另一条路径，现场只能靠猜。
> 42. **AI 输入区 / 图片预览 / 料号 / 黑夜主题（1.0.66，本版核心，四条独立验）**：
>    **① 图片预览浮层（两条界面缺陷）**：AI 回复里点开一张图（消息里**只有这一张**）→ 工具条左侧**不应**再出现那条浅色小横条（此前是单图时渲染空 `ai-img-preview-count` 被 CSS 画出的胶囊）；多图消息点开应正常显示「2 / 5」。滚轮缩到 45% 时右上角「复位」按钮**必须可点**且能回到 100%（此前 `disabled={scale <= 1}` 把它灰掉了）；回到 100% 时才置灰。
>    **② 附件内联（本版改动最大的交互）**：在输入框打几个字「测试」，再 Ctrl+V 粘一张截图 → chip 应**插在光标位置、与文字同排**（18px 缩略图 + `image.png` + ×），而不是单独占一行；继续在后面打字，chip 跟着文字流走。鼠标悬停图片 chip → 上方浮出原图 + 文件名 + 大小。再拖一个 xlsx 进来 → 该 chip 应显示**完整路径**，超长时省略号、悬停看全路径。点 × 或把光标贴在 chip 右侧按 Backspace → 整块删除（不会只删掉一个字符）。
>    **必须一并验的键盘行为**（换 contenteditable 后最容易回归的地方）：Enter 发送、Shift+Enter 换行、**中文输入法组词中按 Enter 只上屏不发送**、从网页/Word 粘贴只进来纯文本（不带样式）、长文本时输入框自动长高到 180px 后内部滚动、发送后输入框与 chip 一起清空。发送后**消息气泡上方**也要显示附件（图片 chip / 文件路径 chip）。
>    顺带验三条入口：粘贴、拖拽、`+` 旁的选择文件；以及「套用提示词 / 撤销改写」把文字写回输入框后，chip 不应丢、光标不应乱跳。
>    **③ 料号带空格**：批量查询框粘贴 `5154 0211 0005 1`（4-4-4-1，13 位）→ 计数显示 **1 个**料号（不是 4 个），查询应命中；粘贴多行带空格料号（md 里那 8 条）→ 每个都命中，不再全 miss；粘贴 `5154 0221 0148 5154 0221 0128`（一行两个带空格）→ 解析成 **2 个** 12 位料号；粘贴全角数字（`５１５４ ０２２１ ０１４８`）同样命中。AI 物料模式下用带空格写法追问这批料号 → 工具卡片里的参数应是去空格的连续串（`515402210148`）。**输出侧**：回复里的料号必须是 12/13 位连续数字、不得 4-4-4 分组、位数不缺（对照工具返回的 ITEM_NUMBER 逐字一致）。
>    **④ 黑夜主题**：设置 → 主题网格第二项「黑夜模式」→ 选中后整站转暗。**重点是找白块**，逐个走一遍：顶栏与倒计时、设置面板、**「主题」行左侧的小方块必须是暗的**（它渲染的是默认壁纸，不压暗就会出现「所选显示为浅色、实际全黑」）、主题网格自身（黑夜项缩略图也必须是暗的）、**「物料结果」整块（库 Tabs 写死了 `#f8f8f0` 背景，本版已覆盖，应随主题变深 —— 这是用户本次报的那块白）**、物料表格（表头 / 斑马纹 / 悬停行）、筛选栏与下拉面板、状态弹窗、AI 面板（左侧会话栏 / 输入框 / 技能 chip / 工具卡片 / 代码块 / 消息气泡）、登录层与二维码卡片（**二维码内白底是刻意保留的**，属预期）、图片预览浮层（图片衬底应是深色而不是白框）、滚动条。
>    **本版新修的三处配色**：① AI 回复「引用文档」里的 `.docx` 链接应为**浅蓝**（`#8fc3ff`），不再是暗底上看不清的深蓝 `#0000EE`；② 悬停 tooltip（如顶栏「打开 OA 工作台」、侧栏「Markdown 编辑器」）文字应为**深棕** `rgb(52,46,36)`，与浅色气泡对比清楚；③ 料号输入框里的数字应为**浅色**（`--mc-ink`），不是偏暗的棕色。
>    再验：重启后保持黑夜；切回「奶油波点」一切正常（**本版所有暗色规则都限定在 `[data-mode='dark']`，浅色主题观感必须零变化**）；浅色主题下的白字按钮（主按钮 / 选中态）、主题缩略图、彩色 Tag 没有变灰。
> 43. **附件 chip 的复制 / 粘贴 / 撤回 + 本地读取格式扩容（1.0.66，本版收尾两条）**：
>    **① chip 复制粘贴**：在输入框打「甲」→ 拖入一个 `README.md` → 再打「乙」，全选（`Ctrl+A`）后 `Ctrl+C`，粘到**同一个**输入框末尾：应是「甲乙」文字 + **两枚** chip、顺序不变。再只框住「乙」两个字（chip 不在选区内）复制 → 粘出来只有「乙」，**不能**把 chip 跟着拖出来。粘贴后按 `Ctrl+Z` → 正文与 chip **整体**回退（不是只删文字、附件列表还留着），`Ctrl+Shift+Z` 能恢复。
>    **② 角标**：`README.md` 的 chip 角标必须是 `MD`（此前一律 `TXT`），`rules.json` → `JSON`、`报告.xlsx` → `XLSX`、`Makefile`（无扩展名）→ `TXT`。
>    **③ 同一文件多份**：把同一个文件**分两次**拖入 → 两枚 chip 都在；**一次**多选拖入同一文件的副本 → 只留一枚（同一次粘贴内部去重）。
>    **④ 读取格式**：Build 模式让 AI 依次读 `.odt` / `.ods` / `.epub` / `.rtf` / 老版 `.doc` / `.ppt` / `.vue` / `.kt` / `.toml` / 无扩展名的 `Dockerfile` → 都应读到正文，且结果里 `note` 说明读法（如「扩展名是 .doc，实际是 HTML，已按 HTML 提取正文」）；喂 `.zip` / `.exe` / 图片 → 应明确报「暂不支持读取该格式…压缩包、可执行文件、图片等二进制请勿用本工具」，**不能**返回一堆乱码。
>    **⑤ 单测**：`npm test` 应 `1 passed / 24 passed`（`src/renderer/src/components/ai/__tests__/inlineAttach.test.ts`）。
> 44. **AI 写文件 / 表头定位 / 工具传参 / 路径容错（1.0.67~1.0.70，四版连验，每条都能独立复现）**：
>    **① 翻译超时不再静默（1.0.67）**：物料表格点「翻译物料描述」，把网络掐掉（或让上游挂起）→ 90 秒内必须出结果：按钮左侧空白处出现**红字胶囊**（失败原因单行省略、悬停看全文、点击关闭），文案应是「已译出 d/n 条，可再次点击继续」而**不是**永久停在「翻译中 x/y」；恢复网络后再点，应从断点续翻。日志里应能看到 abort 与 `timedOut` 标记（手点取消则不应打 `timedOut`）。
>    **② `file_write` 不再写坏文件（1.0.67）**：① 让 AI 写一篇以 `---` 开头的 md（frontmatter）→ 文件内容必须是正文，**不能**变成字面量 `true`；② 写一段超过 32K 字符的长正文 → 完整落盘（不再被命令行截断）；③ 让它改一个 `.js` 文件里含 `'\n'` 字面量的代码 → **不能**被替换成真换行；④ 覆盖已存在的 docx / xlsx → 同目录应生成 `<文件名>.bak-YYYYMMDD-HHmmss`，结果 JSON 带 `backup` 字段；⑤ 传空正文覆盖已有文件 → 必须被拒（`EMPTY_CONTENT`），文件保持原样。`userData\debug-ai.log` 现在有 `[AI] tool <name> start/end/FAILED`，含路径、字符数、是否备份、耗时，出问题先看它。
>    **③ 表头不在第 1 行的表格（1.0.68，本版核心）**：拿用户那份 `418254-…PI_R3.xlsx`（表头上方压着 PI No / 客户地址 / Attn 等 12 行，真实表头在**第 13 行**）→ 让 AI「把 C 列填到 O 列及之后」：① 应自动定位到第 13 行表头，不再报「关键列在原表中不存在」；② 新列应落在 **P 列**（O 列已被 SUB-TOTAL 占用，工具应右移而不是覆盖），结果里 `startColumnRequested=O`、`startColumn=P`；③ O 列原有公式**必须完好**；④ 整行填色覆盖到新列。再故意写错列名 → 应返回 `KEY_NOT_FOUND` + 真实列名清单（`availableColumns`）+ `hint`，而不是让模型换名盲试。`read` 的输出应带 Excel 真实行号（`R13`）与列字母，单元格里的 `|` 转义成 `\|`（否则 Markdown 表格会错列）。
>    **④ 工具传参形态（1.0.69）**：让 AI 查一批料号（含 13 位，如 `5196009100105`）→ **不应**再出现「MC 查询参数不能为空」。即使模型把 `args` 传成对象（`{"args":{"item":"5196009100105"}}`）也应被宽容解析成数组并查询成功；报错时文案必须带「实际收到 args = …」+ 正确写法示例。**同时确认工具卡片**：失败的那次必须立刻变成失败态并显示原因，**不能**永远停在「正在查询」。反向验：AI 若以「料号位数不对 / 请你核对截图」为由质疑你给的 13 位料号，属回归 —— 提示词已禁止这么做。
>    **⑤ 路径容错（1.0.70，本版核心）**：Build 模式让 AI 读技能自带的参考文档，但**故意给错路径**：① 带 NBSP 或全角斜杠（从网页复制一段路径最容易带上）→ 应能正常读到；② 把 `api_reference.md` 写成 `api reference.md`、目录名大小写不一致 → 应逐段归一化匹配后读到；③ 给**旧安装目录**的绝对路径（如 `E:\Program Files\mc-material-query\resources\skills\ceiba2-api-qa\references\api_reference.md`，而当前装在别处）→ 返回里应带 `hint` 指向当前机器上的真实绝对路径，模型据此重读成功；④ 给一个**真不存在**的文件 → 报错必须包含「实际解析为 …」+「最近存在的上级目录」+「该目录下有：…」，能一眼判断是盘符不可用、目录名错还是文件真缺失。回归项：含**全角括号**的中文文件名（如 `报告（终版）.xlsx`）必须仍能正常读取（路径清洗不得把全角括号转半角）。
>    **⑥ 自检**：`npx tsc --noEmit` 0 错误、`electron-vite build` 通过、`npm test` 全绿；产物应为 `mc-material-query-setup-1.0.72.exe`。
> 45. **物料模式读写本机文件 / Ceiba2 双版本 / Jira-JSM 工单助手 / Mermaid 渲染（1.0.71，四条主线各给可复现步骤）**：
>    **① 物料模式读写本机文件（不再提示切 Build）**：在 `E:\销售相关\PI\Order summary` 放一份含「销售 / 品牌 / 客户型号」列的 Excel，**物料模式**下问「找 `E:\销售相关\PI\Order summary` 下的文件数据，筛选销售=许嘉达，出 TCCD 的 A8PRO 整机料号」→ 必须真的调 `file_list` / `file_read` 并给出筛选结果，**不能**再回「本地文件读取在物料模式下不支持，请切换到 Build 模式」。再问「把结果写到同目录 `许嘉达-A8PRO.xlsx`」→ 应先说明目标绝对路径并等确认；确认后生成文件，覆盖同名文件时同目录出现 `.bak-时间戳`。反向验：物料模式让 AI 执行命令（如 `dir`）→ 仍应拒绝（命令执行未开放）。
>    **② Ceiba2 双版本**：勾选「Ceiba2 API 报错排查」，问「客户 2.6.8 上 1.1 取 key 报 209」→ 应给 **POST + RSA 加密** 的新版口径；同一问题改成「2.6.3」→ 应是 GET 口径。再问「User Log 接口怎么查」→ 2.6.8 应说明该章节已移除，2.6.3 才给 15.x 步骤。校验：回答里带版本口径（如「按 2.6.8」），章节号不会跨版本套用；`references/version_diff.md` 的增删对照可直接引用。
>    **③ Jira/JSM 工单助手**：Build 模式勾选该技能 → 首次调用 `jira_config` 应自动生成 `%APPDATA%\mc-material-query\jira-jsm\config.json` 并打开目录。**不要让 AI 在对话里问 token**：填好邮箱与 token 后说「好了」→ 应调 `jira_current_user` 并回显**打码**邮箱。然后：a) 问「上周 ETESC 未关闭的工单」→ 走 `jira_search_issues` 且 JQL 含 `statusCategory != Done`，结果给可点击链接；b) 说「建一个 XX 问题的工单」→ AI 必须先查服务台/类型/必填项，**复述要点后停下等确认**，确认后才创建并回工单号链接；c) 让它评论并带上 `E:\logs\xxx.png` → 图片应内嵌在评论正文里、能打开；d) 说「评论里 @某同事」→ 对方应收到通知（而不是显示成纯文本）；e) 让它把某工单流转到「已解决」→ 同样先确认；若该流转有必填字段，应连着字段一起提交而不是让你手填。**面板 RDMS**：在工单页 F12 → Network → 筛 `useInvokeExtensionRelayMutation` → Copy as cURL 发给 AI → 应回「凭据已保存」且**不回显 cookie/token**；再说「查 ETESC-119 和 ETESC-120 的 RDMS ID」→ 应给 `rmId` + 可点击链接，Bug/Story 自动区分；看不懂类型时应反问而不是猜。等 15 分钟后再查 → 应明确提示「contextToken 已过期，请重新复制一条 cURL」。
>    **④ Mermaid 渲染**：任意模式让 AI「用 mermaid 画一个『收资料 → 定层级 → 对错误码 → 给结论』的流程图」→ 流式生成期间应**先显示源码**（不应每来一个字就重排或报错），生成完 1~2 秒内自动出图；图内文字清晰、无白底突兀色块，跟随界面在**浅色 / 深色**之间切换时配色应一起变（浅色 neutral、深色 dark）。点图应放大到全屏遮罩（大图可滚动、点遮罩关闭），卡片下方「复制源码」可用。再让它画一个**故意写错**的 mermaid（例如 `flowchart TD` 后接 `A -->`）→ 应保留代码块并提示首行错误原因，**整条气泡不能变成空白或报错**；同一会话里画多张图（含历史消息）→ 图与图之间不能串（不应出现别张图的节点）。回归：普通 ```js / ```sql 代码块仍要语法高亮，`pre` 不应套两层深色底或出现多余滚动条。
>    **⑤ 自检**：`npx tsc --noEmit` 0 错误、`electron-vite build` 通过、`npm test` 全绿；产物应为 `mc-material-query-setup-1.0.72.exe`；`out/renderer/assets/` 里应有独立的 `mermaid.core-*.js`（懒加载 chunk，约 1.2MB，不进主 chunk）；Build 模式原有工具（`file_office`、`mc_query`、鸿翼、email-auto）数量只增不减。
> 46. **Jira 粘贴附件直达 + 正文可润色 + 输入框退格不误删附件（1.0.72，三条用户实测反馈各给可复现步骤）**：
>    **① 粘贴截图直接进评论，不再反问路径**：Build 模式勾选「Jira/JSM 工单助手」→ 在输入框 `Ctrl + V` 粘一张截图，只说「把这张图加到 ETESC-133 的评论里，对客户公开，正文写『配置见附图』」→ AI **不得**回「请提供图片在本机的完整路径」，应直接复述正文与附件并停下等确认；回「确认」后评论里应出现**内嵌图**（点得开），而不是只挂在附件区。再验**确认轮复用**：同一会话下一轮只回「确认」→ 应沿用【上一轮附件的本机路径】（1 小时内、仅限 ≤20 字确认类短句），不重复问路径；**开新话题**再只回「确认」→ 不应把上一条会话的图误传上去。反向验：消息里既没有路径提示、也没提图 / 附件时，问它「评论里加张图」→ 此时才应该问你图在哪。
>    **② 成稿照抄、要点润色，但不得翻译 / 扩写 / 补寒暄**：分两笔验。
>    a) **成稿照抄**：输入「给 ETESC-133 加评论，对客户公开，正文：目前客户提供的 VPN 已失效，需要了解附件图片中 ConfigTool 的相关配置，以便继续排查人脸比对上报记录无法查看的问题」→ 确认话术里复述的正文必须与这句**逐字一致**，不补「您好 / Hello」、不附英文译文、不改写成邮件体。
>    b) **要点润色（本版新口径）**：输入「给 ETESC-133 加评论，说客户那边 VPN 失效了，让我们看附件里的 config 配置，不然人脸比对上报记录查不了」→ 复述的正文应是**通顺的书面语**（例如「客户侧 VPN 已失效，需核对附件中 ConfigTool 的配置，以便继续排查人脸比对上报记录无法查看的问题」），而不是把口语原样贴上去；读起来生硬、口语词（「那边 / 让我们 / 不然」）原封不动即算回归。**同时守三条线**：① 不得出现「您好 / 如有疑问请随时联系」这类客套头尾；② 不得附英文译文（用户没提翻译时出现任何英文段落即算回归）；③ 型号 / 版本 / 单号 / 报错码 / 数量等具体信息一个字都不能变，也不能编出排查结论或承诺。说「翻译成英文再加评论」→ 才只提交英文版。约束已写进 SKILL.md 硬规则 9 / frontmatter / 两个工具的参数描述，`jiraPrompt.test.ts` 会拦住误删。
>    **③ 输入框退格不误删附件（本版回归修复）**：在输入框里 `Ctrl + V` 粘一张截图（或拖一个 xlsx 进来），正文写「帮我review下这个表格」→ 把光标移到该句**中间**（例如「表格」两个字之间）按退格 → **只能删文字，附件 chip 必须还在**；句尾连删几个字同样不能连带删附件。反向验：把光标移到**句首**（紧贴 chip 右侧）按退格 → 此时才应该删掉 chip（附件一并从待发列表移除），这正是「贴着 chip 退格」的预期行为。再验中间状态：chip 后先打几个字再全删掉，继续按退格 → 应先删 chip 而不是卡住。
>    **④ 自检**：`npx tsc --noEmit` 0 错误、`npm test` 47 passed（新增 `attachPaths.test.ts` 11 例、`jiraPrompt.test.ts` 5 例、`inlineAttach.test.ts` 退格用例 7 例）、`npm run build` 通过；产物应为 `mc-material-query-setup-1.0.72.exe`；`%APPDATA%\mc-material-query\attachments\` 下应出现粘贴过的图片（文件名已清洗），**重启应用后**在历史会话里再回「确认」仍能复用（路径随历史持久化）。
> 47. **改 Excel 不再把原表写坏（1.0.73，用户实测：「使用 AI Build 模式写入文件时，又把文件写坏了」）**：
>    **① 复现素材**：一张带大量文本框 / 图片的 PI（`OR-Moges _Q4_2026_Order_PI_…xlsx`，`Truck` 表 sheet1 里有 17 个 `<xdr:sp>` 形状 + 18 个 `<xdr:pic>` 图片，还带 `Print_Area` 与 154 个合并单元格）。先把原文件复制一份留底。
>    **② `--update` 只改两行值 + 整行上色**：Build 模式让它把某个料号的 `Unit Cost` 改成 145.5 并把该行「整行标绿」→ 用 `unzip -l` / 脚本对比两份 xlsx：**丢部件数必须为 0**，内容变化的旧部件只允许 `xl/styles.xml` + `xl/worksheets/sheet1.xml`；`xl/drawings/drawing1.xml` 里 `<xdr:sp>` 仍是 17、`<xdr:pic>` 仍是 18；`<mergeCell>` 仍是 154；`Print_Area` 仍是 `Truck!$A$1:$O$67`（**不能**变成 `$A1`）；值变化的行数 = 2，目标单元格应写成数值型 `<v>145.5</v>` 而不是字符串。回归判定：任一形状消失、出现「发现不可读取的内容」修复提示、或打印区域丢 `$`，即算失败。
>    **③ `--newsheet` 追加一张查询表**：`write <原文件> --newsheet MC料号查询 --content "<TSV>"` → 原表 `xl/worksheets/sheet1.xml` 必须与写前**逐字节一致**（`sha1` 相同），包内只允许**新增** `xl/worksheets/sheet2.xml` 一个部件，`workbook.xml` / rels / `[Content_Types].xml` 三处各加一行登记；用 Excel 打开应看到两张表且原表文本框、图片、打印预览全部正常。
>    **④ 追加行 + 新列**：让它「再加一行料号，并新增一列『全新列』」→ 行数 +1、`<dimension>` 扩到新末列，形状/图片计数不变；原表其余行不得发生任何值变化。
>    **⑤ 写坏兜底（白名单校验）**：写盘前先把新包解出来，与写前逐部件比对 SHA1 —— 除允许改的那几个部件（`workbook.xml` / `xl/_rels/workbook.xml.rels` / `[Content_Types].xml` / 目标 sheet / `styles.xml`，`--newsheet` 另加新增的那一个 sheet 部件）外，**任何一个部件**内容不同、缺失、或凭空多出，都判失败并中止（此时原文件还没被写，保持原样；写前另有 `<文件名>.bak-时间戳` 备份）。验法：故意让脚本改一下 `xl/calcChain.xml` 或在包里塞一个多余部件 → 应返回「写入会损坏原文件（… 与写前不一致）」/「多出预期之外的部件（…）」，且目标文件的 `mtime`、大小均不变。早先这里是黑名单（只盯绘图/媒体/图表/打印设置），`calcChain.xml`、`sharedStrings.xml` 被改是抓不到的。
>    **⑥ 自检**：`npx tsc --noEmit` 0 错误、`npm test` 70 passed（新增 `fileOfficeLossless.test.ts` 23 例，覆盖 `xmlEsc` / `xlsxIndex` / `xlsxStyles.styleFor` / `xlsxPatchSheetXml` / `xlsxEnsureLossless` 白名单校验 7 例）、`npm run build` 通过；产物应为 `mc-material-query-setup-1.0.73.exe`。注意 `.xls` 老格式仍走 SheetJS 整本重写（OOXML 之外无法无损），要精确保样式必须用 `.xlsx`。

> 48. **BOM 查询误报「无 BOM」+ 附件里的图片模型看不到（1.0.74，两条一起验收）**：
>    **① #1 参数归一化**：物料模式输入「查 5190010100062 的 BOM」→ 必须返回 26 个子项；故意把 `args` 写成单字符串 / `{"item":"..."}` / 全角 / 4-4-4 分组，也应自动归一化成功，**任何情况下都不许出现「BOM 子项 0 条 / 整机未维护 BOM / 需要权限」**。
>    **② #1 失败与空结果不同构**：断开网络或让 OA 会话失效 → 回复里必须出现「查询失败」及 `error_code` 对应措辞，不得解释成业务原因；`args:[]` → `EMPTY_ARGS`，不重试、不编料号问题。查真实空 BOM 料号 → 工具结果带 `resultCode:OK_EMPTY` + `verifiedTwice:true`，回复注明「已二次核验」。
>    **③ #2 Jira 图片**：Build 模式勾选 Jira/JSM 技能，问「看下 ETESC-128 评论里的轨迹图说明什么」→ 模型调用 `jira_get_issue_attachments`，`%APPDATA%\mc-material-query\attachments\` 下出现 `att-{id}-*.png`，且模型能**描述图中内容**（唯一判据）；第二跳 CDN 请求头不带 `Authorization`。追问「这条评论引用了哪张图」→ `commentImages` 给出文件名映射，`.log` 不被误配成图片。
>    **④ #2 长文件与降级**：下载日志附件 → 工具结果只有 `localPath` + ≤500 字预览，`read_local_file` 能读到全文；混入 8 张以上图片 / 单张 >8MB → 只回灌前 8 张，单条 `status:'error'` 不影响其它。网关拒绝多模态注入时自动移除图片消息并重试本轮，回复如实说明「需要把图拖进输入框」，**工具链不中断、不假装看过图**。
>    **⑤ #2 MC 规格图纸**：物料模式问「哪个能看到 5190010100062 的接口图纸」→ `mc_query spec` 带 `download:true`，落盘到 userData/attachments，PNG 走图片回灌、PDF 走 `read_local_file`。
>    **⑥ 自检**：`npx tsc --noEmit` 0 错误、`npm test` 106 passed（新增 `mcArgs.test.ts` 16 例、`attachmentMedia.test.ts` 20 例）、`npm run build` 通过；产物应为 `mc-material-query-setup-1.0.74.exe`。

### 6. 发布到 GitHub Release

需要一个有**仓库写权限**的 GitHub Token，二选一：

- **Classic PAT**：勾选 `repo` 范围。
- **Fine-grained PAT**：Repository permissions → **Contents** 设为 `Read and write`（GitHub 没有独立的 "Releases" 勾选项，Release 与附件上传都归入 Contents 权限）。

设置 token 并发布：

```powershell
$env:GH_TOKEN = '你的token'
.\build_now.ps1 -Publish
```

等价的底层命令：

```powershell
npx electron-builder --win --config electron-builder.yml --publish=always
```

> 用 PowerShell 临时环境变量，不要写进文件。`cmd` 环境用 `set GH_TOKEN=...`。
> 脚本在**打包完成后**才校验 `GH_TOKEN`，因此不会白跑一趟打包。

该命令会：

1. 重新构建并打包到 `dist/`；
2. 自动创建 git tag `v1.0.50`；
3. 创建 GitHub Release；
4. 上传 `latest.yml`、安装包、`.blockmap`。

### 7. 把 draft 改为 Published（**必做**）

`electron-builder` 默认创建的是 **draft（草稿）** Release。**草稿状态下客户端自动更新检测不到新版本**，必须手动发布：

- 网页：仓库 → Releases → 对应 Release → Edit → 取消勾选 `Set as a draft` → **Publish release**。
- 或脚本：

```powershell
# publish_release.ps1
$token = '你的token'
$h = @{Authorization="Bearer $token"; "Content-Type"="application/json"}
$rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/maozuxiao/mc-tool/releases' -Headers $h
$v = $rel | Where-Object { $_.tag_name -eq 'v1.0.50' }
$body = @{draft=$false} | ConvertTo-Json
Invoke-RestMethod -Method PATCH -Uri "https://api.github.com/repos/maozuxiao/mc-tool/releases/$($v.id)" -Headers $h -Body $body
```

### 8. 验证更新链路

1. 保留一个**旧版本**的客户端（如 1.0.24）。
2. 启动旧客户端，等待约 3 秒（启动后延迟检查）。
3. 顶部应出现更新条，显示新版本号与「下载」按钮。
4. 点击下载 → 进度条 → 完成后显示「立即更新」。
5. 点击「立即更新」→ 当前 app 退出 → NSIS 安装向导弹出（**非静默**，可见进度、可选目录）→ 完成后 `--force-run` 自动启动新版。
6. 新版本「帮助 / 检查更新」应提示「当前已是最新版本」。

---

## 二、客户端自动更新机制

| 环节 | 实现位置 | 说明 |
|---|---|---|
| 更新源 | `src/main/updater.ts` | `autoUpdater.setFeedURL({ provider:'github', owner:'maozuxiao', repo:'mc-tool' })` |
| 触发时机 | `src/main/updater.ts` | 启动后 `setTimeout(..., 3000)` 自动检查，避免阻塞首屏 |
| 下载策略 | `autoUpdater.autoDownload = false` | **不自动下载**，由用户在更新条点「下载」 |
| 版本比较 | `updater.ts` 的 `update-available` | 逐段比较，服务器版本不高于本地则忽略（防低版本误报） |
| 进度回传 | `download-progress` → `update-progress` | 渲染层 `UpdateBar` 显示百分比 |
| 安装方式 | `src/main/index.ts` 的 `IPC.INSTALL_UPDATE` | 取已下载安装包路径，`spawn(installer, ['--updated','--force-run'])` 启动 NSIS 向导，300ms 后 `app.exit(0)`；找不到包时兜底 `quitAndInstall(false, true)` |
| 错误策略 | `updater.ts` 的 `error` | 更新错误**只写日志不弹 UI**，避免 `latest.yml` 缺失等场景打扰用户 |

日志位置（`updater.ts` 的 `debugLog`，仅打包后写入）：

```
%APPDATA%/mc-material-query/app.log
```

---

## 三、历史包袱：1.0.23 及更早版本

**老版本内置的更新地址写死在 exe 里**，指向旧源（`maozuxiao/Streamax` 仓库的 `assets/MC_Tool` 目录），与新 Release 地址不同，因此 **≤ 1.0.23 的客户端检测不到 1.0.24 及之后的更新**。

处理方式：**让用户手动下载覆盖安装一次** 1.0.24，之后即可正常自动更新。

下载入口（公开，无需登录）：

```
https://github.com/maozuxiao/mc-tool/releases/download/v1.0.24/mc-material-query-setup-1.0.24.exe
```

或到 Releases 页面选择 `mc-material-query-setup-1.0.24.exe`。

> 已安装的 1.0.24 用户无需任何操作。

---

## 四、仅打包不发布 / 测试包

### 4.1 只出本地包

```powershell
.\build_now.ps1          # Windows
.\build_now.ps1 -All     # 全平台
```

等价命令 `npm run pack:win` / `npm run pack:all`。不加 `-Publish` 就不会碰 GitHub。

脚本参数速查：

| 参数 | 作用 |
|---|---|
| *(无)* | 打 Windows 包（NSIS + 便携版） |
| `-Mac` | 打 macOS DMG |
| `-All` | 打全平台 |
| `-NoClean` | 保留旧的 `dist/`，不清理 |
| `-Publish` | 打包后发布到 GitHub Releases（需 `GH_TOKEN`） |

### 4.2 输出到独立目录（避免污染正式 dist/）

临时修改 `electron-builder.yml`：

```yaml
directories:
  output: dist/update test
```

打包后**记得还原**为 `output: dist`。

产物在 `dist/update test/`，测试时把该目录的 `latest.yml` + `*.exe` + `*.exe.blockmap` 手动上传到 Release 即可让旧客户端检测到。

### 4.3 只想测 exe 文件版本（不改产品版本）

`electron-builder.yml` 里自定义产物名：

```yaml
nsis:
  artifactName: MC物料查询-${buildVersion}-Setup.${ext}
```

产物为 `MC物料查询-1.0.50.0-Setup.exe`，但 `latest.yml` 里产品版本仍是 `1.0.50`。仅用于测试，正式发布请改回统一命名。

---

## 五、macOS 打包

```bash
npm run pack:mac
```

- 产物：`dist/MC物料查询-1.0.50-<arch>.dmg`（命名来自 `mac.artifactName`）。
- **签名与公证**：当前 `electron-builder.yml` 未配置 `identity` / `notarize`，打出的 DMG 未签名，macOS 会拦截（Gatekeeper）。若要正式分发 macOS 版，需补 Apple Developer 证书与公证配置。
- **不建议在 Windows 上交叉编译 DMG**，请在 macOS 上执行。

---

## 六、常见问题排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 客户端一直检测不到新版本 | Release 仍是 **draft** | 到 GitHub 把 Release 改为 Published |
| 客户端提示「已是最新」但版本号不对 | `package.json` 的 `version` 与 `buildVersion` 不同步，或版本倒退 | 确认两处版本号一致且单调递增 |
| 发布时报 401 / 404 | `GH_TOKEN` 无效或权限不足 | 重签 token，确认 Contents 为 Read and write |
| 发布时报 tag 已存在 | 同名 tag 已建过 | 删除远程 tag 与 Release 后重发，或升版本号 |
| 更新下载到一半失败 | 网络中断 / 附件未上传完整 | 重新点「检查更新」重试；确认 `.blockmap` 与 exe 均已上传 |
| 更新条不显示但确实有新版本 | 更新错误**只写日志不弹 UI** | 查看 `%APPDATA%/mc-material-query/app.log` |
| 老版本（≤1.0.23）收不到更新 | 内置旧更新源，写死在 exe 中 | 手动下载 1.0.24 覆盖安装一次 |
| 打包报图标错误 | `build/icon.ico` / `icon.icns` 未入库（被 `.gitignore` 排除） | 从 `build/icon.png` 用 `sharp` 自行生成，或让 electron-builder 自动转换 |

---

## 七、安全提醒

- GitHub Token 具备仓库写权限，**不要**写进代码、日志或聊天记录。优先用本机临时环境变量，用完可在 GitHub 撤销（已发布的 Release / tag 不受影响）。
- 日常 git 操作推荐用 **SSH**，免 token：

  ```bash
  git remote set-url origin git@github.com:maozuxiao/mc-tool.git
  ```

- 若必须用长期 token，建议 **fine-grained token** 且只授权 `mc-tool` 仓库的 Contents 读写，最小化权限。
- 仓库为 public，**源码与配置对所有人可见**，切勿提交任何内部地址凭据、token 或个人信息。

---

## 八、相关文档

| 文档 | 内容 |
|---|---|
| [README.md](./README.md) | 项目背景、功能、使用方法、开发与打包入口 |
| [PACKAGE_README.md](./PACKAGE_README.md) | 版本号规则、打包细节、任务栏名称等 UI 定制 |
| [MC Tool Release Notes.md](./MC Tool Release Notes.md) | 逐版本变更记录（发布前追加一行） |
