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
// exceljs 逐工作表转 Markdown 表格。公式只给计算结果（cell.value.result），
// 避免把 {formula, result} 对象直接塞给模型。
async function readXlsx(abs) {
  const ExcelJS = require('exceljs')
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(abs)
  const blocks = []
  for (const ws of wb.worksheets) {
    if (ws.rowCount === 0) {
      blocks.push(`# 工作表：${ws.name}（空）`)
      continue
    }
    const rows = []
    ws.eachRow((row) => {
      const cells = []
      row.eachCell({ includeEmpty: true }, (cell) => {
        let v = cell.value
        if (v && typeof v === 'object') {
          if ('text' in v) v = v.text // RichText
          else if ('result' in v) v = v.result // 公式结果
          else if ('formula' in v) v = v.formula // 无结果的公式
          else if (v instanceof Date) v = v.toISOString().slice(0, 10)
          else v = JSON.stringify(v)
        }
        cells.push(v == null ? '' : String(v))
      })
      rows.push('| ' + cells.join(' | ') + ' |')
    })
    blocks.push(`# 工作表：${ws.name}（${ws.rowCount} 行 × ${ws.columnCount} 列）\n` + rows.join('\n'))
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

const READERS = {
  '.docx': readDocx,
  '.xlsx': readXlsx,
  '.pptx': readPptx,
  '.pdf': readPdf
}

function readerFor(ext) {
  return READERS[ext.toLowerCase()]
}

module.exports = { readDocx, readXlsx, readPptx, readPdf, readerFor }
