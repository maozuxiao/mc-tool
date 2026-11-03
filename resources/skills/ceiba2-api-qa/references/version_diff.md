# Ceiba2 / WCMS5 API 2.6.3 → 2.6.8 差异对照

> 用途：客户只知道「服务器版本」而说不清「哪个接口」时，用本表判断他说的接口在新版是否还在、编号变了没有、参数是否要改。
> 口径：只比对 `2.6.3/api_reference.md`（44 个接口）与 `2.6.8/api_reference.md`（64 个接口）的**路径 / 方式 / 请求参数名 / 返回字段名**，逐条机械比对；措辞差异不算变更。
> 结论先行：**拿 key 的方式变了（2.6.8 改 POST）**、**User Log 章节删除**、**12~15 章整体位移且换了内容**、**新增 27 个接口**。

## 一、必须先知道的 5 件事

| # | 变更 | 2.6.3 | 2.6.8 | 排查影响 |
|---|------|-------|-------|----------|
| 1 | **验证接口改 POST** | `GET /api/v1/basic/key?username=&password=` | `POST /api/v1/basic/key`，body 里放 `username` / `password`，可加 `auth`（替代凭据）或 `rsapublickey`（RSA 加密密码，公钥从 `/help/rsapublickey` 下载） | 客户照老文档拼 GET query 会拿到参数错误/401，这是新版最高频的「连不上」原因 |
| 2 | **User Log 章节删除** | `12.1` 操作日志、`12.2` 登录日志 | 两个接口都没了 | 客户问「怎么上报操作/登录日志」，直接答新版无此接口 |
| 3 | **12~15 章位移换内容** | 12=User Log、13=客流、14=人脸、15=证据中心 | 12=客流、13=人脸、14=证据中心、15=刷卡 | **章节号不能跨版本复用**，一律按接口名/路径确认后再回答 |
| 4 | **远程控制接口换路径换参数** | `11.1 /api/v1/basic/device/protocol`，参数 `content` | `11.1 /api/v1/basic/remote/control`，参数 `channel` / `type` / `speed` / `psp`（命令类型见 Appendix 4） | 老代码调新版必失败（路径 404） |
| 5 | **设备列表字段更名** | 返回 `channel` | 返回 `channelcount`（另补 `cname` 通道名） | 客户说「取不到通道数」，先核对字段名 |

## 二、新增接口（27 个）

| 编号 | 接口 | 路径 |
|------|------|------|
| 2.7 | Add vehicle group | `/api/v1/basic/group/create` |
| 2.8 | Delete vehicle group | `/api/v1/basic/group/delete` |
| 2.9 | Add vehicle | `/api/v1/basic/vehicle/create` |
| 2.10 | Delete vehicle | `/api/v1/basic/vehicle/delete` |
| 8.4 | 历史流 FLV 地址（设备侧）[n9m] | `/api/v1/basic/record/flv/video` |
| 8.5 | 历史流 FLV 地址（服务端/中心存储） | `/api/v1/basic/server/video` |
| 8.6 | Pause FLV stream | `/api/v1/basic/flv/pause` |
| 8.7 | Resume FLV stream | `/api/v1/basic/flv/resume` |
| 8.8 | Seek FLV stream | `/api/v1/basic/flv/seek` |
| 8.9 | Stop FLV stream | `/api/v1/basic/flv/stop` |
| 9.6 | 下载任务列表 | `/api/v1/basic/record/taskList` |
| 11.2 | 设备配置页地址 | `/api/v1/basic/device/configline` |
| 11.3 | 设备 TTS 播报 | `/api/v1/basic/device/tts` |
| 13.2 | 人脸比对记录明细 | `/api/v1/basic/face/comparison/listdetail` |
| 14.3 | 证据指定图片信息 | `/api/v1/basic/evidence-center/picture/list` |
| 14.4 | 证据详情 | `/api/v1/basic/evidence-center/detail` |
| 14.5 | 证据视频列表 | `/api/v1/basic/evidence-center/video/list` |
| 14.6 | 生成证据文件（打包） | `/api/v1/basic/evidence-center/filepack` |
| 14.7 | 查询证据服务器信息 | `/api/v1/basic/evidence-center/evidenceserverinfo` |
| 14.8 | 证据关联报警轨迹 | `/api/v1/basic/evidence-center/relatedgpsalarm` |
| 17.1 | 查询 IO 输出状态 | `/api/v1/basic/io/get` |
| 17.2 | 设置 IO 输出状态 | `/api/v1/basic/io/set` |
| 18.1 | 查询证据策略 | `/api/v1/basic/alarm/strategy/config` |
| 18.2 | 保存证据策略 | `/api/v1/basic/alarm/strategy/save` |
| 18.3 | 删除证据策略 | `/api/v1/basic/alarm/strategy/delete` |
| 19.1 | 查询 ACC 明细 | `/api/v1/basic/acc` |
| 20.1 | 网络抓拍 | `/api/v1/basic/remotepic` |

