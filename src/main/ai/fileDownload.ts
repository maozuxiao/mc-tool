import { session } from 'electron'
import http from 'http'
import https from 'https'
import { Readable } from 'stream'
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readSync, renameSync, unlinkSync } from 'fs'
import { basename, join, resolve, sep } from 'path'
import { OA_ORIGIN } from '@shared/constants'
import type { AIExtraRoot } from '@shared/ai-types'

/** 持久化 partition 名（与登录会话共用，Cookie 跨启动保留）。单一来源，index.ts 从这里取。 */
export const PARTITION = 'persist:mc-query'

// 单个文件下载的体积上限（200MB）：流式写入下这只是个保护上限，不再占用同等内存
const MAX_BYTES = 200 * 1024 * 1024
// 「拿到响应头」的超时（连不上/一直不给头才失败）
const OPEN_TIMEOUT_MS = 30000
// 空闲超时：**只在一段时间没有任何新数据**时判失败 —— 大文件慢慢下不会被打断
const IDLE_TIMEOUT_MS = 60000
// 重定向最多跟随 5 跳，避免重定向环
const MAX_REDIRECTS = 5

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/** 取当前 OA 登录态 Cookie 串（OA 域文件下载鉴权用） */
export async function getOaCookieString(): Promise<string> {
  try {
    const cookies = await session.fromPartition(PARTITION).cookies.get({})
    return cookies.map(c => `${c.name}=${c.value}`).join('; ')
  } catch {
    return ''
  }
}

/** 判断 URL 是否属于 OA 域（OA 域下载需要带登录态 Cookie 与 Referer） */
export function isOaUrl(url: string): boolean {
  try {
    return /oa\.streamax\.com$/i.test(new URL(url).hostname)
  } catch {
    return false
  }
}

/** OA 会话失效时会被 302 到 IAM 认证，据此判定「需要重新登录」 */
function isReauthLocation(loc?: string): boolean {
  return !!loc &&
    /iam\.streamax\.com/i.test(loc) &&
    /(authCenter\/authenticate|state=IAM_OA_SSO|authnEngine|idp\/)/i.test(loc)
}

/**
 * 下载到指定路径（**流式**，1.0.43）。所有「下载到本机」的入口都走这里。
 *
 * 为什么改流式：此前是「先把整份内容读进内存 Buffer，再弹保存框 / 写盘」——
 * 点了下载要等整份下完（20MB 的 PDF 也得等好几秒，大文件更久），保存框也迟迟不出现，
 * 内存占用还跟文件大小成正比。现在跟浏览器一致：**先选保存位置，然后边下边写**，
 * 数据分块落盘（先写 `<file>.part`，成功再改名，失败删掉半截文件），内存只占一个块。
 *
 * 超时策略同样是浏览器式的：
 * - 「拿到响应头」有 30s 上限（连不上 / 一直不给头才失败）；
 * - 正文阶段用**空闲超时**（默认 60s 没有新数据才失败）—— 大文件慢慢下不会被打断。
 */
export interface DownloadToPathInput {
  url: string
  /** 最终落盘路径；下载期间写 `${filePath}.part` */
  filePath: string
  /** 走 Chromium 分区会话（内网 https / 鸿翼文件系统等）；默认 node 直连 */
  useSession?: boolean
  /** node 直连的 Cookie（不传时：OA 域自动取分区登录态） */
  cookie?: string
  /** 显式 Referer（鸿翼文件系统要求 preview.html；OA 域自动用 OA_ORIGIN） */
  referer?: string
  /** 空闲超时（毫秒） */
  idleTimeoutMs?: number
  /** 体积上限（毫秒之外的另一层保护） */
  maxBytes?: number
  /** 进度回调：已写字节数 / 总字节数（未知时为 0） */
  onProgress?: (received: number, total: number) => void
  /** 外部中止（用户取消） */
  signal?: AbortSignal
}

export interface DownloadToPathResult {
  ok: true
  size: number
  finalUrl: string
}

/** 已建立、正文尚未读取的响应（交给 pipeToFile 流式消费） */
interface OpenStream {
  stream: NodeJS.ReadableStream | null
  total: number
  finalUrl: string
}

