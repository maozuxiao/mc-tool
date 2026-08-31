#!/usr/bin/env node
'use strict'
/**
 * file-office-local 统一入口
 *
 * 用法：
 *   node file_office.js <command> [args...] [--root <目录>] [--extra-root <别名>|<目录> ...] [--json]
 *
 * 命令：
 *   ping                                 健康检查，报告各格式依赖加载状态
 *   read  <path> [--offset N] [--limit N] [--max-bytes N]
 *                                       读文本 / docx / xlsx / xls / pptx / pdf
 *   list  <dir> [--depth N]             列目录
 *   search <词> [<dir>] [--name-only] [--regex] [--glob <文件名通配符>] [--ext <ext,...>] [--depth N] [--max-results N] [--index] [--rebuild-index]
 *                                       按文件名 / 内容搜索（内容覆盖 xlsx/xls/docx/pptx/pdf，xlsx 命中定位到 sheet+行号）。
 *                                       默认不使用缓存索引，每次直接读取文件；加 --index 启用索引缓存（按 hash+版本校验），命中缓存却零命中时自动全量兜底重扫防漏查；--rebuild-index 强制忽略旧缓存重建。
 *   write <path> [--content <文本>] [--append] [--update]
 *                                       写文本类文件（md/txt/csv/json...）；电子表格 --update 时 content 为 JSON { key, rows } 原地按关键列回填
 *   read_batch <path1> [path2 ...] [--path <p> ...]
 *                                       一次读取多个文件（最多 12 个），返回结果数组
 *
 * 全局选项：
 *   --root <目录>            主工作区根目录（别名留空），所有裸相对路径相对它解析
 *   --extra-root <别名>|<目录>
 *                            额外可访问目录（可重复），模型用「别名/路径」引用其中文件
 *   --json                   以 ===JSON_BEGIN===/===JSON_END=== 包裹输出结构化结果
 *
 * 多根沙箱：每个路径先按「别名/…」前缀定位到对应根，再交给 lib/sandbox 的 resolveSafe
 * 做单根 containment 校验。越界一律返回 PATH_OUTSIDE_ROOT。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { SandboxError, resolveSafe } = require('./lib/sandbox')
const { readerFor } = require('./lib/readers')

const DEFAULT_MAX_BYTES = 200 * 1024 // 单次读取上限，避免撑爆模型上下文
const HARD_MAX_BYTES = 2 * 1024 * 1024 // 无论如何不超过 2MB
const BATCH_MAX_FILES = 12
const BATCH_PER_FILE_BYTES = 120 * 1024
// 这些二进制格式暂时只能「读」，write 还没实现生成，避免写出无效文件。
// xlsx / xls 已支持生成（见 writeSpreadsheet），故不在其中。
const WRITE_UNSUPPORTED = new Set(['.docx', '.pptx', '.pdf', '.doc', '.ppt'])

// ── 输出协议 ──────────────────────────────────────────────
function printJson(obj) {
  console.log('===JSON_BEGIN===')
  console.log(JSON.stringify(obj))
  console.log('===JSON_END===')
}

class CommandError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'CommandError'
    this.code = code || 'COMMAND_FAILED'
  }
}

// ── 参数解析 ──────────────────────────────────────────────
function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') continue
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const eq = key.indexOf('=')
      let k = key
      let v = true
      if (eq > -1) {
        v = key.slice(eq + 1)
        k = key.slice(0, eq)
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        v = argv[++i]
      }
      // 重复出现的 flag 收成数组（如多个 --extra-root / --path）
      if (Object.prototype.hasOwnProperty.call(flags, k)) {
        if (!Array.isArray(flags[k])) flags[k] = [flags[k]]
        flags[k].push(v)
      } else {
        flags[k] = v
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

function toInt(v, fallback) {
  const n = Number.parseInt(String(v), 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

// ── 多根解析 ──────────────────────────────────────────────
// 把「别名/子路径」解析成 { root, rest }；无别名前缀时回退主根（alias=''）或唯一根。
function pickRoot(target, roots) {
  const raw = String(target || '')
  // 显式绝对路径（含盘符，如 C:/Users/.../报告.xlsx；或 Unix 风格以 / 开头）一律按 OpenCode 模式处理：
  // 直接放行给 resolveSafe 做最终校验（仅拦截受保护系统目录），由它决定是否落在已授权目录内。
  // 这样即使会话内已 open_folder 多个别名目录、导致「多根且无主根」，用户给的完整绝对路径也不会被
  // 误判为 AMBIGUOUS_ROOT（之前出现过：关掉 Excel 后重试用绝对路径写入却因多别名而报 AMBIGUOUS_ROOT）。
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/')) {
    return { root: '', rest: raw }
  }
  // OpenCode 模式：未指定任何可访问目录时，允许直接使用本机任意绝对路径
  // （如 C:/Users/.../报告.xlsx、D:/共享/出货.xlsx），相对路径解析到进程 cwd。
  if (roots.length === 0) {
    return { root: '', rest: raw }
  }
  const s = raw.replace(/\\/g, '/')
  const m = s.match(/^([^/]+)\/(.*)$/)
  if (m) {
    const alias = m[1]
    const found = roots.find(r => r.alias === alias)
    if (found) return { root: found.path, rest: m[2] || '.' }
  }
  // 整个 target 恰好等于某别名（无斜杠）→ 指向该根目录自身，如 open_folder 返回的 sharedtest
  const byAlias = roots.find(r => r.alias === raw)
  if (byAlias) return { root: byAlias.path, rest: '.' }
  const primary = roots.find(r => r.alias === '')
  if (primary) return { root: primary.path, rest: raw }
  if (roots.length === 1) return { root: roots[0].path, rest: raw }
  throw new CommandError(
    `路径「${target}」未指定目录别名，且存在多个已授权目录，请用「别名/路径」形式引用（如 shared/xxx）`,
    'AMBIGUOUS_ROOT'
  )
}

function aliasOf(roots, root) {
  const r = roots.find(x => path.resolve(x.path) === path.resolve(root))
  return r ? r.alias : ''
}

// 展示用相对路径：带别名时加前缀；无根（全文件系统模式）时直接展示绝对路径
function displayRel(alias, root, abs) {
  if (!root) return abs.replace(/\\/g, '/')
  const rel = path.relative(path.resolve(root), abs).replace(/\\/g, '/')
  return alias ? `${alias}/${rel}` : rel
}

// ── 文本解码 ──────────────────────────────────────────────
// Windows 中文环境常见 GBK 编码的 txt/csv，Node 原生只认 UTF-8，
// 直接按 utf8 解会得到大量 U+FFFD。这里按替换字符比例判定并回退 GBK。
function decodeText(buf) {
  let iconv = null
  try { iconv = require('iconv-lite') } catch { /* 未安装则只能按 UTF-8 处理 */ }

  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.toString('utf8').replace(/^﻿/, ''), encoding: 'utf-8-bom' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.toString('utf16le'), encoding: 'utf-16le' }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: buf.swap16().toString('utf16le'), encoding: 'utf-16-be' }
  }

  const utf8 = buf.toString('utf8')
  const replacement = (utf8.match(/\uFFFD/g) || []).length
  const ratio = utf8.length ? replacement / utf8.length : 0
  if (ratio > 0.01 && iconv) {
    const gbk = iconv.decode(buf, 'gbk')
    const gbkBad = (gbk.match(/\uFFFD/g) || []).length
    return gbkBad < replacement
      ? { text: gbk, encoding: 'gbk' }
      : { text: utf8, encoding: 'utf-8' }
  }
  return { text: utf8, encoding: 'utf-8' }
}

