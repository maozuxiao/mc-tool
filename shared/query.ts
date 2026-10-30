import { BASE, ORG } from './constants'
import type { MaterialRow } from './types'

// ────────────────────────────────────────────────────────────
// 从 v3.9 用户脚本迁移的纯查询逻辑（无 DOM 依赖，主/渲染进程共用）
// ────────────────────────────────────────────────────────────

// OA 接口返回的数据结构有两种：
//   旧假设: { datas: [ [ {col, value} ] ] }
//   真实返回: { columns:[{title,property}], datas:[ {ITEM_NUMBER, ITEM_DESC, ...} ] }
interface RawCol {
  col: string
  value?: string
}
export interface RawResponse {
  columns?: { title?: string; property?: string }[]
  datas?: RawCol[][] | Record<string, any>[]
}

// 将 OA 返回的行数组转成平铺对象数组
export function normalizeRows(json: RawResponse): MaterialRow[] {
  if (!json || !json.datas) return []
  const datas: any = json.datas
  // 真实返回：datas 是对象数组 [{ITEM_NUMBER,...}]
  if (Array.isArray(datas) && datas.length && typeof datas[0] === 'object' && !Array.isArray(datas[0])) {
    return datas.map((r: any) => {
      const o: MaterialRow = {}
      for (const k of Object.keys(r)) o[k] = r[k]
      return o
    })
  }
  // 旧结构：datas 是数组的数组 [[{col,value}]]
  if (Array.isArray(datas)) {
    return datas.map(row => {
      const o: MaterialRow = {}
      ;(row || []).forEach((c: RawCol) => {
        o[c.col] = c.value || ''
      })
      return o
    })
  }
  return []
}

// ── 物料查询 ───────────────────────────────────────────────
// V1.0.6：搜索条件（描述关键词）不再拼接料号 ITEM_NUMBER，仅按描述查询
export function buildSearchUrl(desc: string, seq = Date.now()): string {
  const parts = [`method=wuliao`, `q.ORGANIZATION_ID=${ORG}`]
  if (desc) parts.push(`q.ITEM_DESC=${encodeURIComponent(desc)}`)
  parts.push(`__seq=${seq}`)
  return `${BASE}?${parts.join('&')}`
}

// V1.0.6：查料号改为独立查询，仅按 ITEM_NUMBER 查询，不与描述条件拼接
export function buildItemNoUrl(itemNo: string, seq = Date.now()): string {
  return `${BASE}?method=wuliao&q.ORGANIZATION_ID=${ORG}&q.ITEM_NUMBER=${encodeURIComponent(
    itemNo
  )}&__seq=${seq}`
}

// ── 批量料号查询 ───────────────────────────────────────────
/**
 * 料号归一化（2026-10-30）。
 *
 * 背景：业务同事从邮件 / Excel 里复制过来的料号常常是 **4-4-4(-1) 分组带空格**的样子
 * （如 `5154 0211 0005 1`），而 OA 的 `q.ITEM_NUMBER` 只认连续数字串。旧实现按空白拆分，
 * 于是一个料号被拆成 4 个碎片逐个去查，必然全部 miss（用户实测：8 个料号全查不到）。
 *
 * 规则：全角转半角 → 去掉所有空白与 `-` / `_` → 若结果是 12 或 13 位纯数字则视为料号、
 * 返回紧凑串；否则**原样返回**（trim 后），以免把描述关键词之类的内容改坏。
 * 13 位是「4-4-4 + 1 位版本」的形态（如 5110 0381 0002 9）。
 */
export function normalizeItemNo(raw: string): string {
  const trimmed = String(raw ?? '').trim()
  const compact = trimmed
    // 全角字符（\uFF01-\uFF5E）与半角相差 0xFEE0，全角空格 \u3000 单独换成半角空格
    .replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .replace(/[\s\-_]/g, '')
  return isItemNo(compact) ? compact : trimmed
}

/** 料号形态：12 位或 13 位纯数字 */
export function isItemNo(v: string): boolean {
  return /^\d{12,13}$/.test(v)
}

/**
 * 批量料号解析。
 *
 * 逐行处理，行内再按需要拆分 —— 这样「一行一个带空格料号」的粘贴形态不会被切碎：
 *  ① 整行归一化后就是一个料号 → 直接收下；
 *  ② 否则按逗号 / 分号 / 顿号 / 空白切成 token，再把**相邻的纯数字 token 重新聚合**
 *     成 12 或 13 位（覆盖「一行里两个带空格料号」这种形态）。
 *
 * 聚合时「12 位之后紧跟单个数字」不切分 —— 那是 13 位料号的最后一位，
 * 早切会把 `5154 0211 0005 1` 变成 `515402210005` + `1`。
 */
