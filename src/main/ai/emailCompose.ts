/**
 * Outlook 工作邮箱助手 · 草稿排版层（1.0.61）
 *
 * 解决的问题（用户在其他 AI 工具里遇到、截图实证）：回复草稿成了一整段纯文本 ——
 * 称呼、四个编号要点、落款、签名全部挤在一行，客户侧极不专业。
 *
 * 三个成因，这里负责后两个（第一个在 SKILL.md 的写作要求里）：
 *   1) 生成侧："不许用 markdown"被模型理解成"不要分行"；
 *   2) 后处理侧：旧实现只删符号，不还原结构 → 本文件的 normalizeReplyBody；
 *   3) 投递侧：旧实现 `body.contentType = "text"`，纯文本换行依赖客户端渲染
 *      （Outlook 常把单换行吞掉）→ 本文件的 toHtml 改成 HTML 段落投递。
 *
 * 设计原则：只在文本层做"结构还原"，不改写语义、不增删内容。
 */

export interface NormalizeResult {
  /** 规范化后的纯文本正文 */
  body: string
  /** 结构告警码，见 SKILL.md 第六节 */
  warnings: string[]
  /** 段落数（按空行切分） */
  paragraphs: number
  /** 被自动修复的行内编号数量（>0 说明模型又把列表写进段落了） */
  inlineListFixes: number
}

export interface HtmlResult {
  html: string
  paragraphs: number
  /** 引用块数量（0 或 1） */
  quotedBlocks: number
}

const CLOSING_RE = /^\s*(best\s+regards|kind\s+regards|regards|sincerely|thanks|thank\s+you|br|此致|顺祝|祝好|敬上)\s*[,，、]?/i
const GREETING_RE = /^\s*(dear\b|hi\b|hello\b|good\s+(morning|afternoon|evening)\b|尊敬的|您好|你好)/i
const LIST_MARK_RE = /^\s*(?:\d{1,2}[.)]|[a-zA-Z][.)]|[-•*]|（\d{1,2}）|\d{1,2}、)\s+/

