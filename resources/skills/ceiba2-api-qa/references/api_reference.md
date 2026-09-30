# Ceiba2 / WCMS5 API 接口索引（自动生成）

> 来源：Ceiba2 / WCMS5 服务端自带 API 文档（`CMS Server\WCMS5\root\public\help\api`，版本 **2.6.3**），由用户于 2026-09-30 导入本技能。原文为英文，此文件保持原样未翻译（便于对照客户/研发用的术语）。

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

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/key?username=admin&password=admin`
- **方式**：`GET`
- **请求参数**：username:username；password:password
- **返回字段**：data:data result；key:[string]verify key；errorcode:error code
- **原文位置**：`api_full.md` L90

### 2.1 Get vehicle group information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/groups?key=123aaeq3jjkljrqweoiu`
- **方式**：`GET`
- **请求参数**：key:[string]verify key
- **返回字段**：data:[]data array；groupid:[int]group ID；groupname:[string]group name；groupfatherid:[int]The parent group ID；errorcode:error code
- **原文位置**：`api_full.md` L126

### 2.2 Get device list

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/devices?key=123aaeq3jjkljrqweoiu`
- **方式**：`GET`
- **请求参数**：key:[string]verify key
- **返回字段**：data:[]data array；carlicence:[int]License plate number；terid:[string] device serial number；sim:[int]Mobile phone number；platecolor:[string]The license plate color；channel:[int]Channel；cname:[string]Channel name, comma-separated；groupid:[int]set of cars ID；devicetype:[int]Device type.1：MDVR，4：N9M；linktype:[int]Connection type；deviceusername:[string]Device login user name；devicepassword:[int]Device login password；registerip:[string]Register server IP；registerport:[int]Register server port；transmitip:[string]Forwarding server IP；transmitport:[int]Forwarding server port；en:[int]Channel enable. -1 represents all channel permissions. The digits need to be converted to binary, and the low to high bits represent the permissions of the corresponding channel respectively；errorcode:error code
- **原文位置**：`api_full.md` L165

### 2.3 Plate number and Serial Number conversion

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/devices/A12456?key=123aaeq3jjkljrqweoiu`
- **方式**：`GET`
- **请求参数**：key:[string]verify key；AA12456:car licence(part of url)
- **返回字段**：data:[]data array；terid:[string] device serial number；errorcode:error code
- **原文位置**：`api_full.md` L230

### 2.4 Query the terminal number to see if it exists

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/devices/exist?terid=asdfwer&key=123aaeq3jjkljrqweoiu`
- **方式**：`GET`
- **请求参数**：key:[string]verify key；terid:[string] device serial number
- **返回字段**：data:[]data array；result:[bool]True means yes, false means no；errorcode:error code
- **原文位置**：`api_full.md` L264

### 2.5 Query the user rights

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/authority?key=asdfwer`
- **方式**：`GET`
- **请求参数**：key:[string]verify key
- **返回字段**：data:authority numbergroup；k:[int]permissions ID；v:[int]Permission values. 0: no permission, 1: yes；errorcode:error code
- **原文位置**：`api_full.md` L298

### 2.6 Query Google maps key

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/mapkey?key=token`
- **方式**：`GET`
- **请求参数**：key:[string]verify key
- **返回字段**：result:[json]JSON object；GMapKey:google map key；errorcode:error code
- **原文位置**：`api_full.md` L335

### 3.1 Get GPS statistics information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/gps/count`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] The terminal number ID array；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- **返回字段**：data:[]data array；terid:[string] device serial number；date:[string]date(yyyy-MM-dd)；count:[int]count；errorcode:error code
- **原文位置**：`api_full.md` L370

