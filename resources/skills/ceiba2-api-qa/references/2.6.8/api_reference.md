# Ceiba2 / WCMS5 API 接口索引（自动生成 · v2.6.8）

> 来源：Ceiba2 / WCMS5 服务端 API 文档（`help/api`，版本 **2.6.8**），由用户于 2026-11-03 导入本技能。原文为英文，此文件保持原样未翻译（便于对照客户/研发用的术语）。

> **版本警示（必读）**：本文件只描述 **v2.6.8**，章节号仅在本版本内有效。2.6.3 的 `12.1/12.2` 是 User Log（本版已整章删除），因此 12~15 章整体换了内容：本版 `12.x`=客流、`13.x`=人脸、`14.x`=证据中心、`15.x`=刷卡。**不要**把 2.6.3 的章节号套到本版，也不要拿本版的 14.x 去回答 2.6.3 客户的问题（那是人脸比对）。两版增删对照见 `../version_diff.md`。

> 本文件按接口逐条列出：**路径 / 请求方式 / 请求参数 / 返回字段 / 原文注意事项**。
> 用来「客户说某个接口报错」时快速核对参数名、类型、格式；完整示例与字段解释见 `api_full.md`。
> 每个条目标注了在原文里的行号（`L1234`），需要看原始 JSON 示例时按行号去 `api_full.md` 查。

## 全局约定（所有接口通用）

- 地址：`http://{HOST}:{PORT}/api/v1/basic/...`（`{HOST}:{PORT}` 是 CMS 服务器地址，例 `192.168.1.10:12056`）。
- 编码：UTF-8；交互格式 JSON；除特别说明外都支持 jsonp，回调名统一为 `callback`。
- `GET`：参数放 query，中文/特殊字符需 URL encode。
- `POST`：`Content-Type: application/json`，参数放 **JSON body**（body 里也要带 `key`）。
- 鉴权：先调 `1.1 验证接口` 拿 `key`，之后**每个请求**都要带 `key`。
- 时间格式：绝大多数接口为 `YYYY-MM-DD HH:mm:ss`；**6.1 里程** 用 `YYYY-MM-DD`（且参数名首字母大写 `Starttime`/`Endtime`）。
- 终端号：`terid`；有的接口收**数组**，有的收**单个字符串**（见各接口）。
- 通道号：`chl` 在 8.x 是**逗号分隔字符串**（`chl=1,2,3,4`），在 9.1 是**整型数组**（`[1,2,3,4]`）。
- 服务器上的文件路径参数（`dir`）是 **base64 编码**（9.4 / 16.1 / 16.2）。

## 接口清单

### 1.1 Verification Interface

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/key`
- **方式**：`POST`
- **请求参数**：username:username；password:password；auth:[string]Authentication credentials. When this field is used, it serves as an alternative login credential；rsapublickey:RSA public key used to encrypt the login password (optional). The public key file `rsapublickey.pem` can be downloaded from `http://{HOST}:{PORT}/help/rsapublickey`
- **返回字段**：data:data result；key:[string]verify key；errorcode:error code
- **原文位置**：`api_full.md` L115

### 2.1 Get vehicle group information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/groups?key=123aaeq3jjkljrqweoiu`
- **方式**：`GET`
- **请求参数**：key:[string]verify key
- **返回字段**：data:[]data array；groupid:[int]group ID；groupname:[string]group name；groupfatherid:[int]The parent group ID；errorcode:error code
- **原文位置**：`api_full.md` L161

### 2.2 Get device list

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/devices?key=123aaeq3jjkljrqweoiu`
- **方式**：`GET`
- **请求参数**：key:[string]verify key
- **返回字段**：data:[]data array；carlicence:[int]License plate number；terid:[string] device serial number；sim:[int]Mobile phone number；platecolor:[string]The license plate color；channelcount:[int]The number of channels；cname:[string]Channel name, comma-separated；groupid:[int]set of cars ID；devicetype:[int]Device type.1：MDVR，4：N9M；linktype:[int]Connection type；deviceusername:[string]Device login user name；devicepassword:[int]Device login password；registerip:[string]Register server IP；registerport:[int]Register server port；transmitip:[string]Forwarding server IP；transmitport:[int]Forwarding server port；en:[int]Channel enable. -1 represents all channel permissions. The digits need to be converted to binary, and the low to high bits represent the permissions of the corresponding channel respectively；errorcode:error code
- **原文位置**：`api_full.md` L200

### 2.3 Plate number and Serial Number conversion

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/devices/A12456?key=123aaeq3jjkljrqweoiu`
- **方式**：`GET`
- **请求参数**：key:[string]verify key；AA12456:car licence(part of url)
- **返回字段**：data:[]data array；terid:[string] device serial number；errorcode:error code
- **原文位置**：`api_full.md` L265

