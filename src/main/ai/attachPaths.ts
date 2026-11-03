/**
 * 附件本机路径 · 纯函数部分（1.0.71）
 *
 * 背景：用户把截图粘进输入框时，渲染层能拿到的只有 `data:image/png;base64,...`，
 * **没有本机路径**；而 `jira_add_comment` / `jira_create_ticket` 的 `attachments`
 * 只认绝对路径。结果就是：用户在输入框里已经贴了图，模型却回头问「请提供该图片在
 * 本机的完整路径」——这一步纯属折腾。
 *
 * 处理办法（参考 `E:\工具\Jira_Jsm` 的 `.attachments` 做法）：
 *   1. 主进程把 dataUrl 落盘，路径写回附件对象（随历史持久化，续聊还能用）；
 *   2. 在提问里注入「附件本机路径」提示，明确要求直接使用、**不要向用户索要路径**；
 *   3. 用户下一轮只说「确认」时，回退复用上一轮的附件（仅限确认类短句）。
 *
 * 这里只放纯函数（可单测）；真正落盘在 `attachStore.ts`（依赖 electron 的 userData）。
 */

export interface SavedAttachment {
  name: string
  path: string
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg'
}

/** dataUrl 的 mime 推断扩展名；认不出来返回空串 */
export function mimeToExt(mime?: string): string {
  const m = String(mime || '').toLowerCase().split(';')[0].trim()
  return EXT_BY_MIME[m] || ''
}

/**
 * 落盘文件名清洗：去掉 Windows 非法字符与空白，保留中文与扩展名。
 * 名字过长时截断——Windows 路径上限 260 字符，附件目录本身已占一截。
 */
export function sanitizeAttachFileName(name?: string, mime?: string): string {
  const raw = String(name || '').split(/[\\/]/).pop()?.trim() || ''
  const dot = raw.lastIndexOf('.')
  const ext = dot > 0 ? raw.slice(dot).toLowerCase() : ''
  const base = (dot > 0 ? raw.slice(0, dot) : raw)
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
  const safeExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ''
  const stem = base || 'attachment'
  return (stem + (safeExt || mimeToExt(mime))).slice(0, 90)
}

/** 解析 dataUrl，返回 mime + 原始字节；格式不对或内容为空时返回 null（由调用方降级，不抛错） */
export function decodeDataUrl(dataUrl?: string): { mime: string; buf: Buffer } | null {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(String(dataUrl || ''))
  if (!m) return null
  const mime = m[1] || 'application/octet-stream'
  if (!m[2]) return null
  let buf: Buffer
  try {
    buf = Buffer.from(m[3], 'base64')
  } catch {
    return null
  }
  if (!buf.length) return null
  return { mime, buf }
}

/**
 * 是否只是对上一轮的简短确认（而非新任务）。
 * 长句子多半带了新内容，一律不继承上一轮附件——否则用户说「再加一条评论说明日志已获取」时，
 * 上一轮的截图会被当成这次评论的附件一起传上去。
 */
const CONFIRM_PREFIX_CN = /^(确认|确定|好的|好|可以|行|没问题|同意|是的|是|对|对的|提交|执行|发送|发布|就这样)/
const CONFIRM_PREFIX_EN = /^(ok|okay|yes|y|go)(\b|$)/i

export function isConfirmFollowUp(text?: string): boolean {
  const t = String(text || '').trim()
    .replace(/^[\s"'「『【]+/, '')
    .replace(/[\s"'」』】，。,.!！?？~～…]+$/, '')
  if (!t || t.length > 20) return false
  return CONFIRM_PREFIX_CN.test(t) || CONFIRM_PREFIX_EN.test(t)
}

function lines(files: SavedAttachment[]): string {
  return files.map(f => `- ${f.name} → ${f.path}`).join('\n')
}

/** 本条消息附件的路径提示：直接可用，禁止再向用户索要路径 */
export function currentAttachNote(files: SavedAttachment[]): string {
  if (!files.length) return ''
  return '【本条消息附件的本机路径（用户已经在输入框里给了这些文件，**不要再向他索要路径**）：'
    + '需要作为工单 / 评论附件时，直接把下面的路径传进 jira_add_comment / jira_create_ticket 的 attachments；'
    + '需要看内容时用 file_read】\n'
    + lines(files)
}

/** 上一轮附件的路径提示：只在用户这轮是「确认」类短句时给，避免把旧图误当成新附件 */
export function previousAttachNote(files: SavedAttachment[], userText?: string): string {
  if (!files.length || !isConfirmFollowUp(userText)) return ''
  return '【上一轮附件的本机路径（用户这句是在确认上一轮的操作，可以直接复用，**不要再向他索要路径**）：'
    + '需要作为工单 / 评论附件时，把下面的路径传进 jira_add_comment / jira_create_ticket 的 attachments】\n'
    + lines(files)
}