### 3.2 Get GPS detail information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/gps/detail`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] The terminal number ID；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- **返回字段**：data:[]data array；altitude:[int] altitude；direction:[int] directi；gpslat:[string] latitude；gpslng:[string] longitude；gpstime:[string]GPS time (yyyy-MM-dd HH:mm:ss)；speed:[int] speed；recordspeed:[int] Tachograph speed；state:[int]Status, temporarily unavailable；Terid:[array] device ID；time:[string]Server time(yyyy-MM-dd HH:mm:ss)；errorcode:error code
- **原文位置**：`api_full.md` L423

### 3.3 Get the last GPS position information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/gps/last`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] The terminal number ID array
- **返回字段**：data:[]data array；altitude:[int] altitude；direction:[int] directi；gpslat:[string] latitude；gpslng:[string] longitude；gpstime:[string]GPS time (yyyy-MM-dd HH:mm:ss)；speed:[int] speed；recordspeed:[int] Tachograph speed；state:[int]Status, temporarily unavailable；Terid:[array] device ID；time:[string]Server time(yyyy-MM-dd HH:mm:ss)；errorcode:error code
- **原文位置**：`api_full.md` L488

### 3.4 Get the GPS calendar information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/gps/day`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] device serial number；year:[int]year；month:[int]month
- **返回字段**：data:[]date array；errorcode:error code
- **原文位置**：`api_full.md` L551

### 4.1 Get The Alarm Statistics Information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/alarm/count`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] The terminal number ID array；type:[int] Alarm type；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- **返回字段**：data:[]data array；terid:[string] device serial number；date:[string]date(yyyy-MM-dd)；count:[int]count；errorcode:error code
- **原文位置**：`api_full.md` L598

### 4.2 Get alarm detail information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/alarm/detail`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] The terminal number ID array；alarmtype:[[int]] Alarm type ID array, empty for all alarm types；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- **返回字段**：data:[]data array；altitude:[int] altitude；direction:[int] directi；gpslat:[string] latitude；gpslng:[string] longitude；gpstime:[string]GPS time (yyyy-MM-dd HH:mm:ss)；speed:[int] speed；recordspeed:[int] Tachograph speed；state:[int]Status, temporarily unavailable；Terid:[array] device ID；time:[string]Server time(yyyy-MM-dd HH:mm:ss)；type:[int] Alarm type；content:Alarm content；cmdtype:[int]Alarm state 2: alarm, 1: alarm relief；errorcode:error code
- **原文位置**：`api_full.md` L653

### 5.1 Device Status Data Interface

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/state/log`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] The terminal number ID array；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- **返回字段**：data:[]data array；terid:[string] device serial number；time:[string]state time(yyyy-MM-dd HH:mm:ss)；type:[int]Status 0: offline, 1: online；errorcode:error code
- **原文位置**：`api_full.md` L732

### 5.2 Get device online/offline information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/state/now`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] The terminal number ID array
- **返回字段**：data:[]data array；terid:[string]Online terminal number；errorcode:error code
- **原文位置**：`api_full.md` L785

### 5.3 Get device final status information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/state/last`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] The terminal number ID array
- **返回字段**：data:[]data array；terid:[string] device serial number；time:[string]state time(yyyy-MM-dd HH:mm:ss)；errorcode:error code
- **原文位置**：`api_full.md` L830

### 6.1 Get terminal mileage statistics

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/mileage/count`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] The terminal number ID array；Starttime:[string]start time,the format YYYY-MM-dd；Endtime:[string]end time,the format YYYY-MM-dd
- **返回字段**：data:[]data array；terid:[string] device serial number；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；mileage:[string]mileage；errorcode:error code
- **原文位置**：`api_full.md` L879

### 7.1 Get video port information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/live/port?key=123aaeq3jjkljrqweoiu`
- **方式**：`GET`
- **请求参数**：key:[string]verify key
- **返回字段**：data:[]Number of sets of port data；port:[int]port；errorcode:error code
- **原文位置**：`api_full.md` L936

