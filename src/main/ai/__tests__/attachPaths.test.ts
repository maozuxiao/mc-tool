import { describe, it, expect } from 'vitest'
import {
  currentAttachNote,
  decodeDataUrl,
  isConfirmFollowUp,
  mimeToExt,
  previousAttachNote,
  sanitizeAttachFileName
} from '../attachPaths'

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AL+2wAAAABJRU5ErkJggg=='

describe('sanitizeAttachFileName', () => {
  it('保留正常文件名与扩展名', () => {
    expect(sanitizeAttachFileName('image.png')).toBe('image.png')
    expect(sanitizeAttachFileName('截图 2026.PNG', 'image/png')).toBe('截图_2026.png')
  })

  it('去掉 Windows 非法字符与路径前缀', () => {
    expect(sanitizeAttachFileName('C:\\temp\\a<b>c:d"e.png')).toBe('a_b_c_d_e.png')
  })

  it('没有扩展名时按 mime 补齐', () => {
    expect(sanitizeAttachFileName('image', 'image/jpeg')).toBe('image.jpg')
    expect(sanitizeAttachFileName('image', 'application/octet-stream')).toBe('image')
  })

  it('超长名字被截断', () => {
    expect(sanitizeAttachFileName('a'.repeat(200) + '.png').length).toBeLessThanOrEqual(90)
  })
})

describe('decodeDataUrl', () => {
  it('解析 base64 dataUrl', () => {
    const dec = decodeDataUrl(PNG_1PX)
    expect(dec?.mime).toBe('image/png')
    expect(dec?.buf.length).toBeGreaterThan(0)
  })

  it('非 dataUrl / 空内容返回 null', () => {
    expect(decodeDataUrl('https://x/y.png')).toBeNull()
    expect(decodeDataUrl('data:image/png;base64,')).toBeNull()
    expect(decodeDataUrl(undefined)).toBeNull()
  })
})

describe('mimeToExt', () => {
  it('常见图片类型', () => {
    expect(mimeToExt('image/jpeg')).toBe('.jpg')
    expect(mimeToExt('image/webp')).toBe('.webp')
    expect(mimeToExt('text/plain')).toBe('')
  })
})

describe('isConfirmFollowUp', () => {
  it('短确认句命中', () => {
    for (const t of ['确认', '确认。', '好的', '可以提交', 'ok', 'Yes', '「确认」']) {
      expect(isConfirmFollowUp(t), t).toBe(true)
    }
  })

  it('带新内容的长句不继承附件', () => {
    expect(isConfirmFollowUp('确认，另外再帮我查一下 ETESC-133 现在的状态')).toBe(false)
    expect(isConfirmFollowUp('')).toBe(false)
  })
})

describe('附件路径提示', () => {
  const files = [{ name: 'image.png', path: 'C:\\Users\\u\\AppData\\Roaming\\mc-material-query\\attachments\\1-1-image.png' }]

  it('本轮提示点名路径并要求不要再索要', () => {
    const note = currentAttachNote(files)
    expect(note).toContain('不要再向他索要路径')
    expect(note).toContain('jira_add_comment')
    expect(note).toContain(files[0].path)
    expect(currentAttachNote([])).toBe('')
  })

  it('上一轮提示只在确认类短句时给出', () => {
    expect(previousAttachNote(files, '确认')).toContain(files[0].path)
    expect(previousAttachNote(files, '再帮我查一下 ETESC-120 的 RDMS')).toBe('')
    expect(previousAttachNote([], '确认')).toBe('')
  })
})