### 2.4 Query the terminal number to see if it exists

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/devices/exist?terid=asdfwer&key=123aaeq3jjkljrqweoiu`
- **方式**：`GET`
- **请求参数**：key:[string]verify key；terid:[string] device serial number
- **返回字段**：data:[]data array；result:[bool]True means yes, false means no；errorcode:error code
- **原文位置**：`api_full.md` L299

### 2.5 Query the user rights

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/authority?key=asdfwer`
- **方式**：`GET`
- **请求参数**：key:[string]verify key
- **返回字段**：data:authority numbergroup；k:[int]permissions ID；v:[int]Permission values. 0: no permission, 1: yes；errorcode:error code
- **原文位置**：`api_full.md` L333

### 2.6 Query Google maps key

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/mapkey?key=token`
- **方式**：`GET`
- **请求参数**：key:[string]verify key
- **返回字段**：result:[json]JSON object；GMapKey:google map key；BMapKey:baidu map key；errorcode:error code
- **原文位置**：`api_full.md` L370

### 2.7 Add vehicle group

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/group/create`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；groupNames:[[string]]Array of vehicle group names to be created；pname:[string]Name of the parent vehicle group under which the new groups are created；remark:[string]Remark information
- **返回字段**：result:[bool]result，True: success, false: failure；errorcode:[int]error code
- **原文位置**：`api_full.md` L405

### 2.8 Delete vehicle group

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/group/delete`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；name:[[string]]Array of vehicle group names to be deleted
- **返回字段**：result:[bool]result，True: success, false: failure；errorcode:[int]error code
- **原文位置**：`api_full.md` L450

### 2.9 Add vehicle

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/vehicle/create`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；carlicense:[string] Carlicense；deviceno:[string]device serial number；groupName:Organizational structure；channel:[int]The number of channels；platecolor:[int]License plate color, default 1 (1: blue 2: yellow 3: black 4: white 5: green)；type:[int]Device type.1：MDVR，4：N9M
- **返回字段**：result:[bool]result，True: success, false: failure；errorcode:[int]error code
- **原文位置**：`api_full.md` L491

### 2.10 Delete vehicle

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/vehicle/delete`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；carlicense:[string] Carlicense
- **返回字段**：result:[bool]result，True: success, false: failure；errorcode:[int]error code
- **原文位置**：`api_full.md` L539

### 3.1 Get GPS statistics information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/gps/count`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] The terminal number ID array；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- **返回字段**：data:[]data array；terid:[string] device serial number；date:[string]date(yyyy-MM-dd)；count:[int]count；errorcode:error code
- **原文位置**：`api_full.md` L579

### 3.2 Get GPS detail information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/gps/detail`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] The terminal number ID；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- **返回字段**：data:[]data array；altitude:[int] altitude；direction:[int] directi；gpslat:[string] latitude；gpslng:[string] longitude；gpstime:[string]GPS time (yyyy-MM-dd HH:mm:ss)；speed:[int] speed；recordspeed:[int] Tachograph speed；state:[int]Status, temporarily unavailable；Terid:[array] device ID；time:[string]Server time(yyyy-MM-dd HH:mm:ss)；errorcode:error code
- **原文位置**：`api_full.md` L632

### 3.3 Get the last GPS position information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/gps/last`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] The terminal number ID array
- **返回字段**：data:[]data array；altitude:[int] altitude；direction:[int] directi；gpslat:[string] latitude；gpslng:[string] longitude；gpstime:[string]GPS time (yyyy-MM-dd HH:mm:ss)；speed:[int] speed；recordspeed:[int] Tachograph speed；state:[int]Status, temporarily unavailable；Terid:[array] device ID；time:[string]Server time(yyyy-MM-dd HH:mm:ss)；errorcode:error code
- **原文位置**：`api_full.md` L697

### 3.4 Get the GPS calendar information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/gps/day`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] device serial number；year:[int]year；month:[int]month
- **返回字段**：data:[]date array；errorcode:error code
- **原文位置**：`api_full.md` L760

### 4.1 Get The Alarm Statistics Information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/alarm/count`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] The terminal number ID array；type:[int] Alarm type；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- **返回字段**：data:[]data array；terid:[string] device serial number；date:[string]date(yyyy-MM-dd)；count:[int]count；errorcode:error code
- **原文位置**：`api_full.md` L807

