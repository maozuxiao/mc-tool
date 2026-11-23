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
  const image = { name: 'image.png', path: 'C:\\Users\\u\\AppData\\Roaming\\mc-material-query\\attachments\\1-1-image.png', kind: 'image' as const, mime: 'image/png' }
  const doc = { name: 'report.xlsx', path: 'C:\\Users\\u\\Documents\\report.xlsx', kind: 'file' as const }

  it('本轮普通文件提示点名路径并要求不要再索要', () => {
    const note = currentAttachNote([doc])
    expect(note).toContain('不要再向他索要路径')
    expect(note).toContain('jira_add_comment')
    expect(note).toContain('需要看内容时用 file_read')
    expect(note).toContain(doc.path)
    expect(currentAttachNote([])).toBe('')
  })

  it('本轮图片提示要求直接看图、禁止 file_read', () => {
    const note = currentAttachNote([image])
    expect(note).toContain(image.path)
    expect(note).toContain('直接看图')
    expect(note).toContain('禁止用 file_read')
    expect(note).not.toContain('需要看内容时用 file_read')
  })

  it('图片靠扩展名也能识别（旧历史数据没有 kind）', () => {
    const note = currentAttachNote([{ name: 'image.png', path: image.path }])
    expect(note).toContain('直接看图')
    expect(note).not.toContain('需要看内容时用 file_read')
  })

  it('混合列表分别给出两种提示', () => {
    const note = currentAttachNote([image, doc])
    expect(note).toContain('直接看图')
    expect(note).toContain('需要看内容时用 file_read')
    expect(note).toContain(image.path)
    expect(note).toContain(doc.path)
  })

  it('上一轮提示只在确认类短句时给出，图片同样禁止 file_read', () => {
    expect(previousAttachNote([doc], '确认')).toContain(doc.path)
    const note = previousAttachNote([image], '确认')
    expect(note).toContain(image.path)
    expect(note).toContain('禁止用 file_read')
    expect(previousAttachNote([doc], '再帮我查一下 ETESC-120 的 RDMS')).toBe('')
    expect(previousAttachNote([], '确认')).toBe('')
  })
})
