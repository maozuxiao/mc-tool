# 客诉场景剧本与回复模板

> 用法：先按客户描述找到对应场景 → 按「要问什么」补齐信息 → 用「判定」给出结论 → 用「模板」回信（中英各一份可改直接用）。
> 所有判定都要回到文档依据（接口章节号 / 错误码 / 字段名），不要只给感觉。
> **版本口径**：本文件覆盖 2.6.3 与 2.6.8。回信模板里的 `{版本}` 请填客户实际版本；涉及取 key、远程控制、证据中心章节号时，先确认版本再填
> （2.6.3：GET 取 key、证据中心 15.x；2.6.8：POST 取 key、证据中心 14.x、远程控制 `/remote/control`）。

---

## 通用回复骨架（任何场景都能套）

**中文**
```
您好，关于您反馈的「{一句话现象}」，根据 Ceiba2 API 文档（{版本，例 v2.6.8}）与您提供的返回信息，初步判断为：{结论：可能原因}。
依据：{错误码/接口章节/字段}。
麻烦您按下面步骤确认，并把结果回复给我：
1) {动作1：可复制的请求或核对点}
2) {动作2}
如仍无法解决，请提供：完整请求 URL（含 HOST:PORT）、请求参数（含 key）、返回原文（HTTP 状态码 + body）、报错时间点，我们进一步定位。
```
**English**
```
Hi, regarding "{issue}", based on the Ceiba2 API document ({version, e.g. v2.6.8}) and the response you provided, our initial finding is: {root cause}.
Reference: {error code / API section / field}.
Could you please check the following and send us the results?
1) {action 1}
2) {action 2}
If the issue persists, please provide the full request URL (with HOST:PORT), the request parameters (including the key), the raw response (HTTP status + body), and the exact time of the failure so we can dig further.
```

---

## 场景 1：拿不到 key / 登录失败（206 / 205 / 217 / 404）

**客户典型描述**：「调 /api/v1/basic/key 报错，拿不到 key」。

**要问**：完整 URL（含 HOST:PORT）、账号密码是否含特殊字符、网页端能否登录、返回原文、**CMS 版本（2.6.3 / 2.6.8）**。

**判定**
- **先分辨方法**：2.6.3 是 `GET` + query；**2.6.8 是 `POST` + JSON body**。客户用 GET 调 2.6.8 会得到 `201 非法请求` / `207 参数数量异常` / `405`，这类「报错但不是账号问题」的情况约占新版客诉的一半。
- `404` → 地址/端口/版本错（路径必须 `/api/v1/basic/key`）。
- `206` → 账号密码不符（特殊字符未 URL encode 最常见）。2.6.8 若用了 `rsapublickey`，密码必须是按该公钥加密后的密文，明文会走 206。
- `205` → 账号过期/停用。
- `217` → 并发登录限制（集成程序与网页端抢同一账号）。
- HTTP 200 但 `data.key` 为空 → 看 body 里的 `errorcode`，按上面对应处理。

**English（给海外客户）**
```
Please note the login endpoint differs by version:
- v2.6.3: GET  http://{HOST}:{PORT}/api/v1/basic/key?username=xxx&password=xxx
- v2.6.8: POST http://{HOST}:{PORT}/api/v1/basic/key  with JSON body {"username":"xxx","password":"xxx"} and Content-Type: application/json
Using the GET form against a v2.6.8 server returns 201/207/405 rather than a key.
An error code 206 means the account or password is incorrect - please make sure special characters in the password are properly encoded.
An error code 205 means the account has expired; please contact your administrator to renew it.
An error code 217 means the same account is already logged in elsewhere (concurrent login limit).
A 404 usually means the host/port or the path is wrong; please confirm the CMS server address and that the path is exactly /api/v1/basic/key .
```

---

## 场景 2：拿到 key 了，但所有业务接口都失败（209 / 210 / 204 / 203）

**客户典型描述**：「key 有了，但调别的接口都报错」。