// 统一截断：把任意长度文本按行/字节约束成模型可消化的片段
function applyTruncation(text, maxBytes, offset, limit) {
  let content = text
  let truncated = false
  if (Buffer.byteLength(content, 'utf8') > maxBytes) {
    // Office/PDF 没有「行」概念，这里按字符数近似截断（避免截断半个多字节字符）
    const maxChars = Math.floor(maxBytes / 2)
    content = content.slice(0, maxChars)
    truncated = true
  }
  if (offset > 0 || limit > 0) {
    const lines = content.split(/\r?\n/)
    const slice = lines.slice(offset, limit > 0 ? offset + limit : undefined)
    content = slice.join('\n')
    if (offset + slice.length < lines.length) truncated = true
  }
  return { content, truncated }
}

// ── 命令：ping ────────────────────────────────────────────
const MODULES = {
  mammoth: 'mammoth',
  jszip: 'jszip',
  'pdfjs-dist': 'pdfjs-dist/legacy/build/pdf.js',
  'iconv-lite': 'iconv-lite',
  xlsx: 'xlsx'
}

function cmdPing() {
  const modules = {}
  for (const [name, request] of Object.entries(MODULES)) {
    try {
      require(request)
      modules[name] = { ok: true }
    } catch (e) {
      modules[name] = { ok: false, error: e && e.message ? e.message : String(e) }
    }
  }
  const failed = Object.entries(modules).filter(([, v]) => !v.ok).map(([k]) => k)
  return {
    ok: failed.length === 0,
    command: 'ping',
    node: process.version,
    platform: process.platform,
    skillRoot: path.resolve(__dirname, '..'),
    modules,
    missing: failed
  }
}

// ── 命令：read ────────────────────────────────────────────
const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.text', '.csv', '.tsv', '.json', '.jsonl',
  '.log', '.yml', '.yaml', '.xml', '.html', '.htm', '.ini', '.conf',
  '.properties', '.sql', '.js', '.ts', '.jsx', '.tsx', '.py', '.ps1',
  '.bat', '.sh', '.gitignore', '.env', '.editorconfig'
])

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (TEXT_EXT.has(ext)) return true
  return ext === '' // 无扩展名（LICENSE、Dockerfile）按文本处理
}

// 单个文件读取（多根版）：返回 { abs, relative, size, format, truncated, content }
async function readOne(roots, target, opts = {}) {
  const { root, rest } = pickRoot(target, roots)
  const abs = resolveSafe(root, rest, { mustExist: true })
  const stat = fs.statSync(abs)
  if (stat.isDirectory()) {
    throw new CommandError(`目标是目录，不是文件：${target}（请用 list 命令）`, 'IS_DIRECTORY')
  }
  const maxBytes = Math.min(toInt(opts.maxBytes, DEFAULT_MAX_BYTES), HARD_MAX_BYTES)
  const offset = toInt(opts.offset, 0)
  const limit = toInt(opts.limit, 0)
  const ext = path.extname(abs).toLowerCase()

  let text
  let format
  const reader = readerFor(ext)
  if (reader) {
    const raw = await reader(abs)
    text = raw.text
    format = raw.format
  } else if (isTextFile(abs)) {
    const buf = fs.readFileSync(abs)
    const d = decodeText(buf)
    text = d.text
    format = 'text'
  } else {
    throw new CommandError(
      `暂不支持读取该格式：${path.basename(abs)}（支持文本类 / docx / xls / xlsx / pptx / pdf）`,
      'UNSUPPORTED_FORMAT'
    )
  }

  const { content, truncated } = applyTruncation(text, maxBytes, offset, limit)
  return {
    abs,
    relative: displayRel(aliasOf(roots, root), root, abs),
    size: stat.size,
    format,
    bytesRead: Buffer.byteLength(content, 'utf8'),
    truncated,
    content
  }
}

async function cmdRead(positional, flags, roots) {
  const target = positional[0]
  if (!target) throw new CommandError('read 需要指定文件路径', 'MISSING_ARG')
  const maxBytes = Math.min(toInt(flags['max-bytes'], DEFAULT_MAX_BYTES), HARD_MAX_BYTES)
  const r = await readOne(roots, target, { offset: toInt(flags.offset, 0), limit: toInt(flags.limit, 0), maxBytes })
  return {
    ok: true,
    command: 'read',
    path: r.abs,
    relative: r.relative,
    source: r.relative,
    size: r.size,
    format: r.format,
    bytesRead: r.bytesRead,
    truncated: r.truncated,
    ...(r.truncated ? { truncatedNote: `内容已截断（上限 ${maxBytes} 字节），如需更多请指定 --offset/--limit 分段读取` } : {}),
    text: r.content
  }
}

// ── 命令：read_batch ──────────────────────────────────────
async function cmdReadBatch(positional, flags, roots) {
  const paths = positional.slice()
  if (flags.path) {
    const extra = Array.isArray(flags.path) ? flags.path : [flags.path]
    for (const p of extra) paths.push(p)
  }
  if (!paths.length) throw new CommandError('read_batch 需要至少一个文件路径', 'MISSING_ARG')
  if (paths.length > BATCH_MAX_FILES) {
    throw new CommandError(`read_batch 一次最多读取 ${BATCH_MAX_FILES} 个文件，收到 ${paths.length} 个`, 'TOO_MANY')
  }
  const results = []
  for (const p of paths) {
    try {
      const r = await readOne(roots, p, { maxBytes: BATCH_PER_FILE_BYTES })
      results.push({
        ok: true,
        path: p,
        relative: r.relative,
        source: r.relative,
        size: r.size,
        format: r.format,
        truncated: r.truncated,
        text: r.content
      })
    } catch (e) {
      results.push({
        ok: false,
        path: p,
        error: e && e.message ? e.message : String(e),
        code: e && e.code
      })
    }
  }
  return { ok: true, command: 'read_batch', count: results.length, results }
}

