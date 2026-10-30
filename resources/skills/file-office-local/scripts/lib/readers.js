'use strict'
// 各格式的「文件 → 纯文本」解析。每个 reader 返回 { text, format, note? }，
// 上层统一负责截断与输出包装。库一律懒加载，避免读 txt 时也把 pdfjs 全加载进来。
const fs = require('fs')
const path = require('path')

// ── docx ───────────────────────────────────────────────────
// mammoth 把 docx 转纯文本（保留段落换行）。需要保留样式/表格时可用 .convertToHtml，
// 但模型读纯文本更直接，这里取 raw text。
async function readDocx(abs) {
  const mammoth = require('mammoth')
  const res = await mammoth.extractRawText({ path: abs })
  return { text: res.value || '', format: 'docx' }
}

// ── xlsx ───────────────────────────────────────────────────
// 用 SheetJS（xlsx）逐工作表转 Markdown 表格。公式单元格返回其缓存结果（有则），
// 无缓存时返回公式串；日期按 ISO 日期输出。复用 xlsx 后不再打包 exceljs（省 ~20MB）。
async function readXlsx(abs) {
  const XLSX = require('xlsx')
  const wb = XLSX.readFile(abs, { cellDates: true, cellNF: false })
  const blocks = []
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' })
    const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0)
    const cells = rows.map(r => r.map((c) => {
      if (c == null) return ''
      if (c instanceof Date) return c.toISOString().slice(0, 10)
      if (typeof c === 'object') return JSON.stringify(c)
      return String(c)
    }))
    const md = cells.map(r => '| ' + r.join(' | ') + ' |').join('\n')
    blocks.push(`# 工作表：${name}（${cells.length} 行 × ${maxCols} 列）\n` + md)
  }
  return { text: blocks.join('\n\n'), format: 'xlsx' }
}

// ── pptx ───────────────────────────────────────────────────
// pptx 本质是 zip：每页 ppt/slides/slideN.xml，文本在 <a:t> 标签里。
// 用 jszip 直接读 xml 取 <a:t>，比 pptxgenjs 更适合「只读」。
async function readPptx(abs) {
  const JSZip = require('jszip')
  const zip = await JSZip.loadAsync(fs.readFileSync(abs))
  const names = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const na = Number.parseInt(a.match(/slide(\d+)/)[1], 10)
      const nb = Number.parseInt(b.match(/slide(\d+)/)[1], 10)
      return na - nb
    })
  const blocks = []
  for (const name of names) {
    const xml = await zip.file(name).async('string')
    const texts = []
    const re = /<a:t>([\s\S]*?)<\/a:t>/g
    let m
    while ((m = re.exec(xml))) texts.push(m[1])
    if (texts.length) blocks.push(`## ${path.basename(name, '.xml')}\n` + texts.join('\n'))
  }
  return { text: blocks.join('\n\n'), format: 'pptx' }
}

// ── pdf ────────────────────────────────────────────────────
// pdfjs 在 Node 下自动选用 NodeCMapReaderFactory（走 fs，而非浏览器 fetch）。
// 只需把 cMapUrl / standardFontDataUrl 指向 pdfjs-dist 自带的绝对路径即可；
// 注意给正斜杠、不要 file:// 前缀（Node 版用 fs.readFile 读，file:// 反而解析失败）。
async function readPdf(abs) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js')
  const pkgDir = path.dirname(require.resolve('pdfjs-dist/package.json'))
  const cMapUrl = path.join(pkgDir, 'cmaps').replace(/\\/g, '/') + '/'
  const standardFontDataUrl = path.join(pkgDir, 'standard_fonts').replace(/\\/g, '/') + '/'

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(abs)),
    disableFontFace: true,
    isEvalSupported: false,
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl
  }).promise

  const blocks = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    const line = content.items.map((it) => it.str || '').join(' ')
    blocks.push(`## 第 ${p} 页 / 共 ${doc.numPages} 页\n${line}`)
  }
  return { text: blocks.join('\n\n'), format: 'pdf' }
}

