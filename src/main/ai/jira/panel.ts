/**
 * Jira / JSM 工单助手 · 面板取数层（1.0.71）
 *
 * 背景：工单页里的「RDMS 关联」是 Forge 面板数据，不在 Jira REST 里。
 * 做法（沿用源项目）：让用户从 DevTools 复制一条面板取数 cURL，AI 校验后存成本机凭据，
 * 之后按工单号批量调用 Forge 中继接口拿 rmId，再拼成 RDMS 链接。
 *
 * 安全：cURL 含 Cookie 与 contextToken，等同登录态 —— 只落本机 userData，不进日志、不回显。
 */
import { httpJson } from './client'
import { jiraLog, loadPanelCache, loadPanelRequest, savePanelCache, savePanelRequest } from './config'

/** 面板数据（RDMS 关联关系）不常变，缓存 12 小时 */
const PANEL_CACHE_TTL_MS = 12 * 3600 * 1000
/** 缓存结构版本：升级字段后旧条目自动重拉 */
const PANEL_CACHE_VERSION = 2
/** app 的 remote 接口路径；原请求里的 path 会被改写成这个 */
const PANEL_QUERY_PATH = '/front/button/query'
/** 面板接口并发上限（同一 token 下别打太猛，避免被限流） */
const PANEL_CONCURRENCY = 4

const RDMS_BUG_URL = (id: string): string =>
  `https://rdms.streamax.com/index.php?m=bugmarket&f=view&bugID=${encodeURIComponent(id)}`
const RDMS_STORY_URL = (id: string): string =>
  `https://rdms.streamax.com/index.php?m=storymarket&f=view&storyID=${encodeURIComponent(id)}`

/** RDMS 链接：类型未知时按 story 兜底（同时把 kind 回传，让模型说明） */
export function rdmsUrlFor(rmId: string, kind: 'bug' | 'story' | null): string {
  return kind === 'bug' ? RDMS_BUG_URL(rmId) : RDMS_STORY_URL(rmId)
}

/** 从面板字段识别 RDMS 记录类型；识别不出返回 null（让模型问用户，不瞎猜） */
export function detectRdmsKind(fields: any): 'bug' | 'story' | null {
  const text = ['rdmsType', 'rdmsKind', 'type', 'kind', 'category', 'documentType', 'issueType', 'targetType']
    .map(k => fields && fields[k])
    .filter(v => v !== undefined && v !== null && String(v).trim() !== '')
    .join(' ')
    .toLowerCase()
  if (!text) return null
  if (/\bbug\b|缺陷|故障/.test(text)) return 'bug'
  if (/story|requirement|需求|user story/.test(text)) return 'story'
  return null
}

/** 面板字段太长会吃掉上下文：只留前 20 个键，每个值截到 120 字 */
export function compactFields(obj: any, limit = 20, maxLen = 120): Record<string, string> {
  const out: Record<string, string> = {}
  Object.keys(obj || {}).slice(0, limit).forEach((k) => {
    const v = obj[k]
    if (v === null || v === undefined || v === '') return
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    out[k] = s.length > maxLen ? s.slice(0, maxLen) + '…' : s
  })
  return out
}

