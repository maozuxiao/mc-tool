/**
 * Jira / JSM 工单助手 · 字段层（1.0.71）
 *
 * 职责：字段定义解析（customfield_xxx）、创建工单必填校验、优先级/组织取值。
 * 为什么需要这一层：JSM 的 Request Type 表单是站点自定义的，
 * 组织字段是自定义字段、优先级 id 也可能被改过 —— 全都不能硬编码，必须现场查。
 */
import { jsmErrorText, jsmFetch, validateConfig } from './client'
import type { JiraConfig } from './config'
import { rdmsUrlFor } from './panel'

export interface FieldDef { id: string; name: string; custom: boolean }
export interface ValidValue { value: string; label: string }

/** 字段定义缓存（按站点 base），避免每次创建工单都拉一遍全部字段 */
const FIELD_DEFS_CACHE = new Map<string, FieldDef[]>()

export async function getFieldDefs(cfg: JiraConfig, signal?: AbortSignal): Promise<FieldDef[]> {
  const { base, errors } = validateConfig(cfg)
  if (errors.length) throw new Error(errors.join('；'))
  const cached = FIELD_DEFS_CACHE.get(base)
  if (cached) return cached
  const r = await jsmFetch(cfg, 'GET', '/rest/api/2/field', null, signal)
  if (r.status !== 200) throw new Error(jsmErrorText(r))
  const list = (Array.isArray(r.json) ? r.json : []).map((f: any) => ({
    id: String(f.id), name: String(f.name || ''), custom: !!f.custom
  }))
  FIELD_DEFS_CACHE.set(base, list)
  return list
}

export function clearFieldCaches(): void {
  FIELD_DEFS_CACHE.clear()
  RT_FIELD_CACHE.clear()
  PRIORITY_CACHE.clear()
  ORG_FIELD_CACHE.clear()
}

/** 字段名 / 字段 ID → 字段定义（精确名优先，其次包含匹配） */
export function resolveFieldDefs(defs: FieldDef[], names: string[]): FieldDef[] {
  const out: FieldDef[] = []
  for (const raw of names) {
    const w = String(raw || '').trim()
    if (!w) continue
    const hit = defs.find(f => f.id.toLowerCase() === w.toLowerCase())
      || defs.find(f => f.name.toLowerCase() === w.toLowerCase())
      || defs.find(f => f.name.toLowerCase().includes(w.toLowerCase()))
    if (hit && !out.some(x => x.id === hit.id)) out.push(hit)
  }
  return out
}

/**
 * 写入路径的字段解析：`{"根本原因": "xxx"}` → `{ customfield_11205: "xxx" }`。
 * 支持三种键：customfield_11205 / 纯数字 11205（JSM 请求字段 id）/ 字段名。
 * unresolved 会如实回传，让模型知道哪些键没写进去，而不是静默丢弃。
 */
export async function resolveWritableFields(
  cfg: JiraConfig,
  input: any,
  signal?: AbortSignal
): Promise<{ fields: Record<string, any>; unresolved: string[] }> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('fields 必须是一个对象，例如 {"根本原因": "内容"}')
  }
  const keys = Object.keys(input)
  if (!keys.length) return { fields: {}, unresolved: [] }

  const defs = await getFieldDefs(cfg, signal)
  const fields: Record<string, any> = {}
  const unresolved: string[] = []
  for (const k of keys) {
    const w = String(k).trim()
    if (!w) continue
    if (/^customfield_\d+$/i.test(w)) { fields[w.toLowerCase()] = input[k]; continue }
    if (/^\d+$/.test(w)) { fields[`customfield_${w}`] = input[k]; continue }
    const hit = resolveFieldDefs(defs, [w])[0]
    if (hit) fields[hit.id] = input[k]
    else unresolved.push(w)
  }
  return { fields, unresolved }
}

// ── 请求类型字段定义 / 组织 / 优先级 ──────────────────────
export interface RtField {
  fieldId: string
  name: string
  required: boolean
  visibility: string
  validValues: ValidValue[]
  hasDefault: boolean
  description: string
}

const RT_FIELD_CACHE = new Map<string, { at: number; fields: RtField[] }>()
const RT_FIELD_TTL_MS = 10 * 60 * 1000

/** 组织字段的常见命名：JSM 默认 Organizations，中文站点是「组织」/「客戶組織」 */
export const ORG_FIELD_RE = /^organi[sz]ations?$|组织|組織/i

