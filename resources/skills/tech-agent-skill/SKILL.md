---
name: Tech-agent-skill
description: 在 AI 助手里通过钉钉 DEAP 智能体查询知识库（Tech-agent-mcp 等实例）。内置团队默认实例 Tech-agent，开箱即用；含「禁止空内容查询」「严格路由到用户指定实例」「保留答案中的图片链接」等强制规则。需要先在「MCP 服务」里登记对应服务才能使用。
version: 1.0.5
category: productivity
---

# Tech-agent 知识库查询（钉钉 DEAP 智能体）

通过 MCP 调用钉钉 DEAP 智能体做知识库问答。**默认内置团队常用实例**，不含任何账号/密码/Token/Cookie，
也不含本机绝对路径。

**使用前提**：① 目标机器人已把你加入「使用范围」；② 对应知识库有你的读取权限；③ 已在
「Skills → MCP 服务」里登记并绑定该实例的服务（见下方「启用」）。

## 启用（MCP 登记 + 一键准备依赖）

本技能随安装包分发 **runtime 源码**（`runtime/mcp-dingtalk-v1-template/`，约 95KB：7 个 .js +
package.json + package-lock.json），但**不含 node_modules** —— 依赖由用户点一次「一键准备依赖」按需安装，
这样安装包体积不变。启用分两步：

**第 1 步：在「MCP 服务」面板登记这个服务**（填表见下表）

| 字段 | 值 |
|---|---|
| 服务名 | `Tech-agent-mcp`（要与下面的工具后缀对上） |
| 绑定技能 | `Tech-agent-skill` |
| 传输 | stdio |
| command | `node`（留 `node` 即可，主进程会解析真实 node） |
| args | `src/index.js` |
| cwd | 用面板里的「选择工作目录」挑到本技能目录下的 `runtime/mcp-dingtalk-v1-template` |
| env | `DINGDING_CONFIG_PATH` = 配置文件（`templates/config.tech-agent.json` 复制到可写位置后的绝对路径） |

> cwd 的实际路径：打包后在**安装目录**下（形如 `…\MC物料查询\resources\skills\tech-agent-skill\runtime\mcp-dingtalk-v1-template`）。
> 该目录**只读**，第 2 步会自动把它复制到用户数据目录再安装依赖，并把登记里的 cwd 切到那个副本 ——
> 你不需要手工指定副本路径。

**第 2 步：点「MCP 服务 → 一键准备依赖」**，等进度条走完即可（会顺带跳过 playwright 的浏览器下载，
登录时优先复用本机已装的 Chrome / Edge）。

之后「测试连接」应列出 `chat_tech_agent` / `status_tech_agent` / `mcp_auth_tech_agent` / `reset_tech_agent`。

配置文件用本包 `templates/` 下的两份：`config.base.json`（共享登录基座，含 `corp_id`）+
`config.tech-agent.json`（默认机器人实例）。**两份都不含 Cookie**，`chat_user_id` 与 Cookie 由登录
流程写入。**不要**手动往里写 `auth.cookie_string`，也**不要**把 `cache.*_path` 写成别人机器的绝对路径
（留空即可，由运行时按本机实际位置解析）。

绑定后本技能条目的「需 MCP」徽标会消失，勾选它即可下发上述工具。

细节与故障排查见 `references/setup-mcp.md`。

## 内置默认实例（开箱即用）

| 参数 | 值 |
|---|---|
| MCP 服务名（`target_mcp`） | `Tech-agent-mcp` |
| 智能体 UUID（`agent.uuid`） | `6ecae008-5346-49ad-a94d-68b04d3418e3` |
| 展示名（`agent.name`） | `Tech-agent` |
| MCP 实例后缀（`mcp.tool_id`） | `tech_agent`（工具即 `chat_tech_agent` / `status_tech_agent` / `mcp_auth_tech_agent` / `reset_tech_agent`） |
| 企业身份（`auth.corp_id`） | `ding6d9605c0b6ce935f` |

接入其它机器人：新增一份 `config.<bot>.json`，改 `agent.uuid` / `mcp.tool_id` / `agent.name` /
`cache.session_path`，并新增一个对应 `target_mcp` 的 MCP 服务登记即可；`chat_user_id` 与 Cookie 仍由登录写入。

## 禁止空内容查询（必须）

- 调用任何 `chat_*` 前，`message` **必须非空**。禁止发空问题或纯空白内容 —— 会在 DEAP 后台产生
  「空请求」，属于必须杜绝的行为。