// ── xls ────────────────────────────────────────────────────
// 老版 Excel（.xls，BIFF 二进制格式）。exceljs 只能读写 .xlsx，无法读 .xls，
// 这里改用 SheetJS（xlsx 社区版，纯 JS）读取，再转 CSV 文本交给模型。
async function readXls(abs) {
  const XLSX = require('xlsx')
  const wb = XLSX.readFile(abs, { cellDates: true, cellNF: false })
  const blocks = []
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]
    const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false })
    const rows = csv.split(/\r?\n/).filter(Boolean).length
    blocks.push(`# 工作表：${name}（${rows} 行）\n${csv}`)
  }
  return { text: blocks.join('\n\n'), format: 'xls' }
}

// ── 通用：zip 里的 XML → 纯文本 ─────────────────────────────
// ODF（odt/ods/odp）与 EPUB 都是「zip + XML」，正文标记各不相同但结构一致：
// 段落/标题/表格行是块级边界，单元格是水平分隔。这里一次性归一化成纯文本。
const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' }

function xmlToText(xml) {
  return String(xml)
    .replace(/<text:(p|h)\b[^>]*\/>/gi, '\n')                       // 空段落
    .replace(/<\/(text:p|text:h)>/gi, '\n')                         // 段落/标题结束
    .replace(/<text:line-break\s*\/>/gi, '\n')
    .replace(/<text:tab\s*\/>/gi, '\t')
    .replace(/<\/table:table-cell>/gi, '\t')
    .replace(/<\/table:table-row>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '\t')                                 // HTML 表格：单元格横向分隔
    .replace(/<\/(p|div|li|h[1-6]|tr|section)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, e) => {
      const v = XML_ENTITIES[e.toLowerCase()]
      return v === undefined ? m : v
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── odt / ods / odp / epub ─────────────────────────────────
async function readOdf(abs) {
  const JSZip = require('jszip')
  const ext = path.extname(abs).toLowerCase()
  const zip = await JSZip.loadAsync(fs.readFileSync(abs))

  if (ext === '.epub') {
    // 按文件名自然排序（chapter2 在 chapter10 之前），逐章拼正文
    const names = Object.keys(zip.files)
      .filter((f) => /\.x?html?$/i.test(f))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    const blocks = []
    for (const n of names) {
      const body = xmlToText(await zip.file(n).async('string'))
      if (body) blocks.push(`## ${path.basename(n)}\n${body}`)
    }
    return { text: blocks.join('\n\n'), format: 'epub', note: `共 ${names.length} 个章节文件` }
  }

  const content = zip.file('content.xml')
  if (!content) throw new Error('压缩包里没有 content.xml（不是有效的 OpenDocument 文件）')
  return { text: xmlToText(await content.async('string')), format: ext.slice(1) }
}

// ── rtf ────────────────────────────────────────────────────
// RTF 是带嵌套组的纯文本格式：正文在外面，字体表/颜色表/图片等放在 {\fonttbl...} 之类的组里。
// 正则剥不干净（组可以嵌套），所以用一个小的深度扫描器：遇到要跳过的组就整组丢掉。
const RTF_SKIP_GROUPS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'themedata',
  'colorschememapping', 'datastore', 'latentstyles', 'listtable', 'listoverridetable',
  'rsidtbl', 'generator', 'xmlnstbl', 'filetbl', 'revtbl', 'pn', 'listtext', 'bkmkstart', 'bkmkend'
])