// ── 命令：list ────────────────────────────────────────────
function cmdList(positional, flags, roots) {
  const target = positional[0] || '.'
  const { root, rest } = pickRoot(target, roots)
  const abs = resolveSafe(root, rest, { mustExist: true })
  const stat = fs.statSync(abs)
  if (!stat.isDirectory()) {
    throw new CommandError(`list 需要目录，不是文件：${target}`, 'NOT_DIRECTORY')
  }
  const depth = toInt(flags.depth, 1)
  const entries = fs.readdirSync(abs, { withFileTypes: true }).map((e) => ({
    name: e.name,
    type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
    size: e.isFile() ? fs.statSync(path.join(abs, e.name)).size : null
  }))
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
  return {
    ok: true,
    command: 'list',
    path: abs,
    relative: displayRel(aliasOf(roots, root), root, abs) || '.',
    depth,
    count: entries.length,
    entries
  }
}

// ── 命令：search ──────────────────────────────────────────
// 通配符（glob）转正则：* → .* ，? → . ，其余正则元字符转义
function globToRegex(glob) {
  let re = ''
  for (const ch of String(glob)) {
    if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + re + '$', 'i')
}

// ── 命令：search ──────────────────────────────────────────
// 类 FileLocatorPro 的内容检索：文件名 / 内容均可搜，且内容搜索覆盖多格式：
//   - 文本类（md/txt/csv/...）直接解码文本匹配；
//   - xlsx / xls：逐单元格抽取，命中时定位到 sheet + 行号；
//   - docx / pptx / pdf：用对应 reader 抽出纯文本后匹配（返回命中片段）。
// 查询模式：正则(--regex) > 文件名通配符(含 * ?) > 子串。--index 可启用索引缓存（默认关闭）。
const SEARCH_INDEX_DIR = path.join(require('os').tmpdir(), 'mc-tool-search-index')
const SEARCH_INDEX_VERSION = 3

function loadIndexStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(SEARCH_INDEX_DIR, 'store.json'), 'utf8'))
    if (raw && raw.version === SEARCH_INDEX_VERSION && raw.files && typeof raw.files === 'object') return raw.files
  } catch { /* 索引损坏或不存在：回退空索引 */ }
  return {}
}
function saveIndexStore(files) {
  try {
    fs.mkdirSync(SEARCH_INDEX_DIR, { recursive: true })
    fs.writeFileSync(path.join(SEARCH_INDEX_DIR, 'store.json'), JSON.stringify({ version: SEARCH_INDEX_VERSION, files }))
  } catch { /* 缓存写失败不影响搜索 */ }
}

