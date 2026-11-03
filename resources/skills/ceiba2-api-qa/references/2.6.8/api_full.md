# WCMS5 / Ceiba2 Server API Documentation

> Source: `C:\Users\streamax\Desktop\api.zip` — `help/api` pages (version 2.6.8, see `help/api/default.html`)
>
> `{HOST}:{PORT}` below stands for the server address, e.g. `192.168.1.10:12056`.

## Introduction

All requests should be utf-8 encode.

Support GET/POST request method, the interaction format is json. Except special statements, all support jsonp format call, and the callback name is unified as `"callback"`.

When the request mode is GET, do url encode for the URL part.

When the request mode is POST, the head part of the Http Head should be `content-type:application/json`.

### Authentication

1. Call the [Verification Interface](#11-verification-interface) with `username` / `password` (or `auth`) to obtain a `key` (verify key).
2. Pass that `key` as the `key` parameter on every subsequent call.

## Contents

- [1. Login Verification Interface](#1-login-verification-interface)
  - [1.1 Verification Interface](#11-verification-interface)
- [2. Basic Data Interface](#2-basic-data-interface)
  - [2.1 Get vehicle group information](#21-get-vehicle-group-information)
  - [2.2 Get device list](#22-get-device-list)
  - [2.3 Plate number and Serial Number conversion](#23-plate-number-and-serial-number-conversion)
  - [2.4 Query the terminal number to see if it exists](#24-query-the-terminal-number-to-see-if-it-exists)
  - [2.5 Query the user rights](#25-query-the-user-rights)
  - [2.6 Query Google maps key](#26-query-google-maps-key)
  - [2.7 Add vehicle group](#27-add-vehicle-group)
  - [2.8 Delete vehicle group](#28-delete-vehicle-group)
  - [2.9 Add vehicle](#29-add-vehicle)
  - [2.10 Delete vehicle](#210-delete-vehicle)
- [3. GPS Data Interface](#3-gps-data-interface)
  - [3.1 Get GPS statistics information](#31-get-gps-statistics-information)
  - [3.2 Get GPS detail information](#32-get-gps-detail-information)
  - [3.3 Get the last GPS position information](#33-get-the-last-gps-position-information)
  - [3.4 Get the GPS calendar information](#34-get-the-gps-calendar-information)
- [4. Alarm Data Interface](#4-alarm-data-interface)
  - [4.1 Get The Alarm Statistics Information](#41-get-the-alarm-statistics-information)
  - [4.2 Get alarm detail information](#42-get-alarm-detail-information)
- [5. Device Status Data Interface](#5-device-status-data-interface)
  - [5.1 Device Status Data Interface](#51-device-status-data-interface)
  - [5.2 Get device online/offline information](#52-get-device-onlineoffline-information)
  - [5.3 Get device final status information](#53-get-device-final-status-information)
- [6. Mileage Data Interface](#6-mileage-data-interface)
  - [6.1 Get terminal mileage statistics](#61-get-terminal-mileage-statistics)
- [7. Live Video Interface](#7-live-video-interface)
  - [7.1 Get video port information](#71-get-video-port-information)
  - [7.2 Get video stream address (flv way)[cms/n9m]](#72-get-video-stream-address-flv-waycmsn9m)
- [8. History Video Interface](#8-history-video-interface)
  - [8.1 Get history video monthly calendar information](#81-get-history-video-monthly-calendar-information)
  - [8.2 Get the historical video file information](#82-get-the-historical-video-file-information)
  - [8.3 Get historical video stream information (HlS way)[n9m]](#83-get-historical-video-stream-information-hlswayn9m)
  - [8.4 Get historical video stream information (FLV way)[n9m]](#84-get-historical-video-stream-information-flv-wayn9m)
  - [8.5 Get server historical video stream information (FLV way)](#85-get-server-historical-video-stream-information-flv-way)
  - [8.6 Pause FLV stream](#86-pause-flv-stream)
  - [8.7 Resume FLV stream](#87-resume-flv-stream)
  - [8.8 Seek FLV stream](#88-seek-flv-stream)
  - [8.9 Stop FLV stream](#89-stop-flv-stream)
- [9. Video Download Interface](#9-video-download-interface)
  - [9.1 Add Video Download Task](#91-add-video-download-task)
  - [9.2 Get the video download task status](#92-get-the-video-download-task-status)
  - [9.3 Get the completed task video files list](#93-get-the-completed-task-video-files-list)
  - [9.4 Download the recording file to the local](#94-download-the-recording-file-to-the-local)
  - [9.5 Delete recording download task](#95-delete-recording-download-task)
  - [9.6 Get the video download task list](#96-get-the-video-download-task-list)
- [10. Realtime Data Subscription](#10-realtime-data-subscription)
  - [10.1 Realtime Data Subscription (Based on socket.io)](#101-realtime-data-subscription-based-on-socketio)
- [11. Device remote operation interface](#11-device-remote-operation-interface)
  - [11.1 Remote control interface [online terminal]](#111-remote-control-interface-online-terminal)
  - [11.2 Get the device configuration page address](#112-get-the-device-configuration-page-address)
  - [11.3 Device TTS](#113-device-tts)
- [12. Passenger flow data interface](#12-passenger-flow-data-interface)
  - [12.1 Query passenger flow detail](#121-query-passenger-flow-detail)
- [13. Face comparison interface](#13-face-comparison-interface)
  - [13.1 Query face comparison record number](#131-query-face-comparison-record-number)
  - [13.2 Query face comparison record list details](#132-query-face-comparison-record-list-details)
- [14. Evidence Center Interface](#14-evidence-center-interface)
  - [14.1 Evidence Search List Number Query](#141-evidence-search-list-number-query)
  - [14.2 Evidence Search List Detail Query](#142-evidence-search-list-detail-query)
  - [14.3 Get Specified Evidence Image Information](#143-get-specified-evidence-image-information)
  - [14.4 Get Specified Evidence Details](#144-get-specified-evidence-details)
  - [14.5 Get a List of Specified Evidence Videos](#145-get-a-list-of-specified-evidence-videos)
  - [14.6 Generate evidence file](#146-generate-evidence-file)
  - [14.7 Query serer information](#147-query-serer-information)
  - [14.8 Evidence alarm track](#148-evidence-alarm-track)
- [15. Swipe card data interface](#15-swipe-card-data-interface)
  - [15.1 Query swipe card detail](#151-query-swipe-card-detail)
  - [15.2 Query swipe card count](#152-query-swipe-card-count)
- [16. Universal Interface](#16-universal-interface)
  - [16.1 Image Preview and Video Playback](#161-image-preview-and-video-playback)
  - [16.2 File Download](#162-file-download)
- [17. IO output interface](#17-io-output-interface)
  - [17.1 Get IO output status](#171-get-io-output-status)
  - [17.2 Set IO output status](#172-set-io-output-status)
- [18. Evidence strategy interface](#18-evidence-strategy-interface)
  - [18.1 Query evidence strategy](#181-query-evidence-strategy)
  - [18.2 Save evidence strategy](#182-save-evidence-strategy)
  - [18.3 Delete evidence strategy](#183-delete-evidence-strategy)
- [19. ACC data interface](#19-acc-data-interface)
  - [19.1 Query ACC detail](#191-query-acc-detail)
- [20. Network snapshot interface](#20-network-snapshot-interface)
  - [20.1 Network snapshot](#201-network-snapshot)
- [Appendix 1: Error Code](#appendix-1-error-code)
- [Appendix 2: Alarm Type Code](#appendix-2-alarm-type-code)
- [Appendix 3: Demo](#appendix-3-demo)
- [Appendix 4: Remote Control (PTZ) Command Type](#appendix-4-remote-control-ptz-command-type)

## 1. Login Verification Interface

### 1.1 Verification Interface

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/key
```

**request:** `POST`

**request body:**

```json
{
  "username": "admin",
  "password": "admin",
  "auth": ""
}
```

**parameter description:**

- username:username
- password:password
- auth:[string]Authentication credentials. When this field is used, it serves as an alternative login credential
- rsapublickey:RSA public key used to encrypt the login password (optional). The public key file `rsapublickey.pem` can be downloaded from `http://{HOST}:{PORT}/help/rsapublickey`

**response:**

```json
{
  "data": {
    "key": "123aaeq3jjkljrqweoiu"
  },
  "errorcode": 200
}
```

**response description:**

- data:data result
- key:[string]verify key
- errorcode:error code

## 2. Basic Data Interface

### 2.1 Get vehicle group information

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/groups?key=123aaeq3jjkljrqweoiu
```

**request:** `GET`

**request body:** none

**parameter description:**

- key:[string]verify key

**response:**

```json
{
  "data": [
    {
      "groupid": 1,
      "groupname": "BusOneCompany",
      "groupfatherid": 0
    }
  ],
  "errorcode": 200
}
```

**response description:**

- data:[]data array
- groupid:[int]group ID
- groupname:[string]group name
- groupfatherid:[int]The parent group ID
- errorcode:error code

### 2.2 Get device list

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/devices?key=123aaeq3jjkljrqweoiu
```

**request:** `GET`

**request body:** none

**parameter description:**

- key:[string]verify key

**response:**

```json
{
  "data": [
    {
      "carlicense": "AA123456",
      "terid": "AE99873120",
      "sim": "13985672541",
      "channelcount": 4,
      "platecolor": 1,
      "groupid": 1,
      "cname": "",
      "devicetype": "4",
      "linktype": "124",
      "deviceusername": "admin",
      "devicepassword": "admin",
      "registerip": "192.168.1.4",
      "registerport": 5556,
      "transmitip": "192.168.1.4",
      "transmitport": 17891,
      "en": -1
    }
  ],
  "errorcode": 200
}
```

**response description:**

- data:[]data array
- carlicence:[int]License plate number
- terid:[string] device serial number
- sim:[int]Mobile phone number
- platecolor:[string]The license plate color
- channelcount:[int]The number of channels
- cname:[string]Channel name, comma-separated
- groupid:[int]set of cars ID
- devicetype:[int]Device type.1：MDVR，4：N9M
- linktype:[int]Connection type
- deviceusername:[string]Device login user name
- devicepassword:[int]Device login password
- registerip:[string]Register server IP
- registerport:[int]Register server port
- transmitip:[string]Forwarding server IP
- transmitport:[int]Forwarding server port
- en:[int]Channel enable. -1 represents all channel permissions. The digits need to be converted to binary, and the low to high bits represent the permissions of the corresponding channel respectively
- errorcode:error code

### 2.3 Plate number and Serial Number conversion

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/devices/A12456?key=123aaeq3jjkljrqweoiu
```

**request:** `GET`

**request body:** none

**parameter description:**

- key:[string]verify key
- AA12456:car licence(part of url)

**response:**

```json
{
  "data": {
    "terid": "AE99873120"
  },
  "errorcode": 200
}
```

**response description:**

- data:[]data array
- terid:[string] device serial number
- errorcode:error code

### 2.4 Query the terminal number to see if it exists

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/devices/exist?terid=asdfwer&key=123aaeq3jjkljrqweoiu
```

**request:** `GET`

**request body:** none

**parameter description:**

- key:[string]verify key
- terid:[string] device serial number

**response:**

```json
{
  "data": {
    "result": true
  },
  "errorcode": 200
}
```

**response description:**

- data:[]data array
- result:[bool]True means yes, false means no
- errorcode:error code

### 2.5 Query the user rights

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/authority?key=asdfwer
```

**request:** `GET`

**request body:** none

**parameter description:**

- key:[string]verify key

**response:**

```json
{
  "data": [
    {
      "k": "301-1",
      "v": 1
    }
  ],
  "errorcode": 200
}
```

**response description:**

- data:authority numbergroup
- k:[int]permissions ID
- v:[int]Permission values. 0: no permission, 1: yes
- errorcode:error code

### 2.6 Query Google maps key

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/mapkey?key=token
```

**request:** `GET`

**request body:** none

**parameter description:**

- key:[string]verify key

**response:**

```json
{
  "result": {
    "GMapKey": "xxx",
    "BMapKey": "zzz"
  },
  "errorcode": 200
}
```

**response description:**

- result:[json]JSON object
- GMapKey:google map key
- BMapKey:baidu map key
- errorcode:error code

### 2.7 Add vehicle group

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/group/create
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "groupNames": [
    "first",
    "second"
  ],
  "pname": "center",
  "remark": "aaa"
}
```

**parameter description:**

- key:[string]verify key
- groupNames:[[string]]Array of vehicle group names to be created
- pname:[string]Name of the parent vehicle group under which the new groups are created
- remark:[string]Remark information

**response:**

```json
{
  "errorcode": 200,
  "result": true
}
```

**response description:**

- result:[bool]result，True: success, false: failure
- errorcode:[int]error code

### 2.8 Delete vehicle group

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/group/delete
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "name": [
    "first",
    "second"
  ]
}
```

**parameter description:**

- key:[string]verify key
- name:[[string]]Array of vehicle group names to be deleted

**response:**

```json
{
  "errorcode": 200,
  "result": true
}
```

**response description:**

- result:[bool]result，True: success, false: failure
- errorcode:[int]error code

### 2.9 Add vehicle

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/vehicle/create
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "carlicense": "AA123456",
  "deviceno": "AE99873120",
  "groupName": "center",
  "channel": 4,
  "platecolor": 4,
  "type": 4
}
```

**parameter description:**

- key:[string]verify key
- carlicense:[string] Carlicense
- deviceno:[string]device serial number
- groupName:Organizational structure
- channel:[int]The number of channels
- platecolor:[int]License plate color, default 1 (1: blue 2: yellow 3: black 4: white 5: green)
- type:[int]Device type.1：MDVR，4：N9M

**response:**

```json
{
  "errorcode": 200,
  "result": true
}
```

**response description:**

- result:[bool]result，True: success, false: failure
- errorcode:[int]error code

### 2.10 Delete vehicle

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/vehicle/delete
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "carlicense": "AA123456"
}
```

**parameter description:**

- key:[string]verify key
- carlicense:[string] Carlicense

**response:**

```json
{
  "errorcode": 200,
  "result": true
}
```

**response description:**

- result:[bool]result，True: success, false: failure
- errorcode:[int]error code

## 3. GPS Data Interface

### 3.1 Get GPS statistics information

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/gps/count
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "terid": [
    "AE99873120"
  ],
  "starttime": "2017-06-19 00:00:00",
  "endtime": "2017-06-19 23:59:59"
}
```

**parameter description:**

- key:[string]verify key
- terid:[string] The terminal number ID array
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss
- endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss

**response:**

```json
{
  "data": [
    {
      "terid": "AE99873120",
      "date": "2017-06-19",
      "count": 5687
    }
  ],
  "errorcode": 200
}
```

**response description:**

- data:[]data array
- terid:[string] device serial number
- date:[string]date(yyyy-MM-dd)
- count:[int]count
- errorcode:error code

### 3.2 Get GPS detail information

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/gps/detail
```

**request:** `POST`

**request body:**

```json
{
  "terid": "AE99873120",
  "key": "123aaeq3jjkljrqweoiu",
  "starttime": "2017-06-19 00:00:00",
  "endtime": "2017-06-19 23:59:59"
}
```

**parameter description:**

- key:[string]verify key
- terid:[string] The terminal number ID
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss
- endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss

**response:**

```json
{
  "data": [
    {
      "terid": "AE99873120",
      "gpstime": "2017-06-19 00:00:00",
      "altitude": 600,
      "direction": 45,
      "gpslat": "23.654123",
      "gpslng": "108.432143",
      "speed": 80,
      "recordspeed": 0,
      "state": 0,
      "time": "2017-06-19 00:00:00"
    }
  ],
  "errorcode": 200
}
```

**response description:**

- data:[]data array
- altitude:[int] altitude
- direction:[int] directi
- gpslat:[string] latitude
- gpslng:[string] longitude
- gpstime:[string]GPS time (yyyy-MM-dd HH:mm:ss)
- speed:[int] speed
- recordspeed:[int] Tachograph speed
- state:[int]Status, temporarily unavailable
- Terid:[array] device ID
- time:[string]Server time(yyyy-MM-dd HH:mm:ss)
- errorcode:error code

### 3.3 Get the last GPS position information

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/gps/last
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "terid": [
    "AE99873120"
  ]
}
```

**parameter description:**

- key:[string]verify key
- terid:[string] The terminal number ID array

**response:**

```json
{
  "data": [
    {
      "terid": "AE99873120",
      "gpstime": "2017-06-19 00:00:00",
      "altitude": 600,
      "direction": 45,
      "gpslat": "23.654123",
      "gpslng": "108.432143",
      "speed": 80,
      "recordspeed": 0,
      "state": 0,
      "time": "2017-06-19 00:00:00"
    }
  ],
  "errorcode": 200
}
```

**response description:**

- data:[]data array
- altitude:[int] altitude
- direction:[int] directi
- gpslat:[string] latitude
- gpslng:[string] longitude
- gpstime:[string]GPS time (yyyy-MM-dd HH:mm:ss)
- speed:[int] speed
- recordspeed:[int] Tachograph speed
- state:[int]Status, temporarily unavailable
- Terid:[array] device ID
- time:[string]Server time(yyyy-MM-dd HH:mm:ss)
- errorcode:error code

### 3.4 Get the GPS calendar information

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/gps/day
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "terid": "AE99873120",
  "year": 2018,
  "month": 2
}
```

**parameter description:**

- key:[string]verify key
- terid:[string] device serial number
- year:[int]year
- month:[int]month

**response:**

```json
{
  "data": [
    "2018-02-01",
    "2018-02-05"
  ],
  "errorcode": 200
}
```

**response description:**

- data:[]date array
- errorcode:error code

## 4. Alarm Data Interface

### 4.1 Get The Alarm Statistics Information

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/alarm/count
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "terid": [
    "AE99873120"
  ],
  "type": 4,
  "starttime": "2017-06-19 00:00:00",
  "endtime": "2017-06-19 23:59:59"
}
```

**parameter description:**

- key:[string]verify key
- terid:[string] The terminal number ID array
- type:[int] Alarm type
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss
- endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss

**response:**

```json
{
  "data": [
    {
      "terid": "AE99873120",
      "date": "2017-06-19",
      "count": 5687
    }
  ],
  "errorcode": 200
}
```

**response description:**

- data:[]data array
- terid:[string] device serial number
- date:[string]date(yyyy-MM-dd)
- count:[int]count
- errorcode:error code

### 4.2 Get alarm detail information

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/alarm/detail
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "terid": [
    "AE99873120"
  ],
  "type": [
    4
  ],
  "starttime": "2017-06-19 00:00:00",
  "endtime": "2017-06-20 00:00:00"
}
```

**parameter description:**

- key:[string]verify key
- terid:[string] The terminal number ID array
- alarmtype:[[int]] Alarm type ID array, empty for all alarm types
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss
- endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss

**response:**

```json
{
  "data": [
    {
      "terid": "AE99873120",
      "gpstime": "2017-06-19 00:00:00",
      "altitude": 600,
      "direction": 45,
      "gpslat": "23.654123",
      "gpslng": "108.432143",
      "speed": 80,
      "recordspeed": 0,
      "state": 0,
      "time": "2017-06-19 00:00:00",
      "type": 4,
      "content": "IO alarm",
      "cmdtype": 2
    }
  ],
  "errorcode": 200
}
```

**response description:**

- data:[]data array
- altitude:[int] altitude
- direction:[int] directi
- gpslat:[string] latitude
- gpslng:[string] longitude
- gpstime:[string]GPS time (yyyy-MM-dd HH:mm:ss)
- speed:[int] speed
- recordspeed:[int] Tachograph speed
- state:[int]Status, temporarily unavailable
- Terid:[array] device ID
- time:[string]Server time(yyyy-MM-dd HH:mm:ss)
- type:[int] Alarm type
- content:Alarm content
- cmdtype:[int]Alarm state 2: alarm, 1: alarm relief
- errorcode:error code

## 5. Device Status Data Interface

### 5.1 Device Status Data Interface

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/state/log
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "terid": [
    "AE99873120"
  ],
  "starttime": "2017-06-19 00:00:00",
  "endtime": "2017-06-19 23:59:59"
}
```

**parameter description:**

- key:[string]verify key
- terid:[string] The terminal number ID array
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss
- endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss

**response:**

```json
{
  "data": [
    {
      "terid": "AE99873120",
      "time": "2017-06-19 00:23:59",
      "type": 1
    }
  ],
  "errorcode": 200
}
```

**response description:**

- data:[]data array
- terid:[string] device serial number
- time:[string]state time(yyyy-MM-dd HH:mm:ss)
- type:[int]Status 0: offline, 1: online
- errorcode:error code

### 5.2 Get device online/offline information

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/state/now
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "terid": [
    "AE99873120"
  ]
}
```

**parameter description:**

- key:[string]verify key
- terid:[string] The terminal number ID array

**response:**

```json
{
  "data": [
    {
      "terid": "AE99873120"
    }
  ],
  "errorcode": 200
}
```

**response description:**

- data:[]data array
- terid:[string]Online terminal number
- errorcode:error code

### 5.3 Get device final status information

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/state/last
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "terid": [
    "AE99873120"
  ]
}
```

**parameter description:**

- key:[string]verify key
- terid:[string] The terminal number ID array

**response:**

```json
{
  "data": [
    {
      "terid": "AE99873120",
      "time": "2016-07-16 23:56:57"
    }
  ],
  "errorcode": 200
}
```

**response description:**

- data:[]data array
- terid:[string] device serial number
- time:[string]state time(yyyy-MM-dd HH:mm:ss)
- errorcode:error code

## 6. Mileage Data Interface

### 6.1 Get terminal mileage statistics

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/mileage/count
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "terid": [
    "AE99873120"
  ],
  "starttime": "2016-07-16",
  "endtime": "2016-07-18"
}
```

**parameter description:**

- key:[string]verify key
- terid:[string] The terminal number ID array
- Starttime:[string]start time,the format YYYY-MM-dd
- Endtime:[string]end time,the format YYYY-MM-dd

**response:**

```json
{
  "data": [
    {
      "terid": "AE99873120",
      "mileage": "5874.36",
      "starttime": "2016-07-17 00:00:00",
      "endtime": "2016-07-17 23:59:59"
    }
  ],
  "errorcode": 200
}
```

**response description:**

- data:[]data array
- terid:[string] device serial number
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss
- endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- mileage:[string]mileage
- errorcode:error code

## 7. Live Video Interface

### 7.1 Get video port information

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/live/port?key=123aaeq3jjkljrqweoiu
```

**request:** `GET`

**request body:** none

**parameter description:**

- key:[string]verify key

**response:**

```json
{
  "data": [
    {
      "port": 12060
    },
    {
      "port": 12061
    }
  ],
  "errorcode": 200
}
```

**response description:**

- data:[]Number of sets of port data
- port:[int]port
- errorcode:error code

### 7.2 Get video stream address (flv way)[cms/n9m]

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/live/video?key=123aaeq3jjkljrqweoiu&terid=00830007CB&chl=1&audio=1&st=0&port=12060
```

**request:** `GET`

**remark:** PS:Because when playing video in HTTP continuous stream mode of FLV, the limit of the number of concurrent downloads will be received from the browser, and the limit is different from browser to browser. It is suggested to open 4-way video on one port and 16-way video at most at the same time

**parameter description:**

- key:[string]verify key
- terid:[string] device serial number
- chl:[int]Channel
- audio:[int]Audio 0: none,1: yes
- st:[int]Codestream type 0: main codestream,1: sub codestream
- port:[int]Video port
- dt:[string]Device type, optional parameter,n9m device is not transmitted, MDVR device is transmitted dt=MDVR

**response:**

```json
{
  "data": {
    "url": "http://{HOST}:12060/live.flv?devid=006000E4C0&chl=1&st=1&audio=1&svrip=127.0.0.1&svrport=17891&token=jYZi%2FP%2FAJPTDkBH%2F9lejs6Wie0zTACJJbNvi7Smh2eNXq1g"
  },
  "errorcode": 200
}
```

**response description:**

- data:Video address
- url:[string]address
- errorcode:error code

## 8. History Video Interface

### 8.1 Get history video monthly calendar information

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/record/calendar?key=123aaeq3jjkljrqweoiu&terid=00830007CB&starttime=2017-01-01&st=1&pbt=1
```

**request:** `GET`

**request body:** none

**parameter description:**

- key:[string]verify key
- terid:[string] device serial number
- starttime:[string]Start time (the month of this time is the query month)
- st:[string]Codestream type 0-sub stream; 1-main stream
- pbt:[int]Record playback type (optional parameter, default 0)

**response:**

```json
{
  "data": [
    {
      "date": "2017-06-17",
      "filetype": 1
    }
  ],
  "errorcode": 200
}
```

**response description:**

- data:[]data array
- date:[string]date(yyyy-MM-dd)
- filetype:[int]File type. 1 -- normal recording; 2 -- alarm recording
- errorcode:error code

### 8.2 Get the historical video file information

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/record/filelist?key=123aaeq3jjkljrqweoiu&terid=00830007CB&starttime=2017-01-01 00:00:00&endtime=2017-01-01 23:59:59&chl=1,2,3,4&st=1&pbt=1
```

**request:** `GET`

**request body:** none

**parameter description:**

- key:[string]verify key
- terid:[string] device serial number
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss
- endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- chl:[string]Channel id(multiple, split)
- st:[string]Codestream type 0-sub stream; 1-main stream
- pbt:[int]Record playback type (optional parameter, default 0)

**response:**

```json
{
  "data": [
    {
      "name": "0-1-0",
      "chn": 1,
      "filetype": 1,
      "starttime": "2017-06-19 07:57:26",
      "endtime": "2017-06-19 11:59:44"
    }
  ],
  "errorcode": 200
}
```

**response description:**

- data:[]data array
- name:[string]file name
- chn:[int]Channel number
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss
- endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- filetype:[int]File type. 1 -- normal recording; 2 -- alarm recording
- errorcode:error code

### 8.3 Get historical video stream information (HlS way)[n9m]

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/record/video?key=123aaeq3jjkljrqweoiu&terid=00830007CB&starttime=2017-06-19 15:20:56&endtime=2017-06-19 16:20:22&chl=1&st=1
```

**request:** `GET`

**request body:** none

**parameter description:**

- key:[string]verify key
- terid:[string] device serial number
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss
- endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- chl:[string]Channel id(multiple, split)
- st:[string]Codestream type 0-sub stream; 1-main stream

**response:**

```json
{
  "data": {
    "url": "http://{HOST}:12056/play/00820000D6/1/20170626002056_20170626003022_main.m3u8"
  },
  "errorcode": 200
}
```

**response description:**

- data:Video address
- url:[string]address
- errorcode:error code

### 8.4 Get historical video stream information (FLV way)[n9m]

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/record/flv/video?key=123aaeq3jjkljrqweoiu&terid=00830007CB&starttime=2023-09-27 15:20:56&chl=1&st=0
```

**request:** `GET`

**request body:** none

**parameter description:**

- key:[string]verify key
- terid:[string] device serial number
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss (playback starts from this time, no endtime)
- chl:[string]Channel id(multiple, split)
- st:[string]Codestream type 0-sub stream; 1-main stream

**response:**

```json
{
  "data": [
    {
      "url": "http://{HOST}:8091/play.flv?devid=00830007CB&chl=1&st=0&audio=1&starttime=20230927152056&sn=123456&token=xxxxxx"
    }
  ],
  "sn": "35DA2A37-8621-48B4-94EE-E052FC9A56E6",
  "errorcode": 200
}
```

**response description:**

- data:[]data array
- url:[string]address
- sn:[string]Stream ID (GUID). Used as the parameter of the FLV pause / resume / seek / stop interfaces (8.6 ~ 8.9)
- errorcode:error code

### 8.5 Get server historical video stream information (FLV way)

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/server/video?key=123aaeq3jjkljrqweoiu&terid=00830007CB&starttime=2023-09-27 15:20:56&chl=1
```

**request:** `GET`

**request body:** none

**parameter description:**

- key:[string]verify key
- terid:[string] device serial number
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss (playback starts from this time)
- chl:[string]Channel id(multiple, split)

**response:**

```json
{
  "data": [
    {
      "url": "http://{HOST}:8091/play.flv?devid=00830007CB&chl=1&st=0&audio=1&starttime=20230927152056&sn=123456&token=xxxxxx"
    }
  ],
  "sn": "35DA2A37-8621-48B4-94EE-E052FC9A56E6",
  "errorcode": 200
}
```

**response description:**

- data:[]data array
- url:[string]address
- sn:[string]Stream ID (GUID). Used as the parameter of the FLV pause / resume / seek / stop interfaces (8.6 ~ 8.9)
- errorcode:error code

### 8.6 Pause FLV stream

Pauses the FLV stream obtained from [8.4](#84-get-historical-video-stream-information-flv-wayn9m) or [8.5](#85-get-server-historical-video-stream-information-flv-way) by its `sn`.

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/flv/pause
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "sn": "35DA2A37-8621-48B4-94EE-E052FC9A56E6"
}
```

**parameter description:**

- key:[string]verify key
- sn:[string]Stream ID

**response:**

```json
{
  "errorcode": 200
}
```

**response description:**

- errorcode:[int]error code

### 8.7 Resume FLV stream

Resumes the paused FLV stream.

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/flv/resume
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "sn": "35DA2A37-8621-48B4-94EE-E052FC9A56E6"
}
```

**parameter description:**

- key:[string]verify key
- sn:[string]Stream ID

**response:**

```json
{
  "errorcode": 200
}
```

**response description:**

- errorcode:[int]error code

### 8.8 Seek FLV stream

Jumps the FLV stream playback to a specified time.

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/flv/seek
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "sn": "35DA2A37-8621-48B4-94EE-E052FC9A56E6",
  "starttime": "2023-10-12 08:30:00"
}
```

**parameter description:**

- key:[string]verify key
- sn:[string]Stream ID
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss

**response:**

```json
{
  "errorcode": 200
}
```

**response description:**

- errorcode:[int]error code

### 8.9 Stop FLV stream

Stops the FLV stream.

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/flv/stop
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "sn": "35DA2A37-8621-48B4-94EE-E052FC9A56E6"
}
```

**parameter description:**

- key:[string]verify key
- sn:[string]Stream ID

**response:**

```json
{
  "errorcode": 200
}
```

**response description:**

- errorcode:[int]error code

## 9. Video Download Interface

### 9.1 Add Video Download Task

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/record/task
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "terid": "00830007CB",
  "starttime": "2017-01-01 00:00:00",
  "endtime": "2017-01-01 08:00:00",
  "chl": [
    1,
    2,
    3,
    4
  ],
  "name": "test",
  "effective": 7,
  "netmode": 1,
  "tasktype": 0,
  "stream": 1
}
```

**parameter description:**

- key:[string]verify key
- terid:[string] device serial number
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss
- endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- chl:[[int]]Array of channel id Numbers
- name:[string]Task name (15 characters)
- effective:[int] effective days
- netmode:[int] Network mode(1:LAN, 2:WIFI, 3:WIFI and LAN, 4:4G, 7:All modes, All modes when this field is empty or does not exist)
- tasktype：[int] Task type(0:Black box , 1:Video recording , 2:All types ,Note that the starttime and endtime passed when tasktype is 0 must be less than today's date)
- stream:[int]Video stream type, 0: sub stream, 1: main stream

**response:**

```json
{
  "data": {
    "taskid": 1
  },
  "errorcode": 200
}
```

**response description:**

- data:response result
- taskid:[int]task ID
- errorcode:error code

### 9.2 Get the video download task status

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/record/taskstate
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "parms": [
    {
      "taskid": 1,
      "date": "2017-01-01"
    }
  ]
}
```

**parameter description:**

- key:[string]verify key
- parms:[]Parameter set array
- taskid:[int]task ID
- date:[string]Date of the task

**response:**

```json
{
  "data": [
    {
      "percent": 85,
      "state": 3,
      "taskid": 1
    }
  ],
  "errorcode": 200
}
```

**response description:**

- data:[]data array
- percent:[int]percentage
- state:[int]Status (-6 pause -5 limited number of connections - in 4 resolution -3 not completed -2 insufficient disk space -1 waiting for 0 resolution to complete 1 downloading 2 no video files 3 task completed 4 task failed 5 deletion 6 download failed 8 task expired)
- taskid:[int]task ID
- errorcode:error code

### 9.3 Get the completed task video files list

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/record/taskfilelist?key=123aaeq3jjkljrqweoiu&taskid=1&tasktype=1
```

**request:** `GET`

**request body:** none

**parameter description:**

- key:[string]verify key
- taskid:[int]task ID
- tasktype：[int] Task type(0:Black box , 1:Video recording , 2:All types ,Note that if this value is not passed, the video recording will be queried by default)

**response:**

```json
{
  "data": [
    {
      "dir": "QzpcVmlkZW9ccXExMjM0XDIwMTctMDYtMTlccmVjb3JkXDE=",
      "name": "qq1234-170619-000000-002000-01p401000000.264"
    },
    {
      "dir": "QzpcVmlkZW9ccXExMjM0XDIwMTctMDYtMTlccmVjb3JkXDE=",
      "name": "qq1234-170619-000000-002000-01p401000000.mp4"
    }
  ],
  "errorcode": 200
}
```

**response description:**

- data:[]data array
- name:[string]file name
- dir:[string]directory
- errorcode:error code

### 9.4 Download the recording file to the local

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/record/download?key=123aaeq3jjkljrqweoiu&dir=QzpcVmlkZW9ccXExMjM0XDIwMTctMDYtMTlccmVjb3JkXDE=&name=qq1234-170619-000000-002000-01p401000000.264
```

**request:** `GET`

**request body:** none

**parameter description:**

- key:[string]verify key
- name:[string]file name
- dir:[string]directory

**response:**

```json
"stream"
```

**response description:**

- [stream]

### 9.5 Delete recording download task

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/record/task
```

**request:** `DELETE`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "parms": [
    {
      "taskid": 1
    }
  ]
}
```

**parameter description:**

- key:[string]verify key
- parms:[]task array
- taskid:[int]task ID

**response:**

```json
{
  "data": {
    "result": true
  },
  "errorcode": 200
}
```

**response description:**

- data:response data
- result:Operating results
- errorcode:error code

### 9.6 Get the video download task list

Queries the download tasks of a vehicle group or a vehicle.

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/record/taskList
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "id": 1,
  "nodetype": 0
}
```

**parameter description:**

- key:[string]verify key
- id:[int]Vehicle group ID or vehicle ID
- nodetype:[int]Node type, 0: vehicle group, 1: vehicle

**response:**

```json
{
  "data": {
    "total": 1,
    "rows": [
      {
        "taskid": 1,
        "taskname": "aaa",
        "device": "AE99873120",
        "devicetype": null,
        "status": 0,
        "startexecute": "2022-07-18",
        "endexecute": "2022-07-18",
        "starttime": "08:00:00",
        "date": null,
        "endtime": "08:05:00",
        "period": 0,
        "tasktype": 1,
        "taskperiod": [],
        "taskchannel": [
          1,
          2,
          3,
          4,
          5,
          6,
          7,
          8,
          9,
          10,
          11,
          12,
          13,
          14,
          15,
          16
        ],
        "channel": null,
        "taskevent": [],
        "taskio": [],
        "relation": "202207181704527601",
        "carlicense": "AA123456",
        "netmode": "7",
        "effective": 7,
        "stream": 1,
        "videotype": 0,
        "channelcount": 16,
        "createtime": "2022-07-18 17:04:52",
        "finishtime": null,
        "updatetime": null,
        "configtime": null,
        "highspeed": null,
        "username": "admin"
      }
    ]
  },
  "errorcode": 200
}
```

**response description:**

- data:response data
- total:[int] Total
- taskid:[int]task ID
- taskname:[string]Task name
- device:[string]equipment ID
- devicetype:[int]Device type.1：MDVR，4：N9M
- status:[int]Task status
- startexecute:[string]Execution start date(yyyy-MM-dd)
- endexecute:[string]Execution end date(yyyy-MM-dd)
- starttime:[string]Daily start time(HH:mm:ss)
- date:[string]Specific date of the task (null means daily task)
- endtime:[string]Daily end time(HH:mm:ss)
- period:[int]Period
- tasktype:[int] Task type(0:Black box , 1:Video recording , 2:All types)
- taskperiod:[array]Task period
- taskchannel:[array]Task channel array
- channel:[int]Channel number
- taskevent:[array]Task event array
- taskio:[array]Task IO array
- relation:[string]Related vehicle record ID
- carlicense:[string] Carlicense
- netmode:[int] Network mode(1:LAN, 2:WIFI, 3:WIFI and LAN, 4:4G, 7:All modes)
- effective:[int] effective days
- stream:[int]Video stream type, 0: sub stream, 1: main stream
- videotype:[int] Recording filetype (1: normal recording, 2: alarm recording)
- channelcount:[int]The number of channels
- createtime:[string]Task creation time(yyyy-MM-dd HH:mm:ss)
- finishtime:[string]Task finish time
- updatetime:[string]Task update time
- configtime:[string]Task configuration time
- highspeed:[string]High-speed related configuration
- username:[string]Creator username
- errorcode:error code

## 10. Realtime Data Subscription

### 10.1 Realtime Data Subscription (Based on socket.io)

**address:**

```
http://{HOST}:{PORT}
```

**request:** `websocket`

**sample code:** `/help/api/images/socketExample.png` (see original HTML doc: `help/api/images/socketExample.png`)

**parameter description:**

- key:[string]verify key
- didArray:[]A null terminal array is a full subscription
- alarmType:[]Array of alarm type ID

**response:**

event `sub_state`

```json
{
  "deviceno": "00820000D6",
  "state": 1,
  "vid": 1,
  "carlicense": "AA123456",
  "groupName": "cneter"
}
```

event `sub_gps`

```json
{
  "deviceno": "006000E4C0",
  "lat": "23.654123",
  "lng": "108.432143",
  "speed": 0,
  "direction": 185,
  "altitude": 400,
  "dateTime": "2017-08-08 15:52:11",
  "carlicense": "AA5678",
  "groupName": "center"
}
```

event `sub_alarm`

```json
{
  "deviceno": "00820000D6",
  "type": 2,
  "speed": 0,
  "direction": 0,
  "altitude": 400,
  "content": "  1",
  "lat": "23.654123",
  "lng": "108.432143",
  "dateTime": "2017-08-08 15:52:37",
  "carlicense": "AA123456",
  "groupName": "center"
}
```

event `sub_mileage`

```json
{
  "deviceno": "00600119D4",
  "dateTime": "2018-01-02 20:01:53",
  "mileage": 0,
  "vid": 197,
  "carlicense": "AA1234",
  "groupName": "20180102"
}
```

event `sub_acc`

```json
{
  "deviceno": "007E00003A",
  "acc": 1,
  "dateTime": "2017-12-29 16:35:53",
  "lat": "0",
  "lng": "0",
  "speed": 0,
  "direction": 0,
  "altitude": "-",
  "vid": 29,
  "carlicense": "jing191",
  "groupName": "20180102"
}
```

event `sub_swipe`

```json
{
  "deviceno": "00820000D6",
  "name": "203name",
  "cardid": "203",
  "lat": "23.654123",
  "lng": "108.432143",
  "ls": 0,
  "ct": 1,
  "carlicense": "AA123456",
  "groupName": "20220906"
}
```

**response description:**

- deviceno:terminal ID
- state:Online 1, offline 0, alarm 2
- carlicence:[int]License plate number
- groupName:Organizational structure
- gpslat:[string] latitude
- gpslng:[string] longitude
- speed:[int] speed
- direction:[int] directi
- dataTime:Report the time
- type:[int] Alarm type
- content:Alarm content
- mileage:[string]mileage
- acc:Switch state
- name:[string] The driver name
- cardid:[string]Card ID
- lat:[double] latitude
- lng:[double] longitude
- ls:[int]Swipe card ride state
- ct:[int]Cumulative count of swipe card records

## 11. Device remote operation interface

### 11.1 Remote control interface [online terminal]

Remote PTZ / device control.

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/remote/control
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "terid": "00820000D6",
  "channel": 1,
  "type": 1,
  "speed": 16,
  "psp": 1
}
```

**parameter description:**

- key:[string]verify key
- terid:[string] device serial number
- channel:[int]Control channel
- type:[int]Remote control command type, see [Appendix 4: Remote Control (PTZ) Command Type](#appendix-4-remote-control-ptz-command-type)
- speed:[int]Control speed, only valid for some command types (see Appendix 4)
- psp:[int]Pan/preset related parameter, only valid for some command types (see Appendix 4)

**response:**

```json
{
  "result": true,
  "errorcode": 200
}
```

**response description:**

- result:[bool]result，True: success, false: failure
- errorcode:[int]error code

### 11.2 Get the device configuration page address

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/device/configline
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "terid": "00820000D6",
  "language": "0"
}
```

**parameter description:**

- key:[string]verify key
- terid:[string] device serial number
- language:[string]Configuration page language, 0: default

**response:**

```json
{
  "data": "http://127.0.0.1:8081/devapi/v1/basic/key?username=******&password=******&language=0&autoLogin=1&serialnum=00BF000054&url=/V3.4.7.1_R22051403/pages/config/default.html",
  "errorcode": 200
}
```

**response description:**

- data:data result (device configuration page address)
- errorcode:error code

### 11.3 Device TTS

Sends text to a device supporting TTS (text to speech).

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/device/tts
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "terid": "00820000D6",
  "time": 0,
  "flag": 8,
  "msg": "123"
}
```

**parameter description:**

- key:[string]verify key
- terid:[string] device serial number
- time:[int]Play time (seconds), 0: default
- flag:[int]Play flag
- msg:[string]Text content to play

**response:**

```json
{
  "data": true,
  "errorcode": 200
}
```

**response description:**

- data:data result (true: success)
- errorcode:error code

## 12. Passenger flow data interface

### 12.1 Query passenger flow detail

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/passenger-count/detail
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "terid": [
    "661",
    "662"
  ],
  "starttime": "2018-07-07 00:00:00",
  "endtime": "2018-07-13 23:59:59",
  "door": ""
}
```

**parameter description:**

- key:[string]verify key
- Terid:[array] device ID
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss
- endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- Door:[string] car door name, the value is empty when the query is all

**response:**

```json
{
  "data": [
    {
      "closetime": "2018-07-11 14:39:22",
      "door": "",
      "off": 2,
      "on": 3,
      "opentime": "2018-07-11 14:39:22",
      "sitename": "AAAAA",
      "terid": "661",
      "time": "2018-07-11 14:39:22",
      "lat": 23.654123,
      "lng": 108.432143
    }
  ],
  "errorcode": 200
}
```

**response description:**

- data:[json]update result
- closetime:[string] closing time
- opentime:[string] Open time
- Door:[string] car door name, the value is empty when the query is all
- off:[int] Out of the car number
- on:[int] Get on the bus number
- sitename:[string] The site name
- terid:[string] equipment ID
- time:[string] time
- lat:[double] latitude
- lng:[double] longitude
- errorcode:[int]error code

## 13. Face comparison interface

### 13.1 Query face comparison record number

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/face/comparison/count
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "terid": [
    "661",
    "662"
  ],
  "starttime": "2018-07-07 00:00:00",
  "endtime": "2018-07-13 23:59:59",
  "trigger": -1,
  "status": -1
}
```

**parameter description:**

- key:[string]verify key
- Terid:[array] device ID
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss
- endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- trigger:[int] -1: All, 0: card comparison, 1: inspection comparison, 2: ignition comparison, 3: departure return comparison
- status:[int] -1: All, 0: comparison passed, 1: comparison failed, 2: timeout, 3: no function enabled, 4: connection abnormal, 5: no driver picture, 6: terminal face database is empty, 7: Not necessarily right

**response:**

```json
{
  "data": {
    "count": 15
  },
  "errorcode": 200
}
```

**response description:**

- data:[json]update result
- count:[int]count
- errorcode:[int]error code

### 13.2 Query face comparison record list details

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/face/comparison/listdetail
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "terid": [
    "661",
    "662"
  ],
  "starttime": "2018-07-07 00:00:00",
  "endtime": "2018-07-13 23:59:59",
  "trigger": -1,
  "status": -1,
  "page": 1,
  "count": 20
}
```

**parameter description:**

- key:[string]verify key
- Terid:[array] device ID
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss
- endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- trigger:[int] -1: All, 0: card comparison, 1: inspection comparison, 2: ignition comparison, 3: departure return comparison
- status:[int] -1: All, 0: comparison passed, 1: comparison failed, 2: timeout, 3: no function enabled, 4: connection abnormal, 5: no driver picture, 6: terminal face database is empty, 7: Not necessarily right
- page:[int] The number of pages, indicating the first few pages. -1 means no paging, return all results
- count:[int] The number of pages per page. When the page is -1, it does not take effect.

**response:**

```json
{
  "data": [
    {
      "capturetime": "2019-08-14 16:16:13",
      "comparisonresult": 0,
      "comparisontime": "2019-08-14 16:16:13",
      "drivernumber": "",
      "faceindex": "",
      "faceuuid": "1f718b55-1bcf-4577-bf4a-7e95de8f8a31",
      "name": "AAA",
      "parentfleet": "20190812",
      "plate": "b123456",
      "terid": "0099000017",
      "trigger": 1,
      "data": [
        {
          "faceid": "0099000017_CH226-270105-000100-2",
          "faceindex": "QzovRmFjZURhdGEvQ29tcGFyZS8yMDE5LTA4LTE",
          "similarity": 17
        }
      ]
    }
  ],
  "errorcode": 200
}
```

**response description:**

- data:[json]update result
- capturetime:[string] Capture time
- comparisonresult:[int] -1: All, 0: comparison passed, 1: comparison failed, 2: timeout, 3: no function enabled, 4: connection abnormal, 5: no driver picture, 6: terminal face database is empty, 7: Not necessarily right
- comparisontime:[string] Comparison time
- drivernumber:[string] Driver number
- faceindex:[string] Capture face index
- faceuuid:[string] Capture the face uuid
- name:[string] The driver name
- parentfleet:[string] Car group
- plate:[string] License plate
- trigger:[int] -1: All, 0: card comparison, 1: inspection comparison, 2: ignition comparison, 3: departure return comparison
- data:[json] Face information result
- faceid:[string] Face id
- terid:[string] equipment ID
- similarity:[double] Similarity (percentage)
- errorcode:[int]error code

## 14. Evidence Center Interface

### 14.1 Evidence Search List Number Query

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/evidence-center/count
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "terid": [
    "008A000152"
  ],
  "starttime": "2019-08-30 00:00:00",
  "endtime": "2019-09-02 23:59:59",
  "type": [
    5
  ],
  "keytype": -1,
  "keyword": "",
  "timetype": 0
}
```

**parameter description:**

- key:[string]verify key
- terid:[[string]] Device ID
- type:[[int]] Array of alarm types, [] check all alarm types
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss
- endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- keytype:[int] Keyword type:-1 keyword does not take effect, 0 driver, 1 license plate, 2 evidence name
- keyword:[string] Keyword value
- timetype:[int]Time type used together with starttime/endtime for filtering

**response:**

```json
{
  "data": {
    "total": 4
  },
  "errorcode": 200
}
```

**response description:**

- data:response result
- total:[int] Total
- errorcode:[int]error code

### 14.2 Evidence Search List Detail Query

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/evidence-center/list
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "terid": [
    "008A000152"
  ],
  "starttime": "2019-08-30 00:00:00",
  "endtime": "2019-09-02 23:59:59",
  "type": [
    5
  ],
  "keytype": -1,
  "keyword": "",
  "page": 1,
  "count": 10,
  "context": "",
  "timetype": 0
}
```

**parameter description:**

- key:[string]verify key
- terid:[[string]] Device ID
- type:[[int]] Array of alarm types, [] check all alarm types
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss
- endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- keytype:[int] Keyword type:-1 keyword does not take effect, 0 driver, 1 license plate, 2 evidence name
- keyword:[string] Keyword value
- page:[int] Number of pages, indicating the first few pages. -1 means no paging, return all results
- count:[int] The number of pages per page.
- context:[string] The context information returned from the last query can be empty for the first query. Note: The content returned in each query may change, that is, each query must use the context field returned by the previous query
- timetype:[int]Time type used together with starttime/endtime for filtering

**response:**

```json
{
  "data": [
    {
      "address": "",
      "alarmid": "008A000152_145_76",
      "alarmlevel": -1,
      "alarmtype": 5,
      "createtime": "2019-09-02 00:00:39",
      "driverlicense": "",
      "drivername": "",
      "driverphone": "",
      "driverphoto": "",
      "eid": "4",
      "ename": "IO 1",
      "endtime": "2019-09-01 23:59:59",
      "gpslat": 0,
      "gpslng": 0,
      "pic": "QzovRXZpZGVuY2VEYXRhLzIwMTktMDktMDIvNC9DSDAxLTE5MDkwMi0wMDAwMTEtOTk2MTQ4MC5qcGc%3D",
      "sec": 3,
      "size": 7.78,
      "starttime": "2019-09-01 23:59:57",
      "terid": "008A000152",
      "time": "2019-09-02 00:00:02",
      "vehicle": "008A000152",
      "evidencestatus": 5,
      "evidencestatusmsg": "transcoding",
      "evidenceservername": "",
      "direction": 251,
      "desc": ""
    }
  ],
  "context": "",
  "errorcode": 200
}
```

**response description:**

- data:response result
- eid:[string] Evidence ID
- ename:[string] Evidence Name
- alarmid:[string] Alarm ID
- alarmtype:[int] Alarm Type
- alarmlevel:[int] Alarm Level
- terid:[[string]] Device ID
- vehicle:[string] Carlicense
- drivername:[string] Driver Name
- driverphone:[string] Driver Phone
- driverImg:[string]Driver Image Path(base64 encoding)
- driverlicense:[string] Driver License
- time:[string] Evidence Time
- createtime:[string] Evidence Create Time
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss
- endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- gpslng:[double] Longitude
- gpslat:[double] Latitude
- address:[string] Evidence Address
- size:[double] Evidence Size(in MB)
- sec:[int] Evidence Length(seconds)
- pic:[int] Cover image path (base64 encoding)
- evidencestatus:[int] Evidence status 0:evidence completed,1: Evidence failure1,2: Queuing,3: Downloading,4: Download completed,5: Transcoding
- evidencestatusmsg:[string] Evidence status description
- evidenceservername:[string] Evidence file storage server alias
- direction:[int] directi
- desc:[string] Describe the evidence
- errorcode:[int]error code
- context:[string] Context information generated by this query

### 14.3 Get Specified Evidence Image Information

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/evidence-center/picture/list
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "eid": "1"
}
```

**parameter description:**

- key:[string]verify key
- eid:[string] Evidence ID

**response:**

```json
{
  "data": [
    {
      "channel": 1,
      "path": "QzovRXZpZGVuY2VEYXRhLzIwMTktMDgtMzAvMS9DSDAxLTE5MDgzMC0yMDMzMTEtOTk2MTQ3Ny5qcGc%3D"
    }
  ],
  "errorcode": 200
}
```

**response description:**

- data:response result
- path:[int] Cover image path (base64 encoding)
- channel:[int]Channel
- errorcode:[int]error code

### 14.4 Get Specified Evidence Details

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/evidence-center/detail
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "eid": [
    "1"
  ]
}
```

**parameter description:**

- key:[string]verify key
- eid:[[string]] Evidence ID

**response:**

```json
{
  "data": [
    {
      "eid": "1",
      "size": 2.54,
      "terid": "0098000094",
      "groupname": "20190906",
      "carlicense": "98k",
      "platecolor": 2,
      "alarmtype": 6,
      "speed": 0,
      "starttime": "2019-09-06 14:00:25",
      "endtime": "2019-09-06 14:00:29",
      "lat": 0,
      "lng": 0,
      "location": "",
      "drivername": "zhmh1111",
      "driverphone": "13983825164",
      "driverlicense": "zhmh1111",
      "driverimg": "",
      "handleusername": "admin",
      "handletime": "2019-09-06 14:45:41",
      "handlemethod": 6,
      "handlecontent": "",
      "evidencestatus": 5,
      "evidencestatusmsg": "transcoding"
    }
  ],
  "errorcode": 200
}
```

**response description:**

- data:response result
- eid:[string] Evidence ID
- size:[double] Evidence Size(in MB)
- terid:[[string]] Device ID
- groupname:[string]groupname
- carlicense:[string] Carlicense
- platecolor:[int]License plate color, default 1 (1: blue 2: yellow 3: black 4: white 5: green)
- alarmtype:[int] Alarm Type
- speed:[double]Speed
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss
- endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- lat:[double] latitude
- lng:[double] longitude
- position:[string]Position Information
- drivername:[string] Driver Name
- driverphone:[string] Driver Phone
- driverlicense:[string] Driver License
- driverImg:[string]Driver Image Path(base64 encoding)
- handleusername:[string]The name of user who handled the driver
- handletime:[string]Handle Time
- handlemethod:[int]Handle Method
- handlecontent:[string]Handle Content
- evidencestatus:[int] Evidence status 0:evidence completed,1: Evidence failure1,2: Queuing,3: Downloading,4: Download completed,5: Transcoding
- evidencestatusmsg:[string] Evidence status description
- errorcode:[int]error code

### 14.5 Get a List of Specified Evidence Videos

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/evidence-center/video/list
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "eid": "31",
  "type": 0
}
```

**parameter description:**

- key:[string]verify key
- eid:[string] Evidence ID
- type:[int]Video type, 0:264, 1:mp4 (default mp4)

**response:**

```json
{
  "data": [
    {
      "channel": 1,
      "video": [
        {
          "starttime": "2019-08-30 20:33:05",
          "endtime": "2019-08-30 20:33:14",
          "path": "QzovRXZpZGVuY2VEYXRhLzIwMTktMDgtMzAvMS8wMDhBMDAwMTUyMDAwMDAwLTE5MDgzMC0yMDMzMDUtMjAzMzE0LTAxcDIxMTAwMDAwMC4yNjQ%3D"
        }
      ]
    }
  ],
  "errorcode": 200
}
```

**response description:**

- data:response result
- channel:[int]Channel
- video:[array string]Video information
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss
- endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- path:[string]Video Path
- errorcode:[int]error code

### 14.6 Generate evidence file

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/evidence-center/filepack
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "serverip": "127.0.0.1",
  "eid": "31"
}
```

**parameter description:**

- key:[string]verify key
- serverip:[string]Server IP
- eid:[string] Evidence ID

**response:**

```json
{
  "data": {
    "path": "QzovRXZpZGVuY2VEYXRhLzIwMTktMDgtMzAvMS8wMDhBMDAwMTUyMDAwMDAwLTE5MDgzMC0yMDMzMDUtMjAzMzE0LTAxcDIxMTAwMDAwMC56aXA="
  },
  "errorcode": 200
}
```

**response description:**

- data:response result
- path:[string]Evidence compressed file path (base64 encoding)
- errorcode:[int]error code

### 14.7 Query serer information

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/evidence-center/evidenceserverinfo
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu"
}
```

**parameter description:**

- key:[string]verify key

**response:**

```json
{
  "data": [
    {
      "serverip": "127.0.0.1",
      "servername": "mainserver",
      "serverrectport": 3113,
      "wcms5port": 12056
    }
  ],
  "errorcode": 200
}
```

**response description:**

- data:response result
- servername:[string] Evidence file storage server alias
- serverip:[string]Server IP
- wcms5port:[int]React service port
- errorcode:[int]error code

### 14.8 Evidence alarm track

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/evidence-center/relatedgpsalarm
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "eid": "1"
}
```

**parameter description:**

- key:[string]verify key
- eid:[string] Evidence ID

**response:**

```json
{
  "errorcode": 200,
  "errorcase": "Success!",
  "result": {
    "relatedGpsLong": "",
    "relatedGpsShort": "",
    "relatedAlarm": [
      {
        "alarmType": 1,
        "isCurrent": 1,
        "lat": 23.593116,
        "lng": 104.11321,
        "loc": "",
        "time": "2020-05-19 11:03:05",
        "uuid": "0099002BB1_6_606"
      }
    ]
  }
}
```

**response description:**

- errorcode:[int]error code
- errorcase:[string]Error description
- result:response result
- relatedGpsLong:[string]GPS information within 1 hour before and after the alarm: multiple GPS, separated by';'
- relatedGpsShort:[string]GPS information within 5 minutes before and after the alarm: multiple GPSs, separated by ';'
- relatedAlarm:response result
- lat:[double] latitude
- lng:[double] longitude
- uuid:[string]Uniquely identifies
- time:[string]Alarm time
- alarmtype:[int] Alarm Type
- loc:[string]Alarm location
- isCurrent:[int]Whether it is an alarm of current evidence

## 15. Swipe card data interface

### 15.1 Query swipe card detail

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/swipelog/detail
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "terid": [
    "661",
    "662"
  ],
  "searchtype": 1,
  "searchvalue": "",
  "starttime": "2018-07-07 00:00:00",
  "endtime": "2018-07-13 23:59:59",
  "page": 1,
  "count": 20
}
```

**parameter description:**

- key:[string]verify key
- Terid:[array] device ID
- searchtype:[int]Search type
- searchvalue:[string]Search keyword, empty for all
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss
- endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- page:[int] The number of pages, indicating the first few pages. -1 means no paging, return all results
- count:[int] The number of pages per page. When the page is -1, it does not take effect.

**response:**

```json
{
  "data": [
    {
      "carlicence": "AA123456",
      "groupname": "BusOneCompany",
      "drivername": "AAA",
      "carid": "661",
      "state": 1,
      "lat": "23.654123",
      "lng": "108.432143",
      "time": "2018-07-07 00:00:00"
    }
  ],
  "errorcode": 200
}
```

**response description:**

- carlicence:[int]License plate number
- groupname:[string]group name
- drivername:[string] Driver Name
- carid:[string]Vehicle ID
- state:[int]Swipe card state
- lat:[double] latitude
- lng:[double] longitude
- time:[string]Swipe card time(yyyy-MM-dd HH:mm:ss)
- errorcode:[int]error code

### 15.2 Query swipe card count

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/swipelog/count
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "terid": [
    "661",
    "662"
  ],
  "searchtype": 1,
  "searchvalue": "",
  "starttime": "2018-07-07 00:00:00",
  "endtime": "2018-07-13 23:59:59"
}
```

**parameter description:**

- key:[string]verify key
- Terid:[array] device ID
- searchtype:[int]Search type
- searchvalue:[string]Search keyword, empty for all
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss
- endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss

**response:**

```json
{
  "data": {
    "total": 4
  },
  "errorcode": 200
}
```

**response description:**

- total:[int] Total
- errorcode:[int]error code

## 16. Universal Interface

### 16.1 Image Preview and Video Playback

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/mediafile/view?key=123&dir=QzpcVmlkZVjb3JkXDE=
```

**request:** `GET`

**request body:** none

**parameter description:**

- key:[string]verify key
- dir:[string] Video Path/Image path (base64 encoding),video only supports mp4 format

**response:**

none

**response description:**

- Image, video stream data

### 16.2 File Download

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/absolute/dwnfile?key=123&dir=QzpcVmlkZjb3JkXDE=
```

**request:** `GET`

**request body:** none

**parameter description:**

- key:[string]verify key
- dir:[string]File in the server save path (base64 encoding)

**response:**

none

**response description:**

- File stream data

## 17. IO output interface

### 17.1 Get IO output status

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/io/get
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "carlicense": "AA123456"
}
```

**parameter description:**

- key:[string]verify key
- carlicense:[string] Carlicense

**response:**

```json
{
  "data": {
    "io": [
      0,
      1
    ]
  },
  "errorcode": 200
}
```

**response description:**

- io:[array]IO output status array ( indexed by IO port, 0/1)
- errorcode:[int]error code

### 17.2 Set IO output status

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/io/set
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "data": {
    "carlicense": "AA123456",
    "io": [
      1,
      1
    ],
    "cm": [
      1,
      0
    ],
    "ti": [
      0,
      30
    ]
  }
}
```

**parameter description:**

- key:[string]verify key
- carlicense:[string] Carlicense
- io:[array]IO output status array
- cm:[array]IO output command array (0: close, 1: open)
- ti:[array]Output duration array (seconds), 0: keep state until changed

**response:**

```json
{
  "data": {
    "result": true
  },
  "errorcode": 200
}
```

**response description:**

- result:[bool]result，True: success, false: failure
- errorcode:[int]error code

## 18. Evidence strategy interface

Per-vehicle alarm evidence recording strategy (pre/post alarm recording, black box contents, snapshot channels, alarm e-mail).

### 18.1 Query evidence strategy

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/alarm/strategy/config
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "carlicense": "AA123456"
}
```

**parameter description:**

- key:[string]verify key
- carlicense:[string] Carlicense

**response:**

```json
{
  "errorcode": 200,
  "data": [
    {
      "d_mainstream": 1,
      "d_substream": 0,
      "d_videochannel": "0,1,2,3,4,5,6",
      "d_before": 600,
      "d_after": 60,
      "d_bboxgps": 1,
      "d_bboxlog": 0,
      "d_bboxacc": 1,
      "d_picchannel": "0,1,2,3,4,5,6,7,8,9",
      "d_alarminter": 0,
      "d_alarmeverday": 0,
      "d_sendemail": -1,
      "d_emailaddress": "",
      "alarmtypes": 5
    }
  ]
}
```

**response description:**

- data:[]data array
- d_mainstream:[int]Whether to record main stream, 0: no, 1: yes
- d_substream:[int]Whether to record sub stream, 0: no, 1: yes
- d_videochannel:[string]Recording video channels, comma-separated
- d_before:[int]Pre-alarm recording time (seconds)
- d_after:[int]Post-alarm recording time (seconds)
- d_bboxgps:[int]Whether to record GPS information into the black box, 0: no, 1: yes
- d_bboxlog:[int]Whether to record logs into the black box, 0: no, 1: yes
- d_bboxacc:[int]Whether to record ACC information into the black box, 0: no, 1: yes
- d_picchannel:[string]Snapshot picture channels, comma-separated
- d_alarminter:[int]Alarm interval (seconds), 0: default
- d_alarmeverday:[int]Daily alarm setting, 0: no limit
- d_sendemail:[int]Whether to send alarm e-mail
- d_emailaddress:[string]Alarm notification e-mail address
- alarmtypes:[int]Alarm type ID
- errorcode:[int]error code

### 18.2 Save evidence strategy

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/alarm/strategy/save
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "d_mainstream": 0,
  "d_substream": 0,
  "d_videochannel": "0,1,2,3,4,5,6,7",
  "d_before": 10,
  "d_after": 20,
  "d_bboxgps": 0,
  "d_bboxlog": 0,
  "d_bboxacc": 0,
  "d_picchannel": "0,1,2,3,4,5,6",
  "d_alarminter": 0,
  "d_alarmeverday": 0,
  "d_emailaddress": "",
  "d_sendemail": -1,
  "carlicense": "AA123456",
  "alarmid": "5"
}
```

**parameter description:**

- key:[string]verify key
- d_mainstream:[int]Whether to record main stream, 0: no, 1: yes
- d_substream:[int]Whether to record sub stream, 0: no, 1: yes
- d_videochannel:[string]Recording video channels, comma-separated
- d_before:[int]Pre-alarm recording time (seconds)
- d_after:[int]Post-alarm recording time (seconds)
- d_bboxgps:[int]Whether to record GPS information into the black box, 0: no, 1: yes
- d_bboxlog:[int]Whether to record logs into the black box, 0: no, 1: yes
- d_bboxacc:[int]Whether to record ACC information into the black box, 0: no, 1: yes
- d_picchannel:[string]Snapshot picture channels, comma-separated
- d_alarminter:[int]Alarm interval (seconds), 0: default
- d_alarmeverday:[int]Daily alarm setting, 0: no limit
- d_emailaddress:[string]Alarm notification e-mail address
- d_sendemail:[int]Whether to send alarm e-mail
- carlicense:[string] Carlicense
- alarmid:[string]Alarm type ID

**response:**

```json
{
  "errorcode": 200,
  "result": true
}
```

**response description:**

- result:[bool]result，True: success, false: failure
- errorcode:[int]error code

### 18.3 Delete evidence strategy

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/alarm/strategy/delete
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "carlicense": "AA123456"
}
```

**parameter description:**

- key:[string]verify key
- carlicense:[string] Carlicense

**response:**

```json
{
  "errorcode": 200,
  "result": true
}
```

**response description:**

- result:[bool]result，True: success, false: failure
- errorcode:[int]error code

## 19. ACC data interface

### 19.1 Query ACC detail

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/acc
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "terid": [
    "AE99873120"
  ],
  "starttime": "2023-03-11 00:00:00",
  "endtime": "2023-03-17 23:59:59",
  "status": 1,
  "page": 1,
  "count": 20
}
```

**parameter description:**

- key:[string]verify key
- terid:[string] The terminal number ID array
- starttime: [string] start time, the format YYYY-MM-dd HH: mm: ss
- endtime: [string] end time, the format YYYY-MM-dd HH: mm: ss
- status:[int]ACC status filter, 0: off, 1: on
- page:[int] The number of pages, indicating the first few pages. -1 means no paging, return all results
- count:[int] The number of pages per page. When the page is -1, it does not take effect.

**response:**

```json
{
  "data": {
    "total": 4,
    "data": [
      {
        "carlicense": "AA123456",
        "terid": "AE99873120",
        "groupname": "20220530",
        "time": "2023-03-13 17:40:04",
        "acc": 1,
        "lat": 23.654123,
        "lng": 108.432143
      }
    ]
  },
  "errorcode": 200
}
```

**response description:**

- total:[int] Total
- carlicense:[string] Carlicense
- terid:[string] device serial number
- groupname:[string]group name
- time:[string] time
- acc:[int]ACC status, 0: off, 1: on
- lat:[double] latitude
- lng:[double] longitude
- errorcode:[int]error code

## 20. Network snapshot interface

### 20.1 Network snapshot

Remotely triggers a device hookup snapshot and returns the download address of the picture.

**address:**

```
http://{HOST}:{PORT}/api/v1/basic/remotepic
```

**request:** `POST`

**request body:**

```json
{
  "key": "123aaeq3jjkljrqweoiu",
  "terid": "AE99873120",
  "channel": 0
}
```

**parameter description:**

- key:[string]verify key
- terid:[string] device serial number
- channel:[int]Snapshot channel number (starting from 0)

**response:**

```json
{
  "data": {
    "terid": "AE99873120",
    "path": "http://{HOST}:{PORT}/api/v1/basic/absolute/dwnfile?key=zT908g2j9nguWMO%2FHXO&dir=QzpcUHJvZ3JhbSBGaWx"
  },
  "errorcode": 200
}
```

**response description:**

- terid:[string] device serial number
- path:[string]Snapshot picture download address (obtained via [16.2 File Download](#162-file-download))
- errorcode:[int]error code

## Appendix 1: Error Code

| Error Code | Description |
| --- | --- |
| 200 | Request successful / Response successful |
| 201 | Illegal request |
| 202 | Server Error |
| 203 | No yes authority |
| 204 | Authorization expired |
| 205 | Account has expired |
| 206 | Username and password are incorrect |
| 207 | Request parameter number exception |
| 208 | Request format error |
| 209 | Unauthorized key detected |
| 210 | Authorization key error |
| 211 | MD5 error |
| 212 | No data |
| 213 | No device |
| 214 | No space |
| 215 | No file |
| 216 | Request parameter content does not meet the restrictions |
| 217 | User logged in |
| 300 | Database connection error |
| 301 | Database operation exception |
| 302 | Internal interface parameter number error |
| 400 | Terminal search video calendar fail |
| 401 | Terminal is not Online |
| 402 | The terminal retrieval service is busy |
| 403 | Terminal execution fail |

## Appendix 2: Alarm Type Code

Alarm types are served dynamically by the server: `GET {HOST}:{PORT}/common/alarm-type`.

| type | Center description | English description |
| --- | --- | --- |
| 1 | Video lost alarm | Video loss |
| 2 | Motion detection alarm | Motion detection |
| 3 | Covering alarm | Cover |
| 4 | Memory exception alarm | Storage exception |
| 5 | User-defined alarm 1 | IO 1 |
| 6 | User-defined alarm 2 | IO 2 |
| 7 | User-defined alarm 3 | IO 3 |
| 8 | User-defined alarm 4 | IO 4 |
| 9 | User-defined alarm 5 | IO 5 |
| 10 | User-defined alarm 6 | IO 6 |
| 11 | User-defined alarm 7 | IO 7 |
| 12 | User-defined alarm 8 | IO 8 |
| 13 | Emergency alarm | Panic alarm |
| 14 | Low speed alarm | Low-speed |
| 15 | High speed alarm | High-speed |
| 16 | Low voltage alarm | Low voltage |
| 17 | plus speedalarm | ACC |
| 18 | Electronic fence | Fence |
| 19 | Illegal Ignition | lllegal power off |
| 20 | Illegal shutdown | lllegal shutdown |
| 29 | temperature alarm | Temperature alarm |

## Appendix 3: Demo

Demo pages shipped with the server:

- `public/h5demo/index.html`
- `public/h5demo/h5.html`
- `public/h5demo/websocket/websocket.html`

(Served from the running CMS server, e.g. `http://{HOST}:{PORT}/h5demo/index.html`)

## Appendix 4: Remote Control (PTZ) Command Type

The remote control ([11.1](#111-remote-control-interface-online-terminal)) command types are served dynamically by the server: `GET {HOST}:{PORT}/help/PTZtype`.

Which optional field of the command is valid depends on the command type:

| Optional field | Valid command types |
| --- | --- |
| `speed` | 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 22, 23, 24, 25 |
| `psp` | 14, 15, 17 |
| line | 16, 19 |
