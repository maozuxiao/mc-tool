# 回复草稿排版规范

工具会把纯文本转成 HTML 段落后再写入 Outlook 草稿箱。**排版错在文本层，HTML 层无法补救** —— 如果正文是一整段，草稿就是一整段。所以这里的规定是硬性的。

## 一、五段式骨架

```
<称呼>
<空行>
<开场：一句确认理解 / 一句感谢>
<空行>
<主体：要点逐条，每条一行>
<空行>
<结尾：下一步 / 需要对方提供什么>
<空行>
<落款>
<签名行 1>
<签名行 2>
```

## 二、英文模板

```
Dear Ersan,

Thanks for the update — the two images are enough for us to locate the issue.

1) Backup. The DataTool 3.0.4.0 package already contains the single-file backup tool we need.
2) Remote access. Yes, please share a download link and a time window that suits you.
3) CMS version. We will ship Ceiba2Srv_2.6.8.25.2 with the matching client.

If anything above is not feasible on your side, tell me and we will adjust.

Best regards,
Sean Mao
Technical Support Engineer | Streamax Technology
```

## 三、中文模板

```
您好，张工：

感谢同步现场情况，先确认一下我的理解：升级后 CMS 无法加载设备列表。

1、备份：请用 DataTool 3.0.4.0 内的单文件备份工具，不要按旧文档逐项导出。
2、远程：本周四 14:00-16:00 我们可接入，请提前开放 443 与 8080。
3、版本：我们会一并提供 2.6.8.25.2 服务端与配套客户端。

如需调整时间，请直接回复本邮件。

此致
Sean Mao
技术支持工程师 | 锐明技术
```

## 四、硬性禁止（工具会返回 `formatOk: false`）

| 反例 | 为什么不行 | 怎么改 |
|------|------------|--------|
| `Dear Ersan, Thanks ... 1) Backup ... 2) Remote ... Best regards, Sean` | 全挤在一段，Outlook 里就是一坨 | 每段之间空行，编号项各占一行 |
| 用 `**加粗**`、`##` 标题、`- ` 列表、表格 | 草稿是纯文本转 HTML，markdown 符号会原样出现 | 用 `1) 2) 3)` 或纯文本分句 |
| 只写 `Sean` 或漏掉职务 | 客户侧不好核对身份 | `Sean Mao` + 职务一行 |
| 把对方多个问题合并成一句回答 | 客户看不出逐条回应 | 一个要点一段/一行，顺序与来信一致 |
| 超过 5 段的客套 | 客户只想知道结论 | 开场 1 句，结尾 1 句 |

## 五、涉敏边界（只能标记，不得代写实质内容）

报价、折扣、付款条件、合同条款、交期承诺、返点、渠道政策、保密协议、投诉定责 —— 仅可生成占位回复，例如：

```
Dear Ersan,

Thanks for your message. This involves commercial terms, so our sales owner will follow up with you directly within one business day.

Best regards,
Sean Mao
Technical Support Engineer | Streamax Technology
```

## 六、称呼与落款

- 有名字用名（`Dear Ersan,`），只有姓用 `Dear Mr. Doru,`，多人用 `Dear team,`，中文用「您好，X 工：」。
- 落款固定 `Best regards,` / `此致`，单独一行。
- 签名默认两行：姓名 + `职务 | 公司`，可在 `mail_config` 的 `signature` 改。

## 七、引用原文

`includeQuote: true`（默认）时，工具会把原邮件正文作为引用块附在草稿末尾，与正文之间加分隔。若用户在跟一个已经很长的线程，可传 `includeQuote: false` 只发正文。
