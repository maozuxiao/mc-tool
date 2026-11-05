/**
 * 附件下载 / 图片回灌 · 纯函数层（1.0.74）
 *
 * 参考 `E:\工具\Jira_Jsm\server.js` 已验收实现移植。这里**不 import electron**，
 * 目录与 fetch 都由调用方注入，便于 vitest 用本地 http server 直接单测。
 *
 * 三条实测教训（照抄，不要"优化"掉）：
 *  1. 单跳必须把 3xx 当 `{redirect}` 返回，不能当正文解析 —— 否则第一跳就炸；
 *  2. 除 Content-Length 预检外必须按**累计字节**拦，无 header 的流式响应才不会打爆内存；
 *  3. 凭据只在第一跳携带，跟随 CDN 时剥离 Authorization，并校验 host 白名单（SSRF）。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { basename, extname, join, resolve, sep } from 'path'

export const MAX_IMAGES_PER_TURN = 8
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
export const MAX_ATTACHMENT_ITEMS = 30
export const MAX_ATTACHMENT_CONCURRENCY = 3

/** 注入系统提示词：统一描述「图片会直接给模型看、长文件按需读」 */
export const MEDIA_TOOL_NOTE =
  '【附件 / 图片读取（1.0.74）】工具下载的图片会以下一条**图片消息**直接提供给你，请直接看图作答，' +
  '禁止说「我看不到图 / 请上传图片」；日志、PDF、压缩包只回 localPath + textPreview，' +
  '需要完整内容时调用 read_local_file 传 filePath 读取；图片确实读不出来时如实说明，绝不假装看过图。'

export interface MediaImage {
  path: string
  name: string
  mime: string
  size: number
}

/** 1.0.74：落盘后的长文件按需读取。文本类走主进程直读，PDF / Office 交给 file_read 技能 */
export const READ_LOCAL_FILE_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'read_local_file',
    description:
      '读取工具（jira_get_issue_attachments / mc_query spec --download）下载到本机的文件完整内容。' +
      '传工具返回的 localPath；文本类（log/txt/md/json/csv/xml 等）直接返回正文，' +
      'PDF / Office 文档自动转纯文本。单次默认最多 40000 字符，可用 maxChars 调整。' +
      '图片不要用它读：图片已作为图片消息直接给你看了。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '工具返回的 localPath 绝对路径' },
        maxChars: { type: 'number', description: '最多返回多少字符，默认 40000，上限 200000' }
      },
      required: ['filePath']
    }
  }
}

const IMAGE_EXT_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp'
}

const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.tsv', '.log', '.xml', '.yml', '.yaml',
  '.html', '.htm', '.js', '.ts', '.jsx', '.tsx', '.java', '.c', '.h', '.cpp', '.py',
  '.sql', '.properties', '.ini', '.conf', '.bat', '.cmd', '.ps1', '.sh', ''
])

export function mimeFromName(name: string): string {
  return IMAGE_EXT_MIME[extname(String(name || '')).toLowerCase()] || ''
}

export function isImageName(name: string, mime?: string): boolean {
  return /^image\//i.test(String(mime || '')) || !!mimeFromName(name)
}

/** 默认白名单：线上只允许 Atlassian 域名（本地单测用 hostChecker 注入放行） */
export function isAllowedAttachmentHost(hostname: string): boolean {
  const h = String(hostname || '').toLowerCase()
  return h === 'atlassian.net' || h.endsWith('.atlassian.net')
    || h === 'atlassian.com' || h.endsWith('.atlassian.com')
}

/** 回灌前必须确认路径在附件目录内（含 realpath 后的符号链接绕过） */
export function isInsideAttachDir(filePath: string, dir: string): boolean {
  try {
    const p = resolve(String(filePath || ''))
    const d = resolve(String(dir || ''))
    return !!d && (p === d || p.startsWith(d.endsWith(sep) ? d : d + sep))
  } catch {
    return false
  }
}

/** 落盘名带附件 id，且清洗路径分隔符与 Windows 非法字符 */
export function safeLocalName(id: string, filename: string): string {
  const raw = basename(String(filename || '')).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
  const safeId = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'x'
  return `att-${safeId}-${raw}`.slice(0, 120)
}

/** 文本类附件抽 ≤500 字符预览；二进制返回 null（由调用方决定是否交给 read_local_file） */
export function attachmentTextPreview(abs: string, mime: string, name: string, limit = 500): string | null {
  const ext = extname(String(name || '')).toLowerCase()
  const isText = /^text\//i.test(String(mime || '')) || TEXT_EXTS.has(ext)
    || /\.(json|xml|csv|txt|log|md)$/i.test(String(name || ''))
  if (!isText) return null
  try {
    const st = statSync(abs)
    const buf = readFileSync(abs)
    const head = buf.subarray(0, Math.min(buf.length, 4096))
    return head.toString('utf8').slice(0, limit) + (st.size > limit ? '…（预览已截断）' : '')
  } catch {
    return null
  }
}