### 4.2 Get alarm detail information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/alarm/detail`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] The terminal number ID array；alarmtype:[[int]] Alarm type ID array, empty for all alarm types；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- **返回字段**：data:[]data array；altitude:[int] altitude；direction:[int] directi；gpslat:[string] latitude；gpslng:[string] longitude；gpstime:[string]GPS time (yyyy-MM-dd HH:mm:ss)；speed:[int] speed；recordspeed:[int] Tachograph speed；state:[int]Status, temporarily unavailable；Terid:[array] device ID；time:[string]Server time(yyyy-MM-dd HH:mm:ss)；type:[int] Alarm type；content:Alarm content；cmdtype:[int]Alarm state 2: alarm, 1: alarm relief；errorcode:error code
- **原文位置**：`api_full.md` L862

### 5.1 Device Status Data Interface

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/state/log`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] The terminal number ID array；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- **返回字段**：data:[]data array；terid:[string] device serial number；time:[string]state time(yyyy-MM-dd HH:mm:ss)；type:[int]Status 0: offline, 1: online；errorcode:error code
- **原文位置**：`api_full.md` L941

### 5.2 Get device online/offline information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/state/now`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] The terminal number ID array
- **返回字段**：data:[]data array；terid:[string]Online terminal number；errorcode:error code
- **原文位置**：`api_full.md` L994

### 5.3 Get device final status information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/state/last`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] The terminal number ID array
- **返回字段**：data:[]data array；terid:[string] device serial number；time:[string]state time(yyyy-MM-dd HH:mm:ss)；errorcode:error code
- **原文位置**：`api_full.md` L1039

### 6.1 Get terminal mileage statistics

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/mileage/count`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] The terminal number ID array；Starttime:[string]start time,the format YYYY-MM-dd；Endtime:[string]end time,the format YYYY-MM-dd
- **返回字段**：data:[]data array；terid:[string] device serial number；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；mileage:[string]mileage；errorcode:error code
- **原文位置**：`api_full.md` L1088

### 7.1 Get video port information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/live/port?key=123aaeq3jjkljrqweoiu`
- **方式**：`GET`
- **请求参数**：key:[string]verify key
- **返回字段**：data:[]Number of sets of port data；port:[int]port；errorcode:error code
- **原文位置**：`api_full.md` L1145

### 7.2 Get video stream address (flv way)[cms/n9m]

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/live/video?key=123aaeq3jjkljrqweoiu&terid=00830007CB&chl=1&audio=1&st=0&port=12060`
- **方式**：`GET`
- **请求参数**：key:[string]verify key；terid:[string] device serial number；chl:[int]Channel；audio:[int]Audio 0: none,1: yes；st:[int]Codestream type 0: main codestream,1: sub codestream；port:[int]Video port；dt:[string]Device type, optional parameter,n9m device is not transmitted, MDVR device is transmitted dt=MDVR
- **返回字段**：data:Video address；url:[string]address；errorcode:error code
- **原文位置**：`api_full.md` L1183

### 8.1 Get history video monthly calendar information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/record/calendar?key=123aaeq3jjkljrqweoiu&terid=00830007CB&starttime=2017-01-01&st=1&pbt=1`
- **方式**：`GET`
- **请求参数**：key:[string]verify key；terid:[string] device serial number；starttime:[string]Start time (the month of this time is the query month)；st:[string]Codestream type 0-sub stream; 1-main stream；pbt:[int]Record playback type (optional parameter, default 0)
- **返回字段**：data:[]data array；date:[string]date(yyyy-MM-dd)；filetype:[int]File type. 1 -- normal recording; 2 -- alarm recording；errorcode:error code
- **原文位置**：`api_full.md` L1224

### 8.2 Get the historical video file information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/record/filelist?key=123aaeq3jjkljrqweoiu&terid=00830007CB&starttime=2017-01-01 00:00:00&endtime=2017-01-01 23:59:59&chl=1,2,3,4&st=1&pbt=1`
- **方式**：`GET`
- **请求参数**：key:[string]verify key；terid:[string] device serial number；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；chl:[string]Channel id(multiple, split)；st:[string]Codestream type 0-sub stream; 1-main stream；pbt:[int]Record playback type (optional parameter, default 0)
- **返回字段**：data:[]data array；name:[string]file name；chn:[int]Channel number；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；filetype:[int]File type. 1 -- normal recording; 2 -- alarm recording；errorcode:error code
- **原文位置**：`api_full.md` L1265