/** 会话通道的请求头 */
function sessionHeaders(input: DownloadToPathInput): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': UA, 'Accept': '*/*' }
  if (input.referer) h['Referer'] = input.referer
  return h
}

/** node 直连的请求头：OA 域自动补登录态 Cookie 与 Referer */
async function nodeHeaders(input: DownloadToPathInput): Promise<Record<string, string>> {
  const h: Record<string, string> = { 'User-Agent': UA, 'Accept': '*/*' }
  if (isOaUrl(input.url)) {
    h['Referer'] = OA_ORIGIN
    if (!input.cookie) {
      const ck = await getOaCookieString()
      if (ck) h['Cookie'] = ck
    }
  } else if (input.referer) {
    h['Referer'] = input.referer
  }
  if (input.cookie) h['Cookie'] = input.cookie
  return h
}

/**
 * 走 Chromium 网络栈（系统证书库 / 代理 / 分区登录 cookie）。
 * 关键点：`AbortSignal` 只在「响应头还没到」这段挂着，拿到头立刻撤掉 ——
 * 否则整段超时会把慢慢下的大文件中途掐断（这正是旧实现的问题之一）。
 */
async function openViaSession(url: string, headers: Record<string, string>): Promise<OpenStream> {
  const sess = session.fromPartition(PARTITION)
  const ac = new AbortController()
  const openTimer = setTimeout(() => ac.abort(new Error('download timeout')), OPEN_TIMEOUT_MS)
  let res: any
  try {
    res = await sess.fetch(url, { headers, signal: ac.signal } as any)
  } finally {
    clearTimeout(openTimer)
  }
  if (res.status === 401 || res.status === 403) throw new Error('NEED_RELOGIN')
  // 落到认证页 / 登录页 = 会话失效：此时响应码往往仍是 200，只能看最终落点。
  // OA/IAM 是 iam.streamax.com，鸿翼文件系统（edoc2）未登录时 302 到 /sso/auth/goToLoginPage。
  if (/iam\.streamax\.com|goToLoginPage|\/sso\//i.test(String(res.url || ''))) throw new Error('NEED_RELOGIN')
  if (res.status >= 400) throw new Error('HTTP ' + res.status)
  const total = Number(res.headers.get('content-length') || 0)
  if (total && total > MAX_BYTES) throw new Error('TOO_LARGE')
  // 期望的是文件却收到 HTML 页面（且不是 .html 文件本身）：说明拿回来的是登录页，不是文件。
  // 这一步在任何字节落盘之前完成，所以不会留下垃圾文件。
  const ct = String(res.headers.get('content-type') || '')
  if (/text\/html/i.test(ct) && !/\.html?($|\?)/i.test(url)) throw new Error('NEED_RELOGIN')
  if (!res.body) throw new Error('EMPTY_BODY')
  return { stream: Readable.fromWeb(res.body as any), total, finalUrl: String(res.url || url) }
}

/** node 直连（http/https）：自跟随重定向、识别 IAM 重新认证；正文保持流式 */
async function openViaNode(url: string, headers: Record<string, string>): Promise<OpenStream> {
  let target = url
  for (let hop = 0; ; hop++) {
    let u: URL
    try { u = new URL(target) } catch { throw new Error('BAD_URL') }
    const useHttps = u.protocol === 'https:'
    const lib = useHttps ? https : http
    const opened = await new Promise<OpenStream>((resolve, reject) => {
      const req = lib.request({
        hostname: u.hostname,
        port: u.port || (useHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers
      }, (res) => {
        const status = res.statusCode || 0
        const loc = res.headers.location ? String(res.headers.location) : ''
        if (status >= 300 && status < 400 && loc) {
          res.resume() // 丢掉重定向响应体，避免连接挂住
          if (isReauthLocation(loc)) {
            const e: any = new Error('NEED_RELOGIN')
            e.code = 'NEED_RELOGIN'
            reject(e)
            return
          }
          resolve({ stream: null, total: 0, finalUrl: new URL(loc, target).toString() })
          return
        }
        if (status >= 400) { res.resume(); reject(new Error('HTTP ' + status)); return }
        const total = Number(res.headers['content-length'] || 0)
        if (total && total > MAX_BYTES) { res.destroy(); reject(new Error('TOO_LARGE')); return }
        // 期望的是文件却收到 HTML 页面（且不是 .html 文件本身）：说明拿回来的是登录页，不是文件。
        // 与会话通道同一判据 —— node 通道此前漏了这一步，会把登录页当规格文件存下来
        //（探针实测：服务端回 text/html 时旧实现照样落盘）。
        const ct = String(res.headers['content-type'] || '')
        if (/text\/html/i.test(ct) && !/\.html?($|\?)/i.test(target)) {
          res.resume()
          const e: any = new Error('NEED_RELOGIN')
          e.code = 'NEED_RELOGIN'
          reject(e)
          return
        }
        resolve({ stream: res, total, finalUrl: target })
      })
      req.setTimeout(OPEN_TIMEOUT_MS, () => req.destroy(new Error('download timeout')))
      req.on('error', reject)
      req.end()
    })
    if (opened.stream) return opened
    if (hop >= MAX_REDIRECTS) throw new Error('TOO_MANY_REDIRECTS')
    target = opened.finalUrl
  }
}

/** 把响应流写进文件：空闲超时 + 体积上限 + 可中止，返回写入字节数 */
function pipeToFile(
  stream: NodeJS.ReadableStream,
  partPath: string,
  opts: { maxBytes: number; idleTimeoutMs: number; total: number; onProgress?: (r: number, t: number) => void; signal?: AbortSignal }
): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = createWriteStream(partPath)
    let received = 0
    let settled = false
    let idle: ReturnType<typeof setTimeout> | null = null
    const cleanup = () => {
      if (idle) { clearTimeout(idle); idle = null }
      opts.signal?.removeEventListener('abort', onAbort)
    }
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (err) {
        // 中断时把两端都关掉：源流 destroy 会连带取消底层请求
        try { (stream as any).destroy?.() } catch { /* ignore */ }
        try { ws.destroy() } catch { /* ignore */ }
        reject(err)
        return
      }
      // end 的回调 = 数据已 flush、fd 已关闭，此时改名才安全
      ws.end(() => resolve(received))
    }
    const onAbort = () => finish(new Error('DOWNLOAD_CANCELED'))
    const armIdle = () => {
      if (idle) clearTimeout(idle)
      idle = setTimeout(() => finish(new Error('download timeout')), opts.idleTimeoutMs)
    }

    if (opts.signal?.aborted) { finish(new Error('DOWNLOAD_CANCELED')); return }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    armIdle()

    stream.on('data', (chunk: Buffer) => {
      if (settled) return
      received += chunk.length
      if (received > opts.maxBytes) { finish(new Error('TOO_LARGE')); return }
      // 背压：写不动就暂停源流，排空后继续（内存里始终只有一个块）
      if (!ws.write(chunk)) { (stream as any).pause?.(); ws.once('drain', () => (stream as any).resume?.()) }
      armIdle()
      opts.onProgress?.(received, opts.total)
    })
    stream.on('end', () => finish())
    stream.on('error', (e: Error) => finish(e))
    ws.on('error', (e: Error) => finish(e))
  })
}

