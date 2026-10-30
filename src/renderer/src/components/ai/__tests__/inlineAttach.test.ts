import { describe, it, expect, beforeEach } from 'vitest'
import type { AIAttachment } from '@shared/ai-types'
import {
  attachKey,
  collapseBatch,
  chipBadge,
  insertChips,
  dedupeChipNodes,
  captureStructure,
  insertStructure,
  measureText,
  sliceStructure,
  readEditorText,
  presentAttachIds,
  pruneToPresent,
  type ChipRangeBox
} from '../inlineAttach'

/**
 * 内联附件输入区的核心用例：复制 / 粘贴 / 撤回。
 *
 * 对应的用户反馈：
 *  1. README.md 的角标显示成 TXT → 应该是 MD（chipBadge）；
 *  2. 同一个文件要能贴多份 → 只在一次粘贴内部折叠重复；
 *  3. 复制输入框内容再粘贴，内容不能丢 → 结构快照能原样还原（含 chip）；
 *  4. Ctrl+Z 要有确定行为 → 撤回用「结构快照」整体还原（纯逻辑见 capture/insertStructure）；
 *  5. 粘贴内联附件不能凭空多空格 → chip 前后不再插空格节点。
 */

const att = (id: string, name: string, extra: Partial<AIAttachment> = {}): AIAttachment => ({
  id,
  name,
  kind: 'text',
  ...extra
})

const makeChip = (a: AIAttachment): HTMLElement => {
  const el = document.createElement('span')
  el.dataset.attachId = a.id
  el.contentEditable = 'false'
  el.textContent = a.name
  return el
}

const makeEditor = (text: string): HTMLElement => {
  const ed = document.createElement('div')
  ed.contentEditable = 'true'
  if (text) ed.appendChild(document.createTextNode(text))
  document.body.appendChild(ed)
  return ed
}

const caret = (node: Node, offset: number): Range => {
  const r = document.createRange()
  r.setStart(node, offset)
  r.collapse(true)
  return r
}

/** 把编辑器结构拍平成「文本片段 | chipId」序列，便于断言顺序 */
const layout = (ed: HTMLElement): string[] =>
  Array.from(ed.childNodes).map(n =>
    n.nodeType === Node.TEXT_NODE
      ? JSON.stringify((n as Text).data)
      : (n as HTMLElement).dataset.attachId || `<${(n as HTMLElement).tagName}>`
  )

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('1. 角标按扩展名显示（markdown 不再是 TXT）', () => {
  it('常见后缀直接显示真实类型', () => {
    expect(chipBadge('README.md', 'text')).toBe('MD')
    expect(chipBadge('rules.txt', 'text')).toBe('TXT')
    expect(chipBadge('data.json', 'text')).toBe('JSON')
    expect(chipBadge('报告.xlsx', 'file')).toBe('XLSX')
    expect(chipBadge('手册.pdf', 'file')).toBe('PDF')
  })

  it('没有扩展名时退回类型名', () => {
    expect(chipBadge('Makefile', 'text')).toBe('TXT')
    expect(chipBadge('某个二进制', 'file')).toBe('FILE')
  })
})

describe('2. 同一个文件可以贴多份，但一次粘贴内部不重复', () => {
  it('一次粘贴里重复投递的同一条文件被折叠成 1 条', () => {
    const same = att('a1', 'README.md', { path: 'E:\\资料\\server-kit\\README.md', size: 51 })
    const batch = collapseBatch([same, { ...same, id: 'a2' }, { ...same, id: 'a3' }])
    expect(batch.map(a => a.id)).toEqual(['a1'])
  })

  it('两次粘贴（两个批次）各自保留 —— 多个实例是允许的', () => {
    const p = 'E:\\资料\\server-kit\\README.md'
    let list: AIAttachment[] = []
    list = [...list, ...collapseBatch([att('a1', 'README.md', { path: p })])]
    list = [...list, ...collapseBatch([att('a2', 'README.md', { path: p })])]
    expect(list.map(a => a.id)).toEqual(['a1', 'a2'])
  })

  it('Windows 路径大小写/斜杠不同的同一条仍算重复', () => {
    const a = att('a1', 'README.md', { path: 'E:\\资料\\README.md' })
    const b = att('a2', 'README.md', { path: 'e:/资料/readme.md' })
    expect(attachKey(a)).toBe(attachKey(b))
    expect(collapseBatch([a, b])).toHaveLength(1)
  })

  it('同名不同目录是两条', () => {
    const a = att('a1', 'README.md', { path: 'E:\\A\\README.md' })
    const b = att('a2', 'README.md', { path: 'E:\\B\\README.md' })
    expect(collapseBatch([a, b])).toHaveLength(2)
  })
})

