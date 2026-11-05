/**
 * 1.0.74 #2 回归：附件下载链路与图片回灌。
 * 参照 E:\工具\Jira_Jsm\scripts\test-attachment-download.js 的验收用例移植到 vitest，
 * 全部跑在本地 http server 上，不连外网、不需任何凭据。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  attachmentTextPreview, buildToolMediaMessage, cachedAttachmentFile,
  downloadBinaryOnce, extractMedia, followAttachmentDownload,
  isAllowedAttachmentHost, isInsideAttachDir, matchCommentImages, mimeFromName,
  readLocalTextFile, safeLocalName, saveDownloadedAttachment
} from '../attachmentMedia'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const DIR = mkdtempSync(join(tmpdir(), 'mc-media-'))
mkdirSync(DIR, { recursive: true })
afterAll(() => { try { rmSync(DIR, { recursive: true, force: true }) } catch { /* ignore */ } })

function tmp(name: string, buf: Buffer): string {
  const p = join(DIR, name)
  writeFileSync(p, buf)
  return p
}

describe('SSRF / 路径边界', () => {
  it('允许 api.media.atlassian.com 与站点 *.atlassian.net', () => {
    expect(isAllowedAttachmentHost('api.media.atlassian.com')).toBe(true)
    expect(isAllowedAttachmentHost('streamaxamerica.atlassian.net')).toBe(true)
  })
  it('拒绝 evil.com 与形似但非法的后缀', () => {
    expect(isAllowedAttachmentHost('evil.example.com')).toBe(false)
    expect(isAllowedAttachmentHost('atlassian.net.evil.com')).toBe(false)
  })
  it('T6：回灌路径必须在附件目录内，../ 逃逸被拒', () => {
    expect(isInsideAttachDir(join(DIR, 'a.png'), DIR)).toBe(true)
    expect(isInsideAttachDir(join(DIR, '..', 'server.js'), DIR)).toBe(false)
    expect(isInsideAttachDir('', DIR)).toBe(false)
  })
  it('T6：落盘名带 id 且清洗路径分隔符与非法字符', () => {
    expect(safeLocalName('74201', 'image.png')).toBe('att-74201-image.png')
    expect(safeLocalName('1', '..\\..\\evil:file?.png')).not.toMatch(/[\\/:*?"<>|]/)
    expect(safeLocalName('1', '..\\..\\evil:file?.png')).toContain('evil')
  })
})

describe('落盘 / 缓存 / 预览 / 按需读', () => {
  it('T3：按 id + size 命中缓存，size 不一致不命中', () => {
    const p = saveDownloadedAttachment(DIR, '90001', 'unit.png', PNG)
    expect(cachedAttachmentFile(DIR, '90001', 'unit.png', PNG.length)).toBe(p)
    expect(cachedAttachmentFile(DIR, '90001', 'unit.png', PNG.length + 1)).toBeNull()
  })
  it('文本附件有预览，图片二进制没有', () => {
    const p = tmp('a.log', Buffer.from('2026-11-05 ERROR device offline\nline2'))
    expect(attachmentTextPreview(p, 'text/plain', 'a.log')).toContain('device offline')
    const img = tmp('a.png', PNG)
    expect(attachmentTextPreview(img, 'image/png', 'a.png')).toBeNull()
  })
  it('T7：read_local_file 能读全文并受 maxChars 限制', () => {
    const p = tmp('long.log', Buffer.from('A'.repeat(1200)))
    const r = readLocalTextFile(p, { maxChars: 100, allowedDir: DIR })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text).toHaveLength(100)
      expect(r.truncated).toBe(true)
    }
  })
  it('目录外路径与二进制扩展名被拒绝', () => {
    expect(readLocalTextFile(join(DIR, '..', 'x.log'), { allowedDir: DIR }).ok).toBe(false)
    const img = tmp('x.png', PNG)
    expect(readLocalTextFile(img, { allowedDir: DIR }).ok).toBe(false)
    expect(readLocalTextFile('', { allowedDir: DIR }).ok).toBe(false)
  })
})