**判定（按顺序排掉）**
1. `209` → **没带上 key**；若客户调的是 POST 接口，八成把 key 放在 query 而不是 **JSON body**。
2. `210` → key 值抄错/截断/带空白。
3. `204` → key 过期（取完后隔太久），应「取新 key 再重试」。
4. `203` → 权限不足（`2.5 authority` 看权限位；或用有权限账号对比）。

**给客户的自检三步**（可直接贴）
```
1) GET http://{HOST}:{PORT}/api/v1/basic/groups?key=<YOUR_KEY>      → 期望 errorcode=200
2) POST http://{HOST}:{PORT}/api/v1/basic/gps/count                 → body 里必须包含 "key"
3) 若 1) 返回 204：请重新调用 /api/v1/basic/key 取新 key 后立即重试（key 会过期）
```

---

## 场景 3：参数类报错（207 / 208 / 216 / 201）

**客户典型描述**：「按文档传了，还是报参数错误」。

**先怀疑这 5 个高频坑**
| 坑 | 正确写法 | 典型错误码 |
|---|---|---|
| POST 的 key 位置 | 放 **JSON body** | 207 / 209 |
| 时间格式 | `YYYY-MM-DD HH:mm:ss` | 208 / 216 |
| 6.1 里程的时间 | 只到日期 `YYYY-MM-DD`，且参数名 `Starttime`/`Endtime` | 207 / 212 |
| terid 形态 | 3.x/4.x/5.x/13.x/14.x 传**数组**；7.2/8.x/9.1 传**字符串** | 207 / 213 |
| chl 形态 | 8.x 用 `1,2,3,4`；9.1 用 `[1,2,3,4]` | 207 / 208 |

**回复要点**：把「文档里该接口的参数清单」原文抄给客户（摘自 `api_reference.md`），让他逐项对；**不要**只说「参数错了」。

---

## 场景 4：查不到数据（212）／查不到设备（213）

**客户典型描述**：「接口返回 200 但没有数据 / 说无设备」。

**判定**
- `213` → 终端号不存在或不属于该账号：让客户用 `2.4 GET /api/v1/basic/devices/exist?terid=<终端号>&key=` 验证（`result:false` = 终端号错或超出账号范围）；车牌需先经 `2.3` 转终端号。
- `212` → 条件没命中：先**放大时间范围**、再**换一个已知有数据的终端**对照；`7.2/8.x` 还要核对 `chl` 与 `st`（主/子码流）。

**回复模板（中文）**
```
返回 212 表示「条件内没有查到数据」，通常是查询范围或终端号的问题，不一定是接口故障。麻烦按顺序确认：
1) 用 2.4 接口确认终端号存在：GET /api/v1/basic/devices/exist?terid=<终端号>&key=<key>  → 期望 data.result=true
2) 把查询时间范围放大（例如整天改为前后各一天）再试
3) 换一个您确定有数据/有录像的终端，用同样的参数查一次
如果 1) 就是 false，请核对终端号是否抄错、或该终端是否在您账号的设备范围内。
```

---

## 场景 5：设备离线 / 终端执行失败（401 / 402 / 403 / 400）

**判定与动作**
- `401` → 设备不在线：`5.2 state/now` 查在线列表，`5.3 state/last` 查最后状态；让客户查设备供电、SIM 流量、注册地址与端口。
- `402` → 检索服务忙：降低并发（同一设备避免多路同时拉流/检索），错峰重试。
- `403` → 设备拒绝执行：核对型号/固件是否支持该指令（`11.1` 远程操作需按 N9M 协议组装 `content`）。
- `400` → 录像日历查询失败：先在网页端确认该设备能否回放，再查存储卡。

**English**
```
Error 401 means the terminal is offline. Please use GET /api/v1/basic/state/now (online list) and /api/v1/basic/state/last (last status) to verify, and check the device power, SIM data plan and the registration server address.
Error 402 means the terminal retrieval service is busy - please reduce concurrency (avoid multiple simultaneous live/record requests to the same device) and retry later.
Error 403 means the device rejected the command - please confirm the device model/firmware supports this operation.
```

