# Graph / 授权 排障

## 一、授权链路

```
POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/devicecode
     body: client_id, scope="offline_access Mail.ReadWrite"
  → { device_code, user_code, verification_uri, expires_in, interval }

POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
     body: grant_type=urn:ietf:params:oauth:grant-type:device_code
           client_id, device_code
  → authorization_pending / slow_down / expired_token / authorization_declined / access_token+refresh_token

续期：grant_type=refresh_token, client_id, refresh_token, scope="offline_access Mail.ReadWrite"
```

要点：

- 公开客户端（public client），**不需要也不要填 client secret**；填了就会诱导改成 Client Credentials + 应用程序权限，那必须走管理员同意。
- `scope` 只允许 `Mail.ReadWrite` 与 `offline_access`，代码层有硬校验，传其他值直接报错。
- `user_code` 有效期约 15 分钟；过期后必须重新 `start`，不要在同一 device_code 上死等。
- 轮询间隔以返回的 `interval` 为准（通常 5 秒），遇到 `slow_down` 要再加 5 秒。

## 二、常见状态码

| 码 | 含义 | 处理 |
|----|------|------|
| 401 | 令牌过期或被撤销 | 内部自动刷新一次；仍失败返回 `MAIL_AUTH_REQUIRED`，重新授权 |
| 403 | 权限不足 / 条件访问策略 | 提示联系 IT，**不要**换权限范围重试 |
| 404 | message id 不存在（可能已删除或移动） | 重新 `mail_search` 取新 id |
| 400 `UnableToDeserializePostBody` | 顶层 `inReplyTo` / `references` 被该租户拒绝 | 去掉这两个属性重投（工具已自动做），主题保留 `Re:` |
| 429 / 503 | 限流 | 按 `Retry-After` 或指数退避重试，最多 3 次 |
| 504 | 网关超时 | 重试一次；仍失败按服务不可用告知用户 |

## 三、草稿投递的两个坑（改动勿回退）

1. **线程头**：该租户的 Graph 不接受顶层 `inReplyTo` / `references`，会返回 400 `UnableToDeserializePostBody`，整封草稿写不进去。正确做法：先带线程头投递，遇 400 自动去掉这两个属性重投一次 —— 代价是丢失线程关联，但草稿能落地，主题仍带 `Re:`，人工审核时能认出来。
2. **引用块**：Graph 草稿只有一个 `body` 字段。回复正文与引用的原邮件在 MIME 里是两个 `text/plain` 分片，**只取第一个分片会把引用静默丢掉**。必须按顺序合并所有分片，并放进 `<blockquote>`。

## 四、必须回读校验

投递返回 `success: true` 不代表写对了。校验方法：

```
GET /me/messages/{draftId}?$select=subject,body,toRecipients
```

核对三件事：

1. `body.contentType` 是 `html`，`<p>` 数量与预期段落数一致；
2. 引用块 `<blockquote>` 存在且非空（`includeQuote: true` 时）；
3. `toRecipients` 只含预期收件人（防"回复全部"）。

工具 `mail_draft_save` 已把这三项做成返回字段：`paragraphs`、`quotedBlocks`、`to[]`、`formatOk`。

## 五、读邮件的注意事项

- `$search` 不能与 `$filter` / `$orderby` 同时使用；带关键字时先 `$search`，时间范围在本地过滤。
- `$top` 上限 50（本工具限制），翻页用 `skip`，返回里的 `hasMore` 指示还有没有。
- `bodyPreview` 只有前 255 字符，判断内容一定要 `mail_read`。
- 附件只在 `mail_read` 里列名字与大小，不下载；用户需要文件时让他自己在 Outlook 里另存。

## 六、日志

主进程把调试信息写到 `<userData>/email-auto/email.log`（超过 2 MB 滚动为 `email.log.1`）。日志只记 id 前缀、主题长度、段落数、状态码，**不记正文**。