// 文件内容 hash（sha256），用于校验缓存是否仍然有效；比仅依赖 mtime/size 更可靠
function hashFile(full) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(full)
    stream.on('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}
// 单元格转可搜索文本：用原始值，避免长整数料号被 Excel 显示成科学计数法（5.19E+12）而搜不到。
// 整数用全精度字符串；日期保持 ISO；同时附带显示格式作为兜底，保证两种写法都能命中。
function cellSearchText(raw, formatted) {
  let s
  if (raw == null) s = ''
  else if (raw instanceof Date) s = raw.toISOString().slice(0, 10)
  else if (typeof raw === 'number') s = String(raw) // 13 位料号等整数用全精度，避免 5190012100066 → 5.19001E+12
  else s = String(raw)
  const fmt = formatted == null ? '' : String(formatted)
  if (!fmt || fmt === s) return s
  return s + '\t' + fmt // 原始值与显示值不同时都带上，扩大命中面
}

// xlsx / xls → 逐工作表、逐行、逐单元格（带 sheet/行号定位）
function extractXlsxCells(full) {
  const XLSX = require('xlsx')
  const wb = XLSX.readFile(full, { cellDates: true })
  const sheets = wb.SheetNames.map(name => {
    const ws = wb.Sheets[name]
    // raw=true 取原始值（数字全精度、日期为 Date），raw=false 取显示格式；两者都保留以便命中
    const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' })
    const dispRows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' })
    const rows = rawRows.map((r, ri) => {
      const dr = dispRows[ri] || []
      return r.map((c, ci) => cellSearchText(c, dr[ci]))
    })
    return { name, rows }
  })
  return { type: 'cells', sheets }
}
// 抽出一个文件用于搜索的内容；返回 null 表示不支持 / 抽取失败
async function extractForSearch(full, ext) {
  if (isTextFile(full)) {
    try { return { type: 'text', text: decodeText(fs.readFileSync(full)).text } } catch { return null }
  }
  if (ext === '.xlsx' || ext === '.xls') {
    try { return extractXlsxCells(full) } catch { return null }
  }
  const reader = readerFor(ext)
  if (reader) {
    try { const r = await reader(full); return { type: 'text', text: r.text } } catch { return null }
  }
  return null
}

// 把一份抽取结果（text / cells）与查询匹配，命中的行追加到 results；返回本次新增命中数。
// 与 cmdSearch 主流程共用同一套全精度匹配逻辑，保证「缓存命中」与「全量兜底重扫」结果一致（不漏不重）。
function appendDataMatches(results, rel, name, ext, data, contentMatcher, altMatchers, maxResults, matchSnippet, query) {
  if (data.type === 'text') {
    if (contentMatcher(data.text)) {
      results.push({ relative: rel, source: rel, name, match: 'content', format: ext.slice(1) || 'text', snippet: matchSnippet(data.text) })
      return 1
    }
    return 0
  }
  if (!data.sheets) return 0
  if (altMatchers) {
    // 多码检索：每个码只记首次出现，避免某码命中过多行把其他码挤出 maxResults 而漏判
    const seenAlts = new Set()
    let added = 0
    sheetLoop:
    for (const sh of data.sheets) {
      for (let r = 1; r < sh.rows.length; r++) {
        const line = sh.rows[r].join('\t')
        for (let i = 0; i < altMatchers.length; i++) {
          if (altMatchers[i].test(line) && !seenAlts.has(i)) {
            seenAlts.add(i)
            results.push({ relative: rel, source: rel, name, match: 'content', format: ext.slice(1), sheet: sh.name, row: r + 1, snippet: line.slice(0, 240), matched: query.split('|')[i] })
            added++
          }
        }
        if (seenAlts.size >= altMatchers.length) break sheetLoop
      }
    }
    return added
  }
  let added = 0
  sheetLoop:
  for (const sh of data.sheets) {
    for (let r = 1; r < sh.rows.length; r++) {
      const line = sh.rows[r].join('\t')
      if (contentMatcher(line)) {
        results.push({ relative: rel, source: rel, name, match: 'content', format: ext.slice(1), sheet: sh.name, row: r + 1, snippet: line.slice(0, 240) })
        added++
        if (results.length >= maxResults) break sheetLoop
      }
    }
  }
  return added
}

async function cmdSearch(positional, flags, roots) {
  const query = positional[0]
  if (!query) throw new CommandError('search 需要查询词', 'MISSING_ARG')
  const dir = positional[1] || '.'
  const { root, rest } = pickRoot(dir, roots)
  const abs = resolveSafe(root, rest, { mustExist: true })
  const nameOnly = !!flags['name-only']
  const useRegex = !!flags.regex
  const maxResults = toInt(flags['max-results'], 50)
  const maxDepth = toInt(flags.depth, 8)
  const useIndex = !!flags.index
  const globFilter = flags.glob ? globToRegex(String(flags.glob)) : null
  const extFilter = flags.ext
    ? String(flags.ext).split(',').map(s => '.' + s.trim().replace(/^\./, '').toLowerCase()).filter(Boolean)
    : null

  let nameMatcher
  let contentMatcher
  if (useRegex) {
    const re = new RegExp(query, 'i')
    nameMatcher = (n) => re.test(n)
    contentMatcher = (t) => re.test(t)
  } else if (/[*?]/.test(query)) {
    // 查询词含通配符 → 视作文件名 glob 匹配（默认只匹配文件名，不扫内容）
    const re = globToRegex(query)
    nameMatcher = (n) => re.test(n)
    contentMatcher = null
  } else {
    const q = query.toLowerCase()
    nameMatcher = (n) => n.toLowerCase().includes(q)
    contentMatcher = (t) => t.toLowerCase().includes(q)
  }

  const store = useIndex ? loadIndexStore() : null
  const rebuildIndex = !!flags['rebuild-index']
  let dirty = false
  // 取文件内容：默认直接抽取，启用索引时通过 hash+版本校验，避免文件更新后仍用旧缓存导致漏查。
  // 返回 { data, fromCache }；fromCache=true 表示命中了本地索引（可能落后于真实文件），
  // 搜索零命中时会触发「全量兜底重扫」防止漏扫（见下方 walk）。
  async function fetchContent(full, ext) {
    if (!store || rebuildIndex) return { data: await extractForSearch(full, ext), fromCache: false }
    let st
    try { st = fs.statSync(full) } catch { return { data: null, fromCache: false } }
    const hit = store[full]
    if (hit && hit.version === SEARCH_INDEX_VERSION && hit.mtime === st.mtimeMs && hit.size === st.size) {
      try {
        const currentHash = await hashFile(full)
        if (hit.hash === currentHash) return { data: hit.data, fromCache: true }
      } catch { /* hash 失败则回退重新抽取 */ }
    }
    const data = await extractForSearch(full, ext)
    if (data) {
      try {
        const currentHash = await hashFile(full)
        store[full] = { version: SEARCH_INDEX_VERSION, mtime: st.mtimeMs, size: st.size, hash: currentHash, data }
        dirty = true
      } catch { /* hash 失败时不写缓存，但返回本次结果 */ }
    }
    return { data, fromCache: false }
  }
  function matchSnippet(text) {
    const lines = text.split(/\r?\n/)
    for (const ln of lines) if (contentMatcher(ln)) return ln.slice(0, 240)
    return text.slice(0, 240)
  }

  const alias = aliasOf(roots, root)
  const results = []
  async function walk(d, current) {
    if (results.length >= maxResults || current > maxDepth) return
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (results.length >= maxResults) return
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        await walk(full, current + 1)
      } else if (e.isFile()) {
        const rel = displayRel(alias, root, full)
        const ext = path.extname(e.name).toLowerCase()
        if (extFilter && !extFilter.includes(ext)) continue
        if (globFilter && !globFilter.test(e.name)) continue
        if (nameMatcher(e.name)) {
          results.push({ relative: rel, source: rel, name: e.name, match: 'name' })
          continue
        }
        if (nameOnly || !contentMatcher) continue
        const fetched = await fetchContent(full, ext)
        const data = fetched.data
        if (!data) continue
        const altMatchers = (useRegex && !/[()[\]]/.test(query)) ? query.split('|').map(s => new RegExp(s, 'i')) : null
        // 主匹配（data 可能来自本地索引缓存）
        const added = appendDataMatches(results, rel, e.name, ext, data, contentMatcher, altMatchers, maxResults, matchSnippet, query)
        // 反漏扫兜底：命中本地索引但本文件零命中时，强制全量重扫一次确认，
        // 避免缓存落后/抽取遗漏导致漏查；若全量确有命中，则用全量结果刷新缓存。
        if (fetched.fromCache && added === 0) {
          const fresh = await extractForSearch(full, ext)
          if (fresh) {
            const added2 = appendDataMatches(results, rel, e.name, ext, fresh, contentMatcher, altMatchers, maxResults, matchSnippet, query)
            if (added2 > 0 && store) {
              try {
                const st2 = fs.statSync(full)
                const cur = await hashFile(full)
                store[full] = { version: SEARCH_INDEX_VERSION, mtime: st2.mtimeMs, size: st2.size, hash: cur, data: fresh }
                dirty = true
              } catch { /* 刷新缓存失败不影响本次结果 */ }
            }
          }
        }
        if (results.length >= maxResults) break
      }
    }
  }
  await walk(abs, 0)
  if (store && dirty) saveIndexStore(store)

  return {
    ok: true,
    command: 'search',
    query,
    mode: useRegex ? 'regex' : (/[*?]/.test(query) ? 'glob' : 'substring'),
    filters: { nameOnly, glob: flags.glob || null, ext: flags.ext || null },
    root: dir === '.' ? '.' : displayRel(alias, root, abs),
    indexed: !!store,
    count: results.length,
    results
  }
}