---

## 场景 6：实时视频 / 历史录像（7.x / 8.x）

**排查顺序**
1. `7.1 GET /api/v1/basic/live/port` 拿视频端口（`port`），不要自行猜端口。
2. `7.2 GET /api/v1/basic/live/video` 参数：`terid`（字符串）、`chl`、`audio`、`st`（0 主/1 子码流）、`port`；**MDVR 传 `dt=MDVR`，N9M 不传 `dt`**。
3. 历史录像：先 `8.1 record/calendar?starttime=YYYY-MM-DD`（该日期所在月）看有没有录像 → 再 `8.2 record/filelist`（时间必须 `YYYY-MM-DD HH:mm:ss`，`chl` 逗号分隔）→ 再 `8.3 record/video`（get 流地址）。
4. 拉不到流时区分：`401` 设备离线 / `402` 忙 / 返回 `url` 但播不了（端口未放通、播放器不支持 flv/hls、`st` 选错码流）。

**English**
```
Please obtain the video port via GET /api/v1/basic/live/port first, then call /api/v1/basic/live/video with terid, chl, st and port.
Note: dt=MDVR is required for MDVR devices and must be omitted for N9M devices.
For recorded video, the flow is: /api/v1/basic/record/calendar -> /record/filelist -> /record/video.
If the API returns a stream URL but playback fails, please check whether the video port is reachable from your network and whether your player supports the returned protocol (flv / hls).
```

---

## 场景 7：录像下载任务（9.1 – 9.5）

**排查顺序**
1. `9.1 POST /record/task` 建任务：`name` ≤ 15 字符；`chl` 是**数组**；`tasktype=0`（黑盒）时 `starttime/endtime` **必须早于今天**；返回 `taskid`。
2. `9.2 POST /record/taskstate` 查进度：`state` 码 —— `-2` 磁盘不足、`-5` 连接数受限、`4` 任务失败、`6` 下载失败、`8` 任务过期、`3` 完成。
3. `9.3 GET /record/taskfilelist?taskid=&tasktype=` 列文件（`tasktype` 不传默认查录像）。
4. `9.4 GET /record/download?dir=<base64>&name=` 下载到本地（**`dir` 是 base64 编码的服务器路径**，直接取 9.3 返回的 `dir`）。

**常见误用**：拿 9.3 的 `dir` 解成明文路径后自己再编码一次（双重编码）→ `215/404`；任务未到 `state=3` 就去 9.4 取文件 → `215`。

---

## 场景 8：证据中心（2.6.3 是 15.x / 2.6.8 是 14.x）

**先对编号**（路径两版一致，只是章节号变了）：

| 功能 | 2.6.3 | 2.6.8 |
|---|---|---|
| 数量 / 明细 | 15.1 / 15.2 | 14.1 / 14.2 |
| 图片 / 详情 / 视频 / 打包 / 服务器 / 关联轨迹 | 15.3 / 15.4 / 15.5 / 15.6 / 15.7 / 15.8 | 14.3 / 14.4 / 14.5 / 14.6 / 14.7 / 14.8 |

**排查顺序**
1. `evidence-center/count` / `evidence-center/list`：`type` 传 `[]` 查全部告警类型；**分页 `page`/`count`**；`list` **必须带上一轮返回的 `context`**。
2. 拿到 `eid` 后再调图片 / 详情 / 视频列表 / 关联轨迹。
3. `filepack` 打包**需要 `serverip`**（可用 `evidenceserverinfo` 查证据存储服务器别名与 IP）。
4. 查不到证据时先确认：该时间段**是否真有告警**；告警类型是否被 `type` 过滤掉；证据是否已被清理。
5. 2.6.8 另有 **18.x 证据策略**（查询 / 保存 / 删除），策略没配会导致某些告警不产生证据 —— 新版客诉「为什么没有证据」要先看这里。