describe('5. 粘贴内联附件不会凭空多空格', () => {
  it('chip 插入后不产生空白文本节点', () => {
    const ed = makeEditor('abcd')
    insertChips(ed, [att('a1', 'README.md')], {
      boxOf: () => ({ range: caret(ed.firstChild as Text, 2) }),
      makeChip
    })
    expect(layout(ed)).toEqual(['"ab"', 'a1', '"cd"'])
    expect(readEditorText(ed)).toBe('abcd')
  })

  it('连续插入多枚 chip 也不会累积空格', () => {
    const ed = makeEditor('XY')
    const box: ChipRangeBox = { range: caret(ed.firstChild as Text, 1) }
    insertChips(ed, [att('a1', '1.md'), att('a2', '2.md')], { boxOf: () => box, makeChip })
    expect(readEditorText(ed)).toBe('XY')
    expect(layout(ed).filter(x => x.startsWith('a'))).toEqual(['a1', 'a2'])
  })
})

describe('3. 复制：即使选区只框住一句话，也要带上中间的 chip', () => {
  it('measureText 统计正文长度时跳过 chip、把 <br> 记 1 个字符', () => {
    const ed = document.createElement('div')
    ed.appendChild(document.createTextNode('ab'))
    ed.appendChild(makeChip(att('a1', 'x.md')))
    ed.appendChild(document.createElement('br'))
    ed.appendChild(document.createTextNode('cd'))
    document.body.appendChild(ed)
    expect(measureText(ed)).toBe(5)
    expect(measureText(null)).toBe(0)
  })

  it('按字符区间切片：正文与 chip 相对位置都跟着裁', () => {
    const st = {
      text: '第一段中间第二段',
      chips: [
        { at: 3, id: 'a1' },
        { at: 8, id: 'a2' }
      ]
    }
    expect(sliceStructure(st, 0, 5)).toEqual({
      text: '第一段中间',
      chips: [{ at: 3, id: 'a1' }]
    })
    expect(sliceStructure(st, 3, 9)).toEqual({
      text: '中间第二段',
      chips: [
        { at: 0, id: 'a1' },
        { at: 5, id: 'a2' }
      ]
    })
  })

  it('区间越界时夹到正文长度，不会抛错', () => {
    const st = { text: 'abc', chips: [{ at: 3, id: 'a1' }] }
    expect(sliceStructure(st, -5, 99).text).toBe('abc')
    expect(sliceStructure(st, 9, 12)).toEqual({ text: '', chips: [] })
  })
})

describe('3. 复制 → 粘贴：正文与 chip 原样还原', () => {
  it('结构快照记录 chip 落在第几个字符之后', () => {
    const ed = makeEditor('前面后面')
    insertChips(ed, [att('a1', 'README.md')], {
      boxOf: () => ({ range: caret(ed.firstChild as Text, 2) }),
      makeChip
    })
    expect(captureStructure(ed)).toEqual({ text: '前面后面', chips: [{ at: 2, id: 'a1' }] })
  })

  it('粘到另一个输入区（新 id）后结构一致，不会「内容消失」', () => {
    const src = makeEditor('第一段\n第二段')
    const textNode = src.firstChild as Text
    insertChips(src, [att('old', 'README.md')], { boxOf: () => ({ range: caret(textNode, 3) }), makeChip })
    const snap = captureStructure(src)

    // 模拟粘贴：老 id 换成新 id
    const dst = makeEditor('')
    insertStructure(dst, { text: snap.text, chips: snap.chips.map(c => ({ ...c, id: 'new' })) }, {
      makeChip: id => (id === 'new' ? makeChip(att('new', 'README.md')) : null)
    })

    expect(captureStructure(dst)).toEqual({ text: '第一段\n第二段', chips: [{ at: 3, id: 'new' }] })
    expect(dst.querySelectorAll('[data-attach-id]')).toHaveLength(1)
  })

  it('粘贴到已有内容中间时替换选区，文字与 chip 顺序正确', () => {
    const ed = makeEditor('左XY右')
    const t = ed.firstChild as Text
    const sel = caret(t, 1)                                  // 选中 X、Y 两个字符
    sel.setEnd(t, 3)

    insertStructure(ed, { text: '插入', chips: [{ at: 1, id: 'n1' }] }, {
      range: sel,
      makeChip: () => makeChip(att('n1', 'note.md'))
    })

    expect(readEditorText(ed)).toBe('左插入右')
    expect(layout(ed)).toEqual(['"左"', '"插"', 'n1', '"入"', '"右"'])
  })

  it('正文里的换行还原成 <br>，不压成一行', () => {
    const ed = makeEditor('')
    insertStructure(ed, { text: 'A\nB', chips: [] }, { makeChip: () => null })
    expect(layout(ed)).toEqual(['"A"', '<BR>', '"B"'])
    expect(readEditorText(ed)).toBe('A\nB')
  })
})

