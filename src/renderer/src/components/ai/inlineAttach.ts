import type { AIAttachment } from '@shared/ai-types'

/**
 * 内联附件（chip）在 contenteditable 输入区里的纯逻辑。
 *
 * 设计要点（对齐 CodeBuddy 输入框的行为）：
 *  1. **结构**：正文是文本，chip 是插在文本某个字符位置上的 `contentEditable=false` 节点。
 *     这里用 `{ text, chips: [{ at, id }] }` 表达整段结构，复制/撤回都靠它还原；
 *  2. **不额外塞空格**：chip 与文字的间距交给 CSS（margin），避免「粘贴附件凭空多一个空格」；
 *  3. **去重只在一次粘贴内做**：同一个文件允许贴多份（用户明确要求），
 *     但同一次 paste 的 files 里重复出现的同一条要合并。
 */

/** 附件身份键：用于「同一次粘贴内」折叠重复条目 */
export function attachKey(a: Pick<AIAttachment, 'name' | 'size' | 'mime' | 'path'>): string {
  // 有本机绝对路径就以路径为准 —— Windows 路径大小写与斜杠方向都不该算作不同文件
  if (a.path) return `path:${a.path.replace(/\\/g, '/').toLowerCase()}`
  // 截图这类内存里的文件没有路径，退化为「文件名 + 大小 + mime」
  return `file:${a.name}:${a.size || 0}:${a.mime || ''}`
}

/**
 * 折叠**一次粘贴**里的重复条目。
 *
 * 注意不要跨次去重：用户确实可能想贴两份 README.md（对照两份稿子），
 * 跨次去重会让第二份「粘不进去」。重复芯片问题只出在一次 paste 内部重复投递。
 */
export function collapseBatch(list: AIAttachment[]): AIAttachment[] {
  const seen = new Set<string>()
  const out: AIAttachment[] = []
  for (const a of list) {
    const key = attachKey(a)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(a)
  }
  return out
}

/** chip 角标文字：优先显示扩展名（README.md → MD），没有扩展名再退回类型名 */
export function chipBadge(name: string, kind: AIAttachment['kind']): string {
  const m = /\.([a-z0-9]{1,6})$/i.exec(name || '')
  if (m) return m[1].toUpperCase().slice(0, 4)
  return kind === 'text' ? 'TXT' : kind === 'image' ? 'IMG' : 'FILE'
}

/** 一批附件共用的插入位置盒子（Range 是活的，用户继续打字时它会自己后移） */
export interface ChipRangeBox {
  range: Range | null
}

export interface InsertChipsOptions {
  /** 取某条附件所属批次的插入位置；没有则追加到末尾 */
  boxOf: (a: AIAttachment) => ChipRangeBox | undefined
  /** 造一个 chip DOM 节点 */
  makeChip: (a: AIAttachment) => HTMLElement
}

export interface InsertChipsResult {
  /** 最后一枚插入的 chip（用于把光标落到它后面） */
  tail: Node | null
  /** 是否至少有一枚是「按光标位置插入」的（拖拽追加的不算） */
  atCaret: boolean
}

/**
 * 把还没有 DOM 节点的附件补进编辑器。
 *
 * 每批附件用自己粘贴时记下的 Range 插入，同一批共用一个盒子并逐步推进 ——
 * 这样「连续粘贴两批」「压缩图片期间又打了字」都不会让后一批插到前一批的位置上。
 */
export function insertChips(
  ed: HTMLElement,
  atts: AIAttachment[],
  opts: InsertChipsOptions
): InsertChipsResult {
  let tail: Node | null = null
  let atCaret = false

  for (const a of atts) {
    if (ed.querySelector(`[data-attach-id="${a.id}"]`)) continue
    const chip = opts.makeChip(a)
    const box = opts.boxOf(a)
    const range = box?.range && ed.contains(box.range.startContainer) ? box.range : null

    if (range) {
      range.insertNode(chip)
      // 不额外插空格：间距由 CSS margin 负责（插空格会凭空多出一个字符）
      const next = document.createRange()
      next.setStartAfter(chip)
      next.collapse(true)
      if (box) box.range = next
      atCaret = true
    } else {
      ed.appendChild(chip)
    }
    tail = chip
  }

  return { tail, atCaret }
}

