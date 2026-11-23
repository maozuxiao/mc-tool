import { describe, it, expect } from 'vitest'
import {
  IMAGE_READ_HINT, imageBatchBlockedResult, imageReadBlockedResult,
  isImageReadPath, splitImagePaths, withSkippedImages
} from '../imageReadGuard'

describe('isImageReadPath', () => {
  const images = [
    'C:/Users/u/Desktop/pic.png',
    'C:\\Users\\u\\Desktop\\PHOTO.JPG',
    'D:/a/b.jpeg', 'D:/a/b.gif', 'D:/a/b.webp', 'D:/a/b.bmp',
    'pic.png?token=abc', 'pic.png#frag'
  ]
  it('常见图片扩展名命中（含大小写 / Windows 斜杠 / querystring）', () => {
    for (const p of images) expect(isImageReadPath(p), p).toBe(true)
  })
  it('普通文件与无文件名不命中', () => {
    for (const p of ['report.xlsx', 'a.txt', 'a.pdf', 'C:/dir/', '', '   ']) {
      expect(isImageReadPath(p), p).toBe(false)
    }
  })
})

describe('拦截结果构造', () => {
  it('file_read 命中图片 → IMAGE_USE_VISION，带原路径与指引', () => {
    const r = imageReadBlockedResult('C:/x/a.png')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('IMAGE_USE_VISION')
    expect(r.path).toBe('C:/x/a.png')
    expect(r.error).toContain('直接看图')
    expect(r.error).toBe(IMAGE_READ_HINT)
  })

  it('file_read_batch 全为图片 → 不启动脚本，返回 skippedImages', () => {
    const r = imageBatchBlockedResult(['a.png', 'b.PNG'])
    expect(r.ok).toBe(false)
    expect(r.code).toBe('IMAGE_USE_VISION')
    expect(r.skippedImages).toEqual(['a.png', 'b.PNG'])
  })
})

describe('splitImagePaths / withSkippedImages', () => {
  it('混合列表拆成图片与非图片，保持原顺序', () => {
    const { images, others } = splitImagePaths(['a.xlsx', 'b.png', 'c.log', 'd.JPG'])
    expect(images).toEqual(['b.png', 'd.JPG'])
    expect(others).toEqual(['a.xlsx', 'c.log'])
  })

  it('批量结果保留原字段并追加 skippedImages 与 note', () => {
    const base = { ok: true, command: 'read_batch', count: 1, results: [{ ok: true, path: 'a.xlsx' }] }
    const out = withSkippedImages(base, ['b.png'])
    expect(out.ok).toBe(true)
    expect(out.count).toBe(1)
    expect(out.results).toEqual(base.results)
    expect(out.skippedImages).toEqual(['b.png'])
    expect(out.note).toContain('直接看图')
  })

  it('没有图片时原样返回', () => {
    const base = { ok: true, count: 2 }
    expect(withSkippedImages(base, [])).toBe(base)
  })
})