/** 按 id + size 命中缓存，避免重复下载 */
export function cachedAttachmentFile(dir: string, id: string, name: string, size: number): string | null {
  try {
    const p = join(dir, safeLocalName(id, name))
    if (!existsSync(p)) return null
    return statSync(p).size === size ? p : null
  } catch {
    return null
  }
}

export function saveDownloadedAttachment(dir: string, id: string, name: string, buf: Buffer): string {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, safeLocalName(id, name))
  writeFileSync(p, buf)
  return p
}

/**
 * 读取本机文本文件（read_local_file 的纯函数部分）。
 * 只认文本类扩展名；二进制文档交给 file_read 技能，图片走视觉通道，避免把 base64 塞进上下文。
 */
export function readLocalTextFile(
  filePath: string,
  opts: { maxChars?: number; maxBytes?: number; allowedDir?: string } = {}
): { ok: true; path: string; size: number; text: string; truncated: boolean } | { ok: false; error: string } {
  const p = String(filePath || '').trim()
  if (!p) return { ok: false, error: '文件路径不能为空' }
  if (opts.allowedDir && !isInsideAttachDir(p, opts.allowedDir)) {
    return { ok: false, error: '只允许读取附件目录内的文件' }
  }
  const ext = extname(p).toLowerCase()
  if (!TEXT_EXTS.has(ext)) {
    return { ok: false, error: `不支持直接读取 ${ext || '该类型'} 文件：请用 file_read 读取 PDF / Office 文档` }
  }
  try {
    const st = statSync(p)
    const maxBytes = opts.maxBytes ?? MAX_ATTACHMENT_BYTES
    if (st.size > maxBytes) return { ok: false, error: `文件过大（${(st.size / 1048576).toFixed(2)}MB），超过读取上限` }
    const text = readFileSync(p, 'utf8')
    const maxChars = opts.maxChars ?? 40000
    return {
      ok: true,
      path: p,
      size: st.size,
      text: text.slice(0, maxChars),
      truncated: text.length > maxChars
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/**
 * 工具结果里的 `_images` 转成一条多模态 user 消息。
 * 单张失败（越界 / 超 8MB / 读不到）只跳过；全部失败返回 null，不注入空消息。
 */
export function buildToolMediaMessage(
  media: MediaImage[],
  toolName: string,
  attachDir: string
): any | null {
  const parts: any[] = []
  for (const im of (Array.isArray(media) ? media : []).slice(0, MAX_IMAGES_PER_TURN)) {
    try {
      if (!im?.path || !isInsideAttachDir(im.path, attachDir)) continue
      const st = statSync(im.path)
      if (st.size > MAX_IMAGE_BYTES || st.size <= 0) continue
      const buf = readFileSync(im.path)
      const mime = im.mime || mimeFromName(im.name) || 'image/png'
      parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } })
    } catch { /* 单张失败不影响其它图片 */ }
  }
  if (!parts.length) return null
  return {
    role: 'user',
    content: [
      { type: 'text', text: `【工具 ${toolName} 下载的图片（共 ${parts.length} 张）已作为图片消息提供，请直接看图作答】` },
      ...parts
    ]
  }
}

/** 从工具结果里摘掉 `_images`（必须在序列化 / 写入调用日志之前做） */
export function extractMedia(result: any): MediaImage[] {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return []
  const out: MediaImage[] = []
  const take = (holder: any): void => {
    if (holder && Array.isArray(holder._images)) {
      out.push(...holder._images.filter((x: any) => x && x.path))
      delete holder._images
    }
  }
  take(result)
  if (result.result && typeof result.result === 'object') take(result.result)
  return out.slice(0, MAX_IMAGES_PER_TURN)
}

/** 评论 wiki 正文里的 `!文件名.png|width=..!` 与附件名精确匹配（不用时间戳，实测 7/7） */
export function matchCommentImages(
  comments: Array<{ id?: string; author?: string; body?: string }>,
  attachments: Array<{ filename: string; mimeType?: string }>
): Array<{ commentId?: string; author?: string; filenames: string[] }> {
  const names = new Set(
    (attachments || [])
      .filter(a => isImageName(a.filename, a.mimeType))
      .map(a => String(a.filename))
  )
  const re = /!([^!|\n]+?)(?:\|[^!\n]*)?!/g
  const out: Array<{ commentId?: string; author?: string; filenames: string[] }> = []
  for (const c of comments || []) {
    const found = new Set<string>()
    let m: RegExpExecArray | null
    re.lastIndex = 0
    while ((m = re.exec(String(c.body || '')))) {
      const n = m[1].trim()
      if (names.has(n)) found.add(n)
    }
    if (found.size) out.push({ commentId: c.id, author: c.author, filenames: [...found] })
  }
  return out
}

