import { session } from 'electron'
import http from 'http'
import https from 'https'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { basename, join, resolve, sep } from 'path'
import { OA_ORIGIN } from '@shared/constants'
import type { AIExtraRoot } from '@shared/ai-types'

/** 持久化 partition 名（与登录会话共用，Cookie 跨启动保留）。单一来源，index.ts 从这里取。 */
export const PARTITION = 'persist:mc-query'

// 单个文件下载的体积上限（200MB），防止异常/超大响应撑爆内存
const MAX_BYTES = 200 * 1024 * 1024
// 默认下载超时
const TIMEOUT_MS = 60000
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

interface OnceResult {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

/** 发一次 GET，返回状态码 / 响应头 / 完整 body；超时与体积超限均中断 */
function requestOnce(url: string, headers: Record<string, string>, timeoutMs: number): Promise<OnceResult> {
  return new Promise((resolve, reject) => {
    let u: URL
    try { u = new URL(url) } catch { reject(new Error('BAD_URL')); return }
    const useHttps = u.protocol === 'https:'
    const lib = useHttps ? https : http
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (useHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers
    }, (res) => {
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (c: Buffer) => {
        total += c.length
        if (total > MAX_BYTES) {
          req.destroy()
          reject(new Error('TOO_LARGE'))
          return
        }
        chunks.push(c)
      })
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('download timeout')) })
    req.end()
  })
}

/**
 * 下载一个 URL 到内存 Buffer。
 * - 传 cookie 时带 Cookie 头（OA 下载），OA 域自动补 Referer；
 * - 自动跟随最多 5 跳重定向；若跳到 IAM 认证则抛 NEED_RELOGIN；
 * - 4xx/5xx、超时、超体积都会抛错，由调用方转成结构化结果。
 * 手动点击下载（IPC.OA_FILE_DOWNLOAD）与 AI 的 file_download 共用此函数。
 */
export async function downloadBuffer(url: string, cookie?: string, timeoutMs: number = TIMEOUT_MS): Promise<Buffer> {
  let target = String(url || '').trim()
  if (!target) throw new Error('BAD_URL')
  for (let hop = 0; ; hop++) {
    const headers: Record<string, string> = {
      'User-Agent': UA,
      'Accept': '*/*'
    }
    if (cookie) headers['Cookie'] = cookie
    if (isOaUrl(target)) headers['Referer'] = OA_ORIGIN

    const res = await requestOnce(target, headers, timeoutMs)
    const loc = res.headers?.location ? String(res.headers.location) : ''
    if (res.status >= 300 && res.status < 400 && loc) {
      if (isReauthLocation(loc)) {
        const e: any = new Error('NEED_RELOGIN')
        e.code = 'NEED_RELOGIN'
        throw e
      }
      if (hop >= MAX_REDIRECTS) throw new Error('TOO_MANY_REDIRECTS')
      try { target = new URL(loc, target).toString() } catch { throw new Error('BAD_REDIRECT') }
      continue
    }
    if (res.status >= 400) throw new Error('HTTP ' + res.status)
    return res.body
  }
}

/** 下载 OA 域文件：自动带上当前 OA 登录态 Cookie，会话失效抛 NEED_RELOGIN */
export async function downloadOaBuffer(url: string, timeoutMs: number = 30000): Promise<Buffer> {
  const cookie = await getOaCookieString()
  return downloadBuffer(url, cookie, timeoutMs)
}

/** 从 URL 推断文件名：优先 fileName= 参数，其次路径末段，兜底 download */
function deriveName(url: string): string {
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
function safeFileName(name: string): string {
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
}

export interface DownloadToDirResult {
  ok: boolean
  savedPath?: string
  /** 相对授权工作区的路径（便于模型回显），无工作区时为绝对路径 */
  relative?: string
  name?: string
  size?: number
  error?: string
  message?: string
}

/**
 * 把 URL 下载到指定目录（AI 的 file_download 走这里）。
 * 流程：目录归属授权根并做越界校验 → 目录不存在则自动创建 → 下载 → 文件名清洗 + 同名自动重命名 → 写盘。
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

  // 3) 下载（OA 域自动带登录态）
  let buf: Buffer
  try {
    buf = isOaUrl(url) ? await downloadOaBuffer(url) : await downloadBuffer(url)
  } catch (e: any) {
    const msg = e?.message || String(e)
    if (msg === 'NEED_RELOGIN' || e?.code === 'NEED_RELOGIN') {
      return { ok: false, error: 'NEED_RELOGIN', message: 'OA 登录态已失效，请先在应用内登录 OA 后再下载' }
    }
    if (msg === 'TOO_LARGE') {
      return { ok: false, error: 'TOO_LARGE', message: '文件超过 200MB 上限，已中止下载' }
    }
    return { ok: false, error: 'DOWNLOAD_FAILED', message: `下载失败：${msg}` }
  }

  // 4) 文件名清洗 + 同名自动重命名 + 写盘
  const base = safeFileName(input?.name || deriveName(url))
  const finalPath = uniquePath(absDir, base)
  try {
    writeFileSync(finalPath, buf)
  } catch (e: any) {
    return { ok: false, error: 'WRITE_FAILED', message: `写入失败：${e?.message || e}` }
  }

  const name = basename(finalPath)
  const relative = rootPath ? join(basename(rootPath), String(absDir === rootPath ? name : join(absDir.slice(rootPath.length), name))) : finalPath
  return { ok: true, savedPath: finalPath, relative, name, size: buf.length }
}