**English**
```
For the Evidence Center, please query with /api/v1/basic/evidence-center/count or /list first (use type: [] to include all alarm types).
Note: in v2.6.3 the Evidence Center chapter is 15.x, in v2.6.8 it is 14.x (paths are unchanged).
For /list, page and count control paging, and the context value returned by the previous response MUST be passed in the next request.
Images/details/videos require an eid obtained from the search results, and file packaging (/filepack) also needs the evidence server IP (see /evidenceserverinfo).
On v2.6.8, please also check the evidence strategy (chapter 18.x) - if no strategy is configured, some alarms will not generate evidence at all.
```

---

## 场景 9：实时数据订阅（10.1 socket.io）

- 连接 `http://{HOST}:{PORT}`（socket.io 长连接，**不是** `/api/...` REST 路径），带 `key`。
- `didArray` 传**空数组 = 全量订阅**；`alarmType` 可选。
- 事件名：`sub_state`（在线/离线/告警状态）、`sub_gps`、`sub_alarm`、`sub_mileage`。
- 常见失败：走了 REST 端口/路径、key 过期（`204`）后没重连、网络中间设备掐长连接（需心跳重连）、浏览器混合内容（https 页面连 http 的 socket 会被拦）。

---

## 场景 10：浏览器跨域 / 混合内容

- 客户在**网页前端**直接调 http 接口，浏览器会因同源策略拦截 → 建议改为**后端调用**；或使用 jsonp（回调名统一 `callback`）；或用服务端自带的 `http://{HOST}:{PORT}/h5demo/index.html` 验证接口本身是否正常。
- https 页面上调 http 接口会被浏览器当作混合内容拦截：同样走服务端中转。

**English**
```
If the API is called directly from a browser page, the same-origin policy may block the request. Please call the API from your backend server, or use JSONP (the callback name is "callback"), or test with the demo page http://{HOST}:{PORT}/h5demo/index.html to prove the API itself works.
```

---

## 场景 11：升级/换服务器后突然不好用

**要问**：升级**前**与**后**的 CMS 版本号（本技能覆盖 **2.6.3 / 2.6.8**）、是否迁移过服务器或数据库、是否改过账号权限。
**判定**：先比版本，再看权限。从 2.6.3 升到 2.6.8 时，下面这几处**必然要改客户端代码**（详见 `version_diff.md`）：

| 变化 | 老代码（2.6.3） | 新版要改成 |
|---|---|---|
| 取 key | `GET /api/v1/basic/key?username=&password=` | `POST /api/v1/basic/key` + JSON body（否则 201/207/405） |
| 远程控制 | `/api/v1/basic/device/protocol` + `content` | `/api/v1/basic/remote/control` + `channel`/`type`/`speed`/`psp`（旧路径 404） |
| 设备列表通道数 | 返回 `channel` | 返回 `channelcount`（另加 `cname`） |
| 证据中心章节 | 15.x | 14.x（路径不变，文档编号变） |
| User Log | `12.1/12.2` | 新版**整章删除**，调用会 404 |

其他仍以现场服务器的 `help/api` 文档为准；账号/数据迁移后常见 `203`（权限）/`205`（账号过期）/`213`（设备不在该账号范围）。

**English**
```
When the CMS server is upgraded from v2.6.3 to v2.6.8, please review these breaking changes on the client side:
1) Login/key: the endpoint changed from GET with query parameters to POST with a JSON body {"username","password"}.
2) Remote control: /api/v1/basic/device/protocol + content was replaced by /api/v1/basic/remote/control with channel/type/speed/psp.
3) Device list: the returned channel count field was renamed from "channel" to "channelcount" (and "cname" was added).
4) Evidence Center: chapter numbers moved from 15.x to 14.x (paths are unchanged).
5) User Log interfaces (old 12.1/12.2) were removed in v2.6.8.
After an account/data migration, 203 (no permission), 205 (account expired) and 213 (device out of account scope) are common.
```