- 用户只说「启动技能」「试一下」「测一下」而没给实际问题时，**默认发送**：`你是谁，可以做什么？`
- 用户给的是空串/纯标点/全空白时，先澄清要查什么；确无内容同样回退到上面那句，绝不传空字符串。

## 严格路由规则（必须）

- 调用时必须给出目标 MCP 名称（`target_mcp`）；用户没指定时先问，或用内置默认实例并说明。
- **只调用用户指定的实例**，禁止自动改用其他实例。
- 未登录 / Cookie 失效 / 提示登录失效时，先对**同一实例**执行 `mcp_auth_*`，再重试原查询。
- `createDialog` 的 `cid` 必须是 `{DEAP userId}:{agentUuid}`；userId 兼容纯数字或 `ST+数字`。
  `corp_id` 是企业身份，**不能**当会话 cid 用。
- 登录会拉起本机 Chrome 打开钉钉 DEAP 页面，用户手动扫码，MCP 自动轮询并保存 Cookie；多个机器人
  共用 `config.base.json` 的登录态，一次成功登录即可恢复全部实例。
- 不要要求用户复制 Cookie、输入密码，也不要建议下载 Playwright 浏览器或安装浏览器插件。

## 保留问答结果中的图片（必须）

- `chat_*` 返回的是 Markdown，答案里可能内嵌图片（`![示意图](https://...)`）。**必须原样保留**
  图片及其链接，不得删除、改写、降级为纯文本或替换成占位符。
- 把结果整理/汇总/导出为 `.md` 文件时，最终文件里同样**必须保留** `![alt](url)` 语法与原始 URL。
- 不要擅自把远程图片下载到本地再换成相对路径；即便 URL 带鉴权参数、很长，也要完整保留、不截断。
- 答案本身没有图片时，正常输出文字即可。

## 默认登录恢复策略

1. 先调用目标实例的 `status_*` 或直接发起查询，检测 Cookie 是否有效；
2. 失效时调用同一实例的 `mcp_auth_*`，告知用户在弹出的浏览器页面手动完成钉钉扫码；
3. 等待 MCP 识别有效 Cookie 与 DEAP userId 并写回配置与缓存；
4. 认证成功后**重试原问题**；只有重试仍失败，才报告目标机器人的权限或服务异常。

## 行为契约（可直接注入系统提示）

1. 用户指定目标实例时只调用它；未指定先澄清。
2. 未鉴权先 `mcp_auth_*`，引导浏览器扫码后重试。
3. 不得输出或存储明文密钥、Token、Cookie。
4. 查询失败时给出可操作的重试步骤，**不编造**知识库内容。
5. 禁止空内容请求（见上）。
6. 保留 `chat_*` 返回的所有图片链接（见上）。

## 常见错误与处置

| 现象 | 含义 | 你要做什么 |
|---|---|---|
| `isOALoggedin` 之外报「MCP 未注册」/ 工具列表里没有 `chat_*` | 服务没登记或没绑到这个技能 | 提示用户去「MCP 服务」登记并绑定（见「启用」），不要反复重试工具 |
| 服务「已信任但 0 工具」或启动即退出 | 依赖没装上（内置 runtime 只随包分发源码，没有 node_modules） | 让用户在「MCP 服务」面板点一次**一键准备依赖**，等进度走完再测试连接（应用会自动把只读目录复制到可写副本再装） |
| `配置文件JSON格式错误: Unexpected token '﻿'` | 模板文件头带 UTF-8 BOM | 去掉文件首字节 BOM（EF BB BF），其余内容不变 |
| 查询报登录失效 | Cookie 过期 | 对同一实例 `mcp_auth_*`，提示扫码，再重试**原问题** |
| `权限不足` / 看不到知识库 | 机器人使用范围或知识库权限没开 | 让用户找机器人管理员把本人加入「使用范围」并开放知识库读取权限 |

改完 runtime 依赖或配置后，需要在 MCP 服务面板「关闭再重新信任」（或重启应用），
让服务重新拉起并注册工具，本会话的工具索引才会刷新。

## 参考

- [references/setup-mcp.md](./references/setup-mcp.md) —— MCP 登记步骤、登录与排查
- [templates/config.base.json](./templates/config.base.json) —— 共享登录基座（含 `corp_id`）
- [templates/config.tech-agent.json](./templates/config.tech-agent.json) —— 默认机器人实例