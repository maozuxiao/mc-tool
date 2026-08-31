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

const READERS = {
  '.docx': readDocx,
  '.xlsx': readXlsx,
  '.xls': readXls,
  '.pptx': readPptx,
  '.pdf': readPdf
}

function readerFor(ext) {
  return READERS[ext.toLowerCase()]
}

module.exports = { readDocx, readXlsx, readXls, readPptx, readPdf, readerFor }