### 8.3 Get historical video stream information (HlS way)[n9m]

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/record/video?key=123aaeq3jjkljrqweoiu&terid=00830007CB&starttime=2017-06-19 15:20:56&endtime=2017-06-19 16:20:22&chl=1&st=1`
- **方式**：`GET`
- **请求参数**：key:[string]verify key；terid:[string] device serial number；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；chl:[string]Channel id(multiple, split)；st:[string]Codestream type 0-sub stream; 1-main stream
- **返回字段**：data:Video address；url:[string]address；errorcode:error code
- **原文位置**：`api_full.md` L1314

### 8.4 Get historical video stream information (FLV way)[n9m]

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/record/flv/video?key=123aaeq3jjkljrqweoiu&terid=00830007CB&starttime=2023-09-27 15:20:56&chl=1&st=0`
- **方式**：`GET`
- **请求参数**：key:[string]verify key；terid:[string] device serial number；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss (playback starts from this time, no endtime)；chl:[string]Channel id(multiple, split)；st:[string]Codestream type 0-sub stream; 1-main stream
- **返回字段**：data:[]data array；url:[string]address；sn:[string]Stream ID (GUID). Used as the parameter of the FLV pause / resume / seek / stop interfaces (8.6 ~ 8.9)；errorcode:error code
- **原文位置**：`api_full.md` L1352

### 8.5 Get server historical video stream information (FLV way)

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/server/video?key=123aaeq3jjkljrqweoiu&terid=00830007CB&starttime=2023-09-27 15:20:56&chl=1`
- **方式**：`GET`
- **请求参数**：key:[string]verify key；terid:[string] device serial number；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss (playback starts from this time)；chl:[string]Channel id(multiple, split)
- **返回字段**：data:[]data array；url:[string]address；sn:[string]Stream ID (GUID). Used as the parameter of the FLV pause / resume / seek / stop interfaces (8.6 ~ 8.9)；errorcode:error code
- **原文位置**：`api_full.md` L1393

### 8.6 Pause FLV stream

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/flv/pause`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；sn:[string]Stream ID
- **返回字段**：errorcode:[int]error code
- **原文位置**：`api_full.md` L1433

### 8.7 Resume FLV stream

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/flv/resume`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；sn:[string]Stream ID
- **返回字段**：errorcode:[int]error code
- **原文位置**：`api_full.md` L1471

### 8.8 Seek FLV stream

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/flv/seek`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；sn:[string]Stream ID；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss
- **返回字段**：errorcode:[int]error code
- **原文位置**：`api_full.md` L1509