// ── 电子表格生成（xlsx / xls） ────────────────────────────
// 模型给出的 content 支持两种形式：
//   1) 分隔文本：含制表符按 TSV、否则按 CSV（支持 "..." 引号），首行作为表头；
//   2) JSON：二维数组 [["a","b"],["1","2"]] 或对象数组 [{a:1}]（键作表头）。
// 用 SheetJS 生成真正的二进制工作簿；append 时把新行追加到首个工作表末尾。
function parseDelimitedLine(line, delim) {
  const out = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else inQ = false
      } else cur += ch
    } else if (ch === '"') {
      inQ = true
    } else if (ch === delim) {
      out.push(cur); cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

function parseSheetRows(content) {
  const trimmed = content.trim()
  if (trimmed.startsWith('[')) {
    const data = JSON.parse(trimmed)
    if (Array.isArray(data) && data.length && Array.isArray(data[0])) {
      return data.map(r => r.map(c => c == null ? '' : (isCellObj(c) ? c : (c instanceof Date ? c.toISOString().slice(0, 10) : String(c)))))
    }
    if (Array.isArray(data) && data.length && data[0] && typeof data[0] === 'object') {
      const headers = []
      for (const o of data) for (const k of Object.keys(o)) if (!headers.includes(k)) headers.push(k)
      return [headers, ...data.map(o => headers.map(h => {
        const v = o[h]
        return v == null ? '' : (isCellObj(v) ? v : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v)))
      }))]
    }
    throw new CommandError('JSON 必须是「二维数组」或「对象数组」', 'BAD_JSON')
  }
  const allLines = content.split(/\r?\n/)
  const lines = []
  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i] === '' && i === allLines.length - 1) continue // 丢弃末尾空行（换行符产生）
    lines.push(allLines[i])
  }
  const delim = lines.some(l => l.includes('\t')) ? '\t' : ','
  return lines.map(l => parseDelimitedLine(l, delim))
}

function writeSpreadsheet(target, content, opts) {
  const XLSX = require('xlsx')
  const ext = path.extname(target).toLowerCase()
  const bookType = ext === '.xls' ? 'xls' : 'xlsx'
  const { root, rest } = pickRoot(target, opts.roots)
  const abs = resolveSafe(root, rest)
  const rawRows = parseSheetRows(content)
  // 行级填充保留键（__rowFill / rowFill）：整行上色用，不应成为普通列写出
  const ROW_FILL_KEYS = new Set(['__rowFill', 'rowFill'])
  const fillWarnings = []
  const header = rawRows[0] || []
  const isRowFillCol = (header || []).map(h => ROW_FILL_KEYS.has(String(h)))
  // 抽出普通值网格与填充色映射：对象式单元格 { value, fill } 先取 value 写值，
  // 再由 fills 单独上色（避免把对象直接丢进 aoa_to_sheet 被误当成单元格值）。
  const values = []
  const fills = []
  const rowFills = []
  for (let r = 0; r < rawRows.length; r++) {
    const inRow = rawRows[r]
    const outRow = []
    let rf = null
    let cc = 0
    for (let c = 0; c < inRow.length; c++) {
      if (isRowFillCol[c]) {
        // 行级填充键：跳过该列、记录整行填充色（表头行除外）
        if (r > 0) {
          const a = normalizeFill(inRow[c] != null ? inRow[c] : null, fillWarnings)
          if (a) rf = a
        }
        continue
      }
      const desc = inRow[c]
      if (isCellObj(desc)) {
        const argb = normalizeFill(desc.fill != null ? desc.fill : (desc.bg != null ? desc.bg : null), fillWarnings)
        const v = desc.value != null ? desc.value : (desc.v != null ? desc.v : (desc.text != null ? desc.text : ''))
        outRow.push(fmtCell(v))
        if (argb) fills.push({ r, c: cc, argb })
      } else {
        outRow.push(desc)
      }
      cc++
    }
    values.push(outRow)
    rowFills.push(rf)
  }
  const applyFills = (ws, r0, c0) => {
    for (const f of fills) {
      const addr = XLSX.utils.encode_cell({ r: r0 + f.r, c: c0 + f.c })
      const cell = ws[addr]
      if (!cell) continue
      cell.s = cell.s || {}
      cell.s.fill = { fgColor: { rgb: f.argb }, patternType: 'solid' }
    }
    // 整行填充：把该行的所有单元格填满指定颜色
    for (let r = 0; r < rowFills.length; r++) {
      const rf = rowFills[r]
      if (!rf) continue
      const outRow = values[r] || []
      for (let c = 0; c < outRow.length; c++) {
        const addr = XLSX.utils.encode_cell({ r: r0 + r, c: c0 + c })
        const cell = ws[addr]
        if (!cell) continue
        cell.s = cell.s || {}
        cell.s.fill = { fgColor: { rgb: rf }, patternType: 'solid' }
      }
    }
  }
  if (opts.append && fs.existsSync(abs)) {
    const wb = XLSX.readFile(abs, { cellDates: true })
    const first = wb.SheetNames[0]
    const ws = wb.Sheets[first]
    const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null
    const nextRow = range ? range.e.r + 1 : 0
    XLSX.utils.sheet_add_aoa(ws, values, { origin: { r: nextRow, c: 0 } })
    applyFills(ws, nextRow, 0)
    XLSX.writeFile(wb, abs, { bookType })
  } else {
    const ws = XLSX.utils.aoa_to_sheet(values)
    applyFills(ws, 0, 0)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
    XLSX.writeFile(wb, abs, { bookType })
  }
  const after = fs.statSync(abs)
  const out = {
    ok: true,
    command: 'write',
    path: abs,
    relative: displayRel(aliasOf(opts.roots, root), root, abs),
    format: bookType,
    bytes: after.size,
    append: !!opts.append,
    size: after.size
  }
  if (fillWarnings.length) {
    out.unsupportedFills = fillWarnings
    out.supportedFills = Object.keys(FILL_PALETTE)
    out.fillNote = '单元格填充色仅支持上述名称或 #RRGGBB 十六进制；未识别的颜色已忽略、未上色，请改用支持的颜色。'
  }
  return out
}

// ── 原地按关键列回填 / 追加列（xlsx / xls） ──────────────
// 模型给 JSON：{ sheet?, key: "关键列名", rows: [ { 关键列: 值, 列名: 值, ... } ] }
// 按 key 匹配已有行：命中则把其余列写回（原表没有的列自动追加到最右）；
// 未命中则追加新行。原地保存，不另存为新文件。
function fmtCell(v) {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'number') return v
  return String(v)
}

// 是否为「对象式单元格描述」{ value, fill }，用于区分标量值与带样式的值
function isCellObj(c) {
  return !!(c && typeof c === 'object' && !Array.isArray(c) && !(c instanceof Date))
}

// 填充色：支持名称（绿/黄/红/蓝/灰/橙及 light 前缀变体）或十六进制（#RRGGBB / FFRRGGBB）
const FILL_PALETTE = {
  green: 'FF00B050', lightgreen: 'FFC6EFCE',
  yellow: 'FFFFFF00', lightyellow: 'FFFFEB9C',
  red: 'FFFF0000', lightred: 'FFFFC7CE',
  blue: 'FF4472C4', lightblue: 'FFDDEBF7',
  gray: 'FFBFBFBF', grey: 'FFBFBFBF', orange: 'FFED7D31', white: 'FFFFFFFF'
}