describe('图片回灌（决策 B）', () => {
  it('图片消息含 image_url 与 data URL', () => {
    const p = tmp('pic.png', PNG)
    const msg = buildToolMediaMessage(
      [{ path: p, name: 'pic.png', mime: 'image/png', size: PNG.length }],
      'jira_get_issue_attachments', DIR
    )
    expect(msg?.role).toBe('user')
    expect(msg?.content.some((x: any) => x.type === 'image_url')).toBe(true)
    expect(msg?.content.find((x: any) => x.type === 'image_url').image_url.url)
      .toMatch(/^data:image\/png;base64,/)
  })
  it('目录外路径被剔除，只留 1 张；全部失败返回 null', () => {
    const p = tmp('pic.png', PNG)
    const msg = buildToolMediaMessage([
      { path: p, name: 'pic.png', mime: 'image/png', size: PNG.length },
      { path: join(DIR, '..', 'evil.png'), name: 'evil.png', mime: 'image/png', size: 10 }
    ], 'tool', DIR)
    expect(msg?.content.filter((x: any) => x.type === 'image_url')).toHaveLength(1)
    expect(buildToolMediaMessage([], 'x', DIR)).toBeNull()
    expect(buildToolMediaMessage(
      [{ path: join(DIR, '..', 'evil.png'), name: 'evil.png', mime: 'image/png', size: 10 }], 'x', DIR
    )).toBeNull()
  })
  it('extractMedia 顶层 / 嵌套都能摘，且摘后字段被删除', () => {
    const a: any = { ok: true, _images: [{ path: 'a', name: 'a.png', mime: 'image/png', size: 1 }] }
    expect(extractMedia(a)).toHaveLength(1)
    expect(a._images).toBeUndefined()
    const b: any = { result: { _images: [{ path: 'b', name: 'b.png', mime: 'image/png', size: 1 }] } }
    expect(extractMedia(b)).toHaveLength(1)
    expect(b.result._images).toBeUndefined()
    expect(extractMedia({ ok: true })).toEqual([])
  })
  it('mimeFromName 认识常见图片扩展名', () => {
    expect(mimeFromName('a.PNG')).toBe('image/png')
    expect(mimeFromName('a.jpg')).toBe('image/jpeg')
    expect(mimeFromName('a.log')).toBe('')
  })
})

describe('评论 ↔ 图片映射（决策 D）', () => {
  const atts = [
    { filename: 'trace.png', mimeType: 'image/png' },
    { filename: 'screen.jpg', mimeType: 'image/jpeg' },
    { filename: 'device.log', mimeType: 'text/plain' }
  ]
  it('T8：7 处 !文件名|width=..! 全部精确命中', () => {
    const body = Array.from({ length: 7 }, (_, i) => `第${i + 1}处 !trace.png|width=800! 结束`).join('\n')
    const out = matchCommentImages([{ id: 'c1', author: '张三', body }], atts)
    expect(out).toHaveLength(1)
    expect(out[0].filenames).toEqual(['trace.png'])
  })
  it('不把 .log 误配成图片，也不匹配不存在的名字', () => {
    const out = matchCommentImages([
      { id: 'c1', body: '!device.log! 和 !screen.jpg|width=100! 还有 !missing.png!' }
    ], atts)
    expect(out[0].filenames).toEqual(['screen.jpg'])
  })
  it('没有引用就不产生映射', () => {
    expect(matchCommentImages([{ body: '纯文本评论' }], atts)).toEqual([])
  })
})

