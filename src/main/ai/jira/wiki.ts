/**
 * Jira / JSM 工单助手 · 文本格式层（1.0.71）
 *
 * Markdown → Jira Wiki 标记，以及 @提及解析。
 * 为什么必须转：JSM 的 description / comment 传字符串时按 **wiki 标记** 渲染，
 * 直接塞 Markdown 会出现 `*加粗*` 残留、表格退化成 `---`、代码围栏原样显示。
 */
import { jsmErrorText, jsmFetch } from './client'
import type { JiraConfig } from './config'

const esc = (s: string): string => String(s).replace(/\\/g, '\\\\').replace(/([{}[\]*_])/g, '\\$1')

function inline(text: string, depth = 0): string {
  const slots: string[] = []
  const put = (v: string): string => { slots.push(v); return '\u0001' + (slots.length - 1) + '\u0001' }
  let s = String(text == null ? '' : text)

  // Jira 的 @提及语法必须原样保留：[~accountid:xxx]（Cloud）/ [~username]（DC）。
  // 若被 esc() 转义成 \[~accountid:...\]，Jira 就不再按 mention 解析，页面显示原始占位文本。
  s = s.replace(/\[~accountid:[^\]\s]+\]|\[~[^\]\s]+\]/g, (m) => put(m))
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => put('{{' + c + '}}'))
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, _a, u: string) => put('!' + u + '!'))
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t: string, u: string) => put('[' + esc(t) + '|' + u + ']'))

  if (depth < 3) {
    // 内层递归上限 3 层，避免极端嵌套（**__`x`__**）无限展开
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, (_m, c: string) => put('*' + inline(c.trim(), depth + 1) + '*'))
    s = s.replace(/__([^_\n]+?)__/g, (_m, c: string) => put('*' + inline(c.trim(), depth + 1) + '*'))
    s = s.replace(/~~([^~\n]+?)~~/g, (_m, c: string) => put('-' + inline(c.trim(), depth + 1) + '-'))
    // 单星号：目标是 Jira，按 wiki 的「加粗」处理（模型常直接写 Jira 风格 *Issue Type*）。
    // 要求开星号后紧跟非空白，避免把 "2 * 3 * 4" 这类乘号当格式。
    s = s.replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*/g, (_m, p: string, c: string) =>
      p + put('*' + inline(c.trim(), depth + 1) + '*'))
    s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, (_m, p: string, c: string) =>
      p + put('_' + inline(c.trim(), depth + 1) + '_'))
  }

  s = esc(s)
  // 兜底：成对星号仍被转义（\*x\*）时还原，让 Jira 自己配对渲染，避免页面显示原始星号
  s = s.replace(/\\\*([^*\n]+?)\\\*/g, '*$1*')
  return s.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => slots[Number(i)] ?? '')
}