/** 附件在正文里的位置：落在第几个字符之后 */
export interface ChipAt {
  at: number
  id: string
}

/** 输入框的完整结构快照：正文 + chip 位置。复制、撤回都以它为准 */
export interface EditorStructure {
  text: string
  chips: ChipAt[]
}

/**
 * 读编辑器结构（正文 + chip 位置）。
 *
 * 不用 `innerText`：它对未挂载节点会退化成 textContent，换行全丢。
 * `<br>`/`<div>` 一律折算成 `\n`，chip 不占正文、只记位置。
 */
export function captureStructure(ed: Element | null): EditorStructure {
  if (!ed) return { text: '', chips: [] }
  return scan(ed, true)
}

/**
 * 统计一段 DOM（可以是 `DocumentFragment`）的正文长度，规则与 captureStructure 一致，
 * 但不做尾部换行裁剪 —— 计算选区的字符偏移必须精确到点位。
 */
export function measureText(node: Node | null): number {
  if (!node) return 0
  return scan(node, false).text.length
}

function scan(root: Node, trim: boolean): EditorStructure {
  let text = ''
  const chips: ChipAt[] = []

  const walk = (node: Node) => {
    node.childNodes.forEach(n => {
      if (n.nodeType === Node.TEXT_NODE) { text += (n as Text).data; return }
      if (!(n instanceof HTMLElement)) return
      if (n.dataset.attachId) { chips.push({ at: text.length, id: n.dataset.attachId }); return }
      if (n.tagName === 'BR') { text += '\n'; return }
      if (n.tagName === 'DIV' || n.tagName === 'P') {
        if (text && !text.endsWith('\n')) text += '\n'
        walk(n)
        return
      }
      walk(n)
    })
  }
  walk(root)

  // nbsp 还原成普通空格；末尾多余的换行去掉（contenteditable 常留一个尾随 <br>）
  text = text.replace(/\u00a0/g, ' ')
  if (trim) text = text.replace(/\n+$/, '')
  // 正文被裁短后，落在末尾之外的 chip 位置夹回来
  for (const c of chips) if (c.at > text.length) c.at = text.length
  return { text, chips }
}

/**
 * 从整段结构里切出 `[start, end)` 这一段（复制局部内容用）。
 *
 * 浏览器的选区拿不到 `user-select:none` 的 chip，所以复制时是「先按字符偏移切正文，
 * 再把落在区间里的 chip 按相对位置带上」。
 */
export function sliceStructure(st: EditorStructure, start: number, end: number): EditorStructure {
  const s = Math.max(0, Math.min(start, st.text.length))
  const e = Math.max(s, Math.min(end, st.text.length))
  // 空区间（光标塌陷在一点）没有可复制的内容，chip 也不带
  if (e <= s) return { text: '', chips: [] }
  return {
    text: st.text.slice(s, e),
    chips: st.chips.filter(c => c.at >= s && c.at <= e).map(c => ({ at: c.at - s, id: c.id }))
  }
}

/** 读编辑器里的纯文本（复制出去的内容就是它，chip 不参与） */
export function readEditorText(ed: HTMLElement | null): string {
  return captureStructure(ed).text
}

export interface InsertStructureOptions {
  /** 按 id 造 chip；返回 null 表示这条附件已经找不到了，跳过 */
  makeChip: (id: string) => HTMLElement | null
  /**
   * 插入位置。给了 Range 就替换选区后插入（粘贴语义），
   * 没给（或 Range 已经失效）则追加到末尾（撤回恢复语义）。
   */
  range?: Range | null
}

/**
 * 按结构快照把正文与 chip 一起写进编辑器。
 *
 * 复制粘贴回填、撤回恢复都走它 —— 保证「文字与 chip 的相对位置」原样保留。
 */