export function parseBatchItemNos(text: string): string[] {
  const out: string[] = []
  const push = (v: string) => { const s = v.trim(); if (s) out.push(s) }

  for (const line of String(text ?? '').split(/[\r\n]+/)) {
    const seg = line.trim()
    if (!seg) continue

    const whole = normalizeItemNo(seg)
    if (isItemNo(whole)) { push(whole); continue }

    const toks = seg.split(/[\s,，;；、|\t]+/).filter(Boolean)
    let buf = ''
    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i]
      if (!/^\d+$/.test(tk)) {
        if (buf) { push(buf); buf = '' }
        push(normalizeItemNo(tk))
        continue
      }
      buf += tk
      const nextIsSingleDigit = /^\d$/.test(toks[i + 1] || '')
      if (buf.length === 13 || (buf.length === 12 && !nextIsSingleDigit) || buf.length > 13) {
        push(buf)
        buf = ''
      }
    }
    if (buf) push(buf)
  }
  return out
}

export function buildBatchUrl(itemNo: string, seq: number): string {
  return `${BASE}?method=wuliao&q.ORGANIZATION_ID=${ORG}&q.ITEM_NUMBER=${encodeURIComponent(
    itemNo
  )}&__seq=${Date.now()}_${seq}`
}

// 合并批量查询结果，优先精确匹配
export function mergeBatchResults(
  rows: MaterialRow[],
  itemNo: string
): MaterialRow[] {
  const exact = rows.filter(r => r.ITEM_NUMBER === itemNo)
  if (exact.length) return exact
  if (rows.length) return rows
  return []
}

// ── BOM 查询 ───────────────────────────────────────────────
export function buildBomUrl(itemNo: string, seq = Date.now()): string {
  return `${BASE}?method=bom&q.ORGANIZATION_ID=${ORG}&q.ASSEMBLY_ITEM_NUMBER=${encodeURIComponent(
    itemNo
  )}&__seq=${seq}`
}

// ── 规格文件查询 ───────────────────────────────────────────
export function buildFileUrl(itemNo: string, seq = Date.now()): string {
  return `${BASE}?method=specificationFile&q.itemNumber=${encodeURIComponent(
    itemNo
  )}&__seq=${seq}`
}