/** Markdown → Jira Wiki（标题/列表/表格/代码块/引用/分隔线全覆盖） */
export function mdToJiraWiki(md: string): string {
  const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let inCode = false
  let codeLang = ''
  let codeBuf: string[] = []
  const flushCode = (): void => {
    out.push('{code' + (codeLang ? ':' + codeLang : '') + '}')
    out.push(...codeBuf)
    out.push('{code}')
    codeBuf = []
    codeLang = ''
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const fence = /^\s*```+\s*(\w*)\s*$/.exec(line)
    if (fence) {
      if (inCode) { inCode = false; flushCode() } else { inCode = true; codeLang = fence[1] || '' }
      continue
    }
    if (inCode) { codeBuf.push(line); continue }

    // 表格：需第二行是 |---|---| 分隔行，否则按普通段落处理
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[] = []
      let j = i
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) { rows.push(lines[j].trim()); j++ }
      const isSep = (r: string): boolean => /^\|[\s:|-]+\|$/.test(r)
      if (rows.length > 1 && isSep(rows[1])) {
        const cellsOf = (r: string): string[] => r.replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()))
        out.push('||' + cellsOf(rows[0]).join('||') + '||')
        for (let k = 2; k < rows.length; k++) out.push('|' + cellsOf(rows[k]).join('|') + '|')
        i = j - 1
        continue
      }
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) { out.push('h' + h[1].length + '. ' + inline(h[2].trim())); continue }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('----'); continue }

    if (/^\s*>\s?/.test(line)) { out.push('bq. ' + inline(line.replace(/^\s*>\s?/, ''))); continue }

    const li = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line)
    if (li) {
      const indent = li[1].replace(/\t/g, '  ').length
      const depth = Math.min(6, Math.floor(indent / 2)) + 1
      out.push((li[3] ? '#' : '*').repeat(depth) + ' ' + inline(li[4]))
      continue
    }

    if (!line.trim()) { out.push(''); continue }
    out.push(inline(line))
  }
  if (inCode) flushCode()
  return out.join('\n')
}

// ── @提及 ───────────────────────────────────────────────
/** 按显示名/邮箱解析出唯一用户；只有精确命中才算，避免「张三」命中「张三丰」@错人 */
export async function resolveMentionUser(
  cfg: JiraConfig,
  query: string,
  signal?: AbortSignal
): Promise<{ accountId: string; displayName: string } | null> {
  const q = String(query || '').trim().replace(/^@/, '')
  if (!q) return null
  const params = new URLSearchParams({ query: q, maxResults: '20' })
  const r = await jsmFetch(cfg, 'GET', `/rest/api/2/user/search?${params}`, null, signal)
  if (r.status >= 400) throw new Error(jsmErrorText(r))
  const list = (Array.isArray(r.json) ? r.json : []).filter((u: any) => u && u.accountId)
  if (!list.length) return null
  const lc = q.toLowerCase()
  const hit = list.find((u: any) => String(u.displayName || '').toLowerCase() === lc)
    || list.find((u: any) => String(u.emailAddress || '').toLowerCase() === lc)
  return hit ? { accountId: String(hit.accountId), displayName: String(hit.displayName || q) } : null
}

export interface MentionResult {
  text: string
  resolved: Array<{ name: string; accountId: string }>
  unresolved: string[]
}

/**
 * 把正文里的 `@人名` 换成 Jira 认可的 `[~accountid:xxx]`。
 *
 * 两种用法：
 *   1. 显式传 mentions：`["Baran Karataş"]` 或 `[{ accountId, name }]`；
 *   2. 不传时自动识别正文的 `@Name`（仅接受显示名精确命中，最多 3 个，
 *      避免 @here / @all / 邮箱误伤）。
 * 已写成 `[~accountid:...]` 的片段保持原样。
 */
export async function applyMentions(
  cfg: JiraConfig,
  text: string,
  mentions: any,
  signal?: AbortSignal
): Promise<MentionResult> {
  let s = String(text == null ? '' : text)
  const resolved: Array<{ name: string; accountId: string }> = []
  const unresolved: string[] = []
  const done = new Set<string>()

  const replaceHandle = (name: string, accountId?: string): boolean => {
    if (!accountId || done.has(accountId)) return false
    const escName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp('@' + escName + '(?=\\s|[,，。.、:：;；!！?？)\\]]|$)', 'i')
    if (!re.test(s)) return false
    s = s.replace(re, () => { done.add(accountId); return `[~accountid:${accountId}]` })
    return true
  }

  const list: any[] = Array.isArray(mentions) ? mentions : (mentions ? [mentions] : [])
  const pending: Array<{ name: string; accountId: string }> = []

  for (const m of list) {
    if (!m) continue
    if (typeof m === 'object' && m.accountId) {
      const label = String(m.name || m.displayName || m.accountId)
      if (!replaceHandle(label, m.accountId)) pending.push({ name: label, accountId: m.accountId })
      resolved.push({ name: label, accountId: m.accountId })
      continue
    }
    const name = String(m).trim().replace(/^@/, '')
    if (!name) continue
    try {
      const u = await resolveMentionUser(cfg, name, signal)
      if (!u) { unresolved.push(name); continue }
      if (!replaceHandle(name, u.accountId)) pending.push({ name: u.displayName, accountId: u.accountId })
      resolved.push({ name: u.displayName, accountId: u.accountId })
    } catch (e: any) {
      unresolved.push(`${name}（${e?.message || e}）`)
    }
  }

  if (!list.length && !/\[~accountid:[^\]\s]+\]/.test(s)) {
    const handles = [...new Set(
      (s.match(/@[A-Z][\p{L}.'-]*(?:\s+[A-Z][\p{L}.'-]*){0,2}/gu) || []).map(x => x.slice(1))
    )].slice(0, 3)
    for (const name of handles) {
      try {
        const u = await resolveMentionUser(cfg, name, signal)
        if (u && replaceHandle(name, u.accountId)) resolved.push({ name: u.displayName, accountId: u.accountId })
      } catch { /* 自动识别失败不影响评论发送 */ }
    }
  }

  // 正文没写 @名字（模型只给了 mentions）：把提及放到开头，保证对方收到通知
  if (pending.length) {
    s = pending.map(p => `[~accountid:${p.accountId}]`).join(' ') + ' ' + s
    for (const p of pending) done.add(p.accountId)
  }

  return { text: s, resolved, unresolved }
}

/** 图片附件正则：决定评论里用 `!文件名!` 内嵌还是当普通附件 */
export const ATTACH_IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i