### 8.9 Stop FLV stream

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/flv/stop`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；sn:[string]Stream ID
- **返回字段**：errorcode:[int]error code
- **原文位置**：`api_full.md` L1549

### 9.1 Add Video Download Task

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/record/task`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] device serial number；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；chl:[[int]]Array of channel id Numbers；name:[string]Task name (15 characters)；effective:[int] effective days；netmode:[int] Network mode(1:LAN, 2:WIFI, 3:WIFI and LAN, 4:4G, 7:All modes, All modes when this field is empty or does not exist)；tasktype：[int] Task type(0:Black box , 1:Video recording , 2:All types ,Note that the starttime and endtime passed when tasktype is 0 must be less than today's date)；stream:[int]Video stream type, 0: sub stream, 1: main stream
- **返回字段**：data:response result；taskid:[int]task ID；errorcode:error code
- **原文位置**：`api_full.md` L1589

### 9.2 Get the video download task status

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/record/taskstate`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；parms:[]Parameter set array；taskid:[int]task ID；date:[string]Date of the task
- **返回字段**：data:[]data array；percent:[int]percentage；state:[int]Status (-6 pause -5 limited number of connections - in 4 resolution -3 not completed -2 insufficient disk space -1 waiting for 0 resolution to complete 1 downloading 2 no video files 3 task completed 4 task failed 5 deletion 6 download failed 8 task expired)；taskid:[int]task ID；errorcode:error code
- **原文位置**：`api_full.md` L1651

### 9.3 Get the completed task video files list

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/record/taskfilelist?key=123aaeq3jjkljrqweoiu&taskid=1&tasktype=1`
- **方式**：`GET`
- **请求参数**：key:[string]verify key；taskid:[int]task ID；tasktype：[int] Task type(0:Black box , 1:Video recording , 2:All types ,Note that if this value is not passed, the video recording will be queried by default)
- **返回字段**：data:[]data array；name:[string]file name；dir:[string]directory；errorcode:error code
- **原文位置**：`api_full.md` L1705

### 9.4 Download the recording file to the local

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/record/download?key=123aaeq3jjkljrqweoiu&dir=QzpcVmlkZW9ccXExMjM0XDIwMTctMDYtMTlccmVjb3JkXDE=&name=qq1234-170619-000000-002000-01p401000000.264`
- **方式**：`GET`
- **请求参数**：key:[string]verify key；name:[string]file name；dir:[string]directory
- **返回字段**：[stream]
- **原文位置**：`api_full.md` L1748

### 9.5 Delete recording download task

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/record/task`
- **方式**：`DELETE`
- **请求参数**：key:[string]verify key；parms:[]task array；taskid:[int]task ID
- **返回字段**：data:response data；result:Operating results；errorcode:error code
- **原文位置**：`api_full.md` L1776

### 9.6 Get the video download task list

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/record/taskList`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；id:[int]Vehicle group ID or vehicle ID；nodetype:[int]Node type, 0: vehicle group, 1: vehicle
- **返回字段**：data:response data；total:[int] Total；taskid:[int]task ID；taskname:[string]Task name；device:[string]equipment ID；devicetype:[int]Device type.1：MDVR，4：N9M；status:[int]Task status；startexecute:[string]Execution start date(yyyy-MM-dd)；endexecute:[string]Execution end date(yyyy-MM-dd)；starttime:[string]Daily start time(HH:mm:ss)；date:[string]Specific date of the task (null means daily task)；endtime:[string]Daily end time(HH:mm:ss)；period:[int]Period；tasktype:[int] Task type(0:Black box , 1:Video recording , 2:All types)；taskperiod:[array]Task period；taskchannel:[array]Task channel array；channel:[int]Channel number；taskevent:[array]Task event array；taskio:[array]Task IO array；relation:[string]Related vehicle record ID；carlicense:[string] Carlicense；netmode:[int] Network mode(1:LAN, 2:WIFI, 3:WIFI and LAN, 4:4G, 7:All modes)；effective:[int] effective days；stream:[int]Video stream type, 0: sub stream, 1: main stream；videotype:[int] Recording filetype (1: normal recording, 2: alarm recording)；channelcount:[int]The number of channels；createtime:[string]Task creation time(yyyy-MM-dd HH:mm:ss)；finishtime:[string]Task finish time；updatetime:[string]Task update time；configtime:[string]Task configuration time；highspeed:[string]High-speed related configuration；username:[string]Creator username；errorcode:error code
- **原文位置**：`api_full.md` L1822

### 10.1 Realtime Data Subscription (Based on socket.io)

- **路径**：`http://{HOST}:{PORT}`
- **方式**：`WEBSOCKET`
- **请求参数**：key:[string]verify key；didArray:[]A null terminal array is a full subscription；alarmType:[]Array of alarm type ID
- **返回字段**：deviceno:terminal ID；state:Online 1, offline 0, alarm 2；carlicence:[int]License plate number；groupName:Organizational structure；gpslat:[string] latitude；gpslng:[string] longitude；speed:[int] speed；direction:[int] directi；dataTime:Report the time；type:[int] Alarm type；content:Alarm content；mileage:[string]mileage；acc:Switch state；name:[string] The driver name；cardid:[string]Card ID；lat:[double] latitude；lng:[double] longitude；ls:[int]Swipe card ride state；ct:[int]Cumulative count of swipe card records
- **原文位置**：`api_full.md` L1950

### 11.1 Remote control interface [online terminal]
> **版本差异**：本版由 Terminal interface 更名为 Remote control interface，路径与参数不变。

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/remote/control`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] device serial number；channel:[int]Control channel；type:[int]Remote control command type, see [Appendix 4: Remote Control (PTZ) Command Type](#appendix-4-remote-control-ptz-command-type)；speed:[int]Control speed, only valid for some command types (see Appendix 4)；psp:[int]Pan/preset related parameter, only valid for some command types (see Appendix 4)
- **返回字段**：result:[bool]result，True: success, false: failure；errorcode:[int]error code
- **原文位置**：`api_full.md` L2087

### 11.2 Get the device configuration page address

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/device/configline`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] device serial number；language:[string]Configuration page language, 0: default
- **返回字段**：data:data result (device configuration page address)；errorcode:error code
- **原文位置**：`api_full.md` L2135

### 11.3 Device TTS

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/device/tts`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] device serial number；time:[int]Play time (seconds), 0: default；flag:[int]Play flag；msg:[string]Text content to play
- **返回字段**：data:data result (true: success)；errorcode:error code
- **原文位置**：`api_full.md` L2175

### 12.1 Query passenger flow detail
> **版本差异**：2.6.3 的 12.1 是 Add user operation log（User Log 章节在 2.6.8 中已整章删除），本版 12.1 改为客流明细。

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/passenger-count/detail`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；Terid:[array] device ID；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；Door:[string] car door name, the value is empty when the query is all
- **返回字段**：data:[json]update result；closetime:[string] closing time；opentime:[string] Open time；Door:[string] car door name, the value is empty when the query is all；off:[int] Out of the car number；on:[int] Get on the bus number；sitename:[string] The site name；terid:[string] equipment ID；time:[string] time；lat:[double] latitude；lng:[double] longitude；errorcode:[int]error code
- **原文位置**：`api_full.md` L2223