### 7.2 Get video stream address address (flv way)[cms/n9m]

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/live/video?key=123aaeq3jjkljrqweoiu&terid=00830007CB&chl=1&audio=1&st=0&port=12060&dt=mdvr`
- **方式**：`GET`
- **请求参数**：key:[string]verify key；terid:[string] device serial number；chl:[int]Channel；audio:[int]Audio 0: none,1: yes；st:[int]Codestream type 0: main codestream,1: sub codestream；port:[int]Video port；dt:[string]Device type, optional parameter,n9m device is not transmitted, MDVR device is transmitted dt=MDVR
- **返回字段**：data:Video address；url:[string]address；errorcode:error code
- **原文位置**：`api_full.md` L974

### 8.1 Get history video monthly calendar information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/record/calendar?key=123aaeq3jjkljrqweoiu&terid=00830007CB&starttime=2017-01-01&st=1`
- **方式**：`GET`
- **请求参数**：key:[string]verify key；terid:[string] device serial number；starttime:[string]Start time (the month of this time is the query month)；st:[string]Codestream type 0-sub stream; 1-main stream
- **返回字段**：data:[]data array；date:[string]date(yyyy-MM-dd)；filetype:[int]File type. 1 -- normal recording; 2 -- alarm recording；errorcode:error code
- **原文位置**：`api_full.md` L1015

### 8.2 Get the historical video file information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/record/filelist?key=123aaeq3jjkljrqweoiu&terid=00830007CB&starttime=2017-01-01 00:00:00&endtime=2017-01-01 23:59:59&chl=1,2,3,4&st=1`
- **方式**：`GET`
- **请求参数**：key:[string]verify key；terid:[string] device serial number；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；chl:[string]Channel id(multiple, split)；st:[string]Codestream type 0-sub stream; 1-main stream
- **返回字段**：data:[]data array；name:[string]file name；chn:[int]Channel number；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；filetype:[int]File type. 1 -- normal recording; 2 -- alarm recording；errorcode:error code
- **原文位置**：`api_full.md` L1055