function readRtf(abs) {
  const raw = fs.readFileSync(abs).toString('latin1')
  let iconv = null
  try { iconv = require('iconv-lite') } catch { /* 无 iconv 时非 ASCII 字节只能按 latin1 输出 */ }
  let encoding = 'gbk'                             // 中文 RTF 绝大多数声明 \ansicpg936

  let out = ''
  let depth = 0
  let skipAt = -1                                  // >=0 表示当前处在被跳过的组里（记录其深度）
  let ucSkip = 1                                   // \uN 之后最多要吃掉的替代字符数
  let hex = []                                     // 连续 \'hh 攒成字节串再按代码页解码（中文是 2 字节）

  const flushHex = () => {
    if (!hex.length) return
    const buf = Buffer.from(hex)
    hex = []
    out += iconv ? iconv.decode(buf, encoding) : buf.toString('latin1')
  }
  const emit = (s) => { flushHex(); out += s }

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '{') { depth++; continue }
    if (ch === '}') {
      depth--
      if (skipAt > depth) skipAt = -1
      continue
    }
    if (ch === '\\') {
      const next = raw[i + 1]
      // \\ \{ \} ：转义出来的字面量字符
      if (next === '\\' || next === '{' || next === '}') {
        if (skipAt < 0) emit(next)
        i++
        continue
      }
      // \'hh：一个字节的十六进制（中文正文最常走这条）
      if (next === "'") {
        const h = raw.slice(i + 2, i + 4)
        i += 3
        if (skipAt < 0 && /^[0-9a-f]{2}$/i.test(h)) hex.push(parseInt(h, 16))
        continue
      }
      // 控制字：字母串 + 可选数字 + 一个空格分隔符
      let j = i + 1
      let word = ''
      while (j < raw.length && /[a-zA-Z]/.test(raw[j])) { word += raw[j]; j++ }
      let num = ''
      if (raw[j] === '-') { num += '-'; j++ }
      while (j < raw.length && /[0-9]/.test(raw[j])) { num += raw[j]; j++ }
      if (raw[j] === ' ') j++
      i = j - 1

      if (word === '*') { skipAt = depth; continue }
      if (RTF_SKIP_GROUPS.has(word.toLowerCase())) { skipAt = depth; continue }
      if (skipAt >= 0) continue

      if (word === 'par' || word === 'line' || word === 'row') emit('\n')
      else if (word === 'tab' || word === 'cell') emit('\t')
      else if (word === 'uc') ucSkip = Number(num || 1)
      else if (word === 'ansicpg') encoding = String(num) === '936' ? 'gbk' : 'win1252'
      else if (word === 'u') {
        // \uN? 里 N 是有符号 16 位码位，负数要加 65536；
        // 后面紧跟 ucSkip 个「替代字符」（通常一个 '?'），要跳过
        const code = Number(num)
        if (Number.isFinite(code)) emit(String.fromCharCode(code < 0 ? code + 65536 : code))
        i += ucSkip
      }
      continue
    }
    if (ch === '\r' || ch === '\n') continue
    if (skipAt >= 0) continue
    emit(ch)
  }
  flushHex()

  const text = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return { text, format: 'rtf' }
}

// ── 老版 Office 二进制（.doc / .ppt）────────────────────────
// 现实里企业内网的 .doc 往往根本不是 OLE 二进制：OA 另存为 HTML、Word 另存为 RTF、
// 甚至直接改了扩展名的 docx 都很常见。先按「真实容器」判断，能精确读的就精确读，
// 真正的 OLE 二进制才退化为「按 UTF-16 文本段尽力抽取」。
function looksLikeOle(buf) {
  return buf.length > 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0
}

/** 与 file_office.js 的 decodeText 同策略（BOM → UTF-8 → GBK 兜底）；此处独立实现，避免循环依赖 */
function decodeBuffer(buf) {
  let iconv = null
  try { iconv = require('iconv-lite') } catch { /* 未装 iconv 就只按 UTF-8 解 */ }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString('utf8').replace(/^﻿/, '')
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le')
  const utf8 = buf.toString('utf8')
  const bad = (utf8.match(/\uFFFD/g) || []).length
  if (bad && iconv) {
    const gbk = iconv.decode(buf, 'gbk')
    if ((gbk.match(/\uFFFD/g) || []).length < bad) return gbk
  }
  return utf8
}

function extractUtf16Runs(buf) {
  const runs = []
  let cur = ''
  const push = () => {
    const s = cur.replace(/[\r\n\t]+/g, ' ').trim()
    if (s.length >= 6 && /[\u4e00-\u9fff\w]/.test(s)) runs.push(s)
    cur = ''
  }
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const code = buf.readUInt16LE(i)
    const printable =
      (code >= 0x20 && code <= 0x7e) ||
      code === 0x09 || code === 0x0d ||
      (code >= 0x4e00 && code <= 0x9fff) ||          // CJK 基本区
      (code >= 0x3000 && code <= 0x303f) ||          // CJK 标点
      (code >= 0xff00 && code <= 0xffef)             // 全角字符
    if (printable) cur += String.fromCharCode(code)
    else push()
  }
  push()
  // 上限兜底：老文档里混着大量二进制碎片，抽出来的量可能远超模型上下文
  return runs.join('\n').slice(0, 400 * 1024)
}