function flattenValidValues(list: any, depth = 0): ValidValue[] {
  const out: ValidValue[] = []
  if (!Array.isArray(list) || depth > 2) return out
  for (const v of list) {
    if (!v || typeof v !== 'object') continue
    if (v.value !== undefined) out.push({ value: String(v.value), label: String(v.label != null ? v.label : v.value) })
    if (Array.isArray(v.children) && v.children.length) out.push(...flattenValidValues(v.children, depth + 1))
  }
  return out
}

/**
 * 某服务台 + 某请求类型的字段定义 —— 判断「组织字段 id / 优先级可选值 / 哪些必填」的唯一可靠来源。
 * 权限不足或类型不存在时返回 null，由调用方降级，不让整个创建流程失败。
 */
export async function getRequestTypeFieldDefs(
  cfg: JiraConfig,
  serviceDeskId: string,
  requestTypeId: string,
  signal?: AbortSignal
): Promise<RtField[] | null> {
  const { base } = validateConfig(cfg)
  const cacheKey = `${base}|${serviceDeskId}|${requestTypeId}`
  const cached = RT_FIELD_CACHE.get(cacheKey)
  if (cached && Date.now() - cached.at < RT_FIELD_TTL_MS) return cached.fields

  const apiPath = `/rest/servicedeskapi/servicedesk/${encodeURIComponent(serviceDeskId)}`
    + `/requesttype/${encodeURIComponent(requestTypeId)}/field`
  const r = await jsmFetch(cfg, 'GET', apiPath, null, signal)
  if (r.status !== 200) return null

  const raw = Array.isArray(r.json && r.json.requestTypeFields) ? r.json.requestTypeFields : []
  const fields: RtField[] = raw.map((f: any) => ({
    fieldId: String(f.fieldId || ''),
    name: String(f.name || ''),
    required: f.required === true,
    visibility: f.visibility || 'SHOW',
    validValues: flattenValidValues(f.validValues),
    hasDefault: f.jiraDefaultValue != null,
    description: f.description ? String(f.description).slice(0, 200) : ''
  })).filter((f: RtField) => f.fieldId)

  RT_FIELD_CACHE.set(cacheKey, { at: Date.now(), fields })
  return fields
}

/**
 * 组织列表。传 serviceDeskId 取该服务台已关联的组织（最贴合创建工单），否则取当前用户可见全部。
 * 自动翻页，最多 200 条，避免组织多时只拿第一页。
 */
export async function fetchOrganizations(
  cfg: JiraConfig,
  serviceDeskId?: string,
  maxTotal = 200,
  signal?: AbortSignal
): Promise<Array<{ id: string; name: string }>> {
  const apiPath = serviceDeskId
    ? `/rest/servicedeskapi/servicedesk/${encodeURIComponent(serviceDeskId)}/organization`
    : '/rest/servicedeskapi/organization'

  const out: any[] = []
  let start = 0
  let status = 200
  let lastResp: any = null
  for (let guard = 0; guard < 10; guard++) {
    const joiner = apiPath.includes('?') ? '&' : '?'
    const r = await jsmFetch(cfg, 'GET', `${apiPath}${joiner}start=${start}&limit=50`, null, signal)
    if (r.status !== 200) { status = r.status; lastResp = r; break }
    const vals = Array.isArray(r.json && r.json.values) ? r.json.values : []
    out.push(...vals)
    const isLast = r.json && r.json.isLastPage !== undefined ? r.json.isLastPage === true : vals.length < 50
    start += vals.length
    if (isLast || !vals.length || out.length >= maxTotal) break
  }

  if (status !== 200) {
    if (status === 403) {
      throw new Error('没有读取组织的权限：需要该服务台的 Agent（服务台工作人员）权限。'
        + '可以改为直接传 organizationId，或让用户在自己的 portal 上先确认组织。')
    }
    throw new Error(jsmErrorText(lastResp))
  }

  const seen = new Set<string>()
  return out
    .map(v => ({ id: String(v.id), name: String(v.name || '') }))
    .filter(o => (seen.has(o.id) ? false : (seen.add(o.id), true)))
}

const DEFAULT_PRIORITY_IDS: Record<string, string> = {
  highest: '1', high: '2', medium: '3', low: '4', lowest: '5',
  最高: '1', 高: '2', 中: '3', 普通: '3', 低: '4', 最低: '5'
}

/** 用户说的优先级（High / 高 / 2）→ JSM 接受的值 { id } */
export function resolvePriorityValue(input: any, validValues?: ValidValue[]): { id: string } | null {
  const s = String(input == null ? '' : input).trim()
  if (!s) return null
  const lower = s.toLowerCase()
  const list = Array.isArray(validValues) ? validValues : []
  const hit = list.find(v => v.label.toLowerCase() === lower)
    || list.find(v => v.value === s)
    || list.find(v => v.label.toLowerCase().includes(lower) || lower.includes(v.label.toLowerCase()))
  if (hit) return { id: hit.value }
  if (/^\d+$/.test(s)) return { id: s }
  return { id: DEFAULT_PRIORITY_IDS[lower] || s }
}