/** 读取本地文件头几个字节（下载后做文件头校验用） */
function readHeadSync(p: string, n: number): Buffer {
  try {
    const fd = openSync(p, 'r')
    try {
      const buf = Buffer.alloc(n)
      const read = readSync(fd, buf, 0, n, 0)
      return buf.subarray(0, read)
    } finally {
      closeSync(fd)
    }
  } catch {
    return Buffer.alloc(0)
  }
}

/** 流式下载一个 URL 到指定路径；失败自动清掉 `.part` 半截文件 */
export async function downloadToPath(input: DownloadToPathInput): Promise<DownloadToPathResult> {
  const url = String(input?.url || '').trim()
  if (!url) throw new Error('BAD_URL')
  const filePath = String(input?.filePath || '').trim()
  if (!filePath) throw new Error('BAD_PATH')
  const idleTimeoutMs = input.idleTimeoutMs ?? IDLE_TIMEOUT_MS
  const maxBytes = input.maxBytes ?? MAX_BYTES
  const part = filePath + '.part'
  try { if (existsSync(part)) unlinkSync(part) } catch { /* 旧半截文件清不掉也不影响后续覆盖写 */ }

  const opened = input.useSession
    ? await openViaSession(url, sessionHeaders(input))
    : await openViaNode(url, await nodeHeaders(input))

  let written: number
  try {
    written = await pipeToFile(opened.stream!, part, {
      maxBytes,
      idleTimeoutMs,
      total: opened.total,
      onProgress: input.onProgress,
      signal: input.signal
    })
  } catch (e) {
    try { if (existsSync(part)) unlinkSync(part) } catch { /* ignore */ }
    throw e
  }
  try {
    renameSync(part, filePath)
  } catch (e: any) {
    try { if (existsSync(part)) unlinkSync(part) } catch { /* ignore */ }
    throw new Error('WRITE_FAILED: ' + (e?.message || e))
  }
  return { ok: true, size: written, finalUrl: opened.finalUrl }
}

/** 从 URL 推断文件名：优先 fileName= 参数，其次路径末段，兜底 download */
export function deriveName(url: string): string {
  const m = /fileName=([^&]+)/i.exec(url || '')
  if (m) {
    try { return decodeURIComponent(m[1]) } catch { return m[1] }
  }
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop()
    if (seg) {
      try { return decodeURIComponent(seg) } catch { return seg }
    }
  } catch { /* 非法 URL 走兜底 */ }
  return 'download'
}