describe('下载链路（本地 http server）', () => {
  let server: Server
  let port = 0
  let hits: Array<{ url: string; headers: any }> = []

  const start = async (): Promise<void> => {
    server = createServer((req, res) => {
      hits.push({ url: req.url || '', headers: req.headers })
      if (req.url?.startsWith('/content/')) {
        res.writeHead(303, { Location: `http://127.0.0.1:${port}/cdn/pic.png` })
        res.end()
      } else if (req.url?.startsWith('/cdn/')) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(PNG.length) })
        res.end(PNG)
      } else if (req.url?.startsWith('/binary/')) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(PNG.length) })
        res.end(PNG)
      } else if (req.url?.startsWith('/big-declared/')) {
        res.writeHead(200, { 'Content-Length': String(999 * 1024 * 1024) })
        res.end(PNG)
      } else if (req.url?.startsWith('/big-stream/')) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        res.write(Buffer.alloc(64 * 1024, 1))
        res.write(Buffer.alloc(64 * 1024, 2))
        res.end()
      } else if (req.url?.startsWith('/redirect-evil/')) {
        res.writeHead(303, { Location: 'https://evil.example.com/steal' })
        res.end()
      } else if (req.url?.startsWith('/loop/')) {
        res.writeHead(303, { Location: `http://127.0.0.1:${port}/loop/` })
        res.end()
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('not found')
      }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address()
    port = typeof addr === 'object' && addr ? addr.port : 0
  }

  const stop = async (): Promise<void> => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  const url = (p: string): string => `http://127.0.0.1:${port}${p}`
  const fetchImpl = (async (u: any, init: any) => globalThis.fetch(u, init)) as typeof fetch

  it('单跳能收完整二进制；303 返回 redirect 而不是当正文', async () => {
    await start()
    try {
      const one = await downloadBinaryOnce(url('/binary/a'), {}, { maxBytes: 1024 * 1024, fetchImpl })
      expect(Buffer.isBuffer(one.buf)).toBe(true)
      expect(one.buf?.equals(PNG)).toBe(true)
      const red = await downloadBinaryOnce(url('/content/a'), {}, { maxBytes: 1024 * 1024, fetchImpl })
      expect(red.redirect).toContain('/cdn/')
      const e404 = await downloadBinaryOnce(url('/missing'), {}, { maxBytes: 1024 * 1024, fetchImpl })
      expect(e404.error).toBe('HTTP 404')
    } finally { await stop() }
  })

  it('Content-Length 预检 + 无 header 时按累计字节拦截', async () => {
    await start()
    try {
      const declared = await downloadBinaryOnce(url('/big-declared/a'), {}, { maxBytes: 1024, fetchImpl })
      expect(declared.error).toMatch(/过大|超过上限/)
      const streamed = await downloadBinaryOnce(url('/big-stream/a'), {}, { maxBytes: 1024, fetchImpl })
      expect(streamed.error).toMatch(/超过|中断/)
    } finally { await stop() }
  })

  it('T1：跟随 303 拿到完整图片，凭据只出现在第一跳', async () => {
    await start()
    hits = []
    try {
      const looped = await followAttachmentDownload(
        url('/content/73042'),
        (hop): Record<string, string> => (hop === 0 ? { Authorization: 'Basic TOP-SECRET' } : {}),
        { maxBytes: 1024 * 1024, hostChecker: () => true, retries: 0, fetchImpl }
      )
      expect(looped.buf.equals(PNG)).toBe(true)
      expect(hits).toHaveLength(2)
      expect(hits[0].headers.authorization).toBe('Basic TOP-SECRET')
      expect(hits[1].headers.authorization).toBeUndefined()
    } finally { await stop() }
  })

  it('T5：默认白名单拒绝本地 / 恶意重定向；循环被 maxHops 截断', async () => {
    await start()
    try {
      await expect(followAttachmentDownload(
        url('/content/x'), () => ({}), { maxBytes: 1024 * 1024, retries: 0, fetchImpl }
      )).rejects.toThrow(/非 Atlassian 域名/)
      await expect(followAttachmentDownload(
        url('/redirect-evil/x'), () => ({}), { maxBytes: 1024 * 1024, retries: 0, fetchImpl }
      )).rejects.toThrow(/非 Atlassian 域名/)
      await expect(followAttachmentDownload(
        url('/loop/'), () => ({}),
        { maxBytes: 1024 * 1024, hostChecker: () => true, maxHops: 2, retries: 0, fetchImpl }
      )).rejects.toThrow(/重定向次数过多/)
    } finally { await stop() }
  })

  it('4xx 不重试（只发 1 次请求）', async () => {
    await start()
    hits = []
    try {
      await expect(followAttachmentDownload(
        url('/missing'), () => ({}),
        { maxBytes: 1024 * 1024, hostChecker: () => true, retries: 1, fetchImpl }
      )).rejects.toThrow('HTTP 404')
      expect(hits).toHaveLength(1)
    } finally { await stop() }
  })
})