function parseFill(fill) {
  if (!fill || typeof fill !== 'string') return null
  const up = fill.trim().toUpperCase()
  const key = up.toLowerCase()
  if (FILL_PALETTE[key]) return FILL_PALETTE[key]
  let hex = up.startsWith('#') ? up.slice(1) : up
  if (/^[0-9A-F]{6}$/.test(hex)) return 'FF' + hex
  if (/^[0-9A-F]{8}$/.test(hex)) return hex
  return null
}

// 解析填充色；无法识别时计入 warnings（不阻断写入），便于向用户提示支持的颜色
function normalizeFill(fill, warnings) {
  if (fill == null) return null
  const s = String(fill).trim()
  if (!s) return null
  const argb = parseFill(s)
  if (!argb) {
    if (warnings && !warnings.includes(s)) warnings.push(s)
    return null
  }
  return argb
}

// 单元格值：允许标量，或 { value, fill } / { v, fill } 形式携带填充色
function cellValueAndFill(raw, warnings) {
  if (isCellObj(raw)) {
    const fill = normalizeFill(raw.fill != null ? raw.fill : (raw.bg != null ? raw.bg : null), warnings)
    const val = raw.value != null ? raw.value : (raw.v != null ? raw.v : (raw.text != null ? raw.text : ''))
    return { value: fmtCell(val), fill }
  }
  return { value: fmtCell(raw), fill: null }
}

// ExcelJS 单元格填充（保留其余样式，仅设置背景色）
// 注意：必须用 cell.style = Object.assign(...) 重新赋值，而不要直接 cell.fill = {...}。
// 直接 cell.fill = 会在「既有单元格共享同一默认 style 引用」时就地篡改该共享对象，
// 导致循环中后写入的颜色覆盖前面所有行（批量整行染色时 A-D 全变成最后一行颜色）。
// 重新赋值 style 会给每个单元格独立的 style 对象，避免共享引用被串色。
function applyExcelFill(cell, argb) {
  if (!argb) return
  const prev = cell.style || {}
  cell.style = Object.assign({}, prev, { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb }, bgColor: { argb } } })
}

// ExcelJS 单元格值转可读字符串（用于按关键列匹配已有行，避免被数字格式/富文本干扰）
function cellValueAsString(cell) {
  const v = cell.value
  if (v == null) return ''
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v === 'string') return v
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    if ('text' in v && v.text != null) return String(v.text)
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map(r => r.text || '').join('')
    if ('result' in v && v.result != null) return String(v.result)
  }
  const t = cell.text
  return t != null ? String(t) : ''
}

function loadExcelJs() {
  try { return require('exceljs') } catch {
    throw new CommandError(
      'update 模式需要 exceljs 依赖以保留原文件样式，但未安装。请在 skills/file-office-local 目录下执行 npm install exceljs。',
      'MISSING_DEP'
    )
  }
}

// ── 原地按关键列回填 / 追加列：旧实现（SheetJS，不保留样式，仅作为 .xls 兜底） ──
function updateSpreadsheetLegacy(target, content, opts) {
  const XLSX = require('xlsx')
  const ext = path.extname(target).toLowerCase()
  const bookType = ext === '.xls' ? 'xls' : 'xlsx'
  const { root, rest } = pickRoot(target, opts.roots)
  const abs = resolveSafe(root, rest, { mustExist: true }) // 必须已存在
  let spec
  try { spec = JSON.parse(String(content)) } catch {
    throw new CommandError('update 模式 content 必须是 JSON：{ key, rows:[{关键列:值, 列名:值,...}] }', 'BAD_JSON')
  }
  if (!spec || !Array.isArray(spec.rows)) {
    throw new CommandError('update 模式 JSON 必须包含 rows 数组', 'BAD_JSON')
  }
  const keyCol = spec.key
  if (!keyCol) throw new CommandError('update 模式 JSON 必须包含 key（关键列名，用于匹配已有行）', 'BAD_JSON')

  const wb = XLSX.readFile(abs, { cellDates: true })
  const sheetName = spec.sheet || wb.SheetNames[0]
  if (!wb.SheetNames.includes(sheetName)) throw new CommandError(`工作表不存在：${sheetName}`, 'SHEET_NOT_FOUND')
  const ws = wb.Sheets[sheetName]
  const grid = ws['!ref'] ? XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }) : []
  if (!grid.length) grid.push([])
  const header = grid[0].map(h => String(h))
  const keyIdx = header.indexOf(String(keyCol))
  if (keyIdx < 0) throw new CommandError(`关键列「${keyCol}」在原表中不存在`, 'KEY_NOT_FOUND')

  let updated = 0
  const appended = []
  const newCols = []

  const ensureCol = (k) => {
    let ci = header.indexOf(String(k))
    if (ci < 0) {
      header.push(String(k)); ci = header.length - 1; newCols.push(String(k))
      grid.forEach(r => { while (r.length < header.length) r.push('') })
    }
    return ci
  }

  for (const row of spec.rows) {
    if (!row || typeof row !== 'object') continue
    const kv = String(row[keyCol] ?? '')
    if (!kv) continue
    let hit = -1
    for (let i = 1; i < grid.length; i++) {
      if (String(grid[i][keyIdx] ?? '') === kv) { hit = i; break }
    }
    const cols = {}
    for (const k of Object.keys(row)) {
      if (k === 'key' || k === keyCol) continue
      cols[k] = row[k]
    }
    if (hit >= 0) {
      for (const k of Object.keys(cols)) grid[hit][ensureCol(k)] = fmtCell(cols[k])
      updated++
    } else {
      const newRow = new Array(header.length).fill('')
      newRow[keyIdx] = fmtCell(kv)
      for (const k of Object.keys(cols)) newRow[ensureCol(k)] = fmtCell(cols[k])
      grid.push(newRow)
      appended.push(kv)
    }
  }
  grid[0] = header
  wb.Sheets[sheetName] = XLSX.utils.aoa_to_sheet(grid)
  XLSX.writeFile(wb, abs, { bookType })
  const after = fs.statSync(abs)
  return {
    ok: true,
    command: 'write',
    mode: 'update',
    path: abs,
    relative: displayRel(aliasOf(opts.roots, root), root, abs),
    sheet: sheetName,
    key: String(keyCol),
    updated,
    appended: appended.length,
    appendedKeys: appended,
    newColumns: newCols,
    format: bookType,
    size: after.size
  }
}