// ── 过滤 / 去重 / 排序 ─────────────────────────────────────
export function getDedupedData(
  data: MaterialRow[],
  enabled: boolean
): MaterialRow[] {
  if (!enabled) return data
  const seen = new Set<string>()
  return data.filter(r => {
    const k = String(r.ITEM_NUMBER || '')
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export interface FilterOptions {
  include: string // 包含词，空格=AND，|=OR
  exclude: string // 排除词，逗号分隔
  type?: string // 物料类型精确过滤
  statuses?: Set<string> // 生命周期多选
}

export function applyMaterialFilter(
  data: MaterialRow[],
  opt: FilterOptions
): MaterialRow[] {
  const rawInclude = (opt.include || '').trim()
  const rawExclude = (opt.exclude || '').trim()
  const includeGroups = rawInclude
    ? rawInclude
        .replace(/\s*\|\s*/g, '|')
        .split(/\s+/)
        .map(g => g.split('|').map(t => t.trim().toLowerCase()).filter(Boolean))
        .filter(g => g.length > 0)
    : []
  const excludeTerms = rawExclude
    ? rawExclude
        .split(/[,，]/)
        .map(t => t.trim().toLowerCase())
        .filter(Boolean)
    : []

  return data.filter(r => {
    if (opt.type && r.ITEM_TYPE !== opt.type) return false
    if (opt.statuses && opt.statuses.size > 0 && !opt.statuses.has(String(r.INV_STATUS_NAME)))
      return false
    const hay = [
      r.ITEM_NUMBER,
      r.ITEM_DESC,
      r.ITEM_TYPE,
      r.INV_STATUS_NAME,
      r.K3_ITEM_NUMBER
    ]
      .join(' ')
      .toLowerCase()
    for (const group of includeGroups) {
      if (!group.some(t => hay.includes(t))) return false
    }
    for (const t of excludeTerms) {
      if (t && hay.includes(t)) return false
    }
    return true
  })
}

export function applyBomFilter(data: MaterialRow[], kw: string, kwNot = ''): MaterialRow[] {
  const raw = (kw || '').trim()
  const groups = raw
    ? raw
        .replace(/\s*\|\s*/g, '|')
        .split(/\s+/)
        .map(g => g.split('|').map(t => t.trim().toLowerCase()).filter(Boolean))
        .filter(g => g.length > 0)
    : []
  const excludeTerms = (kwNot || '')
    .split(/[,，]/)
    .map(t => t.trim().toLowerCase())
    .filter(Boolean)
  return data.filter(r => {
    const hay = [
      r.COMPONENT_ITEM,
      r.COMPONENT_ITEM_DESC,
      r.K3_ITEM_NUMBER,
      r.COMPONENT_REMARKS
    ]
      .join(' ')
      .toLowerCase()
    for (const g of groups) {
      if (!g.some(t => hay.includes(t))) return false
    }
    for (const t of excludeTerms) {
      if (t && hay.includes(t)) return false
    }
    return true
  })
}

// 通用排序
export function sortRows<T extends Record<string, string | number>>(
  rows: T[],
  key: string,
  asc: boolean,
  numeric = false
): T[] {
  return [...rows].sort((a, b) => {
    let va: string | number = a[key] || ''
    let vb: string | number = b[key] || ''
    if (numeric) {
      va = parseFloat(String(va)) || 0
      vb = parseFloat(String(vb)) || 0
    }
    if (va < vb) return asc ? -1 : 1
    if (va > vb) return asc ? 1 : -1
    return 0
  })
}

// 将服务端返回的相对链接转换为绝对地址并新标签打开
export function fixLinks(html: string, origin: string): string {
  return (html || '')
    .replace(/href="\//g, `href="${origin}/`)
    .replace(/src="\//g, `src="${origin}/`)
    .replace(/<a /g, '<a target="_blank" rel="noopener" ')
}

// 从 OA 返回的 fileName 字段（可能含无效嵌套 <a> 的 HTML）提取真实下载链接
// OA 返回形如：<a href="/ruiming/.../specificationFileDownload?...">真实文件名</a>
// 但有时 <a> 未正常闭合（嵌套了另一个 <a>），需兼容处理
export function extractFileLink(
  fileNameHtml: string,
  origin: string
): { url: string; text: string } | null {
  const html = (fileNameHtml || '').toString()
  // 优先匹配有闭合标签的：<a href="...">文本</a>
  const mClosed = html.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i)
  // 退路：只匹配 <a href="...">（可能未闭合）
  const mOpen = html.match(/<a[^>]*href="([^"]*)"/i)

  const urlMatch = mClosed || mOpen
  if (!urlMatch) return null

  let url = urlMatch[1]
  if (url.startsWith('/')) url = origin + url

  // 无有效文件标识（fileId 与 fileName 均为空）视为无附件，避免渲染无效空链接
  const hasFileId = /fileId=([^&]+)/i.test(url) && !/fileId=&/.test(url) && !/[?&]fileId=$/.test(url)
  const hasFileName = /fileName=([^&]+)/i.test(url) && !/fileName=&/.test(url) && !/[?&]fileName=$/.test(url)
  if (!hasFileId && !hasFileName) return null

  // 提取显示文本：优先闭合标签内的文本，否则从 href 的 fileName= 参数取，再否则用默认
  let text = ''
  if (mClosed && mClosed[2]) {
    text = mClosed[2].replace(/<[^>]*>/g, '').trim()
  }
  if (!text) {
    const fnMatch = url.match(/fileName=([^&]+)/i)
    if (fnMatch) text = decodeURIComponent(fnMatch[1])
  }
  if (!text) {
    // 从 URL 路径段兜底提取文件名
    try {
      const u = new URL(url)
      const seg = u.pathname.split('/').pop() || ''
      if (seg) text = decodeURIComponent(seg)
    } catch { /* ignore */ }
  }
  if (!text || text === '') text = '下载规格文件'

  return { url, text }
}

// HTML 转义
export function escapeHtml(s: string | number | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// CSV 导出（带 BOM，文本列加等号防止数字被科学计数法）
export function toCSV(headers: string[] | string, keys: string[], rows: MaterialRow[], textCols: Set<string>): string {
  // 确保表头为数组（某些 i18n 取值可能返回合并后的字符串）
  const headerRow: string[] = Array.isArray(headers)
    ? headers
    : String(headers).split(',').map(s => s.trim())
  const csv = [headerRow, ...rows.map(r => keys.map(k => {
    const v = String(r[k] ?? '').replace(/"/g, '""')
    return textCols.has(k) ? `"=""${v}"""` : `"${v}"`
  }))]
    .map(r => r.join(','))
    .join('\n')
  return '﻿' + csv
}