> 注意 14.x 是**证据中心**（不是人脸），8.4~8.9 是一整套 **FLV 流控**（拿到流地址后要配合 pause/resume/seek/stop，单看 8.4 会以为没有控制手段）。

## 三、删除接口（2 个）

| 编号 | 接口 | 路径 | 说明 |
|------|------|------|------|
| 12.1（旧） | Add user operation log | `/api/v1/basic/logs/opt` | 整章 User Log 在 2.6.8 删除；新版 12.1 已被客流明细占用 |
| 12.2（旧） | Add user login log | `/api/v1/basic/logs/login` | 同上 |

> 其余「2.6.3 有、2.6.8 无」的编号（`15.3`~`15.8`）不是删除，而是证据中心整组从 15.x 前移到 14.x，见下节位移表。

## 四、编号位移（同接口、不同编号）

| 接口 | 2.6.3 | 2.6.8 | 路径是否变化 |
|------|-------|-------|--------------|
| 客流明细 | 13.1 | **12.1** | 不变（`/passenger-count/detail`） |
| 人脸比对记录数 | 14.1 | **13.1** | 不变（`/face/comparison/count`） |
| 人脸比对明细 | 14.2 | **13.2** | 不变（`/face/comparison/listdetail`） |
| 证据清单数量 | 15.1 | **14.1** | 不变（`/evidence-center/count`） |
| 证据清单明细 | 15.2 | **14.2** | 不变（`/evidence-center/list`） |
| 证据图片/详情/视频/打包/服务器/轨迹 | 15.3~15.8 | **14.3~14.8** | 不变（`/evidence-center/*`） |
| 刷卡明细 / 刷卡数量 | 无 | **15.1 / 15.2** | `/swipelog/detail`、`/swipelog/count` |

> 判断口诀：**看接口名与路径，不看编号**。2.6.3 客户说「15.3 报错」，在 2.6.8 里对应的是 14.3。

## 五、同名接口的真实变更

### 5.1 请求参数变化

| 编号 | 接口 | 变化 |
|------|------|------|
| 1.1 | Verification Interface | `GET` → `POST`；新增 `auth`（替代登录凭据）、`rsapublickey`（RSA 公钥，可选）；`username`/`password` 从 query 移入 body |
| 7.2 | 实时流地址（FLV 方式）[cms/n9m] | 地址示例去掉了 `&dt=mdvr`（`dt` 参数在新版清单里不再出现，仍传多数情况兼容，但不要当作必需） |
| 8.1 | 历史视频月历 | 新增 `pbt`（录像回放类型，可选，默认 0） |
| 8.2 | 历史视频文件列表 | 新增 `pbt`（同上） |
| 9.1 | 添加录像下载任务 | 新增 `stream`（码流选择）；`chl` 仍为整型数组 |
| 11.1 | 远程控制（在线终端） | 路径 `device/protocol` → `remote/control`；`content` 移除，改为 `channel` / `type` / `speed` / `psp` |

### 5.2 返回字段变化

| 编号 | 接口 | 变化 |
|------|------|------|
| 2.2 | 设备列表 | `channel` → **`channelcount`**（通道数）；新增 `cname`（通道名，逗号分隔） |
| 2.6 | 地图 key | 新增 `BMapKey`（百度地图 key），与 `GMapKey` 并列 |
| 10.1 | 实时数据订阅（socket.io） | 文档补全了 gps 子字段（`name` / `cardid` / `lat` / `lng` / `ls` / `ct`），接口本身未变 |
| 11.1 | 远程控制 | 返回由 `data` 改为 **`result`（bool）** |

### 5.3 未变但容易踩的点

- `1.1` 之后**所有接口照旧** `key` 必带（GET 放 query、POST 放 body）。
- 时间格式仍为 `YYYY-MM-DD HH:mm:ss`（`6.1` 里程仍是 `YYYY-MM-DD` 且参数名首字母大写）。
- `chl` 在 8.x 是逗号字符串、在 `9.1` 是整型数组 —— 两版一致。
- `dir`（服务器文件路径）仍是 base64（`9.4` / `16.1` / `16.2`）。
- 分页参数仍是 `page` / `count`（`page=-1` 表示不分页）。

## 六、按版本给结论的话术

- 客户是 **2.6.8**：不要引用 User Log 接口；拿 key 一律 POST；远程控制用 `/remote/control` + `type` 命令码；证据中心在 14.x；有 FLV 流控与 TTS、IO、ACC 等能力。
- 客户是 **2.6.3**：拿 key 是 GET query；远程控制是 `device/protocol` + `content` 报文；证据中心在 15.x；没有人脸 13.2、没有车辆增删、没有 FLV 流控。
- 客户**没说版本**：先按「接口名/路径」对齐，再问一句服务器版本；回答里明确标注「以下结论适用于 vX」，两版行为不同处并列写出。