// ── 原地按关键列回填 / 追加列（xlsx，保留原样式） ──
// 用 ExcelJS 读写：保留原字体 / 列宽 / 合并单元格 / 数字格式等，仅改写指定单元格的值。
async function updateSpreadsheetXlsx(target, content, opts) {
  const { root, rest } = pickRoot(target, opts.roots)
  const abs = resolveSafe(root, rest, { mustExist: true }) // 必须已存在
  let spec
  try { spec = JSON.parse(String(content)) } catch {
    throw new CommandError('update 模式 content 必须是 JSON：{ key, rows:[{关键列:值, 列名:值,...}] }', 'BAD_JSON')
  }
  if (!spec || !Array.isArray(spec.rows)) {
    throw new CommandError('update 模式 JSON 必须包含 rows 数组', 'BAD_JSON')
  }
  const keyCol = spec.key
  if (!keyCol) throw new CommandError('update 模式 JSON 必须包含 key（关键列名，用于匹配已有行）', 'BAD_JSON')

  const ExcelJS = loadExcelJs()
  const wb = new ExcelJS.Workbook()
  // readFile 保留工作簿样式（列宽、字体、合并单元格、数字格式等）；注意 ExcelJS 为异步 API
  await wb.xlsx.readFile(abs)
  const sheetName = spec.sheet || (wb.worksheets[0] && wb.worksheets[0].name)
  if (!sheetName || !wb.getWorksheet(sheetName)) {
    throw new CommandError(`工作表不存在：${sheetName || '(空)'}`, 'SHEET_NOT_FOUND')
  }
  const ws = wb.getWorksheet(sheetName)

  // 读取表头（第 1 行）
  const header = []
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
    header[colNumber - 1] = cellValueAsString(cell)
  })
  const keyIdx = header.indexOf(String(keyCol))
  if (keyIdx < 0) throw new CommandError(`关键列「${keyCol}」在原表中不存在`, 'KEY_NOT_FOUND')

  let updated = 0
  const appended = []
  const newColumns = []
  const fillWarnings = []
  let rowFillAutoPromoted = false // 是否因模型未用 __rowFill 而自动扩展为整行填充

  const ensureCol = (k) => {
    let ci = header.indexOf(String(k))
    if (ci < 0) {
      header.push(String(k)); ci = header.length - 1; newColumns.push(String(k))
      // 在最右列补上表头名
      ws.getRow(1).getCell(ci + 1).value = String(k)
    }
    return ci
  }

  const lastRow = ws.rowCount // 含表头
  for (const row of spec.rows) {
    if (!row || typeof row !== 'object') continue
    const kv = String(row[keyCol] ?? '')
    if (!kv) continue
    let hitRow = null
    for (let r = 2; r <= lastRow; r++) {
      if (String(cellValueAsString(ws.getRow(r).getCell(keyIdx + 1))) === kv) { hitRow = ws.getRow(r); break }
    }
    const cols = {}
    let rowFill = null
    for (const k of Object.keys(row)) {
      if (k === 'key' || k === keyCol) continue
      // 保留键 __rowFill / rowFill / 行色 / 整行颜色 / rowColor：整行上色，不作为普通列写入
      if (k === '__rowFill' || k === 'rowFill' || k === '行色' || k === '整行颜色' || k === 'rowColor') {
        rowFill = normalizeFill(row[k], fillWarnings); continue
      }
      cols[k] = row[k]
    }
    if (hitRow) {
      let lastFill = null
      const cellFills = new Set()
      for (const k of Object.keys(cols)) {
        const ci = ensureCol(k)
        const { value, fill } = cellValueAndFill(cols[k], fillWarnings)
        const cell = hitRow.getCell(ci + 1)
        cell.value = value
        applyExcelFill(cell, fill)
        if (fill) {
          cellFills.add(fill)
          lastFill = fill
        }
      }
      // 整行填充：优先 __rowFill；否则以最右侧有 fill 的单元格颜色兜底，并把 A 列到工作表最右列全部重染（覆盖旧色）
      const appliedRowFill = rowFill || lastFill
      if (appliedRowFill) {
        const w = Math.max(header.length, ws.columnCount || 0, hitRow.cellCount || 0)
        for (let c = 1; c <= w; c++) applyExcelFill(hitRow.getCell(c), appliedRowFill)
        if (!rowFill && lastFill) rowFillAutoPromoted = true
      }
      updated++
    } else {
      const newRow = ws.addRow(new Array(header.length).fill(''))
      newRow.getCell(keyIdx + 1).value = fmtCell(kv)
      let lastFill = null
      const cellFills = new Set()
      for (const k of Object.keys(cols)) {
        const ci = ensureCol(k)
        const { value, fill } = cellValueAndFill(cols[k], fillWarnings)
        const cell = newRow.getCell(ci + 1)
        cell.value = value
        applyExcelFill(cell, fill)
        if (fill) {
          cellFills.add(fill)
          lastFill = fill
        }
      }
      // 整行填充：优先 __rowFill；否则以最右侧有 fill 的单元格颜色兜底，并把 A 列到工作表最右列全部重染
      const appliedRowFill = rowFill || lastFill
      if (appliedRowFill) {
        const w = Math.max(header.length, ws.columnCount || 0, newRow.cellCount || 0)
        for (let c = 1; c <= w; c++) applyExcelFill(newRow.getCell(c), appliedRowFill)
        if (!rowFill && lastFill) rowFillAutoPromoted = true
      }
      appended.push(kv)
    }
  }
  // 原地写回，保留原样式
  await wb.xlsx.writeFile(abs)
  const after = fs.statSync(abs)
  const out = {
    ok: true,
    command: 'write',
    mode: 'update',
    path: abs,
    relative: displayRel(aliasOf(opts.roots, root), root, abs),
    sheet: sheetName,
    key: String(keyCol),
    updated,
    appended: appended.length,
    appendedKeys: appended,
    newColumns: newColumns,
    format: path.extname(abs).toLowerCase() === '.xls' ? 'xls' : 'xlsx',
    size: after.size
  }
  if (fillWarnings.length) {
    out.unsupportedFills = fillWarnings
    out.supportedFills = Object.keys(FILL_PALETTE)
    out.fillNote = '单元格填充色仅支持 green/yellow/red/blue/gray/orange 等名称（及 light 前缀变体）或 #RRGGBB 十六进制；未识别的颜色已忽略、未上色。'
  }
  if (rowFillAutoPromoted) {
    out.rowFillAutoPromoted = true
    out.rowFillNote = '检测到单元格级 fill 但未显式使用 "__rowFill"；已自动将其扩展为整行填充。后续建议直接对每行使用 "__rowFill" 控制整行颜色。'
  }
  return out
}

// 分发：.xlsx 用 ExcelJS 保留样式；.xls 为旧格式，ExcelJS 不支持，回退 SheetJS（不保样式）
function updateSpreadsheet(target, content, opts) {
  const ext = path.extname(target).toLowerCase()
  if (ext === '.xls') return updateSpreadsheetLegacy(target, content, opts)
  return updateSpreadsheetXlsx(target, content, opts)
}