export function insertStructure(
  ed: HTMLElement,
  structure: EditorStructure,
  opts: InsertStructureOptions
): void {
  const frag = document.createDocumentFragment()
  const pending = structure.chips.slice().sort((a, b) => a.at - b.at)
  const text = structure.text
  let pendingIdx = 0
  let buf = ''

  const flushText = () => {
    if (!buf) return
    frag.appendChild(document.createTextNode(buf))
    buf = ''
  }
  const flushChips = (pos: number) => {
    while (pendingIdx < pending.length && pending[pendingIdx].at <= pos) {
      flushText()
      const chip = opts.makeChip(pending[pendingIdx].id)
      if (chip) frag.appendChild(chip)
      pendingIdx++
    }
  }

  for (let i = 0; i < text.length; i++) {
    flushChips(i)
    const ch = text[i]
    if (ch === '\n') {
      flushText()
      frag.appendChild(document.createElement('br'))
    } else {
      buf += ch
    }
  }
  flushChips(text.length)
  flushText()
  // 位置超出正文的 chip（老数据/异常数据）也别丢，接到末尾
  while (pendingIdx < pending.length) {
    const chip = opts.makeChip(pending[pendingIdx].id)
    if (chip) frag.appendChild(chip)
    pendingIdx++
  }

  const range = opts.range && ed.contains(opts.range.startContainer) ? opts.range : null
  if (range) {
    // insertNode 会把 fragment 的子节点搬走，末节点必须在插入前记下来
    const last = frag.lastChild
    range.deleteContents()
    range.insertNode(frag)
    if (last && last.parentNode) {
      const after = document.createRange()
      after.setStartAfter(last)
      after.collapse(true)
      const sel = window.getSelection()
      if (sel) { sel.removeAllRanges(); sel.addRange(after) }
    }
  } else {
    ed.appendChild(frag)
  }
}

/**
 * 编辑器里现存的 chip id 集合。
 *
 * 撤回（Ctrl+Z）会把 chip 节点一起撤掉，此时 `attachments` 里还留着它 ——
 * 用这个集合反查，把 DOM 里已经不存在的那几条从 state 里删掉，避免状态与界面不一致。
 */
export function presentAttachIds(ed: HTMLElement | null): Set<string> {
  const ids = new Set<string>()
  if (!ed) return ids
  ed.querySelectorAll('[data-attach-id]').forEach(n => {
    const id = (n as HTMLElement).dataset.attachId
    if (id) ids.add(id)
  })
  return ids
}

/**
 * 同一个 attachId 的 chip 只保留第一个，其余删掉。
 *
 * 兜底用：只要有一次粘贴漏过我们的拦截（浏览器默认 HTML 粘贴、或从旧剪贴板恢复），
 * DOM 里就会出现同一枚 chip 的副本；随后按 id 查重时只会命中第一个，剩下的变成
 * 「点不动、也删不掉」的僵尸节点 —— 也就是用户看到的重复 chip 与嵌套结构。
 */
export function dedupeChipNodes(ed: HTMLElement | null): number {
  if (!ed) return 0
  let removed = 0
  const seen = new Set<string>()
  ed.querySelectorAll('[data-attach-id]').forEach(n => {
    const id = (n as HTMLElement).dataset.attachId || ''
    if (!id) return
    if (seen.has(id)) { n.remove(); removed++ } else seen.add(id)
  })
  return removed
}

/** 按「DOM 里还在不在」过滤附件；全都还在时返回原数组（避免无谓的重渲染） */
export function pruneToPresent(atts: AIAttachment[], present: Set<string>): AIAttachment[] {
  if (!atts.some(a => !present.has(a.id))) return atts
  return atts.filter(a => present.has(a.id))
}

/** 光标落到编辑器末尾（粘贴/撤回重建后接着打字用） */
export function placeCaretAtEnd(ed: HTMLElement | null): void {
  if (!ed) return
  const r = document.createRange()
  r.selectNodeContents(ed)
  r.collapse(false)
  const sel = window.getSelection()
  if (!sel) return
  sel.removeAllRanges()
  sel.addRange(r)
}
