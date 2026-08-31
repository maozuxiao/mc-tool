#!/usr/bin/env node
'use strict'
/**
 * file-office-local 统一入口
 *
 * 用法：
 *   node file_office.js <command> [args...] [--root <工作区根目录>] [--json]
 *
 * 命令：
 *   ping                                 健康检查，报告各格式依赖加载状态
 *   read  <path> [--offset N] [--limit N] [--max-bytes N]
 *                                       读文本 / docx / xlsx / pptx / pdf
 *   list  <dir> [--depth N]             列目录
 *   search <词> [<dir>] [--name-only] [--depth N] [--max-results N]
 *                                       按文件名 / 内容搜索
 *   write <path> [--content <文本>] [--append]
 *                                       写文本类文件（md/txt/csv/json...）
 *
 * 全局选项：
 *   --root <目录>    工作区根目录，所有路径必须落在其中（沙箱边界）
 *   --json           以 ===JSON_BEGIN===/===JSON_END=== 包裹输出结构化结果
 *
 * 输出协议与 mc_query.js 一致：结果 JSON 打印在标记之间，便于调用方提取。
 */
const fs = require('fs')
const path = require('path')
const { SandboxError, resolveSafe } = require('./lib/sandbox')
const { readerFor } = require('./lib/readers')

const DEFAULT_MAX_BYTES = 200 * 1024 // 单次读取上限，避免撑爆模型上下文
const HARD_MAX_BYTES = 2 * 1024 * 1024 // 无论如何不超过 2MB
// 这些二进制格式暂时只能「读」，write 还没实现生成，避免写出无效文件
const WRITE_UNSUPPORTED = new Set(['.docx', '.xlsx', '.pptx', '.pdf', '.doc', '.xls', '.ppt'])

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
      if (eq > -1) {
        flags[key.slice(0, eq)] = key.slice(eq + 1)
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[key] = argv[++i]
      } else {
        flags[key] = true
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
    return { text: buf.swap16().toString('utf16le'), encoding: 'utf-16be' }
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
  exceljs: 'exceljs',
  mammoth: 'mammoth',
  docx: 'docx',
  pptxgenjs: 'pptxgenjs',
  jszip: 'jszip',
  'pdfjs-dist': 'pdfjs-dist/legacy/build/pdf.js',
  'iconv-lite': 'iconv-lite'
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

function relOf(root, abs) {
  return path.relative(path.resolve(root), abs).replace(/\\/g, '/')
}

async function cmdRead(positional, flags, root) {
  const target = positional[0]
  if (!target) throw new CommandError('read 需要指定文件路径', 'MISSING_ARG')

  const abs = resolveSafe(root, target, { mustExist: true })
  const stat = fs.statSync(abs)
  if (stat.isDirectory()) {
    throw new CommandError(`目标是目录，不是文件：${target}（请用 list 命令）`, 'IS_DIRECTORY')
  }

  const maxBytes = Math.min(toInt(flags['max-bytes'], DEFAULT_MAX_BYTES), HARD_MAX_BYTES)
  const offset = toInt(flags.offset, 0)
  const limit = toInt(flags.limit, 0)
  const ext = path.extname(abs).toLowerCase()

  let text
  let format
  const reader = readerFor(ext)
  if (reader) {
    const raw = await reader(abs)
    text = raw.text
    format = raw.format
  } else if (isTextFile(abs)) {
    const buf = stat.size > maxBytes ? fs.readFileSync(abs) : fs.readFileSync(abs)
    const d = decodeText(buf)
    text = d.text
    format = 'text'
  } else {
    throw new CommandError(
      `暂不支持读取该格式：${path.basename(abs)}（支持文本类 / docx / xlsx / pptx / pdf）`,
      'UNSUPPORTED_FORMAT'
    )
  }

  const { content, truncated } = applyTruncation(text, maxBytes, offset, limit)
  return {
    ok: true,
    command: 'read',
    path: abs,
    relative: relOf(root, abs),
    size: stat.size,
    format,
    bytesRead: Buffer.byteLength(content, 'utf8'),
    truncated,
    ...(truncated ? { truncatedNote: `内容已截断（上限 ${maxBytes} 字节），如需更多请指定 --offset/--limit 分段读取` } : {}),
    text: content
  }
}

// ── 命令：list ────────────────────────────────────────────
function cmdList(positional, flags, root) {
  const target = positional[0] || '.'
  const abs = resolveSafe(root, target, { mustExist: true })
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
    relative: relOf(root, abs) || '.',
    depth,
    count: entries.length,
    entries
  }
}