async function readLegacyDoc(abs) {
  const buf = fs.readFileSync(abs)
  if (buf.length > 2 && buf[0] === 0x50 && buf[1] === 0x4b) {
    const r = await readDocx(abs)
    return { ...r, format: 'docx', note: '扩展名是 .doc，实际是 docx 容器，已按 docx 精确读取' }
  }
  if (buf.slice(0, 5).toString('latin1') === '{\\rtf') {
    return { ...readRtf(abs), format: 'rtf', note: '扩展名是 .doc，实际是 RTF，已按 RTF 精确读取' }
  }
  const head = buf.slice(0, 4096).toString('latin1').toLowerCase()
  if (head.includes('<html') || head.includes('word.document') || head.includes('urn:schemas-microsoft-com:office:word')) {
    return {
      text: xmlToText(decodeBuffer(buf)),
      format: 'html',
      note: '扩展名是 .doc，实际是 HTML（OA 导出的常见形态），已按 HTML 提取正文'
    }
  }
  if (!looksLikeOle(buf)) {
    // 既不是 zip/rtf/html，也不是 OLE：可能是纯文本被改名，直接按文本返回
    const plain = decodeBuffer(buf)
    if (!plain.includes('\uFFFD')) return { text: plain, format: 'text' }
  }
  const text = extractUtf16Runs(buf)
  if (!text) {
    throw new Error('老版 .doc（OLE 二进制）里没有抽取到正文，请用 Word/WPS 另存为 .docx 后再读')
  }
  return {
    text,
    format: 'doc',
    note: '老版 .doc 二进制格式：按 UTF-16 文本段尽力抽取，段落顺序、表格结构与图片可能缺失'
  }
}

async function readLegacyPpt(abs) {
  const buf = fs.readFileSync(abs)
  if (buf.length > 2 && buf[0] === 0x50 && buf[1] === 0x4b) {
    const r = await readPptx(abs)
    return { ...r, format: 'pptx', note: '扩展名是 .ppt，实际是 pptx 容器，已按 pptx 精确读取' }
  }
  const text = extractUtf16Runs(buf)
  if (!text) {
    throw new Error('老版 .ppt（OLE 二进制）里没有抽取到正文，请用 PowerPoint/WPS 另存为 .pptx 后再读')
  }
  return { text, format: 'ppt', note: '老版 .ppt 二进制格式：按 UTF-16 文本段尽力抽取，页序与版式可能不完整' }
}

const READERS = {
  // OOXML 家族（含启用宏 / 模板变体，容器结构一致，直接复用）
  '.docx': readDocx,
  '.docm': readDocx,
  '.dotx': readDocx,
  '.dotm': readDocx,
  '.xlsx': readXlsx,
  '.xlsm': readXlsx,
  '.xltx': readXlsx,
  '.xltm': readXlsx,
  '.xls': readXls,
  '.pptx': readPptx,
  '.pptm': readPptx,
  '.ppsx': readPptx,
  '.potx': readPptx,
  '.pdf': readPdf,
  // OpenDocument / 电子书
  '.odt': readOdf,
  '.ods': readOdf,
  '.odp': readOdf,
  '.epub': readOdf,
  // 富文本 / 老版二进制（含改名的 docx/rtf/html）
  '.rtf': readRtf,
  '.doc': readLegacyDoc,
  '.dot': readLegacyDoc,
  '.ppt': readLegacyPpt
}

function readerFor(ext) {
  return READERS[ext.toLowerCase()]
}

/** 支持的读取格式（报错信息与工具描述共用，避免两处各写一份漏掉新增项） */
const SUPPORTED_FORMATS = Object.keys(READERS)

module.exports = {
  readDocx, readXlsx, readXls, readPptx, readPdf, readOdf, readRtf, readLegacyDoc, readLegacyPpt,
  readerFor, SUPPORTED_FORMATS
}