/** 清洗文件名：去掉路径分隔符与 Windows 非法字符、去首尾点、限长 */
export function safeFileName(name: string): string {
  let s = String(name || '').trim()
  s = s.replace(/[\\/:*?"<>|]/g, '_')
  s = s.replace(/^\.+/, '').trim()
  if (!s) s = 'download'
  return s.slice(0, 180)
}

/** 同名文件自动重命名：名称(1).ext / 名称(2).ext …，不覆盖已有文件 */
function uniquePath(dir: string, name: string): string {
  let candidate = join(dir, name)
  if (!existsSync(candidate)) return candidate
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 1; i < 1000; i++) {
    candidate = join(dir, `${stem}(${i})${ext}`)
    if (!existsSync(candidate)) return candidate
  }
  return join(dir, `${stem}(${Date.now()})${ext}`)
}

export interface DownloadToDirInput {
  /** 文件 URL：OA 规格文件链接或任意 http(s) 链接 */
  url: string
  /** 目标目录（绝对路径，或「别名/子路径」）；必须在已授权工作区内 */
  dir: string
  /** 可选文件名，省略则由 URL 推断 */
  name?: string
  /** Build 模式已授权目录白名单（多根）；为空表示不限制目录 */
  roots?: AIExtraRoot[]
  /** 需要显式 Referer 的站点（如鸿翼文件系统要求 preview.html） */
  referer?: string
  /** 走 Chromium 会话下载（内网 https + 分区登录态），见 downloadToPath 的 useSession */
  useSession?: boolean
  /** node 直连时显式指定 Cookie（不传则按 OA 域自动取分区 cookie） */
  cookie?: string
  /**
   * 校验下载内容是不是「真文件」（1.0.43，参考原技能包 download.ps1 的文件头校验）：
   * 拿到 HTML 页面（登录页 / request invalid!）时直接判为登录态失效，避免把登录页当文件写盘。
   */
  validateFileHeader?: boolean
  /** 期望字节数（搜索结果里的 size）：给了就在返回里给出 sizeMatched */
  expectedSize?: number
}

export interface DownloadToDirResult {
  ok: boolean
  savedPath?: string
  /** 相对授权工作区的路径（便于模型回显），无工作区时为绝对路径 */
  relative?: string
  name?: string
  size?: number
  /** 按文件头识别出的类型（DOCX/XLSX(PK)、PDF、DOC/XLS(OLE2)、HTML、未知(hex)） */
  kind?: string
  /** 提供 expectedSize 时：实际字节数与期望是否一致 */
  sizeMatched?: boolean
  error?: string
  message?: string
}

/**
 * 按文件头（magic bytes）判断类型 —— 与原技能包 download.ps1 同一套判据：
 * DOCX/XLSX=504b0304(PK)、PDF=25504446(%PDF)、DOC/XLS=d0cf11e0(OLE2)。
 * HTML（3c）说明拿回来的是登录页而不是文件。
 */
export function detectFileKind(buf: Buffer): string {
  if (!buf || buf.length < 4) return 'EMPTY'
  const hex = buf.subarray(0, 4).toString('hex')
  if (hex.startsWith('504b0304')) return 'DOCX/XLSX(PK)'
  if (hex.startsWith('25504446')) return 'PDF'
  if (hex.startsWith('d0cf11e0')) return 'DOC/XLS(OLE2)'
  if (buf[0] === 0x3c) return 'HTML'
  return '未知(' + hex + ')'
}

/**
 * 把 URL 下载到指定目录（AI 的 file_download / wjxt_download 走这里）。
 * 流程：目录归属授权根并做越界校验 → 目录不存在则自动创建 → 文件名清洗 + 同名自动重命名
 * → **流式下载**（边下边写 `xxx.part`，成功后改名，失败自动清理）→ 文件头校验。
 */
export async function downloadToDir(input: DownloadToDirInput): Promise<DownloadToDirResult> {
  const url = String(input?.url || '').trim()
  const dir = String(input?.dir || '').trim()
  if (!url) return { ok: false, error: 'MISSING_ARG', message: '缺少 url 参数' }
  if (!dir) return { ok: false, error: 'MISSING_ARG', message: '缺少 dir 参数' }

  // 1) 目录归属到某个授权根（支持「别名/路径」前缀），越界直接拒绝
  const roots = (input.roots || []).map(r => ({ alias: r.alias || '', path: resolve(r.path) }))
  let rootPath = ''
  let rest = dir
  if (roots.length) {
    const m = /^([^/\\]+)[/\\]([\s\S]*)$/.exec(dir)
    const byAlias = m ? roots.find(r => r.alias && r.alias === m[1]) : undefined
    if (byAlias) {
      rootPath = byAlias.path
      rest = m![2] || '.'
    } else {
      const primary = roots.find(r => r.alias === '')
      if (primary) {
        rootPath = primary.path
        rest = dir
      } else if (roots.length === 1) {
        rootPath = roots[0].path
        rest = dir
      } else {
        // 多别名且无主根：绝对路径命中某个根才放行，否则要求用别名前缀
        const abs0 = resolve(dir)
        const hit = roots.find(r => abs0 === r.path || abs0.startsWith(r.path + sep))
        if (!hit) {
          return {
            ok: false,
            error: 'AMBIGUOUS_ROOT',
            message: '存在多个工作区，请用「别名/路径」指定目标目录'
          }
        }
        rootPath = hit.path
        rest = abs0
      }
    }
  }
  const absDir = rootPath ? resolve(rootPath, rest || '.') : resolve(dir)
  if (rootPath) {
    const p = resolve(rootPath)
    if (!(absDir === p || absDir.startsWith(p + sep))) {
      return {
        ok: false,
        error: 'PATH_OUTSIDE_ROOT',
        message: `目标目录不在已授权工作区（${rootPath}）内，请先用 open_folder 打开该目录`
      }
    }
  }

  // 2) 目录不存在则自动创建
  try {
    if (!existsSync(absDir)) mkdirSync(absDir, { recursive: true })
  } catch (e: any) {
    return { ok: false, error: 'MKDIR_FAILED', message: `目录创建失败：${e?.message || e}` }
  }

  // 3) 文件名清洗 + 同名自动重命名 —— **先定好落盘路径**，才能边下边写
  const base = safeFileName(input?.name || deriveName(url))
  const finalPath = uniquePath(absDir, base)

  // 4) 流式下载（OA 域自动带登录态；鸿翼等内网站点走会话通道 + 显式 Referer）：
  //    直接往 `xxx.part` 写，走完再改名；失败 / 超限 / 登录失效都会自动清掉半截文件。
  let size = 0
  try {
    const r = await downloadToPath({
      url,
      filePath: finalPath,
      useSession: input.useSession,
      cookie: input.cookie,
      referer: input.referer
    })
    size = r.size
  } catch (e: any) {
    const msg = e?.message || String(e)
    if (msg === 'NEED_RELOGIN' || e?.code === 'NEED_RELOGIN') {
      return { ok: false, error: 'NEED_RELOGIN', message: '登录态已失效（OA 或内网文件系统），请先在应用内登录后再下载' }
    }
    if (msg === 'TOO_LARGE') {
      return { ok: false, error: 'TOO_LARGE', message: '文件超过 200MB 上限，已中止下载' }
    }
    if (msg === 'DOWNLOAD_CANCELED') return { ok: false, error: 'CANCELED', message: '下载已取消' }
    return { ok: false, error: 'DOWNLOAD_FAILED', message: `下载失败：${msg}` }
  }

  // 4.5) 文件头校验（参考原技能包 download.ps1）：拿回 HTML 说明是登录页而不是文件。
  //      流式落盘后从文件里读前 8 个字节即可，不再为了校验把整份留在内存里。
  let kind: string | undefined
  if (input.validateFileHeader) {
    kind = detectFileKind(readHeadSync(finalPath, 8))
    if (kind === 'HTML' || kind === 'EMPTY') {
      try { unlinkSync(finalPath) } catch { /* 清不掉也只是留个坏文件，下面会明确报错 */ }
      return {
        ok: false,
        kind,
        error: 'NEED_RELOGIN',
        message: kind === 'HTML'
          ? '服务端返回的是登录页 HTML 而不是文件（登录态已失效），请重新登录后再下载'
          : '下载内容为空，可能是签名链接已过期，请重新发起下载'
      }
    }
  }

  const name = basename(finalPath)
  const relative = rootPath ? join(basename(rootPath), String(absDir === rootPath ? name : join(absDir.slice(rootPath.length), name))) : finalPath
  const sizeMatched = input.expectedSize ? size === input.expectedSize : undefined
  return {
    ok: true,
    savedPath: finalPath,
    relative,
    name,
    size,
    ...(kind ? { kind } : {}),
    ...(sizeMatched !== undefined ? { sizeMatched } : {})
  }
}