### 13.1 Query face comparison record number
> **版本差异**：2.6.3 的 13.1 是 Query passenger flow detail（客流），本版 13.1 改为人脸比对记录数。

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/face/comparison/count`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；Terid:[array] device ID；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；trigger:[int] -1: All, 0: card comparison, 1: inspection comparison, 2: ignition comparison, 3: departure return comparison；status:[int] -1: All, 0: comparison passed, 1: comparison failed, 2: timeout, 3: no function enabled, 4: connection abnormal, 5: no driver picture, 6: terminal face database is empty, 7: Not necessarily right
- **返回字段**：data:[json]update result；count:[int]count；errorcode:[int]error code
- **原文位置**：`api_full.md` L2295

### 13.2 Query face comparison record list details
> **版本差异**：2.6.3 没有人脸比对的第二个接口（该版 14.x 才是人脸），本版 13.2 是人脸比对记录明细。

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/face/comparison/listdetail`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；Terid:[array] device ID；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；trigger:[int] -1: All, 0: card comparison, 1: inspection comparison, 2: ignition comparison, 3: departure return comparison；status:[int] -1: All, 0: comparison passed, 1: comparison failed, 2: timeout, 3: no function enabled, 4: connection abnormal, 5: no driver picture, 6: terminal face database is empty, 7: Not necessarily right；page:[int] The number of pages, indicating the first few pages. -1 means no paging, return all results；count:[int] The number of pages per page. When the page is -1, it does not take effect.
- **返回字段**：data:[json]update result；capturetime:[string] Capture time；comparisonresult:[int] -1: All, 0: comparison passed, 1: comparison failed, 2: timeout, 3: no function enabled, 4: connection abnormal, 5: no driver picture, 6: terminal face database is empty, 7: Not necessarily right；comparisontime:[string] Comparison time；drivernumber:[string] Driver number；faceindex:[string] Capture face index；faceuuid:[string] Capture the face uuid；name:[string] The driver name；parentfleet:[string] Car group；plate:[string] License plate；trigger:[int] -1: All, 0: card comparison, 1: inspection comparison, 2: ignition comparison, 3: departure return comparison；data:[json] Face information result；faceid:[string] Face id；terid:[string] equipment ID；similarity:[double] Similarity (percentage)；errorcode:[int]error code
- **原文位置**：`api_full.md` L2347

### 14.1 Evidence Search List Number Query
> **版本差异**：2.6.3 的 14.x 是人脸比对（14.1 记录数 / 14.2 明细），本版 14.x 才是证据中心。

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/evidence-center/count`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[[string]] Device ID；type:[[int]] Array of alarm types, [] check all alarm types；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；keytype:[int] Keyword type:-1 keyword does not take effect, 0 driver, 1 license plate, 2 evidence name；keyword:[string] Keyword value；timetype:[int]Time type used together with starttime/endtime for filtering
- **返回字段**：data:response result；total:[int] Total；errorcode:[int]error code
- **原文位置**：`api_full.md` L2437

### 14.2 Evidence Search List Detail Query

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/evidence-center/list`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[[string]] Device ID；type:[[int]] Array of alarm types, [] check all alarm types；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；keytype:[int] Keyword type:-1 keyword does not take effect, 0 driver, 1 license plate, 2 evidence name；keyword:[string] Keyword value；page:[int] Number of pages, indicating the first few pages. -1 means no paging, return all results；count:[int] The number of pages per page.；context:[string] The context information returned from the last query can be empty for the first query. Note: The content returned in each query may change, that is, each query must use the context field returned by the previous query；timetype:[int]Time type used together with starttime/endtime for filtering
- **返回字段**：data:response result；eid:[string] Evidence ID；ename:[string] Evidence Name；alarmid:[string] Alarm ID；alarmtype:[int] Alarm Type；alarmlevel:[int] Alarm Level；terid:[[string]] Device ID；vehicle:[string] Carlicense；drivername:[string] Driver Name；driverphone:[string] Driver Phone；driverImg:[string]Driver Image Path(base64 encoding)；driverlicense:[string] Driver License；time:[string] Evidence Time；createtime:[string] Evidence Create Time；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；gpslng:[double] Longitude；gpslat:[double] Latitude；address:[string] Evidence Address；size:[double] Evidence Size(in MB)；sec:[int] Evidence Length(seconds)；pic:[int] Cover image path (base64 encoding)；evidencestatus:[int] Evidence status 0:evidence completed,1: Evidence failure1,2: Queuing,3: Downloading,4: Download completed,5: Transcoding；evidencestatusmsg:[string] Evidence status description；evidenceservername:[string] Evidence file storage server alias；direction:[int] directi；desc:[string] Describe the evidence；errorcode:[int]error code；context:[string] Context information generated by this query
- **原文位置**：`api_full.md` L2494