describe('4. 撤回：按快照整体还原（正文 + chip + 附件）', () => {
  it('回到上一个快照即可把 chip 与被删文字一起还原', () => {
    // 快照 1：只有文字
    const ed = makeEditor('abc')
    const snap1 = captureStructure(ed)

    // 用户接着粘贴了一枚 chip
    insertChips(ed, [att('a1', 'x.md')], { boxOf: () => ({ range: caret(ed.firstChild as Text, 3) }), makeChip })
    const snap2 = captureStructure(ed)
    expect(snap2.chips).toHaveLength(1)

    // 撤回：清空后按 snap1 还原
    ed.innerHTML = ''
    insertStructure(ed, snap1, { makeChip: () => null })

    expect(captureStructure(ed)).toEqual({ text: 'abc', chips: [] })
    expect(ed.querySelectorAll('[data-attach-id]')).toHaveLength(0)
  })

  it('撤回后附件列表与被撤掉的 chip 一致', () => {
    const ed = makeEditor('abc')
    const list = [att('a1', 'x.md'), att('a2', 'y.md')]
    const box: ChipRangeBox = { range: caret(ed.firstChild as Text, 3) }
    insertChips(ed, list, { boxOf: () => box, makeChip })

    // 撤销其中一枚（等价于撤回到一个不含它的快照）
    ed.querySelector('[data-attach-id="a2"]')!.remove()
    const pruned = pruneToPresent(list, presentAttachIds(ed))

    expect(pruned.map(a => a.id)).toEqual(['a1'])
  })

  it('没有变化时返回原数组（避免无谓重渲染）', () => {
    const list = [att('a1', 'x.md')]
    expect(pruneToPresent(list, new Set(['a1']))).toBe(list)
  })
})

describe('3b. 重复 chip 节点自愈（默认 HTML 粘贴留下的僵尸副本）', () => {
  it('同一 attachId 只保留第一个节点', () => {
    const ed = makeEditor('abc')
    const dup = att('a1', 'README.md')
    ed.appendChild(makeChip(dup))
    ed.appendChild(makeChip(dup))
    ed.appendChild(makeChip(att('a2', 'other.md')))

    expect(dedupeChipNodes(ed)).toBe(1)
    expect(ed.querySelectorAll('[data-attach-id]')).toHaveLength(2)
    expect(ed.querySelectorAll('[data-attach-id="a1"]')).toHaveLength(1)
  })

  it('没有重复时不改动 DOM', () => {
    const ed = makeEditor('abc')
    ed.appendChild(makeChip(att('a1', 'x.md')))
    expect(dedupeChipNodes(ed)).toBe(0)
  })
})

describe('粘贴/撤回的通用约束', () => {
  it('chip 落在光标处，不是排到末尾', () => {
    const ed = makeEditor('abcd')
    const res = insertChips(ed, [att('a1', 'README.md')], {
      boxOf: () => ({ range: caret(ed.firstChild as Text, 2) }),
      makeChip
    })
    expect(layout(ed)).toEqual(['"ab"', 'a1', '"cd"'])
    expect(res.atCaret).toBe(true)
  })

  it('光标位置失效时追加到末尾，不丢附件', () => {
    const ed = makeEditor('abc')
    const stale: ChipRangeBox = { range: caret(document.createTextNode('gone'), 0) }
    const res = insertChips(ed, [att('a1', 'x.md')], { boxOf: () => stale, makeChip })
    expect(layout(ed)).toEqual(['"abc"', 'a1'])
    expect(res.atCaret).toBe(false)
  })

  it('重复调用不会把同一枚 chip 插两次', () => {
    const ed = makeEditor('abc')
    const box: ChipRangeBox = { range: caret(ed.firstChild as Text, 3) }
    const list = [att('a1', 'x.md')]
    insertChips(ed, list, { boxOf: () => box, makeChip })
    insertChips(ed, list, { boxOf: () => box, makeChip })
    expect(ed.querySelectorAll('[data-attach-id]')).toHaveLength(1)
  })

  it('读正文时 chip 不参与，nbsp 还原成空格', () => {
    const ed = document.createElement('div')
    ed.appendChild(document.createTextNode('第一行'))
    ed.appendChild(document.createElement('br'))
    ed.appendChild(document.createTextNode('第二行\u00a0结束'))
    ed.appendChild(makeChip(att('a1', 'README.md')))
    document.body.appendChild(ed)
    expect(readEditorText(ed)).toBe('第一行\n第二行 结束')
  })
})