// ── 命令：write ───────────────────────────────────────────
function cmdWrite(positional, flags, roots) {
  const target = positional[0]
  if (!target) throw new CommandError('write 需要指定文件路径', 'MISSING_ARG')
  const ext = path.extname(target).toLowerCase()
  const isSheet = ext === '.xlsx' || ext === '.xls'
  if (!isSheet && WRITE_UNSUPPORTED.has(ext)) {
    throw new CommandError(
      `暂不支持生成该二进制格式：${path.basename(target)}（write 目前仅支持文本类 md/txt/csv/json 与电子表格 xlsx/xls）`,
      'WRITE_BINARY_UNSUPPORTED'
    )
  }
  // 内容来源：优先 --content，其次路径后的位置参数（write file.txt "内容"）
  let content = flags.content
  if (content === undefined) content = positional.slice(1).join(' ')
  if (content === undefined) throw new CommandError('缺少写入内容（--content 或路径后位置参数）', 'MISSING_ARG')

  const doUpdate = isSheet && !!flags.update
  // 还原模型常用的字面转义（update 模式给的是 JSON，不做转义以免破坏）
  if (!doUpdate) {
    content = String(content).replace(/\\n/g, '\n').replace(/\\t/g, '\t')
  }

  // 电子表格原地按关键列回填（xlsx / xls）：content 为 JSON { key, rows }
  if (doUpdate) {
    return updateSpreadsheet(target, content, { roots })
  }
  // 电子表格（xlsx / xls）：把 CSV/TSV/JSON 内容写成真正的二进制工作簿。
  // 护栏：禁止用「无 --update」的 write 直接覆盖已存在的表格——那样会丢失原工作表名
  // （如 Sheet2）与全部样式，重建内容也未必符合预期。已有文件要做新增/修改/标记颜色，
  // 一律用 --update 在原表上原地处理。确需覆盖重建时显式传 --force。
  if (isSheet) {
    const { root: sr, rest: st } = pickRoot(target, roots)
    const sabs = resolveSafe(sr, st)
    if (!flags.append && !flags.force && fs.existsSync(sabs)) {
      throw new CommandError(
        `目标已存在：${target}。禁止用「无 --update」的 write 直接重建表格（会丢失原工作表名与样式）。请改用 write --update 在原表格上按关键列新增/修改/标记颜色；确需覆盖重建时加 --force。`,
        'EXISTS_NO_UPDATE'
      )
    }
    return writeSpreadsheet(target, content, { append: !!flags.append, roots })
  }

  const { root, rest } = pickRoot(target, roots)
  // 新建写入允许目标不存在；仅当 append 到不存在文件时单独报错，避免 mustExist 误判
  const abs = resolveSafe(root, rest)
  if (flags.append && !fs.existsSync(abs)) {
    throw new CommandError(`append 目标不存在：${target}`, 'NOT_FOUND')
  }

  const buf = Buffer.from(content, 'utf8')
  if (flags.append) fs.appendFileSync(abs, buf)
  else fs.writeFileSync(abs, buf)
  const after = fs.statSync(abs)
  return {
    ok: true,
    command: 'write',
    path: abs,
    relative: displayRel(aliasOf(roots, root), root, abs),
    bytes: buf.length,
    append: !!flags.append,
    size: after.size
  }
}

// ── 分发 ──────────────────────────────────────────────────
const COMMANDS = {
  ping: (pos) => cmdPing(pos),
  read: (pos, flags, roots) => cmdRead(pos, flags, roots),
  read_batch: (pos, flags, roots) => cmdReadBatch(pos, flags, roots),
  list: (pos, flags, roots) => cmdList(pos, flags, roots),
  search: (pos, flags, roots) => cmdSearch(pos, flags, roots),
  write: (pos, flags, roots) => cmdWrite(pos, flags, roots)
}

function usage() {
  return [
    'file-office-local 用法：',
    '  node file_office.js ping [--json]',
    '  node file_office.js read <path> [--offset N] [--limit N] [--max-bytes N] --root <目录> [--extra-root <别名>|<目录> ...] [--json]',
    '  node file_office.js read_batch <path1> [path2 ...] [--path <p> ...] --root <目录> [--extra-root <别名>|<目录> ...] [--json]',
    '  node file_office.js list <dir> [--depth N] --root <目录> [--extra-root <别名>|<目录> ...] [--json]',
    '  node file_office.js search <词> [<dir>] [--name-only] [--regex] [--glob <通配>] [--ext <ext,...>] [--depth N] [--max-results N] [--index] [--rebuild-index] --root <目录> [--extra-root <别名>|<目录> ...] [--json]',
    '  node file_office.js write <path> [--content <文本>] [--append] [--update] --root <目录> [--extra-root <别名>|<目录> ...] [--json]'
  ].join('\n')
}

async function main() {
  const argv = process.argv.slice(2)
  const { positional, flags } = parseArgs(argv)
  const command = positional[0]
  const args = positional.slice(1)
  const asJson = !!flags.json

  if (!command || flags.help) {
    if (asJson) printJson({ ok: false, error: 'MISSING_COMMAND', usage: usage() })
    else console.log(usage())
    process.exitCode = 1
    return
  }

  const handler = COMMANDS[command]
  if (!handler) {
    const msg = `不支持的命令：${command}`
    if (asJson) printJson({ ok: false, command, error: msg, available: Object.keys(COMMANDS) })
    else console.error(msg)
    process.exitCode = 1
    return
  }

  // 组装多根白名单：--root 为主根（alias=''），--extra-root <别名>|<目录> 为额外根
  const root = flags.root ? path.resolve(String(flags.root)) : ''
  const extraRoots = []
  const extras = Array.isArray(flags['extra-root']) ? flags['extra-root'] : (flags['extra-root'] ? [flags['extra-root']] : [])
  for (const e of extras) {
    const s = String(e)
    const i = s.indexOf('|')
    if (i > 0) extraRoots.push({ alias: s.slice(0, i), path: path.resolve(s.slice(i + 1)) })
  }
  const roots = []
  if (root) roots.push({ alias: '', path: root })
  roots.push(...extraRoots)

  // OpenCode 风格：不传 --root / --extra-root 时，roots 为空，表示允许访问本机任意文件/目录（全文件系统）。
  const result = await handler(args, flags, roots)
  if (asJson) printJson(result)
  else console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
}

main().catch((e) => {
  const payload = {
    ok: false,
    error: e && e.message ? e.message : String(e),
    code: e && e.code ? e.code : undefined
  }
  if (e instanceof SandboxError) {
    payload.code = 'PATH_OUTSIDE_ROOT'
    printJson(payload)
    process.exitCode = 2
    return
  }
  printJson(payload)
  process.exitCode = 1
})