/** 去掉模型偏爱的 markdown 语法符号（草稿是纯文本转 HTML，符号会原样露出来） */
function stripMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')                 // 标题
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')                // 粗体
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/`{1,3}([^`\n]+)`{1,3}/g, '$1')            // 行内代码
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1 ($2)') // 链接
    .replace(/^\s*>\s?/gm, '> ')                        // 统一引用前缀
    .replace(/^\s*(?:\*\*\*|---|___)\s*$/gm, '')        // 分隔线
    .replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, '')         // 表格分隔行
    .replace(/^\s*\|\s*/gm, '')                         // 表格左侧竖线
    .replace(/\s*\|\s*$/gm, '')                         // 表格右侧竖线
    .replace(/[ \t]+$/gm, '')
}

/**
 * 结构还原：把"一整段"的正文拆回"称呼 / 要点 / 落款 / 签名"。
 *
 * 只做保守的断行，不做语义重排：
 * - 行内 `1) ` / `2) ` / `- ` 等列表标记前断行（**不包括** `2.` 形式 —— 会把
 *   `2.6.8.25.2` 这种版本号误伤）；
 * - 落款词前补空行；
 * - 连续空行压成一段空行。
 */
export function normalizeReplyBody(input: string, opts: { signature?: string } = {}): NormalizeResult {
  const warnings: string[] = []
  let inlineListFixes = 0

  let text = stripMarkdown(String(input || '').trim())
  if (!text) {
    return { body: '', warnings: ['EMPTY_BODY'], paragraphs: 0, inlineListFixes: 0 }
  }

  // 1) 行内编号断行：`... guide. 2) Remote ...` → 在 `2) ` 前插入换行。
  //    只处理 `N)` 与 `N、`/`（N）`，避免误伤小数与版本号。
  const inlineListRe = /(?<=[^\n])([ \t]+)(\d{1,2}[)）]|\d{1,2}、)\s+/g
  text = text.replace(inlineListRe, (_m, _sp, mark) => {
    inlineListFixes++
    return `\n${mark} `
  })
  // 行内 `- ` 极少见，容易误伤连字符（"2.6.8.25.2-2024"），不做处理。

  // 2) 落款前断开（模型常把 "…We will adjust.Best regards," 连写）
  text = text.replace(/([^\n])((?:Best|Kind)\s+regards\b|Sincerely\b|此致|顺祝|祝好)/gi, (_m, prev, word) => {
    return `${prev}\n\n${word}`
  })

  let lines = text.split('\n')

  // 3) 称呼独占一行：`Dear Ersan, Thank you for ...` → 称呼 + 空行 + 正文
  const gi = lines.findIndex(l => l.trim())
  if (gi >= 0) {
    const line = lines[gi]
    const m = /^(\s*(?:Dear\b[^,\n]{0,60}|Hi\b[^,\n]{0,60}|Hello\b[^,\n]{0,60}|尊敬的[^，,：:\n]{0,30}|您好|你好)[,，：:])\s*(\S[\s\S]*)$/i
      .exec(line)
    // 只有称呼后面还跟着实质内容才拆（"Dear Eric," 单独一行不动）
    if (m && m[2] && m[2].trim().length > 0) {
      lines.splice(gi, 1, m[1].trim(), '', m[2].trim())
    }
  }

  // 4) 落款独占一行：`Best regards, Sean Mao ...` → 落款 + 换行 + 余下内容。
  //
  //    只把「后面紧跟签名」的情况当作落款，否则会误伤正文
  //    （`Thank you for the update, ...` 会把 "Thank you" 当成落款拆断）。
  //    判据：余下内容以配置的签名首行开头，或本身就像一个人名（首字母大写、长度有限）。
  const sigFirstGuess = String(opts.signature || '').split('\n')[0]?.trim() || ''
  const rebuilt: string[] = []
  for (const line of lines) {
    const m = /^(\s*(?:Best|Kind)\s+regards|Sincerely|Thanks|Thank\s+you|此致|顺祝|祝好)\s*[,，、:：]?\s*(.+)$/i.exec(line)
    const rest = m ? m[2].trim() : ''
    const restHasWords = /[A-Za-z\u4e00-\u9fa5]/.test(rest)
    const looksLikeSignature = !!rest && restHasWords && (
      (sigFirstGuess ? rest.startsWith(sigFirstGuess) : false) ||
      (/^[A-Z][\p{L}.'-]+(?:\s+[A-Z][\p{L}.'-]+){0,3}\b/u.test(rest) && rest.length <= 90)
    )
    if (m && looksLikeSignature) {
      rebuilt.push(m[1].trim() + ',')
      rebuilt.push('')
      rebuilt.push(rest)
    } else {
      rebuilt.push(line)
    }
  }

  // 5) 编号项独占一段：每个列表项前补空行（视觉上每条独立，HTML 里是独立 <p>）
  const spaced: string[] = []
  for (const line of rebuilt) {
    if (LIST_MARK_RE.test(line) && spaced.length && spaced[spaced.length - 1].trim() !== '') {
      spaced.push('')
    }
    spaced.push(line)
  }

  // 6) 签名按配置拆行：`Sean Mao Technical Support Engineer | ...` → 姓名 / 职务两行
  const sigFirst = String(opts.signature || '').split('\n')[0]?.trim()
  const sigLines: string[] = []
  for (const line of spaced) {
    const t = line.trim()
    if (sigFirst && t.startsWith(sigFirst + ' ') && t.length > sigFirst.length + 1) {
      sigLines.push(sigFirst)
      sigLines.push(t.slice(sigFirst.length).trim())
      continue
    }
    sigLines.push(line)
  }

  text = sigLines.join('\n')
  // 7) 连续空行压成一段空行；去掉行尾空白
  text = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim()

  const blocks = text.split(/\n{2,}/).filter(b => b.trim())
  const paragraphs = blocks.length

  // ── 结构校验（只告警，不改写）──────────────────────────
  const firstLine = (text.split('\n').find(l => l.trim()) || '').trim()
  if (!GREETING_RE.test(firstLine)) warnings.push('NO_GREETING')
  if (!text.split('\n').some(l => CLOSING_RE.test(l))) warnings.push('NO_CLOSING')
  if (text.split('\n').some(l => l.length > 400)) warnings.push('WALL_OF_TEXT')
  if (inlineListFixes > 0) warnings.push('INLINE_LIST')
  if (sigFirst && !text.includes(sigFirst)) warnings.push('NO_SIGNATURE')
  if (paragraphs < 2) warnings.push('SINGLE_PARAGRAPH')

  return { body: text, warnings, paragraphs, inlineListFixes }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function paragraphsToHtml(text: string): { html: string; count: number } {
  const blocks = text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean)
  const html = blocks
    .map(b => `<p style="margin:0 0 12px 0">${escapeHtml(b).replace(/\n/g, '<br>')}</p>`)
    .join('')
  return { html, count: blocks.length }
}

/**
 * 纯文本 → HTML。正文按空行分段（`<p>`），段内单换行 `<br>`，
 * 以 `>` 开头的尾部内容视为引用原文，放进 `<blockquote>` 并用 `<hr>` 与正文分隔。
 *
 * 为什么必须 HTML：`text/plain` 下 Outlook 对单换行的渲染不可控，
 * 之前"整段粘连"的观感问题一半来自这里。
 */
export function toHtml(bodyText: string): HtmlResult {
  const text = String(bodyText || '').replace(/\r\n?/g, '\n').trim()
  if (!text) return { html: '', paragraphs: 0, quotedBlocks: 0 }

  const lines = text.split('\n')
  let quoteStart = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*>/.test(lines[i])) { quoteStart = i; break }
  }

  const mainLines = (quoteStart >= 0 ? lines.slice(0, quoteStart) : lines).join('\n').trim()
  const quoteLines = quoteStart >= 0 ? lines.slice(quoteStart) : []

  const main = paragraphsToHtml(mainLines)
  let html = main.html
  let paragraphs = main.count
  let quotedBlocks = 0

  if (quoteLines.length) {
    const quoteText = quoteLines
      .map(l => l.replace(/^\s*>\s?/, ''))
      .join('\n')
      .trim()
    if (quoteText) {
      const q = paragraphsToHtml(quoteText)
      html += `<hr style="border:none;border-top:1px solid #d0d7de;margin:16px 0">`
      html += `<blockquote style="margin:0;padding-left:12px;border-left:3px solid #d0d7de;color:#57606a">${q.html}</blockquote>`
      quotedBlocks = 1
      // 总段落数（含引用）—— 与 countHtmlStructure 的回读口径保持一致，
      // 否则「预期 2 段 / 回读 5 段」这种错位会让校验结论失真。
      paragraphs += q.count
    }
  }

  return {
    html: `<div style="font-family:'Segoe UI',Arial,sans-serif;font-size:14px;line-height:1.6">${html}</div>`,
    paragraphs,
    quotedBlocks
  }
}

/** 把原邮件正文整理成可引用的 `>` 块（保留段落，截断超长内容） */
export function toQuotedBlock(originalBody: string, maxChars = 4000): string {
  const text = String(originalBody || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const clipped = text.length > maxChars ? text.slice(0, maxChars) + '\n…（原邮件较长，已截断）' : text
  return clipped
    .split('\n')
    .map(l => (l.trim() ? `> ${l}` : '>'))
    .join('\n')
}

/** 从 HTML 里数结构（回读校验用）：段落数与引用块数 */
export function countHtmlStructure(html: string): { paragraphs: number; quotedBlocks: number } {
  const src = String(html || '')
  const paragraphs = (src.match(/<p[\s>]/gi) || []).length
  const quotedBlocks = (src.match(/<blockquote[\s>]/gi) || []).length
  return { paragraphs, quotedBlocks }
}

/** 生成给用户看的纯文本预览（保留换行，截断） */
export function previewBody(body: string, maxChars = 600): string {
  const t = String(body || '').trim()
  return t.length > maxChars ? t.slice(0, maxChars) + '…' : t
}
