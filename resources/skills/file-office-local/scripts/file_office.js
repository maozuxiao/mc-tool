#!/usr/bin/env node
'use strict'
/**
 * file-office-local 统一入口
 *
 * 用法：
 *   node file_office.js <command> [args...] [--root <工作区根目录>] [--json]
 *
 * 命令：
 *   ping                      健康检查，同时报告各格式依赖的加载状态
 *   read  <path> [--offset N] [--limit N] [--max-bytes N]
 *                             读取文本类文件（md/txt/csv/json/log/yml...）
 *
 * 全局选项：
 *   --root <目录>    工作区根目录，所有路径必须落在其中（沙箱边界）
 *   --json           以 ===JSON_BEGIN===/===JSON_END=== 包裹输出结构化结果
 *
 * 输出协议与 mc_query.js 保持一致：结果 JSON 打印在标记之间，
 * 便于调用方从 stdout 中可靠提取（脚本自身允许输出进度日志）。
 */
const fs = require('fs')
const path = require('path')
const { SandboxError, resolveSafe } = require('./lib/sandbox')

const DEFAULT_MAX_BYTES = 200 * 1024 // 单次读取上限，避免撑爆模型上下文
const HARD_MAX_BYTES = 2 * 1024 * 1024 // 无论如何不超过 2MB

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
    // 明显的 UTF-8 解码失败：按 GBK 再试，选替换字符更少的那个
    const gbk = iconv.decode(buf, 'gbk')
    const gbkBad = (gbk.match(/\uFFFD/g) || []).length
    return gbkBad < replacement
      ? { text: gbk, encoding: 'gbk' }
      : { text: utf8, encoding: 'utf-8' }
  }
  return { text: utf8, encoding: 'utf-8' }
}

// ── 命令：ping ────────────────────────────────────────────
// 逐个 require 依赖并报告状态。目的是把「原生模块 / 缺失依赖」这类问题
// 在第一次调用时就能暴露，而不是等到真正读某个格式时才炸。
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
  // 无扩展名（如 LICENSE、Dockerfile）按文本处理
  return ext === ''
}

function cmdRead(positional, flags, root) {
  const target = positional[0]
  if (!target) throw new CommandError('read 需要指定文件路径', 'MISSING_ARG')

  const abs = resolveSafe(root, target, { mustExist: true })
  const stat = fs.statSync(abs)
  if (stat.isDirectory()) {
    throw new CommandError(`目标是目录，不是文件：${target}（请用 list 命令）`, 'IS_DIRECTORY')
  }
  if (!isTextFile(abs)) {
    throw new CommandError(
      `暂不支持该格式的文本化读取：${path.basename(abs)}（Office/PDF 读取在后续步骤接入）`,
      'UNSUPPORTED_FORMAT'
    )
  }

  const maxBytes = Math.min(toInt(flags['max-bytes'], DEFAULT_MAX_BYTES), HARD_MAX_BYTES)
  const offset = toInt(flags.offset, 0) // 起始行（0 基）
  const limit = toInt(flags.limit, 0) // 读取行数，0 表示不限

  let truncated = false
  let buf
  if (stat.size > maxBytes) {
    // 大文件只读前 maxBytes，避免把整个文件塞进上下文
    const fd = fs.openSync(abs, 'r')
    try {
      buf = Buffer.alloc(maxBytes)
      fs.readSync(fd, buf, 0, maxBytes, 0)
    } finally {
      fs.closeSync(fd)
    }
    truncated = true
  } else {
    buf = fs.readFileSync(abs)
  }

  const { text, encoding } = decodeText(buf)
  let content = text
  if (offset > 0 || limit > 0) {
    const lines = content.split(/\r?\n/)
    const slice = lines.slice(offset, limit > 0 ? offset + limit : undefined)
    content = slice.join('\n')
    if (offset + slice.length < lines.length) truncated = true
  }

  return {
    ok: true,
    command: 'read',
    path: abs,
    relative: path.relative(path.resolve(root), abs).replace(/\\/g, '/'),
    size: stat.size,
    encoding,
    bytesRead: Buffer.byteLength(content, 'utf8'),
    truncated,
    ...(truncated ? { truncatedNote: `内容已截断（上限 ${maxBytes} 字节），如需更多请指定 --offset/--limit 分段读取` } : {}),
    text: content
  }
}

// ── 分发 ──────────────────────────────────────────────────
const COMMANDS = {
  ping: (pos, flags) => cmdPing(pos, flags),
  read: (pos, flags, root) => cmdRead(pos, flags, root)
}

function usage() {
  return [
    'file-office-local 用法：',
    '  node file_office.js ping [--json]',
    '  node file_office.js read <path> [--offset N] [--limit N] [--max-bytes N] --root <目录> [--json]'
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
    // 沙箱拒绝是「AI 越界」的信号，单独编码便于上层给出明确提示
    payload.code = 'PATH_OUTSIDE_ROOT'
    printJson(payload)
    process.exitCode = 2
    return
  }
  printJson(payload)
  process.exitCode = 1
})
