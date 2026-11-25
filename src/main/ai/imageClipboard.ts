/**
 * AI 回复里的图片 → 系统剪贴板（#12，纯函数 + 主进程编排）。
 *
 * 背景：主进程的 `context-menu` handler 原先遇到图片直接早退（既非可编辑区、也无选中文字），
 * 图片上右键没有任何菜单。这里提供 `mediaType === 'image'` 分支所需的判定与字节加载能力：
 * 图片来源可能是 dataUrl（用户粘贴的截图）、http(s)（工具下载 / 带鉴权参数的知识库图）、
 * file（本地文件），按协议分流后再写进系统剪贴板。
 *
 * 不 import electron 顶层模块（NativeImage / clipboard 由调用方注入），便于 vitest 直接测纯函数。
 */
import { existsSync, readFileSync, statSync } from 'fs'
import { fileURLToPath } from 'url'

/** 单张图片上限：渲染层粘贴时已压缩、工具下载图默认 ≤8MB，20MB 足够且防卡死主进程 */
export const MAX_COPY_IMAGE_BYTES = 20 * 1024 * 1024

export type ImageSourceKind = 'data' | 'http' | 'file'

export interface ParsedImageSource {
  kind: ImageSourceKind
  value: string
  mime?: string
}

/**
 * 解析图片来源；不支持的协议 / 空串返回 null（菜单项禁用或提示失败）。
 * http(s) 保留完整 URL（含鉴权 query），交给调用方用主进程会话 fetch 拉取。
 */
export function parseImageSource(src: string): ParsedImageSource | null {
  const s = String(src || '').trim()
  if (!s) return null
  if (/^data:image\/[^;,]+;base64,/i.test(s)) {
    const mime = /^data:([^;,]+)/i.exec(s)?.[1] || ''
    return { kind: 'data', value: s.slice(s.indexOf(',') + 1), mime }
  }
  if (/^https?:\/\//i.test(s)) return { kind: 'http', value: s }
  if (/^file:\/\//i.test(s)) {
    try { return { kind: 'file', value: fileURLToPath(s) } } catch { return null }
  }
  return null
}

/** dataUrl 的 base64 载荷 → Buffer；非法 / 空 / 超限返回 null */
export function decodeDataUrlImage(src: string): Buffer | null {
  const parsed = parseImageSource(src)
  if (!parsed || parsed.kind !== 'data') return null
  try {
    const buf = Buffer.from(parsed.value, 'base64')
    if (!buf.length || buf.length > MAX_COPY_IMAGE_BYTES) return null
    return buf
  } catch { return null }
}

/** 本地文件 → Buffer；不存在 / 非文件 / 超限返回 null */
export function readLocalImage(path: string): Buffer | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null
    const st = statSync(path)
    if (!st.size || st.size > MAX_COPY_IMAGE_BYTES) return null
    return readFileSync(path)
  } catch { return null }
}

export interface CopyImageDeps {
  /** 主进程带会话的 fetch（复用 net.fetch / session.fetch，保证带鉴权 cookie） */
  fetchImpl: (url: string) => Promise<ArrayBuffer>
  /** nativeImage.createFromBuffer 的注入（避免顶层 import electron） */
  makeImage: (buf: Buffer) => { isEmpty(): boolean } | null
  /** clipboard.writeImage 的注入 */
  writeImage: (img: any) => void
}

export interface CopyImageResult {
  ok: boolean
  kind?: ImageSourceKind
  bytes?: number
  error?: 'BAD_SOURCE' | 'EMPTY' | 'TOO_LARGE' | 'DECODE_FAILED' | 'WRITE_FAILED'
}

/**
 * 加载图片字节并写入系统剪贴板。
 * 纯编排：所有平台 API 通过 deps 注入，单测可用 mock 覆盖 http / 超限 / 解码失败。
 */
export async function copyImageToClipboard(src: string, deps: CopyImageDeps): Promise<CopyImageResult> {
  const parsed = parseImageSource(src)
  if (!parsed) return { ok: false, error: 'BAD_SOURCE' }

  let buf: Buffer | null = null
  if (parsed.kind === 'data') {
    buf = decodeDataUrlImage(src)
  } else if (parsed.kind === 'file') {
    buf = readLocalImage(parsed.value)
  } else {
    try {
      const ab = await deps.fetchImpl(parsed.value)
      const b = Buffer.from(ab)
      if (!b.length) return { ok: false, kind: 'http', error: 'EMPTY' }
      if (b.length > MAX_COPY_IMAGE_BYTES) return { ok: false, kind: 'http', error: 'TOO_LARGE' }
      buf = b
    } catch {
      return { ok: false, kind: 'http', error: 'DECODE_FAILED' }
    }
  }

  if (!buf) {
    // dataUrl 超限 / 本地文件超限都要区分出来，便于提示
    const size = parsed.kind === 'data'
      ? Buffer.byteLength(parsed.value, 'base64')
      : (() => { try { return statSync(parsed.value).size } catch { return 0 } })()
    return { ok: false, kind: parsed.kind, error: size > MAX_COPY_IMAGE_BYTES ? 'TOO_LARGE' : 'DECODE_FAILED' }
  }

  const img = deps.makeImage(buf)
  if (!img || img.isEmpty()) return { ok: false, kind: parsed.kind, bytes: buf.length, error: 'DECODE_FAILED' }
  try {
    deps.writeImage(img)
  } catch {
    return { ok: false, kind: parsed.kind, bytes: buf.length, error: 'WRITE_FAILED' }
  }
  return { ok: true, kind: parsed.kind, bytes: buf.length }
}

/** 错误码 → 中文提示（主进程 tr() 用 i18n key 更准确，这里给单测与兜底） */
export function copyImageErrorText(code: CopyImageResult['error']): string {
  switch (code) {
    case 'TOO_LARGE': return '图片过大（超过 20MB），无法复制'
    case 'EMPTY': return '图片内容为空，无法复制'
    case 'BAD_SOURCE': return '不支持的图片地址，无法复制'
    case 'WRITE_FAILED': return '写入剪贴板失败'
    case 'DECODE_FAILED':
    default: return '图片解码失败或链接已过期，无法复制'
  }
}