// ── 二进制下载（首跳带凭据 / 后续剥离 / 白名单 / 体积双保险） ──────────

export interface DownloadOptions {
  maxBytes?: number
  timeoutMs?: number
  maxHops?: number
  retries?: number
  hostChecker?: (hostname: string) => boolean
  /** 单测注入：本地 http 服务或 mock */
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

export interface DownloadResult {
  buf: Buffer
  contentType: string
  hops: number
  fromHost: string
}

function isLocalhost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1'
}

/** 单跳：返回 {buf} / {redirect} / {error}，不做重定向跟随 */
export async function downloadBinaryOnce(
  urlStr: string,
  headers: Record<string, string> = {},
  opts: DownloadOptions = {}
): Promise<{ buf?: Buffer; contentType?: string; redirect?: string; error?: string }> {
  let u: URL
  try { u = new URL(urlStr) } catch { return { error: '附件下载地址无效' } }
  if (u.protocol !== 'https:' && !isLocalhost(u.hostname)) return { error: '附件下载仅支持 https' }
  const maxBytes = opts.maxBytes ?? MAX_ATTACHMENT_BYTES
  const doFetch = opts.fetchImpl || fetch
  let res: Response
  try {
    res = await doFetch(u.toString(), {
      method: 'GET',
      headers: { Accept: '*/*', ...headers },
      redirect: 'manual',
      signal: opts.signal
    } as RequestInit)
  } catch (e: any) {
    return { error: e?.message || String(e) }
  }
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    return { redirect: String(res.headers?.get?.('location') || '') }
  }
  if (res.status !== 200) return { error: `HTTP ${res.status}` }
  const declared = Number(res.headers?.get?.('content-length') || 0)
  if (declared > maxBytes) return { error: `附件过大（${(declared / 1048576).toFixed(1)}MB），超过上限` }

  try {
    const anyRes = res as any
    if (typeof anyRes.body?.getReader === 'function') {
      const reader = anyRes.body.getReader()
      const chunks: Buffer[] = []
      let size = 0
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        const part = Buffer.from(value)
        size += part.length
        if (size > maxBytes) {
          try { await reader.cancel() } catch { /* ignore */ }
          return { error: '附件下载超过体积上限' }
        }
        chunks.push(part)
      }
      return { buf: Buffer.concat(chunks), contentType: String(res.headers?.get?.('content-type') || '') }
    }
    const ab = await anyRes.arrayBuffer()
    const buf = Buffer.from(ab)
    if (buf.length > maxBytes) return { error: '附件下载超过体积上限' }
    return { buf, contentType: String(res.headers?.get?.('content-type') || '') }
  } catch (e: any) {
    return { error: e?.message || '附件下载中断' }
  }
}

/** 跟随下载循环；makeHeaders(hop) 由调用方决定凭据只出现在第 0 跳 */
export async function followAttachmentDownload(
  startUrl: string,
  makeHeaders: (hop: number) => Record<string, string>,
  opts: DownloadOptions = {}
): Promise<DownloadResult> {
  const maxHops = opts.maxHops ?? 3
  const retries = opts.retries ?? 1
  const hostChecker = opts.hostChecker || isAllowedAttachmentHost
  let lastErr: Error | null = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    let url = startUrl
    try {
      for (let hop = 0; hop <= maxHops; hop++) {
        const r = await downloadBinaryOnce(url, makeHeaders(hop), opts)
        if (r.redirect !== undefined) {
          if (hop === maxHops) throw new Error('附件下载重定向次数过多')
          const next = new URL(r.redirect, url)
          if (next.protocol !== 'https:' && !isLocalhost(next.hostname)) {
            throw new Error('附件重定向到非 https 地址，已拒绝')
          }
          if (!hostChecker(next.hostname)) throw new Error('附件重定向到非 Atlassian 域名，已拒绝')
          url = next.toString()
          continue
        }
        if (r.error) throw new Error(r.error)
        return {
          buf: r.buf as Buffer,
          contentType: r.contentType || '',
          hops: hop,
          fromHost: new URL(url).hostname
        }
      }
      throw new Error('附件下载重定向次数过多')
    } catch (e: any) {
      lastErr = e
      // 4xx / 安全拒绝 / 超限重试也没用；仅网络类错误重试一次
      if (/HTTP 4\d\d|已拒绝|超过上限|无效|次数过多/.test(String(e?.message || e))) break
    }
  }
  throw lastErr || new Error('附件下载失败')
}
