import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import {
  copyImageToClipboard, copyImageErrorText, decodeDataUrlImage,
  MAX_COPY_IMAGE_BYTES, parseImageSource, readLocalImage, type CopyImageDeps
} from '../imageClipboard'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AL+2wAAAABJRU5ErkJggg=='
const DIR = mkdtempSync(join(tmpdir(), 'mc-imgclip-'))
afterAll(() => { try { rmSync(DIR, { recursive: true, force: true }) } catch { /* ignore */ } })

function mockDeps(bytes = Buffer.from('imagedata')): CopyImageDeps & { written: any[] } {
  const written: any[] = []
  return {
    written,
    fetchImpl: async () => Uint8Array.from(bytes).buffer,
    makeImage: () => ({ isEmpty: () => false }),
    writeImage: (img) => { written.push(img) }
  }
}

describe('parseImageSource', () => {
  it('识别 data / http / file，大小写不敏感', () => {
    expect(parseImageSource(`data:image/png;base64,${PNG_B64}`)?.kind).toBe('data')
    expect(parseImageSource('DATA:IMAGE/PNG;BASE64,xxx')?.kind).toBe('data')
    expect(parseImageSource('https://x/y.png?token=abc')?.kind).toBe('http')
    expect(parseImageSource('HTTP://x/y.png')?.kind).toBe('http')
    expect(parseImageSource(pathToFileURL(join(DIR, 'a.png')).href)?.kind).toBe('file')
  })
  it('保留 http 的鉴权参数原文，file 转成系统路径', () => {
    const http = parseImageSource('https://x/y.png?token=abc')
    expect(http?.value).toBe('https://x/y.png?token=abc')
    const f = join(DIR, 'a.png')
    expect(parseImageSource(pathToFileURL(f).href)?.value).toBe(f)
  })
  it('不支持的协议 / 空串返回 null', () => {
    for (const s of ['', '   ', 'about:blank', 'javascript:alert(1)', 'ftp://x/y.png']) {
      expect(parseImageSource(s)).toBeNull()
    }
  })
})

describe('decodeDataUrlImage / readLocalImage', () => {
  it('dataUrl 解出字节，非 dataUrl 返回 null', () => {
    const buf = decodeDataUrlImage(`data:image/png;base64,${PNG_B64}`)
    expect(buf?.length).toBeGreaterThan(0)
    expect(decodeDataUrlImage('https://x/y.png')).toBeNull()
    expect(decodeDataUrlImage('data:image/png;base64,')).toBeNull()
  })
  it('本地文件存在才读，目录 / 不存在返回 null', () => {
    const f = join(DIR, 'a.png')
    writeFileSync(f, Buffer.from('png'))
    expect(readLocalImage(f)?.toString()).toBe('png')
    expect(readLocalImage(DIR)).toBeNull()
    expect(readLocalImage(join(DIR, 'missing.png'))).toBeNull()
  })
})

describe('copyImageToClipboard', () => {
  it('dataUrl → 写入剪贴板，返回 kind=data 与字节数', async () => {
    const deps = mockDeps()
    const r = await copyImageToClipboard(`data:image/png;base64,${PNG_B64}`, deps)
    expect(r.ok).toBe(true)
    expect(r.kind).toBe('data')
    expect(r.bytes).toBeGreaterThan(0)
    expect(deps.written).toHaveLength(1)
  })

  it('http → 走注入的会话 fetch，保留 URL 原文', async () => {
    const deps = mockDeps()
    const r = await copyImageToClipboard('https://x/y.png?token=secret', deps)
    expect(r.ok).toBe(true)
    expect(r.kind).toBe('http')
    expect(deps.written).toHaveLength(1)
  })

  it('file → 读本地字节', async () => {
    const f = join(DIR, 'local.png')
    writeFileSync(f, Buffer.from('local-png'))
    const deps = mockDeps()
    const r = await copyImageToClipboard(pathToFileURL(f).href, deps)
    expect(r.ok).toBe(true)
    expect(r.kind).toBe('file')
  })

  it('不支持的来源 → BAD_SOURCE，不调用任何 API', async () => {
    const deps = mockDeps()
    const r = await copyImageToClipboard('javascript:alert(1)', deps)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('BAD_SOURCE')
    expect(deps.written).toHaveLength(0)
  })

  it('http fetch 失败 → DECODE_FAILED，不写剪贴板', async () => {
    const deps = mockDeps()
    deps.fetchImpl = async () => { throw new Error('HTTP 401') }
    const r = await copyImageToClipboard('https://x/y.png', deps)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('DECODE_FAILED')
    expect(deps.written).toHaveLength(0)
  })

  it('writeImage 抛错 → WRITE_FAILED', async () => {
    const deps = mockDeps()
    deps.writeImage = () => { throw new Error('clipboard busy') }
    const r = await copyImageToClipboard('https://x/y.png', deps)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('WRITE_FAILED')
  })

  it('nativeImage 判空 → DECODE_FAILED', async () => {
    const deps = mockDeps()
    deps.makeImage = () => ({ isEmpty: () => true })
    const r = await copyImageToClipboard('https://x/y.png', deps)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('DECODE_FAILED')
  })

  it('超限图片 → TOO_LARGE（>20MB 的 dataUrl）', async () => {
    const huge = 'data:image/png;base64,' + 'A'.repeat(Math.ceil(MAX_COPY_IMAGE_BYTES / 3 * 4) + 8)
    const r = await copyImageToClipboard(huge, mockDeps())
    expect(r.ok).toBe(false)
    expect(r.error).toBe('TOO_LARGE')
  })
})

describe('copyImageErrorText', () => {
  it('每个错误码都有非空中文提示', () => {
    for (const code of ['BAD_SOURCE', 'EMPTY', 'TOO_LARGE', 'DECODE_FAILED', 'WRITE_FAILED'] as const) {
      expect(copyImageErrorText(code).length).toBeGreaterThan(0)
    }
  })
})