// ── 命令：search ──────────────────────────────────────────
function cmdSearch(positional, flags, root) {
  const query = positional[0]
  if (!query) throw new CommandError('search 需要查询词', 'MISSING_ARG')
  const q = query.toLowerCase()
  const dir = positional[1] || '.'
  const abs = resolveSafe(root, dir, { mustExist: true })
  const nameOnly = !!flags['name-only']
  const maxResults = toInt(flags['max-results'], 50)
  const maxDepth = toInt(flags.depth, 8)
  const results = []

  function walk(d, current) {
    if (results.length >= maxResults || current > maxDepth) return
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (results.length >= maxResults) return
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        walk(full, current + 1)
      } else if (e.isFile()) {
        const rel = relOf(root, full)
        if (e.name.toLowerCase().includes(q)) {
          results.push({ relative: rel, name: e.name, match: 'name' })
        } else if (!nameOnly && isTextFile(full)) {
          try {
            const txt = decodeText(fs.readFileSync(full)).text.toLowerCase()
            if (txt.includes(q)) results.push({ relative: rel, name: e.name, match: 'content' })
          } catch { /* 解码失败跳过 */ }
        }
      }
    }
  }
  walk(abs, 0)

  return {
    ok: true,
    command: 'search',
    query,
    root: dir === '.' ? '.' : relOf(root, abs),
    count: results.length,
    results
  }
}

// ── 命令：write ───────────────────────────────────────────
function cmdWrite(positional, flags, root) {
  const target = positional[0]
  if (!target) throw new CommandError('write 需要指定文件路径', 'MISSING_ARG')
  const ext = path.extname(target).toLowerCase()
  if (WRITE_UNSUPPORTED.has(ext)) {
    throw new CommandError(
      `暂不支持生成该二进制格式：${path.basename(target)}（write 目前仅支持文本类 md/txt/csv/json 等）`,
      'WRITE_BINARY_UNSUPPORTED'
    )
  }
  // 内容来源：优先 --content，其次路径后的位置参数（write file.txt "内容"）
  let content = flags.content
  if (content === undefined) content = positional.slice(1).join(' ')
  if (content === undefined) throw new CommandError('缺少写入内容（--content 或路径后位置参数）', 'MISSING_ARG')
  // 还原模型常用的字面转义
  content = String(content).replace(/\\n/g, '\n').replace(/\\t/g, '\t')
  const append = !!flags.append
  // 新建写入允许目标不存在；仅当 append 到不存在文件时单独报错，避免 mustExist 误判
  const abs = resolveSafe(root, target)
  if (append && !fs.existsSync(abs)) {
    throw new CommandError(`append 目标不存在：${target}`, 'NOT_FOUND')
  }

  const buf = Buffer.from(content, 'utf8')
  if (append) fs.appendFileSync(abs, buf)
  else fs.writeFileSync(abs, buf)
  const after = fs.statSync(abs)
  return {
    ok: true,
    command: 'write',
    path: abs,
    relative: relOf(root, abs),
    bytes: buf.length,
    append,
    size: after.size
  }
}

// ── 分发 ──────────────────────────────────────────────────
const COMMANDS = {
  ping: (pos) => cmdPing(pos),
  read: (pos, flags, root) => cmdRead(pos, flags, root),
  list: (pos, flags, root) => cmdList(pos, flags, root),
  search: (pos, flags, root) => cmdSearch(pos, flags, root),
  write: (pos, flags, root) => cmdWrite(pos, flags, root)
}

function usage() {
  return [
    'file-office-local 用法：',
    '  node file_office.js ping [--json]',
    '  node file_office.js read <path> [--offset N] [--limit N] [--max-bytes N] --root <目录> [--json]',
    '  node file_office.js list <dir> [--depth N] --root <目录> [--json]',
    '  node file_office.js search <词> [<dir>] [--name-only] [--depth N] [--max-results N] --root <目录> [--json]',
    '  node file_office.js write <path> [--content <文本>] [--append] --root <目录> [--json]'
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

  // 除 ping 外，所有命令都必须带工作区根目录（沙箱边界）
  const root = flags.root ? path.resolve(String(flags.root)) : ''
  if (command !== 'ping' && !root) {
    printJson({ ok: false, command, error: '缺少 --root 参数（工作区根目录）' })
    process.exitCode = 1
    return
  }

  const result = await handler(args, flags, root)
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