### 14.3 Get Specified Evidence Image Information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/evidence-center/picture/list`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；eid:[string] Evidence ID
- **返回字段**：data:response result；path:[int] Cover image path (base64 encoding)；channel:[int]Channel；errorcode:[int]error code
- **原文位置**：`api_full.md` L2611

### 14.4 Get Specified Evidence Details

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/evidence-center/detail`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；eid:[[string]] Evidence ID
- **返回字段**：data:response result；eid:[string] Evidence ID；size:[double] Evidence Size(in MB)；terid:[[string]] Device ID；groupname:[string]groupname；carlicense:[string] Carlicense；platecolor:[int]License plate color, default 1 (1: blue 2: yellow 3: black 4: white 5: green)；alarmtype:[int] Alarm Type；speed:[double]Speed；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；lat:[double] latitude；lng:[double] longitude；position:[string]Position Information；drivername:[string] Driver Name；driverphone:[string] Driver Phone；driverlicense:[string] Driver License；driverImg:[string]Driver Image Path(base64 encoding)；handleusername:[string]The name of user who handled the driver；handletime:[string]Handle Time；handlemethod:[int]Handle Method；handlecontent:[string]Handle Content；evidencestatus:[int] Evidence status 0:evidence completed,1: Evidence failure1,2: Queuing,3: Downloading,4: Download completed,5: Transcoding；evidencestatusmsg:[string] Evidence status description；errorcode:[int]error code
- **原文位置**：`api_full.md` L2656

### 14.5 Get a List of Specified Evidence Videos

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/evidence-center/video/list`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；eid:[string] Evidence ID；type:[int]Video type, 0:264, 1:mp4 (default mp4)
- **返回字段**：data:response result；channel:[int]Channel；video:[array string]Video information；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；path:[string]Video Path；errorcode:[int]error code
- **原文位置**：`api_full.md` L2745

### 14.6 Generate evidence file

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/evidence-center/filepack`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；serverip:[string]Server IP；eid:[string] Evidence ID
- **返回字段**：data:response result；path:[string]Evidence compressed file path (base64 encoding)；errorcode:[int]error code
- **原文位置**：`api_full.md` L2801

### 14.7 Query serer information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/evidence-center/evidenceserverinfo`
- **方式**：`POST`
- **请求参数**：key:[string]verify key
- **返回字段**：data:response result；servername:[string] Evidence file storage server alias；serverip:[string]Server IP；wcms5port:[int]React service port；errorcode:[int]error code
- **原文位置**：`api_full.md` L2844

### 14.8 Evidence alarm track

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/evidence-center/relatedgpsalarm`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；eid:[string] Evidence ID
- **返回字段**：errorcode:[int]error code；errorcase:[string]Error description；result:response result；relatedGpsLong:[string]GPS information within 1 hour before and after the alarm: multiple GPS, separated by';'；relatedGpsShort:[string]GPS information within 5 minutes before and after the alarm: multiple GPSs, separated by ';'；relatedAlarm:response result；lat:[double] latitude；lng:[double] longitude；uuid:[string]Uniquely identifies；time:[string]Alarm time；alarmtype:[int] Alarm Type；loc:[string]Alarm location；isCurrent:[int]Whether it is an alarm of current evidence
- **原文位置**：`api_full.md` L2890

### 15.1 Query swipe card detail
> **版本差异**：2.6.3 的 15.x 是证据中心（15.1~15.8），本版 15.x 改为刷卡数据。

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/swipelog/detail`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；Terid:[array] device ID；searchtype:[int]Search type；searchvalue:[string]Search keyword, empty for all；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；page:[int] The number of pages, indicating the first few pages. -1 means no paging, return all results；count:[int] The number of pages per page. When the page is -1, it does not take effect.
- **返回字段**：carlicence:[int]License plate number；groupname:[string]group name；drivername:[string] Driver Name；carid:[string]Vehicle ID；state:[int]Swipe card state；lat:[double] latitude；lng:[double] longitude；time:[string]Swipe card time(yyyy-MM-dd HH:mm:ss)；errorcode:[int]error code
- **原文位置**：`api_full.md` L2956

### 15.2 Query swipe card count

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/swipelog/count`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；Terid:[array] device ID；searchtype:[int]Search type；searchvalue:[string]Search keyword, empty for all；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- **返回字段**：total:[int] Total；errorcode:[int]error code
- **原文位置**：`api_full.md` L3027

### 16.1 Image Preview and Video Playback

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/mediafile/view?key=123&dir=QzpcVmlkZVjb3JkXDE=`
- **方式**：`GET`
- **请求参数**：key:[string]verify key；dir:[string] Video Path/Image path (base64 encoding),video only supports mp4 format
- **返回字段**：Image, video stream data
- **原文位置**：`api_full.md` L3080