function decodeJwtPayload(token: string): any {
  try {
    const p = String(token).split('.')[1]
    return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch { return null }
}

const REQUEST_HEADER_BLOCKLIST = ['content-length', 'host', 'cookie']

/** 把 DevTools 的「Copy as cURL (cmd/bash)」还原成结构化请求（兼容 cmd 的 ^ 续行与引号内转义） */
export function parseCurl(text: string): { url: string; headers: Record<string, string>; cookie: string; data: string } {
  let s = String(text || '').replace(/\r\n/g, '\n').trim()
  s = s.replace(/\^\s*\n/g, ' ').replace(/`\s*\n/g, ' ').replace(/\\\s*\n/g, ' ')
  s = s.replace(/\^([\s\S])/g, '$1')

  const args: string[] = []
  let cur = ''
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      // 引号内的 \" 是 JSON 自己的转义，必须原样保留，否则请求体解析失败
      if (ch === '\\' && i + 1 < s.length) { cur += ch + s[i + 1]; i++; continue }
      if (ch === quote) quote = ''
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (/\s/.test(ch)) { if (cur) { args.push(cur); cur = '' } continue }
    cur += ch
  }
  if (cur) args.push(cur)

  const out = { url: '', headers: {} as Record<string, string>, cookie: '', data: '' }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const next = (): string => args[++i] || ''
    if (a === '-H' || a === '--header') {
      const line = next()
      const idx = line.indexOf(':')
      if (idx > 0) {
        const k = line.slice(0, idx).trim()
        const v = line.slice(idx + 1).trim()
        if (k && !k.startsWith(':')) out.headers[k] = v
      }
    } else if (a === '-b' || a === '--cookie') {
      out.cookie = next()
    } else if (a === '--data-raw' || a === '--data' || a === '--data-binary' || a === '-d') {
      out.data = next()
    } else if (a === '--url' || a === '-X' || a === '--request' || a === '--compressed') {
      if (a === '--url') out.url = next()
    } else if (/^https?:\/\//i.test(a)) {
      out.url = a
    }
  }
  // Chrome 的 Copy as cURL 把 cookie 放在 `-H 'cookie: ...'` 里而不是 `-b`：
  // 直接按黑名单删掉会丢掉登录态 → 取出值存进 cookie 字段，再删头。
  for (const k of Object.keys(out.headers)) {
    const lk = k.toLowerCase()
    if (lk === 'cookie') {
      if (!out.cookie) out.cookie = out.headers[k]
      delete out.headers[k]
      continue
    }
    if (REQUEST_HEADER_BLOCKLIST.includes(lk)) delete out.headers[k]
  }
  return out
}

/** cURL 里的请求体：shell 的 \" 转义会带进字符串，先直解再退一步去转义 */
function tryParseJsonArg(s: string): any {
  const text = String(s || '')
  try { return JSON.parse(text) } catch { /* 继续尝试去转义 */ }
  try { return JSON.parse(text.replace(/\\(["\\/])/g, '$1')) } catch { return null }
}

export interface PanelStatus {
  configured: boolean
  siteUrl?: string
  issuedForIssue?: string | null
  expiresAt?: number | null
  expiresInSec?: number | null
  expired?: boolean
  savedAt?: string
  hint?: string
}

/** 凭据状态：token 还剩多久、当初是从哪个工单抓的（绝不回显 token 本身） */
export function panelStatus(): PanelStatus {
  const req = loadPanelRequest()
  if (!req) {
    return {
      configured: false,
      hint: '还没有面板取数凭据。请用户打开任意工单页 → F12 Network → 筛 useInvokeExtensionRelayMutation → '
        + '右键 Copy as cURL，然后把整段发给 AI（jira_save_panel_curl）。'
    }
  }
  const input = (req.body && req.body.variables && req.body.variables.input) || {}
  const ctx = (input.payload && input.payload.context) || {}
  const jwt = decodeJwtPayload(ctx.contextToken)
  const exp = jwt && jwt.exp ? jwt.exp * 1000 : 0
  const issue = jwt && jwt.context && jwt.context.extension && jwt.context.extension.issue
  return {
    configured: true,
    siteUrl: ctx.siteUrl || '',
    issuedForIssue: (issue && issue.key) || null,
    expiresAt: exp || null,
    expiresInSec: exp ? Math.round((exp - Date.now()) / 1000) : null,
    expired: !!exp && exp < Date.now(),
    savedAt: req.savedAt,
    ...(!exp ? { hint: '凭据里没有可解析的 contextToken，建议重新复制一条 cURL。' } : {})
  }
}

/**
 * 保存用户粘贴的 cURL：结构校验 + 过期检查。
 * 校验点（缺一个就会在真正查询时莫名其妙失败）：
 *   1. 能解析出 URL 与请求体；
 *   2. 请求体是 Forge 中继调用（useInvokeExtensionRelayMutation）；
 *   3. 带 payload.context（siteUrl/contextToken 都从这里取）；
 *   4. contextToken 未过期（15 分钟）。
 */
export function savePanelCurl(curlText: string): PanelStatus {
  const c = parseCurl(curlText)
  if (!c.url || !c.data) {
    throw new Error('没解析出 URL 或请求体：请复制完整的一条 cURL（含 --data-raw 与 cookie）')
  }
  if (!/useInvokeExtensionRelayMutation/.test(c.data)) {
    throw new Error('这不是面板取数请求：请在 Network 里筛 useInvokeExtensionRelayMutation 的那条再复制')
  }
  const body = tryParseJsonArg(c.data)
  if (!body) throw new Error('请求体不是合法 JSON，请确认复制的是完整的一条 cURL')
  const input = body.variables && body.variables.input
  if (!input || !input.payload || !input.payload.context) {
    throw new Error('请求体缺少 Forge 上下文（payload.context），请确认复制的是工单页的面板请求')
  }

  // 统一成服务端调用所需结构：contextToken 放 payload 顶层，entryPoint 放 input 顶层
  const ctx = input.payload.context
  input.payload.contextToken = input.payload.contextToken || ctx.contextToken
  ctx.contextToken = input.payload.contextToken
  input.entryPoint = input.entryPoint || input.payload.entryPoint || 'resolver'

  const jwt = decodeJwtPayload(input.payload.contextToken)
  if (!jwt || !jwt.exp) throw new Error('contextToken 无法解析，请重新复制一条 cURL')
  if (jwt.exp * 1000 < Date.now()) {
    throw new Error('这条 cURL 里的 contextToken 已过期（有效期 15 分钟），请在工单页重新复制一条')
  }

  savePanelRequest({ url: c.url, headers: c.headers, cookie: c.cookie, body })
  return panelStatus()
}

/** 查单个工单的面板数据；返回 rmId（= RDMS ID），未关联时 null */
export async function panelFetchIssue(issueKey: string): Promise<Record<string, any>> {
  const req = loadPanelRequest()
  if (!req) throw new Error('还没有配置面板数据凭据：请让用户粘贴一次工单页的面板 cURL')

  const status = panelStatus()
  if (status.expired) throw new Error('contextToken 已过期（15 分钟有效）：请在任意工单页重新复制一条 cURL 并保存')

  const body = JSON.parse(JSON.stringify(req.body))
  const input = body.variables.input
  input.entryPoint = input.entryPoint || 'resolver'
  input.payload.contextToken = input.payload.contextToken || input.payload.context.contextToken
  // 原请求固定查「当前工单」，这里改成按 issueKey 查，才能批量
  input.payload.call.payload.path = `${PANEL_QUERY_PATH}?issueKey=${encodeURIComponent(issueKey)}`

  const siteUrl = String(input.payload.context.siteUrl || '').replace(/\/+$/, '')
  const headers: Record<string, string> = {
    ...req.headers,
    ...(req.cookie ? { cookie: req.cookie } : {}),
    'accept-encoding': 'identity',
    ...(siteUrl ? { referer: `${siteUrl}/browse/${issueKey}` } : {})
  }

  const r = await httpJson(req.url, { method: 'POST', headers, body, timeoutMs: 20_000 })
  if (r.status >= 400) throw new Error(`面板接口 HTTP ${r.status}：${String(r.text || '').slice(0, 200)}`)

  const inv = r.json && r.json.data && r.json.data.invokeExtension
  if (!inv) throw new Error('面板接口返回异常：' + String(r.text || '').slice(0, 200))
  if (!inv.success) {
    const e = (inv.errors && inv.errors[0]) || {}
    if (/context token/i.test(String(e.message || ''))) {
      throw new Error('contextToken 已过期：请在任意工单页重新复制一条 cURL 并保存')
    }
    throw new Error(`面板调用失败：${e.errorType || ''} ${e.message || ''}`.trim())
  }

  const raw = inv.response && inv.response.body && inv.response.body.body
  let inner: any = null
  try { inner = JSON.parse(raw) } catch { /* 非 JSON 说明该工单面板为空 */ }
  const data = (inner && inner.data) || {}
  const fields = data.fields || {}
  const rmId = String(fields.rmId || '').trim()
  const kind = detectRdmsKind(fields)
  return {
    issueKey,
    rmId: rmId || null,
    rdmsKind: kind,
    rdmsUrl: rmId ? rdmsUrlFor(rmId, kind) : null,
    summary: fields.summary || data.summary || null,
    organization: fields.organization || data.organization || null,
    fields: compactFields(fields)
  }
}

/** 批量查 RDMS ID：先命中缓存，其余按并发上限拉取；单个失败不影响其它 */
export async function getPanelRdms(issueKeys: any): Promise<Record<string, any>> {
  const keys = [...new Set((Array.isArray(issueKeys) ? issueKeys : [issueKeys])
    .map(k => String(k || '').trim().toUpperCase()).filter(Boolean))]
  if (!keys.length) throw new Error('issueKeys 不能为空')

  const status = panelStatus()
  if (!status.configured) {
    throw new Error('还没有配置面板数据凭据：请让用户把工单页 Network 里 useInvokeExtensionRelayMutation 的那条 cURL 发过来')
  }
  if (status.expired) {
    throw new Error('contextToken 已过期（15 分钟有效）：请让用户在任意工单页重新复制一条 cURL 并保存')
  }

  const cache = loadPanelCache()
  const now = Date.now()
  const results: any[] = []
  const todo: string[] = []
  for (const key of keys) {
    const hit = cache[key]
    // v 不一致说明是旧版缓存（没有 rdmsKind / rdmsUrl），重拉一次
    if (hit && hit.v === PANEL_CACHE_VERSION && now - hit.at < PANEL_CACHE_TTL_MS) results.push({ ...hit, cached: true })
    else todo.push(key)
  }

  for (let i = 0; i < todo.length; i += PANEL_CONCURRENCY) {
    const slice = todo.slice(i, i + PANEL_CONCURRENCY)
    const done = await Promise.all(slice.map(async (key) => {
      try {
        return await panelFetchIssue(key)
      } catch (e: any) {
        return { issueKey: key, rmId: null, error: String(e?.message || e) }
      }
    }))
    for (const item of done) {
      if (!(item as any).error) cache[item.issueKey] = { ...item, at: now, v: PANEL_CACHE_VERSION }
      results.push(item)
    }
  }

  savePanelCache(cache)
  const failed = results.filter(r => r.error)
  if (failed.length && failed.every(r => /contextToken 已过期|context token/i.test(String(r.error)))) {
    throw new Error('contextToken 已过期（15 分钟有效）：请让用户在任意工单页重新复制一条 cURL 并保存')
  }

  jiraLog(`[panel] 批量查询 ${keys.length} 个工单，失败 ${failed.length} 个`)
  return {
    results: results.sort((a, b) => keys.indexOf(a.issueKey) - keys.indexOf(b.issueKey)),
    note: 'rmId 即 RDMS ID；rdmsUrl 是按 rdmsKind 生成的可点击链接（bug→bugmarket/bugID，story→storymarket/storyID）。'
      + 'rdmsKind 为 null 表示面板没给出记录类型，不要自己猜，直接问用户是 Bug 还是 Story；'
      + 'rmId 为空表示该工单未关联 RDMS 记录。',
    tokenExpiresInSec: panelStatus().expiresInSec
  }
}