const PRIORITY_CACHE = new Map<string, { at: number; list: ValidValue[] }>()

/** 站点级优先级列表（客户门户表单常不暴露 Priority，但工单上确实有这个字段） */
export async function fetchSitePriorities(cfg: JiraConfig, signal?: AbortSignal): Promise<ValidValue[]> {
  const { base } = validateConfig(cfg)
  const cached = PRIORITY_CACHE.get(base)
  if (cached && Date.now() - cached.at < RT_FIELD_TTL_MS) return cached.list
  const r = await jsmFetch(cfg, 'GET', '/rest/api/2/priority', null, signal)
  if (r.status !== 200) return []
  const list = (Array.isArray(r.json) ? r.json : [])
    .map((p: any) => ({ value: String(p.id), label: String(p.name) }))
    .filter((p: ValidValue) => p.value && p.label)
  PRIORITY_CACHE.set(base, { at: Date.now(), list })
  return list
}

const ORG_FIELD_CACHE = new Map<string, { fieldId: string; name: string } | null>()

/** 站点级 JSM 组织字段（customfield_xxxx）；没启用时返回 null */
export async function findOrganizationField(
  cfg: JiraConfig,
  signal?: AbortSignal
): Promise<{ fieldId: string; name: string } | null> {
  const { base } = validateConfig(cfg)
  if (ORG_FIELD_CACHE.has(base)) return ORG_FIELD_CACHE.get(base) || null
  const defs = await getFieldDefs(cfg, signal).catch(() => [] as FieldDef[])
  const hit = defs.find(f => ORG_FIELD_RE.test(String(f.name || '').trim()))
  const val = hit ? { fieldId: hit.id, name: hit.name } : null
  ORG_FIELD_CACHE.set(base, val)
  return val
}

/** 组织名 / 组织 id → id 列表；找不到的进 unknown 用于提示 */
export function resolveOrganizationIds(
  input: any,
  orgs: Array<{ id: string; name: string }>
): { ids: string[]; unknown: string[] } {
  const inputs = (Array.isArray(input) ? input : [input])
    .map(x => String(x == null ? '' : x).trim())
    .filter(Boolean)
  const ids: string[] = []
  const unknown: string[] = []
  for (const raw of inputs) {
    const lower = raw.toLowerCase()
    const hit = orgs.find(o => o.id === raw)
      || orgs.find(o => o.name.toLowerCase() === lower)
      || orgs.find(o => o.name.toLowerCase().includes(lower))
    if (hit) { if (!ids.includes(hit.id)) ids.push(hit.id) }
    else unknown.push(raw)
  }
  return { ids, unknown }
}

/**
 * 创建成功后补写站点级字段（优先级 / 组织）。
 * 客户门户的 Request Type 表单不一定包含这些字段，放进 requestFieldValues 会被忽略，
 * 因此改成创建后 PUT；组织字段各站点写入形态不同，按 3 种候选依次重试。
 */
export async function applyPostCreateFields(
  cfg: JiraConfig,
  issueKey: string,
  fields: Record<string, any>,
  signal?: AbortSignal
): Promise<{ applied: string[]; failed: string[]; error?: string }> {
  const keys = Object.keys(fields)
  if (!keys.length) return { applied: [], failed: [] }

  const attempts: Array<Record<string, any>> = [fields]
  const orgKey = keys.find(k => Array.isArray(fields[k])
    && fields[k].length
    && fields[k].every((v: any) => v && typeof v === 'object' && v.organizationId !== undefined))
  if (orgKey) {
    const ids = fields[orgKey].map((v: any) => String(v.organizationId))
    attempts.push({ ...fields, [orgKey]: ids.map((id: string) => ({ id })) })
    attempts.push({ ...fields, [orgKey]: ids })
  }

  let last: any = null
  for (const payload of attempts) {
    const r = await jsmFetch(cfg, 'PUT', `/rest/api/2/issue/${encodeURIComponent(issueKey)}`, { fields: payload }, signal)
    if (r.status < 400) return { applied: keys, failed: [] }
    last = r
    if (!(r.status === 400 || r.status === 422)) break
  }
  return { applied: [], failed: keys, error: last ? jsmErrorText(last) : '未知错误' }
}

