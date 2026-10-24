# MCP 登记 / 一键准备依赖 / 登录 / 排查

本技能随安装包分发**runtime 源码**（不含 node_modules）。启用 = 登记一个 stdio 服务 + 点一次「一键准备依赖」。

## 1. 登记 MCP 服务

「Skills → MCP 服务 → 新增」，按下表填写：

| 字段 | 值 |
|---|---|
| 服务名 | `Tech-agent-mcp` |
| 绑定技能 | `Tech-agent-skill` |
| 传输 | stdio |
| command | `node` |
| args | `src/index.js` |
| cwd | 用面板的「选择工作目录」挑到 `resources/skills/tech-agent-skill/runtime/mcp-dingtalk-v1-template` |
| env | `DINGDING_CONFIG_PATH` = 配置文件的绝对路径（见第 2 节） |

> **cwd 是只读的**：打包后它在安装目录下（Program Files），普通用户没有写权限，
> 直接在里面 `npm install` 会失败（EPERM/EACCES）。这由「一键准备依赖」自动处理，见下一节。

## 2. 生成配置文件

**1.0.57+ 默认全自动，不用手工做**：点「准备依赖」或「测试连接」时，应用会读本包的 `mcp.json`
声明（`config.env` = `DINGDING_CONFIG_PATH`，`config.template` = `templates/config.tech-agent.json`），
把 `config.base.json`（`_merge_auth_from` 基座）与 `config.tech-agent.json` 合并、剔除他人凭证后，
写到登记的 `DINGDING_CONFIG_PATH` 指向的位置；日志里会出现
`[config] 已自动生成本机配置 → C:\Users\<用户>\AppData\Roaming\mc-material-query\mcp\tech-agent-config.json`。

手工流程只在两种情况下需要：

- 用的是 **1.0.56 及更早**版本（没有自动生成）；
- 要接**自己的机器人实例**：复制两份模板到可写位置（如 `%APPDATA%/mc-material-query/mcp/`），
  改 `agent.uuid` / `mcp.tool_id` / `agent.name`，再把 `DINGDING_CONFIG_PATH` 指过去 ——
  文件已存在时应用不会覆盖它。

两份模板都**不含 Cookie**；`cache.cookie_path` / `cache.session_path` 留空，由运行时按本机实际位置解析。

> `corp_id` 是企业身份，**不能**当会话 cid 用；`createDialog.cid` 由运行时按
> `{DEAP userId}:{agentUuid}` 生成。
>
> 模板文件头若带 UTF-8 BOM 会报 `配置文件JSON格式错误: Unexpected token '﻿'` —— 保存时选 UTF-8 无 BOM。

## 3. 一键准备依赖

在「MCP 服务」面板点该服务的「一键准备依赖」。应用会：

1. 探测登记的 `cwd` 是否可写；
2. **不可写时**（安装版的内置技能目录）把运行所需的最小集合（`src/` + `package.json` +
   `package-lock.json`）复制到 `%APPDATA%/mc-material-query/mcp/<服务id>/runtime`，
   并把登记里的 `cwd` 自动切到该副本 —— 你**不需要手工指定副本路径**；
3. 在该目录执行 `npm install --no-audit --no-fund --registry=https://registry.npmmirror.com`，
   同时设置 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`（playwright 的 postinstall 会另外下载约 150MB 的
   Chromium，登录时优先复用本机已装的 Chrome / Edge，两者都没有才需要浏览器）；
4. 装完点「测试连接」，应列出 `chat_tech_agent` / `status_tech_agent` / `mcp_auth_tech_agent` /
   `reset_tech_agent`。

> 若你的服务目录本来就可写（例如自己放在 D 盘的副本），应用会**原地安装**，不会覆盖已有依赖。

## 4. 登录（浏览器扫码）

1. 首次使用或登录态失效时，调用同一实例的 `mcp_auth_tech_agent`；
2. 应用会拉起本机浏览器打开钉钉 DEAP 页面，用手机钉钉扫码；
3. MCP 自动轮询、校验并保存 Cookie，同时解析缓存 DEAP userId；
4. 多个机器人共用同一登录态，**一次成功登录即可恢复全部实例**。

登录全程只走浏览器扫码，不存账号密码。

## 5. 排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 「已信任但 0 工具」/ 启动即退出 | 依赖没装或没装成 | 点一次「一键准备依赖」，等进度条走完再测试连接 |
| `工作目录不存在：…` | 登记里的路径无效或环境变量未展开 | 用「选择工作目录」重挑；若刚删过技能目录，重新登记一次 |
| `配置文件JSON格式错误: Unexpected token '﻿'` | 配置模板首字节带 UTF-8 BOM | 另存为 UTF-8（无 BOM） |
| 改了依赖/配置但行为没变 | 旧进程未重拉 | MCP 服务面板「关闭再重新信任」，或重启应用 |
| 查询报登录失效 | Cookie 过期 | `mcp_auth_tech_agent` → 扫码 → 重试**原问题** |
| 权限不足 / 看不到知识库 | 机器人使用范围或知识库权限没开 | 找机器人管理员把本人加入「使用范围」并开放读取权限 |

DEAP 管理入口：<https://deap.dingtalk.com/#/agent-admin>

## 6. 安全约束

- **禁止**把密钥 / Token / Cookie / `chat_user_id` 硬编码进技能包；它们由登录流程或本地配置注入。
- **禁止**在技能包里硬编码本机绝对路径（`C:\Users\...`）；路径由宿主按本机实际环境解析。
- 例外：团队默认实例的**非敏感**标识（`agent.uuid` / `mcp.tool_id` / `agent.name` / `auth.corp_id`）
  作为开箱即用配置内置在 templates 中，方便同团队用户直接使用。