### 16.2 File Download

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/absolute/dwnfile?key=123&dir=QzpcVmlkZjb3JkXDE=`
- **方式**：`GET`
- **请求参数**：key:[string]verify key；dir:[string]File in the server save path (base64 encoding)
- **返回字段**：File stream data
- **原文位置**：`api_full.md` L3105

### 17.1 Get IO output status

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/io/get`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；carlicense:[string] Carlicense
- **返回字段**：io:[array]IO output status array ( indexed by IO port, 0/1)；errorcode:[int]error code
- **原文位置**：`api_full.md` L3132

### 17.2 Set IO output status

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/io/set`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；carlicense:[string] Carlicense；io:[array]IO output status array；cm:[array]IO output command array (0: close, 1: open)；ti:[array]Output duration array (seconds), 0: keep state until changed
- **返回字段**：result:[bool]result，True: success, false: failure；errorcode:[int]error code
- **原文位置**：`api_full.md` L3175

### 18.1 Query evidence strategy

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/alarm/strategy/config`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；carlicense:[string] Carlicense
- **返回字段**：data:[]data array；d_mainstream:[int]Whether to record main stream, 0: no, 1: yes；d_substream:[int]Whether to record sub stream, 0: no, 1: yes；d_videochannel:[string]Recording video channels, comma-separated；d_before:[int]Pre-alarm recording time (seconds)；d_after:[int]Post-alarm recording time (seconds)；d_bboxgps:[int]Whether to record GPS information into the black box, 0: no, 1: yes；d_bboxlog:[int]Whether to record logs into the black box, 0: no, 1: yes；d_bboxacc:[int]Whether to record ACC information into the black box, 0: no, 1: yes；d_picchannel:[string]Snapshot picture channels, comma-separated；d_alarminter:[int]Alarm interval (seconds), 0: default；d_alarmeverday:[int]Daily alarm setting, 0: no limit；d_sendemail:[int]Whether to send alarm e-mail；d_emailaddress:[string]Alarm notification e-mail address；alarmtypes:[int]Alarm type ID；errorcode:[int]error code
- **原文位置**：`api_full.md` L3236

### 18.2 Save evidence strategy

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/alarm/strategy/save`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；d_mainstream:[int]Whether to record main stream, 0: no, 1: yes；d_substream:[int]Whether to record sub stream, 0: no, 1: yes；d_videochannel:[string]Recording video channels, comma-separated；d_before:[int]Pre-alarm recording time (seconds)；d_after:[int]Post-alarm recording time (seconds)；d_bboxgps:[int]Whether to record GPS information into the black box, 0: no, 1: yes；d_bboxlog:[int]Whether to record logs into the black box, 0: no, 1: yes；d_bboxacc:[int]Whether to record ACC information into the black box, 0: no, 1: yes；d_picchannel:[string]Snapshot picture channels, comma-separated；d_alarminter:[int]Alarm interval (seconds), 0: default；d_alarmeverday:[int]Daily alarm setting, 0: no limit；d_emailaddress:[string]Alarm notification e-mail address；d_sendemail:[int]Whether to send alarm e-mail；carlicense:[string] Carlicense；alarmid:[string]Alarm type ID
- **返回字段**：result:[bool]result，True: success, false: failure；errorcode:[int]error code
- **原文位置**：`api_full.md` L3305

### 18.3 Delete evidence strategy

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/alarm/strategy/delete`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；carlicense:[string] Carlicense
- **返回字段**：result:[bool]result，True: success, false: failure；errorcode:[int]error code
- **原文位置**：`api_full.md` L3371

### 19.1 Query ACC detail

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/acc`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] The terminal number ID array；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；status:[int]ACC status filter, 0: off, 1: on；page:[int] The number of pages, indicating the first few pages. -1 means no paging, return all results；count:[int] The number of pages per page. When the page is -1, it does not take effect.
- **返回字段**：total:[int] Total；carlicense:[string] Carlicense；terid:[string] device serial number；groupname:[string]group name；time:[string] time；acc:[int]ACC status, 0: off, 1: on；lat:[double] latitude；lng:[double] longitude；errorcode:[int]error code
- **原文位置**：`api_full.md` L3411

### 20.1 Network snapshot

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/remotepic`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] device serial number；channel:[int]Snapshot channel number (starting from 0)
- **返回字段**：terid:[string] device serial number；path:[string]Snapshot picture download address (obtained via [16.2 File Download](#162-file-download))；errorcode:[int]error code
- **原文位置**：`api_full.md` L3483
