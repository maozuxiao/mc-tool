# edoc2 企业内容库 API 参考

> 本文件从原 opencode 技能包 `wjxt-file-download` 迁移而来，接口契约未改动。
> 注意：原包靠外部浏览器在页面上下文里 `eval fetch`；在 MC Tool 里这些请求全部由**主进程**发出
> （见 `src/main/ai/wjxtSkill.ts`），登录态取自应用分区，因此下文出现的 `agent-browser`/curl 说明仅供参考。

系统：edoc2（Streamax 企业内容库），前端 SPA：`index.html`（列表）、`preview.html`（预览）。
主机：`https://wj.streamax.com:9443`（重庆区域，DOCX 下载 RegionUrl 为 `https://wjcq.streamax.com:9443`）。
所有请求需携带登录态 Cookie，且 `Referer` 必须是 `https://wj.streamax.com:9443/preview.html`。

## 1. 搜索

- 端点：`POST /WebCore`
- Content-Type：`application/x-www-form-urlencoded`

| 参数 | 值 |
|---|---|
| module | `WebClient` |
| fun | `GetMapSearchResultList` |
| searchXml | ES 查询 JSON（URL 编码） |
| mnId | `0` |
| docViewId | `0` |
| argsXml | `<GetListArgs><PageNum>0</PageNum><PageSize>10</PageSize></GetListArgs>` |
| startNum | `0` |
| metaDataSearch | `false` |
| searchType | `MixFile` |
| searchLocation | `enterprise` |

searchXml 结构：

```json
{
  "from": 0,
  "size": 10,
  "_source": {"excludes": ["filecontent"]},
  "sort": [{"_score": {"order": "desc"}}],
  "query": {
    "query_string": {
      "query": "(filepath:(1) OR masterfilepath:(1)) AND (filename:(<关键词>) OR filecontent:(<关键词>))",
      "default_operator": "AND"
    }
  },
  "highlight": {
    "fields": {"filename": {}, "filecontent": {"type": "fvh"}},
    "pre_tags": "<span class='Highlighter'>",
    "post_tags": "</span>",
    "number_of_fragments": 3,
    "no_match_size": 250
  }
}
```

响应：`docListInfo.FilesInfo[]`，关键字段：

- `id`：ES 文档 ID（DownLoadCheck 用）
- `fileGuid`：GUID（GetPreviewPara 用）
- `name` / `extName` / `size`（原始文件字节数，用于校验）
- `parentFolderId` / `lastVerId`：目录与版本信息

## 2. 预览参数（拿下载 URL）

- 端点：`GET /Preview/GetPreviewPara`
- 参数：`t=<Date.now()>`、`fileId=<fileGuid>`、`byid=true`、`clientTypeName=pc`、`deviceTypeName=pc`、`browserPlatform=1`

响应 `data`：

- `fileUrl`：下载/预览 URL
- `fileId` / `fileVerId`：数值 ID
- `conversionState`：5200 = 未转换

### fileUrl 两种形态

PDF（浏览器可原生预览）→ `GetOriginFile`，x 参数 3 段：

```
/Preview/GetOriginFile?x=<A>,<B>,<C>&token=<C>&t=<ts>&fileId=<guid>&byid=true&clientTypeName=pc&deviceTypeName=pc&browserPlatform=1
```

DOC/DOCX（需转换预览）→ `GetConversionFile`，x 参数 4 段（第 4 段恒为 `dbwM2X15sOjA8MnjQqsOmA==`）：

```
/Preview/GetConversionFile?x=<A>,<B>,<C>,dbwM2X15sOjA8MnjQqsOmA==&token=<C>&r=<hex>&t=<ts>&fileId=<guid>&byid=true&clientTypeName=pc&deviceTypeName=pc&&browserPlatform=1
```

### 改造为原始文件 URL

```
u.pathname = u.pathname.replace('GetConversionFile', 'GetOriginFile');
u.searchParams.set('x', u.searchParams.get('x').split(',').slice(0,3).join(','));
u.searchParams.delete('r');
```

直接请求 GetOriginFile 即可返回原始文件（PDF 返回 application/pdf，DOC 返回 OLE2 复合文档，DOCX 返回 PK zip）。

## 3. DownLoadCheck（DOCX 备用下载）

- 端点：`GET /downLoad/DownLoadCheck`
- 参数：`fileIds=<id>`（ES 文档 ID）、`r=<Date.now()>`、`isIe=false`

响应 `nResult=0` 成功：

- `RegionUrl`：区域主机，如 `https://wjcq.streamax.com:9443`
- `RegionHash`：含 `|` 和 base64，使用前必须 `encodeURIComponent`

下载链接：

```
<RegionUrl>/downLoad/index?fileIds=<id>&regionHash=<encodeURIComponent(RegionHash)>
```

限制：

- DOCX 可用；DOC/PDF 返回 `nResult=5`（不适用，用 GetOriginFile 法）。
- `nResult=601`：token 异常或需要重新登录。
- RegionHash 尾部 `=` 可能被服务端双重编码（`%3D%3D`），原样传递即可。

## 4. 错误码

| nResult | 含义 |
|---|---|
| 0 | 成功 |
| 5 | 该接口不支持此文件类型（DOC/PDF 走 GetOriginFile） |
| 601 | 登录态/token 失效，重新扫码或重新调 GetPreviewPara |
| - | HTTP 200 但正文为 `request invalid!` → Referer 不对，必须带 preview.html Referer |