### 8.3 Get historical video stream information (HlS way)[n9m]

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/record/video?key=123aaeq3jjkljrqweoiu&terid=00830007CB&starttime=2017-06-19 15:20:56&endtime=2017-06-19 16:20:22&chl=1&st=1`
- **方式**：`GET`
- **请求参数**：key:[string]verify key；terid:[string] device serial number；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；chl:[string]Channel id(multiple, split)；st:[string]Codestream type 0-sub stream; 1-main stream
- **返回字段**：data:Video address；url:[string]address；errorcode:error code
- **原文位置**：`api_full.md` L1103

### 9.1 Add Video Download Task

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/record/task`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] device serial number；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；chl:[[int]]Array of channel id Numbers；name:[string]Task name (15 characters)；effective:[int] effective days；netmode:[int] Network mode(1:LAN, 2:WIFI, 3:WIFI and LAN, 4:4G, 7:All modes, All modes when this field is empty or does not exist)；tasktype：[int] Task type(0:Black box , 1:Video recording , 2:All types ,Note that the starttime and endtime passed when tasktype is 0 must be less than today's date)
- **返回字段**：data:response result；taskid:[int]task ID；errorcode:error code
- **原文位置**：`api_full.md` L1143

### 9.2 Get the video download task status

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/record/taskstate`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；parms:[]Parameter set array；taskid:[int]task ID；date:[string]Date of the task
- **返回字段**：data:[]data array；percent:[int]percentage；state:[int]Status (-6 pause -5 limited number of connections - in 4 resolution -3 not completed -2 insufficient disk space -1 waiting for 0 resolution to complete 1 downloading 2 no video files 3 task completed 4 task failed 5 deletion 6 download failed 8 task expired)；taskid:[int]task ID；errorcode:error code
- **原文位置**：`api_full.md` L1203

### 9.3 Get the completed task video files list

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/record/taskfilelist?key=123aaeq3jjkljrqweoiu&taskid=1&tasktype=1`
- **方式**：`GET`
- **请求参数**：key:[string]verify key；taskid:[int]task ID；tasktype：[int] Task type(0:Black box , 1:Video recording , 2:All types ,Note that if this value is not passed, the video recording will be queried by default)
- **返回字段**：data:[]data array；name:[string]file name；dir:[string]directory；errorcode:error code
- **原文位置**：`api_full.md` L1257

### 9.4 Download the recording file to the local

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/record/download?key=123aaeq3jjkljrqweoiu&dir=QzpcVmlkZW9ccXExMjM0XDIwMTctMDYtMTlccmVjb3JkXDE=&name=qq1234-170619-000000-002000-01p401000000.264`
- **方式**：`GET`
- **请求参数**：key:[string]verify key；name:[string]file name；dir:[string]directory
- **返回字段**：[stream]
- **原文位置**：`api_full.md` L1300

### 9.5 Delete recording download task

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/record/task`
- **方式**：`DELETE`
- **请求参数**：key:[string]verify key；parms:[]task array；taskid:[int]task ID
- **返回字段**：data:response data；result:Operating results；errorcode:error code
- **原文位置**：`api_full.md` L1328

### 10.1 Realtime Data Subscription (Based onsocket.io)

- **路径**：`http://{HOST}:{PORT}`
- **方式**：`websocket`
- **请求参数**：key:[string]verify key；didArray:[]A null terminal array is a full subscription；alarmType:[]Array of alarm type ID
- **返回字段**：deviceno:terminal ID；state:Online 1, offline 0, alarm 2；carlicence:[int]License plate number；groupName:Organizational structure；gpslat:[string] latitude；gpslng:[string] longitude；speed:[int] speed；direction:[int] directi；dataTime:Report the time；type:[int] Alarm type；content:Alarm content；mileage:[string]mileage；acc:Switch state
- **原文位置**：`api_full.md` L1376

### 11.1 Terminal interface [online terminal]

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/device/protocol`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[string] device serial number；content:[string]Content string, actually referring to the N9M document
- **返回字段**：data:The contents of the json string are actually referenced to the N9M document；errorcode:error code
- **原文位置**：`api_full.md` L1491

### 12.1 Add user operation log

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/logs/opt`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；Data:[array] operation log list；terid:[string] equipment ID；time:[string] Operation time, format YYYY-MM-dd HH:mm:ss；type:[string] Operation type；msg:[string] Operating content；Source:[int] source, 1:web, 2:CB2,3:app
- **返回字段**：data:[json]update result；result:[bool] Results: true: success, false: failure；errorcode:[int]error code
- **原文位置**：`api_full.md` L1533

### 12.2 Add user login log

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/logs/login`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；Ip:[string]client IPaddress；Source:[int] source, 1:web, 2:CB2,3:app；Content:[string] version number；Time:[json] login time；Type:[int] login type, 0: exit, 1: login
- **返回字段**：data:[json]update result；result:[bool] Results: true: success, false: failure；errorcode:[int]error code
- **原文位置**：`api_full.md` L1587

### 13.1 Query passenger flow detail

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/passenger-count/detail`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；Terid:[array] device ID；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；Door:[string] car door name, the value is empty when the query is all
- **返回字段**：data:[json]update result；closetime:[string] closing time；opentime:[string] Open time；Door:[string] car door name, the value is empty when the query is all；off:[int] Out of the car number；on:[int] Get on the bus number；sitename:[string] The site name；terid:[string] equipment ID；time:[string] time；errorcode:[int]error code
- **原文位置**：`api_full.md` L1638

### 14.1 Query face comparison record number

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/face/comparison/count`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；Terid:[array] device ID；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；trigger:[int] -1: All, 0: card comparison, 1: inspection comparison, 2: ignition comparison, 3: departure return comparison；status:[int] -1: All, 0: comparison passed, 1: comparison failed, 2: timeout, 3: no function enabled, 4: connection abnormal, 5: no driver picture, 6: terminal face database is empty, 7: Not necessarily right
- **返回字段**：data:[json]update result；count:[int]count；errorcode:[int]error code
- **原文位置**：`api_full.md` L1706

### 14.2 Query face comparison record list details

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/face/comparison/listdetail`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；Terid:[array] device ID；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；trigger:[int] -1: All, 0: card comparison, 1: inspection comparison, 2: ignition comparison, 3: departure return comparison；status:[int] -1: All, 0: comparison passed, 1: comparison failed, 2: timeout, 3: no function enabled, 4: connection abnormal, 5: no driver picture, 6: terminal face database is empty, 7: Not necessarily right；page:[int] The number of pages, indicating the first few pages. -1 means no paging, return all results；count:[int] The number of pages per page. When the page is -1, it does not take effect.
- **返回字段**：data:[json]update result；capturetime:[string] Capture time；comparisonresult:[int] -1: All, 0: comparison passed, 1: comparison failed, 2: timeout, 3: no function enabled, 4: connection abnormal, 5: no driver picture, 6: terminal face database is empty, 7: Not necessarily right；comparisontime:[string] Comparison time；drivernumber:[string] Driver number；faceindex:[string] Capture face index；faceuuid:[string] Capture the face uuid；name:[string] The driver name；parentfleet:[string] Car group；plate:[string] License plate；trigger:[int] -1: All, 0: card comparison, 1: inspection comparison, 2: ignition comparison, 3: departure return comparison；data:[json] Face information result；faceid:[string] Face id；terid:[string] equipment ID；similarity:[double] Similarity (percentage)；errorcode:[int]error code
- **原文位置**：`api_full.md` L1758

### 15.1 Evidence Search List Number Query

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/evidence-center/count`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[[string]] Device ID；type:[[int]] Array of alarm types, [] check all alarm types；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；keytype:[int] Keyword type:-1 keyword does not take effect, 0 driver, 1 license plate, 2 evidence name；keyword:[string] Keyword value
- **返回字段**：data:response result；total:[int] Total；errorcode:[int]error code
- **原文位置**：`api_full.md` L1848

### 15.2 Evidence Search List Detail Query

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/evidence-center/list`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；terid:[[string]] Device ID；type:[[int]] Array of alarm types, [] check all alarm types；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；keytype:[int] Keyword type:-1 keyword does not take effect, 0 driver, 1 license plate, 2 evidence name；keyword:[string] Keyword value；page:[int] Number of pages, indicating the first few pages. -1 means no paging, return all results；count:[int] The number of pages per page.；context:[string] The context information returned from the last query can be empty for the first query. Note: The content returned in each query may change, that is, each query must use the context field returned by the previous query
- **返回字段**：data:response result；eid:[string] Evidence ID；ename:[string] Evidence Name；alarmid:[string] Alarm ID；alarmtype:[int] Alarm Type；alarmlevel:[int] Alarm Level；terid:[[string]] Device ID；vehicle:[string] Carlicense；drivername:[string] Driver Name；driverphone:[string] Driver Phone；driverImg:[string]Driver Image Path(base64 encoding)；driverlicense:[string] Driver License；time:[string] Evidence Time；createtime:[string] Evidence Create Time；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；gpslng:[double] Longitude；gpslat:[double] Latitude；address:[string] Evidence Address；size:[double] Evidence Size(in MB)；sec:[int] Evidence Length(seconds)；pic:[int] Cover image path (base64 encoding)；evidencestatus:[int] Evidence status 0:evidence completed,1: Evidence failure1,2: Queuing,3: Downloading,4: Download completed,5: Transcoding；evidencestatusmsg:[string] Evidence status description；evidenceservername:[string] Evidence file storage server alias；direction:[int] directi；desc:[string] Describe the evidence；errorcode:[int]error code；context:[string] Context information generated by this query
- **原文位置**：`api_full.md` L1903

### 15.3 Get Specified Evidence Image Information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/evidence-center/picture/list`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；eid:[string] Evidence ID
- **返回字段**：data:response result；path:[int] Cover image path (base64 encoding)；channel:[int]Channel；errorcode:[int]error code
- **原文位置**：`api_full.md` L2018

### 15.4 Get Specified Evidence Details

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/evidence-center/detail`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；eid:[[string]] Evidence ID
- **返回字段**：data:response result；eid:[string] Evidence ID；size:[double] Evidence Size(in MB)；terid:[[string]] Device ID；groupname:[string]groupname；carlicense:[string] Carlicense；platecolor:[int]License plate color, default 1 (1: blue 2: yellow 3: black 4: white 5: green)；alarmtype:[int] Alarm Type；speed:[double]Speed；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；lat:[double] latitude；lng:[double] longitude；position:[string]Position Information；drivername:[string] Driver Name；driverphone:[string] Driver Phone；driverlicense:[string] Driver License；driverImg:[string]Driver Image Path(base64 encoding)；handleusername:[string]The name of user who handled the driver；handletime:[string]Handle Time；handlemethod:[int]Handle Method；handlecontent:[string]Handle Content；evidencestatus:[int] Evidence status 0:evidence completed,1: Evidence failure1,2: Queuing,3: Downloading,4: Download completed,5: Transcoding；evidencestatusmsg:[string] Evidence status description；errorcode:[int]error code
- **原文位置**：`api_full.md` L2063

### 15.5 Get a List of Specified Evidence Videos

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/evidence-center/video/list`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；eid:[string] Evidence ID；type:[int]Video type, 0:264, 1:mp4 (default mp4)
- **返回字段**：data:response result；channel:[int]Channel；video:[array string]Video information；starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss；endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss；path:[string]Video Path；errorcode:[int]error code
- **原文位置**：`api_full.md` L2152

### 15.6 Generate evidence file

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/evidence-center/filepack`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；serverip:[string]Server IP；eid:[string] Evidence ID
- **返回字段**：data:response result；path:[string]Evidence compressed file path (base64 encoding)；errorcode:[int]error code
- **原文位置**：`api_full.md` L2208

### 15.7 Query serer information

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/evidence-center/evidenceserverinfo`
- **方式**：`POST`
- **请求参数**：key:[string]verify key
- **返回字段**：data:response result；servername:[string] Evidence file storage server alias；serverip:[string]Server IP；wcms5port:[int]React service port；errorcode:[int]error code
- **原文位置**：`api_full.md` L2251

### 15.8 Evidence alarm track

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/evidence-center/relatedgpsalarm`
- **方式**：`POST`
- **请求参数**：key:[string]verify key；eid:[string] Evidence ID
- **返回字段**：errorcode:[int]error code；errorcase:[string]Error description；result:response result；relatedGpsLong:[string]GPS information within 1 hour before and after the alarm: multiple GPS, separated by';'；relatedGpsShort:[string]GPS information within 5 minutes before and after the alarm: multiple GPSs, separated by ';'；relatedAlarm:response result；lat:[double] latitude；lng:[double] longitude；uuid:[string]Uniquely identifies；time:[string]Alarm time；alarmtype:[int] Alarm Type；loc:[string]Alarm location；isCurrent:[int]Whether it is an alarm of current evidence
- **原文位置**：`api_full.md` L2297

### 16.1 Image Preview and Video Playback

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/mediafile/view?key=123&dir=QzpcVmlkZVjb3JkXDE=`
- **方式**：`GET`
- **请求参数**：key:[string]verify key；dir:[string] Video Path/Image path (base64 encoding),video only supports mp4 format
- **返回字段**：Image, video stream data
- **原文位置**：`api_full.md` L2363

### 16.2 File Download

- **路径**：`http://{HOST}:{PORT}/api/v1/basic/absolute/dwnfile?key=123&dir=QzpcVmlkZjb3JkXDE=`
- **方式**：`GET`
- **请求参数**：key:[string]verify key；dir:[string]File in the server save path (base64 encoding)
- **返回字段**：File stream data
- **原文位置**：`api_full.md` L2388