/** 生成「创建工单前要向客户确认哪些选项」的提示语（漏选 Request Type/组织/优先级是 422 主因） */
export function buildFieldHint(opts: {
  requiredFields?: RtField[]
  priorityField?: RtField | { required: boolean; validValues: ValidValue[] } | null
  orgField?: { name: string; required?: boolean; unsupported?: boolean } | null
}): string {
  const requiredFields = opts.requiredFields || []
  const priorityField = opts.priorityField || null
  const orgField = opts.orgField || null
  const asks: string[] = []

  if (priorityField && (priorityField.required || priorityField.validValues.length)) {
    const o = priorityField.validValues.map(v => v.label).slice(0, 10).join(' / ')
    asks.push(`优先级 Priority${priorityField.required ? '（必填）' : ''}${o ? `：可选 ${o}` : ''}`)
  }
  if (orgField) {
    asks.push(orgField.unsupported
      ? `组织 ${orgField.name}（该类型表单未包含此字段，API 无法写入——需提醒客户到工单界面选择，或请管理员把组织字段加入表单）`
      : `组织 ${orgField.name}${orgField.required ? '（必填）' : '（可选）'}`)
  }
  const others = requiredFields
    .filter(f => f.fieldId !== 'priority' && !ORG_FIELD_RE.test(f.name)
      && f.fieldId !== 'summary' && f.fieldId !== 'description')
    .map(f => f.name)
  if (others.length) asks.push(`其他必填字段：${others.slice(0, 10).join('、')}`)

  if (!asks.length) return '该 Request Type 没有额外的必填选择项，确认标题和描述即可创建。'
  return `创建工单前请先让客户确认：${asks.join('；')}。确认后再调用 jira_create_ticket 并带上 priority / organization 参数。`
}

// ── 字段值 → 外部系统链接 / RDMS 引用抽取 ────────────────
/**
 * 自定义字段 → 外部系统链接模板。
 * 字段里没有 bug/story 类型信息，这里按 Story 兜底；
 * 面板取数请走 jira_panel_rdms，它带 rdmsKind 能给出准确链接。
 */
const FIELD_URL_TEMPLATES = [
  { test: /rdms/i, build: (v: string) => rdmsUrlFor(v, 'story') }
]

export function fieldUrlFor(fieldName: string, value: any): string | null {
  let v = value
  if (v && typeof v === 'object') v = v.value !== undefined ? v.value : (v.name !== undefined ? v.name : v.id)
  if (v === null || v === undefined || String(v).trim() === '') return null
  const hit = FIELD_URL_TEMPLATES.find(t => t.test.test(String(fieldName)))
  return hit ? hit.build(String(v).trim()) : null
}

const RDMS_REF_PATTERNS: Array<{ re: RegExp; kind: 'bug' | 'story' | 'auto' | null }> = [
  { re: /bugID[=:\s]*(\d{2,8})/gi, kind: 'bug' },
  { re: /storyID[=:\s]*(\d{2,8})/gi, kind: 'story' },
  { re: /RDMS\s*(?:ID|编号|号)?\s*[:：#=]?\s*(\d{2,8})/gi, kind: null },
  { re: /\b(Bug|Story)\s*(?:ID)?\s*[:：#=]\s*(\d{2,8})/gi, kind: 'auto' }
]

/**
 * 从任意文本（工单描述、评论、面板字段）抽取 RDMS 引用。
 * 覆盖 wiki 链接、裸 URL、以及「RDMS 6705」「Bug 12840」这类口语写法。
 */
export function extractRdmsRefs(text: string): Array<{ id: string; kind: 'bug' | 'story' | null; url: string | null; raw: string }> {
  const src = String(text || '')
  if (!src || !/rdms|bugID|storyID|\bBug\b|\bStory\b/i.test(src)) return []
  const seen = new Map<string, { id: string; kind: 'bug' | 'story' | null; url: string | null; raw: string }>()
  for (const { re, kind } of RDMS_REF_PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      const k = kind === 'auto' ? String(m[1] || '').toLowerCase() : kind
      const id = kind === 'auto' ? m[2] : m[1]
      if (!id) continue
      const resolved: 'bug' | 'story' | null = k === 'bug' ? 'bug' : (k === 'story' ? 'story' : null)
      const key = `${resolved || 'unknown'}:${id}`
      if (seen.has(key)) continue
      const start = Math.max(0, m.index - 30)
      seen.set(key, {
        id,
        kind: resolved,
        url: rdmsUrlFor(id, resolved),
        raw: src.slice(start, m.index + m[0].length + 30).replace(/\s+/g, ' ').trim()
      })
    }
  }
  // 同一编号既有「带类型的链接」又有「裸编号」时，只保留能确定类型的那条
  const known = new Set([...seen.values()].filter(r => r.kind).map(r => r.id))
  return [...seen.values()].filter(r => r.kind || !known.has(r.id))
}
