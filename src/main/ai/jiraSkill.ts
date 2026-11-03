/**
 * Jira / JSM 工单助手 · 工具执行层（1.0.71）
 *
 * 来源：外部工具 `E:\工具\Jira_Jsm`（Node + 浏览器前端）。这里内置成 mc-tool 的原生技能：
 * 与 email-auto 同一模式 —— 主进程直接实现工具，**不随包分发脚本/运行时/前端页面**，不新增 npm 依赖。
 *
 * 工具面（14 个，统一 jira_ 前缀；仅在 build 模式 + 勾选「Jira/JSM 工单助手」时下发）：
 *   配置类 jira_config / jira_panel_status / jira_save_panel_curl
 *   只读类 jira_current_user / jira_service_desks / jira_request_types /
 *          jira_request_type_fields / jira_search_issues / jira_get_issue /
 *          jira_request_status / jira_panel_rdms
 *   写入类 jira_create_ticket / jira_add_comment / jira_transition_issue
 *          —— 三个写操作都要求「先复述要点、等用户确认后再调用」（工具描述 + SKILL.md 双写）。
 *
 * 凭据：一律落 `userData/jira-jsm/config.json`，不通过对话索取；返回与日志只给掩码。
 */
import { readFileSync, statSync } from 'fs'
import { extname, resolve as resolvePath } from 'path'
import { assertConfigured, attachLocalFiles, jsmErrorText, jsmFetch } from './jira/client'
import {
  configExists, configView, jiraLog, loadConfig, maskEmail, openConfigDir, writeConfigTemplate
} from './jira/config'
import { getPanelRdms, panelStatus, savePanelCurl } from './jira/panel'
import { ATTACH_IMAGE_RE, applyMentions, mdToJiraWiki } from './jira/wiki'
import {
  ORG_FIELD_RE, applyPostCreateFields, buildFieldHint, extractRdmsRefs, fetchOrganizations,
  fetchSitePriorities, fieldUrlFor, findOrganizationField, getFieldDefs, getRequestTypeFieldDefs,
  resolveFieldDefs, resolveOrganizationIds, resolvePriorityValue, resolveWritableFields, type RtField
} from './jira/fields'

// ── 小工具 ───────────────────────────────────────────────
function clampInt(v: any, def: number, min: number, max: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

function needStr(input: any, key: string, hint: string): string {
  const v = String(input?.[key] ?? '').trim()
  if (!v) throw new Error(`缺少 ${key}：${hint}`)
  return v
}

function issueUrl(base: string, key: string): string {
  return `${base}/browse/${key}`
}

/** 允许作为描述正文的文本类扩展名（与源实现保持一致） */
const TEXT_FILE_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.log', '.xml', '.yml', '.yaml',
  '.html', '.htm', '.js', '.ts', '.java', '.c', '.h', '.cpp', '.py', '.sql',
  '.properties', '.ini', '.conf', '.bat', '.cmd', '.ps1', '.sh', ''
])
const DOC_MAX_BYTES = 5 * 1024 * 1024
/** Jira 描述上限 32767 字符，超了会整条 400 拒绝 */
const DESC_MAX_CHARS = 32000

/** 读本机文本文件作为描述正文：拒绝二进制与超大文件（长文档不必经过模型上下文） */
function readLocalTextFile(filePath: string): { text: string; path: string; size: number } {
  const raw = String(filePath || '').trim()
  if (!raw) throw new Error('文件路径不能为空')
  const abs = resolvePath(raw)
  let st
  try { st = statSync(abs) } catch { throw new Error('文件不存在或无法访问：' + abs) }
  if (!st.isFile()) throw new Error('目标不是文件：' + abs)
  if (st.size > DOC_MAX_BYTES) {
    throw new Error(`文件过大（${(st.size / 1048576).toFixed(2)}MB），超过读取上限 ${DOC_MAX_BYTES / 1048576}MB`)
  }
  const buf = readFileSync(abs)
  if (buf.includes(0)) throw new Error('看起来是二进制文件，无法按文本读取：' + abs)
  const ext = extname(abs).toLowerCase()
  if (!TEXT_FILE_EXTS.has(ext)) {
    throw new Error(`不支持的文件类型 ${ext || '(无扩展名)'}，仅支持文本类文件（.md/.txt/.json/.csv/.xml 等）`)
  }
  return { text: buf.toString('utf8'), path: abs, size: st.size }
}

// ── 工具：jira_config ───────────────────────────────────
/**
 * 查看配置 / 生成模板 / 打开目录。
 * 凭据**不通过对话索取**：模板里的 email 与 apiToken 留空，由用户自己打开文件填写，
 * 这样 token 不会进入聊天历史，也不会被模型回显。
 */
async function runJiraConfig(input: any): Promise<any> {
  const action = String(input?.action || 'view').trim()
  const cfg = loadConfig()

  if (action === 'init' || (action === 'view' && !configExists())) {
    const t = writeConfigTemplate()
    const opened = await openConfigDir()
    return {
      ok: true,
      action,
      ...configView(loadConfig()),
      templateCreated: t.created,
      opened: opened.ok,
      ...(opened.ok ? {} : { openError: opened.error }),
      // 给用户看的话术：模型直接照抄；token 只显示掩码，不要让用户把 token 发到聊天里
      instruction: t.created
        ? `已生成配置模板并打开目录：${t.path}。请你在文件夹里打开 config.json，把 email 改成你的 Streamax 工作邮箱，`
          + 'apiToken 填成 Atlassian 生成的 API Token（https://id.atlassian.com/manage-profile/security/api-tokens ），'
          + '保存后告诉我一声，我立即验证。'
        : `配置文件已存在：${t.path}（目录已打开）。请检查 email 与 apiToken 两项是否都已填写，保存后告诉我。`
    }
  }

  if (action === 'open') {
    const opened = await openConfigDir()
    return {
      ok: opened.ok,
      path: opened.path,
      ...(opened.error ? { error: opened.error } : {}),
      message: opened.ok ? '已打开配置目录' : '打开目录失败：' + opened.error
    }
  }

  const view = configView(cfg)
  return {
    ok: true,
    action: 'view',
    ...view,
    instruction: view.ready
      ? 'JSM 凭据已配置，可以直接查询/创建工单。'
      : '还没配置好凭据。请调用 jira_config action=init 生成模板并打开目录，让用户自己填写 email 与 apiToken。'
  }
}

// ── 工具：面板凭据 ───────────────────────────────────────
function runJiraPanelStatus(): any {
  const s = panelStatus()
  return {
    ok: true,
    ...s,
    message: s.configured
      ? (s.expired
        ? '面板取数凭据已过期（contextToken 只有 15 分钟有效），请让用户重新复制一条 cURL。'
        : `面板取数凭据可用，剩余约 ${Math.round((s.expiresInSec || 0) / 60)} 分钟。`)
      : (s.hint || '还没有面板取数凭据')
  }
}

function runJiraSavePanelCurl(input: any): any {
  const curl = String(input?.curl || '').trim()
  if (!curl) return { ok: false, error: 'MISSING_CURL', message: '需要把浏览器里复制的整段 cURL 传进来' }
  const s = savePanelCurl(curl)
  return {
    ok: true,
    ...s,
    message: `面板取数凭据已保存（有效期约 ${Math.round((s.expiresInSec || 0) / 60)} 分钟）。`
      + '现在可以按工单号批量查 RDMS ID 了；token 过期后再复制一条新的即可。'
  }
}

// ── 工具：只读 ──────────────────────────────────────────
async function runJiraCurrentUser(signal?: AbortSignal): Promise<any> {
  const cfg = loadConfig()
  assertConfigured(cfg)
  const r = await jsmFetch(cfg, 'GET', '/rest/api/2/myself', null, signal)
  if (r.status !== 200) return { ok: false, error: jsmErrorText(r), status: r.status }
  const me = r.json || {}
  return {
    ok: true,
    accountId: me.accountId,
    displayName: me.displayName,
    email: me.emailAddress ? maskEmail(me.emailAddress) : undefined,
    active: me.active,
    timeZone: me.timeZone,
    siteUrl: r.base,
    message: `已用 ${maskEmail(String(me.emailAddress || ''))} 登录 ${r.base}`
  }
}

async function runJiraServiceDesks(input: any, signal?: AbortSignal): Promise<any> {
  const cfg = loadConfig()
  assertConfigured(cfg)
  const limit = clampInt(input?.limit, 50, 1, 100)
  const r = await jsmFetch(cfg, 'GET', `/rest/servicedeskapi/servicedesk?limit=${limit}`, null, signal)
  if (r.status !== 200) return { ok: false, error: jsmErrorText(r), status: r.status }
  const kw = String(input?.keyword || '').trim().toLowerCase()
  const all = (Array.isArray(r.json?.values) ? r.json.values : []).map((d: any) => ({
    id: String(d.id),
    projectKey: d.projectKey,
    name: d.name,
    url: d._links?.self?.href || ''
  }))
  const list = kw
    ? all.filter((d: any) => `${d.name} ${d.projectKey || ''}`.toLowerCase().includes(kw))
    : all
  return {
    ok: true,
    total: all.length,
    serviceDesks: list,
    ...(list.length ? {} : { hint: '没有匹配的服务台。去掉 keyword 再查一次全部；仍为空说明该账号没有服务台权限。' })
  }
}

async function runJiraRequestTypes(input: any, signal?: AbortSignal): Promise<any> {
  const cfg = loadConfig()
  assertConfigured(cfg)
  const serviceDeskId = needStr(input, 'serviceDeskId', '先调用 jira_service_desks 拿 id')
  const r = await jsmFetch(
    cfg, 'GET',
    `/rest/servicedeskapi/servicedesk/${encodeURIComponent(serviceDeskId)}/requesttype?limit=100`,
    null, signal
  )
  if (r.status !== 200) return { ok: false, error: jsmErrorText(r), status: r.status }
  const kw = String(input?.keyword || '').trim().toLowerCase()
  const all = (Array.isArray(r.json?.values) ? r.json.values : []).map((t: any) => ({
    id: String(t.id),
    name: t.name,
    description: String(t.description || '').slice(0, 200)
  }))
  const list = kw ? all.filter((t: any) => t.name.toLowerCase().includes(kw)) : all
  return {
    ok: true,
    serviceDeskId,
    total: all.length,
    requestTypes: list,
    hint: '创建工单必须用 requestTypeId（不是名称）。把名称和 id 一起列给用户选，选定后再调用 jira_request_type_fields 查必填项。'
  }
}

async function runJiraRequestTypeFields(input: any, signal?: AbortSignal): Promise<any> {
  const cfg = loadConfig()
  assertConfigured(cfg)
  const serviceDeskId = needStr(input, 'serviceDeskId', '服务台 id')
  const requestTypeId = needStr(input, 'requestTypeId', 'Request Type id')

  const defs = await getRequestTypeFieldDefs(cfg, serviceDeskId, requestTypeId, signal)
  if (!defs) {
    return {
      ok: false,
      error: `读取不到请求类型 ${requestTypeId} 的字段定义（可能是权限不足或该类型不存在）`,
      hint: '先用 jira_request_types 确认 id；仍失败说明该账号不是该服务台的 Agent。'
    }
  }

  const pickField = (f: RtField): any => ({
    fieldId: f.fieldId,
    name: f.name,
    required: f.required,
    hasDefault: f.hasDefault,
    ...(f.validValues.length ? { validValues: f.validValues.slice(0, 30) } : {}),
    ...(f.description ? { description: f.description } : {})
  })

  const priorityField = defs.find(f => f.fieldId === 'priority') || null
  const rtOrg = defs.find(f => ORG_FIELD_RE.test(f.name)) || null
  const siteOrgField = rtOrg ? null : await findOrganizationField(cfg, signal).catch(() => null)

  let organizations: any = null
  if (rtOrg) {
    const orgs = await fetchOrganizations(cfg, serviceDeskId, 200, signal).catch(() => [])
    organizations = {
      field: { fieldId: rtOrg.fieldId, name: rtOrg.name, required: rtOrg.required },
      options: orgs.slice(0, 100),
      hint: orgs.length
        ? undefined
        : '没有读到该服务台的组织列表（可能未关联组织或需要 Agent 权限）。可以直接传 organizationId，或让用户在门户上确认组织。'
    }
  } else if (siteOrgField) {
    organizations = {
      field: { fieldId: siteOrgField.fieldId, name: siteOrgField.name, unsupported: true },
      hint: `站点有「${siteOrgField.name}」字段，但该 Request Type 的表单未包含它，API 无法写入；`
        + '需要管理员把组织字段加入表单，或创建后在工单界面手动选择。'
    }
  }

  return {
    ok: true,
    serviceDeskId,
    requestTypeId,
    requiredFields: defs.filter(f => f.required && !f.hasDefault).map(pickField),
    priority: priorityField ? pickField(priorityField) : null,
    organizations,
    selectFields: defs
      .filter(f => f.visibility !== 'HIDDEN' && f.validValues.length
        && f.fieldId !== 'priority' && !ORG_FIELD_RE.test(f.name))
      .map(pickField)
      .slice(0, 20),
    hint: buildFieldHint({
      requiredFields: defs,
      priorityField,
      orgField: organizations
        ? {
          name: organizations.field.name,
          required: !!organizations.field.required,
          unsupported: !!organizations.field.unsupported
        }
        : null
    })
  }
}

/**
 * JQL 检索。该站点禁止无条件 JQL（会 400/超时），所以强制要求带过滤条件；
 * extraFields 一次把自定义字段（如 RDMS ID）带出来，避免对每条结果再 get_issue。
 */
function assertJqlUsable(jql: string): void {
  const s = jql.trim()
  if (!s) throw new Error('jql 不能为空，也不允许无条件查询。请带上 project / statusCategory / updated 等过滤条件。')
  if (/^order\s+by\b/i.test(s)) {
    throw new Error('该站点不允许无条件 JQL。请加入过滤条件，例如 project = ETESC AND statusCategory != Done ORDER BY updated DESC')
  }
  if (!/(\bproject\b|\bkey\b|\bstatus\b|\bassignee\b|\breporter\b|\bupdated\b|\bcreated\b|\btext\b|~|>=|<=|=)/i.test(s)) {
    throw new Error('jql 看起来没有实际过滤条件：' + s + '。请补上 project/status/时间等条件。')
  }
}

async function runJiraSearchIssues(input: any, signal?: AbortSignal): Promise<any> {
  const cfg = loadConfig()
  assertConfigured(cfg)
  const jql = String(input?.jql || '').trim()
  assertJqlUsable(jql)
  const maxResults = clampInt(input?.maxResults, 10, 1, 50)

  const wanted = Array.isArray(input?.extraFields) ? input.extraFields : (input?.extraFields ? [input.extraFields] : [])
  const extraDefs = wanted.length ? resolveFieldDefs(await getFieldDefs(cfg, signal), wanted) : []
  const fieldsParam = ['summary', 'status', 'issuetype', 'assignee', 'priority', 'created', 'updated',
    ...extraDefs.map(d => d.id)].join(',')

  // 新版站点用 /rest/api/3/search/jql（旧接口已废弃），旧站点仍走 /rest/api/2/search
  const qs = new URLSearchParams({ jql, maxResults: String(maxResults), fields: fieldsParam })
  let r = await jsmFetch(cfg, 'GET', `/rest/api/2/search?${qs}`, null, signal)
  if (r.status === 400 || r.status === 404 || r.status === 410) {
    const alt = await jsmFetch(cfg, 'GET', `/rest/api/3/search/jql?${qs}`, null, signal)
    if (alt.status === 200) r = alt
  }
  if (r.status !== 200) return { ok: false, error: jsmErrorText(r), status: r.status, jql }

  const issues = (Array.isArray(r.json?.issues) ? r.json.issues : []).map((i: any) => {
    const f = i.fields || {}
    const customFields: Record<string, any> = {}
    const fieldUrls: Record<string, string> = {}
    for (const d of extraDefs) {
      const v = f[d.id] === undefined ? null : f[d.id]
      customFields[d.name] = v
      const u = fieldUrlFor(d.name, v)
      if (u) fieldUrls[d.name] = u
    }
    return {
      key: i.key,
      summary: f.summary,
      status: f.status?.name,
      type: f.issuetype?.name,
      assignee: f.assignee?.displayName,
      priority: f.priority?.name,
      created: f.created,
      updated: f.updated,
      url: issueUrl(r.base || '', i.key),
      ...(extraDefs.length ? { customFields, ...(Object.keys(fieldUrls).length ? { fieldUrls } : {}) } : {})
    }
  })

  jiraLog(`[search] jql=${jql.slice(0, 120)} -> ${issues.length}`)
  return {
    ok: true,
    jql,
    total: issues.length,
    issues,
    isLast: r.json?.isLast !== false,
    ...(issues.length ? {} : {
      hint: '结果为空：先说明所用 JQL。中文状态名容易与实际不符，可改用 statusCategory != Done 或 updated <= -7d 再试。'
    })
  }
}

async function runJiraGetIssue(input: any, signal?: AbortSignal): Promise<any> {
  const cfg = loadConfig()
  assertConfigured(cfg)
  const issueKey = needStr(input, 'issueKey', '工单号，如 ETESC-119').toUpperCase()

  const wanted = Array.isArray(input?.extraFields) ? input.extraFields : (input?.extraFields ? [input.extraFields] : [])
  const extraDefs = wanted.length ? resolveFieldDefs(await getFieldDefs(cfg, signal), wanted) : []
  const fieldsParam = ['summary', 'status', 'description', 'issuetype', 'assignee', 'reporter', 'priority',
    'created', 'updated', 'attachment', 'comment', ...extraDefs.map(d => d.id)].join(',')

  const r = await jsmFetch(cfg, 'GET',
    `/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=${fieldsParam}&expand=transitions`, null, signal)
  if (r.status !== 200) return { ok: false, error: jsmErrorText(r), status: r.status }

  const f = r.json?.fields || {}
  const description = String(f.description || '')
  const customFields: Record<string, any> = {}
  const fieldUrls: Record<string, string> = {}
  for (const d of extraDefs) {
    const v = f[d.id] === undefined ? null : f[d.id]
    customFields[d.name] = v
    const u = fieldUrlFor(d.name, v)
    if (u) fieldUrls[d.name] = u
  }
  const comments = Array.isArray(f.comment?.comments) ? f.comment.comments : []
  // 先扫描述再扫评论：RDMS 编号常被客户写在评论里，只扫描述会漏
  const rdmsRefs = [
    ...extractRdmsRefs(description),
    ...extractRdmsRefs(comments.map((c: any) => String(c.body || '')).join('\n'))
  ]
  const dedup = [...new Map(rdmsRefs.map(x => [`${x.kind || 'unknown'}:${x.id}`, x])).values()]

  return {
    ok: true,
    issueKey,
    url: issueUrl(r.base || '', issueKey),
    summary: f.summary,
    status: f.status?.name,
    statusCategory: f.status?.statusCategory?.name,
    type: f.issuetype?.name,
    assignee: f.assignee?.displayName,
    reporter: f.reporter?.displayName,
    priority: f.priority?.name,
    created: f.created,
    updated: f.updated,
    description: description.length > 4000 ? description.slice(0, 4000) + '…（已截断）' : description,
    attachments: (Array.isArray(f.attachment) ? f.attachment : []).slice(0, 20).map((a: any) => ({
      id: a.id, filename: a.filename, size: a.size
    })),
    commentCount: comments.length,
    ...(dedup.length ? { rdmsRefs: dedup } : {}),
    transitions: (Array.isArray(r.json?.transitions) ? r.json.transitions : [])
      .map((t: any) => ({ id: t.id, name: t.name, to: t.to?.name })),
    ...(extraDefs.length ? { customFields, ...(Object.keys(fieldUrls).length ? { fieldUrls } : {}) } : {})
  }
}

async function runJiraRequestStatus(input: any, signal?: AbortSignal): Promise<any> {
  const cfg = loadConfig()
  assertConfigured(cfg)
  const issueKey = needStr(input, 'issueKey', '工单号').toUpperCase()
  const r = await jsmFetch(cfg, 'GET', `/rest/servicedeskapi/request/${encodeURIComponent(issueKey)}`, null, signal)
  if (r.status !== 200) return { ok: false, error: jsmErrorText(r), status: r.status }

  const j = r.json || {}
  // 请求状态接口不带 statusCategory（判断是否 Done 靠它），补查一次平台字段
  const cat = await jsmFetch(cfg, 'GET',
    `/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=status,resolution,updated`, null, signal)
    .catch(() => null)

  return {
    ok: true,
    issueKey,
    url: issueUrl(r.base || '', issueKey),
    portalUrl: j._links?.web,
    status: j.currentStatus?.status,
    statusCategory: cat?.json?.fields?.status?.statusCategory?.name,
    resolution: cat?.json?.fields?.resolution?.name,
    requestType: j.requestType?.name,
    serviceDesk: j.serviceDesk?.name,
    created: j.createdDate,
    reporter: j.reporter?.displayName,
    ...(j.currentStatus?.statusDate?.iso8601 ? { statusSince: j.currentStatus.statusDate.iso8601 } : {})
  }
}

async function runJiraPanelRdms(input: any): Promise<any> {
  const raw = input?.issueKeys
  const keys = Array.isArray(raw) ? raw : (raw ? String(raw).split(/[,\s]+/) : [])
  if (!keys.length) return { ok: false, error: 'MISSING_ARG', message: '需要 issueKeys（工单号数组）' }
  try {
    const res = await getPanelRdms(keys)
    return { ok: true, ...res }
  } catch (e: any) {
    return {
      ok: false,
      error: e?.message || String(e),
      hint: '凭据缺失或过期时，请让用户在任意工单页 F12 → Network → useInvokeExtensionRelayMutation → Copy as cURL，'
        + '把整段发给 AI 即可（jira_save_panel_curl）。不要编造 RDMS 值。'
    }
  }
}

// ── 工具：jira_create_ticket ────────────────────────────
/**
 * 创建服务台工单。
 * 顺序与源实现一致：字段定义 → 必填校验（本地先拦）→ 组织值形态回退 → 端点下线回退平台 API → 补写/附件。
 * 写操作，工具描述里要求模型先复述服务台/类型/标题/描述要点并等用户确认。
 */
async function runJiraCreateTicket(input: any, signal?: AbortSignal): Promise<any> {
  const cfg = loadConfig()
  assertConfigured(cfg)

  const serviceDeskId = String(input?.serviceDeskId ?? '').trim()
  if (!serviceDeskId) {
    return {
      ok: false,
      error: 'MISSING_SERVICE_DESK',
      message: '缺少 serviceDeskId：先调用 jira_service_desks 让用户确认要提单的服务台'
    }
  }
  const requestTypeId = String(input?.requestTypeId ?? '').trim()
  if (!requestTypeId) {
    return {
      ok: false,
      error: 'MISSING_REQUEST_TYPE',
      message: '缺少 requestTypeId：先用 jira_request_types 让用户选择工单类型'
    }
  }
  const summary = String(input?.summary ?? '').trim()
  if (!summary) return { ok: false, error: 'MISSING_SUMMARY', message: '缺少 summary：先与用户确认标题' }

  // 长文档由主进程直接读文件（不必经过模型上下文，更准也更省 token）
  let descMd = String(input?.description ?? '')
  if (!descMd.trim() && input?.descriptionFile) {
    descMd = readLocalTextFile(String(input.descriptionFile)).text
  }
  let descWiki = mdToJiraWiki(descMd)
  const warnings: string[] = []
  if (descWiki.length > DESC_MAX_CHARS) {
    descWiki = descWiki.slice(0, DESC_MAX_CHARS) + '\n\n（描述超过 Jira 上限已截断，完整内容见附件）'
    warnings.push(`描述超过 ${DESC_MAX_CHARS} 字符，已截断；完整内容请作为附件上传。`)
  }

  const rtFields = await getRequestTypeFieldDefs(cfg, serviceDeskId, requestTypeId, signal).catch(() => null)
  const rtPriority = rtFields ? rtFields.find(f => f.fieldId === 'priority') || null : null
  const rtOrg = rtFields ? rtFields.find(f => ORG_FIELD_RE.test(f.name)) || null : null

  // 客户门户表单常不暴露 Priority / Organizations，但工单上确有这两个字段 → 创建后补写
  const sitePriorities = rtPriority ? [] : await fetchSitePriorities(cfg, signal).catch(() => [])
  const siteOrgField = rtOrg ? null : await findOrganizationField(cfg, signal).catch(() => null)

  const requestFieldValues: Record<string, any> = { summary, description: descWiki }
  const postCreateFields: Record<string, any> = {}
  const unresolvedFields: string[] = []
  const missing: Array<{ field: string; label: string; options?: string[] }> = []

  // 优先级
  if (input?.priority != null && String(input.priority).trim() !== '') {
    const valid = rtPriority ? rtPriority.validValues : sitePriorities
    const v = resolvePriorityValue(input.priority, valid)
    if (v) {
      if (rtPriority) requestFieldValues.priority = v
      else postCreateFields.priority = v
    }
  } else if (rtPriority && rtPriority.required && !rtPriority.hasDefault) {
    missing.push({
      field: 'priority',
      label: rtPriority.name || 'Priority（优先级）',
      options: rtPriority.validValues.map(v => v.label)
    })
  }

  // 组织
  const orgInput = input?.organizations !== undefined && input?.organizations !== null
    ? input.organizations
    : input?.organization
  const hasOrgInput = Array.isArray(orgInput)
    ? orgInput.some(x => String(x == null ? '' : x).trim() !== '')
    : orgInput != null && String(orgInput).trim() !== ''

  if (hasOrgInput) {
    if (rtOrg) {
      const orgList = await fetchOrganizations(cfg, serviceDeskId, 200, signal).catch(() => null)
      let orgIds: string[] = []
      if (orgList && orgList.length) {
        const resolved = resolveOrganizationIds(orgInput, orgList)
        orgIds = resolved.ids
        if (resolved.unknown.length) {
          warnings.push(`组织「${resolved.unknown.join('、')}」不在该服务台的组织列表中`
            + `（可选：${orgList.slice(0, 20).map(o => o.name).join('、')}）`)
        }
      } else {
        orgIds = (Array.isArray(orgInput) ? orgInput : [orgInput])
          .map(x => String(x == null ? '' : x).trim()).filter(Boolean)
      }
      if (orgIds.length) requestFieldValues[rtOrg.fieldId] = orgIds
    } else if (siteOrgField) {
      warnings.push(`「组织」字段（${siteOrgField.fieldId}）未包含在该 Request Type 的表单中，API 无法写入，本次未设置组织。`
        + '需要管理员把组织字段加入表单，或创建后在工单界面手动选择。')
    } else {
      warnings.push('该站点没有启用「组织（Organizations）」字段，已忽略 organization 参数')
    }
  } else if (rtOrg && rtOrg.required && !rtOrg.hasDefault) {
    const orgList = await fetchOrganizations(cfg, serviceDeskId, 200, signal).catch(() => [])
    missing.push({
      field: 'organization',
      label: rtOrg.name || 'Organizations（组织）',
      options: orgList.map(o => o.name)
    })
  }

  // 其它自定义字段：键可以是字段名、customfield_xxx 或纯数字（JSM 请求字段 id）
  const extraFields = input?.fields && typeof input.fields === 'object' && !Array.isArray(input.fields)
    ? input.fields
    : null
  if (extraFields) {
    const allDefs = rtFields ? [] : await getFieldDefs(cfg, signal).catch(() => [])
    for (const [rawKey, rawVal] of Object.entries(extraFields)) {
      const w = String(rawKey || '').trim()
      if (!w) continue
      if (/^(customfield_\d+|priority|duedate|labels)$/i.test(w)) {
        requestFieldValues[w.toLowerCase()] = rawVal
        continue
      }
      if (/^\d+$/.test(w)) { requestFieldValues[`customfield_${w}`] = rawVal; continue }
      const hit = rtFields && (
        rtFields.find(f => f.fieldId.toLowerCase() === w.toLowerCase())
        || rtFields.find(f => f.name.toLowerCase() === w.toLowerCase())
        || rtFields.find(f => f.name.toLowerCase().includes(w.toLowerCase()))
      )
      if (hit) { requestFieldValues[hit.fieldId] = rawVal; continue }
      const def = resolveFieldDefs(allDefs, [w])[0]
      if (def) requestFieldValues[def.id] = rawVal
      else unresolvedFields.push(w)
    }
  }

  // 必填校验：宁可在本地拦下，也不要等 422 之后让用户重填
  if (rtFields) {
    for (const f of rtFields) {
      if (!f.required || f.hasDefault) continue
      if (f.fieldId === 'summary' || f.fieldId === 'description') continue
      if (requestFieldValues[f.fieldId] !== undefined) continue
      if (missing.some(m => m.field === f.fieldId)) continue
      missing.push({ field: f.fieldId, label: f.name, options: f.validValues.map(v => v.label) })
    }
  }
  if (missing.length) {
    const lines = missing.map(m => `- ${m.label}（${m.field}）`
      + (m.options && m.options.length ? `：可选 ${m.options.slice(0, 12).join(' / ')}` : '，需要用户提供'))
    return {
      ok: false,
      error: 'MISSING_REQUIRED_FIELDS',
      missing,
      message: '创建工单前还缺少必填项，请先让用户确认后再创建：\n' + lines.join('\n')
    }
  }

  // 组织字段值形态在不同站点可能是 ["1"] 或 [{organizationId:"1"}]，失败自动回退
  const orgValueForms: any[][] = []
  if (rtOrg && Array.isArray(requestFieldValues[rtOrg.fieldId])) {
    const ids = requestFieldValues[rtOrg.fieldId]
    orgValueForms.push(ids, ids.map((id: string) => ({ organizationId: id })))
  }

  const finalize = async (base: string, issueKey: string, extra: Record<string, any>): Promise<any> => {
    // 站点级优先级不在门户表单里，创建后补写（平台 API 可写 priority，不能写 Organizations）
    const post = await applyPostCreateFields(cfg, issueKey, postCreateFields, signal)
    if (post.failed.length) {
      warnings.push(`工单已创建，但补写 ${post.failed.join('、')} 失败：${post.error}`)
    }
    // 粘贴进来的截图/文件直接作为工单附件
    const attachRes = await attachLocalFiles(cfg, issueKey, input?.attachments, signal)
    if (attachRes.attachmentFailures) {
      warnings.push(`附件上传失败：${attachRes.attachmentFailures.join('；')}`)
    }
    const appliedPriority = requestFieldValues.priority || postCreateFields.priority || null
    const appliedOrgs = rtOrg ? requestFieldValues[rtOrg.fieldId] : null
    jiraLog(`[create] ${issueKey} type=${requestTypeId} desk=${serviceDeskId}`)
    return {
      ok: true,
      issueKey,
      url: issueUrl(base, issueKey),
      ...extra,
      requestTypeId: String(requestTypeId),
      ...(appliedPriority ? { priority: appliedPriority } : {}),
      ...(appliedOrgs ? { organizations: appliedOrgs } : {}),
      ...(attachRes.attachments ? { attachments: attachRes.attachments } : {}),
      ...(unresolvedFields.length ? { unresolvedFields } : {}),
      ...(warnings.length ? { warnings } : {}),
      message: '工单已创建。请把工单号与链接回给用户，并提醒他核对必填项/组织是否符合预期。'
    }
  }

  let r: any = null
  for (let i = 0; i < Math.max(orgValueForms.length, 1); i++) {
    if (rtOrg && orgValueForms.length) requestFieldValues[rtOrg.fieldId] = orgValueForms[i]
    r = await jsmFetch(cfg, 'POST',
      `/rest/servicedeskapi/servicedesk/${encodeURIComponent(serviceDeskId)}/request`,
      { serviceDeskId: String(serviceDeskId), requestTypeId: String(requestTypeId), requestFieldValues },
      signal)
    if (r.status < 400) break
    // 只有「组织字段取值形态不对」才值得换一种形态重试，其它错误直接抛
    if (!(r.status === 400 || r.status === 422) || !rtOrg) break
    const errText = jsmErrorText(r)
    if (!new RegExp(rtOrg.fieldId, 'i').test(errText) && !ORG_FIELD_RE.test(errText)) break
    if (i === orgValueForms.length - 1) break
  }

  // Atlassian 已下线旧版创建请求端点（404 "No endpoint"），回退到 Jira 平台 API 创建
  if (r.status === 404 || r.status === 410) {
    const sd = await jsmFetch(cfg, 'GET', `/rest/servicedeskapi/servicedesk/${encodeURIComponent(serviceDeskId)}`, null, signal)
    if (sd.status !== 200) return { ok: false, error: jsmErrorText(sd), status: sd.status }
    const rt = await jsmFetch(cfg, 'GET',
      `/rest/servicedeskapi/servicedesk/${encodeURIComponent(serviceDeskId)}/requesttype/${encodeURIComponent(requestTypeId)}`,
      null, signal)
    if (rt.status !== 200) return { ok: false, error: jsmErrorText(rt), status: rt.status }

    const platformFields: Record<string, any> = {
      project: { id: String(sd.json.projectId) },
      issuetype: { id: String(rt.json.issueTypeId) },
      summary,
      description: descWiki
    }
    if (requestFieldValues.priority) platformFields.priority = requestFieldValues.priority
    if (rtOrg && Array.isArray(requestFieldValues[rtOrg.fieldId])) {
      platformFields[rtOrg.fieldId] = requestFieldValues[rtOrg.fieldId]
        .map((v: any) => (typeof v === 'object' && v ? v : { organizationId: String(v) }))
    }
    r = await jsmFetch(cfg, 'POST', '/rest/api/2/issue', { fields: platformFields }, signal)
    if (r.status >= 400) return { ok: false, error: jsmErrorText(r), status: r.status }
    return finalize(r.base || '', String(r.json?.key || ''), { via: 'jira-platform-api' })
  }

  if (r.status >= 400) {
    return {
      ok: false,
      error: jsmErrorText(r),
      status: r.status,
      hint: r.status === 403
        ? '该账号可能没有在此服务台创建工单的权限（需要客户/Agent 权限），或服务台已关闭请求入口。'
        : undefined
    }
  }
  const key = r.json?.issueKey || (r.json?._links?.self ? String(r.json._links.self).split('/').pop() : '')
  return finalize(r.base || '', String(key || ''), {
    customerPortalUrl: r.json?._links?.web?.href
  })
}

// ── 工具：jira_add_comment ──────────────────────────────
/**
 * 加评论（可带本机附件 + @提及）。
 * 先上传附件再建评论：正文要用 `!文件名!` 引用它们，必须等 Jira 返回最终文件名；
 * 反过来的话图片只会出现在「附件」区，评论正文里看不到。
 */
async function runJiraAddComment(input: any, signal?: AbortSignal): Promise<any> {
  const cfg = loadConfig()
  assertConfigured(cfg)
  const issueKey = needStr(input, 'issueKey', '工单号').toUpperCase()
  const comment = String(input?.comment ?? '')

  const attachFirst = await attachLocalFiles(cfg, issueKey, input?.attachments, signal)
  const inlineImages = (attachFirst.attachments || [])
    .filter((a: any) => ATTACH_IMAGE_RE.test(String(a.filename || '')))
    .map((a: any) => `!${a.filename}!`)

  if (!comment.trim() && !inlineImages.length) {
    // 附带了却全部上传失败时，如实报附件错误 —— 否则用户会以为是「评论为空」
    if (attachFirst.attachmentFailures?.length) {
      return {
        ok: false,
        error: 'ATTACH_FAILED',
        message: '附件全部上传失败，评论未发布：' + attachFirst.attachmentFailures.join('；')
      }
    }
    return { ok: false, error: 'MISSING_COMMENT', message: 'comment 不能为空（只有图片附件时也可以，但至少要有一个附件）' }
  }

  const mentioned = await applyMentions(cfg, comment, input?.mentions, signal)
  const bodyText = inlineImages.length
    ? `${mentioned.text}${mentioned.text ? '\n\n' : ''}${inlineImages.join('\n')}`
    : mentioned.text
  const bodyWiki = mdToJiraWiki(bodyText)

  // JSM 请求评论支持 public 标记；端点下线时回退到平台评论接口（无 public 概念）
  let r = await jsmFetch(cfg, 'POST',
    `/rest/servicedeskapi/request/${encodeURIComponent(issueKey)}/comment`,
    { body: bodyWiki, public: input?.isPublic !== false },
    signal)
  if (r.status === 404 || r.status === 410) {
    r = await jsmFetch(cfg, 'POST',
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment`, { body: bodyWiki }, signal)
  }
  if (r.status >= 400) return { ok: false, error: jsmErrorText(r), status: r.status }

  jiraLog(`[comment] ${issueKey} len=${bodyWiki.length} att=${(attachFirst.attachments || []).length}`)
  return {
    ok: true,
    issueKey,
    commentId: r.json?.id,
    url: `${r.base}/browse/${issueKey}`,
    ...(mentioned.resolved.length ? { mentions: mentioned.resolved } : {}),
    ...(mentioned.unresolved.length ? { unresolvedMentions: mentioned.unresolved } : {}),
    ...attachFirst,
    ...(inlineImages.length ? { inlinedImages: inlineImages } : {}),
    message: '评论已发布'
  }
}

// ── 工具：jira_transition_issue ─────────────────────────
/**
 * 流转工单状态。
 * 关闭/完成类流转常带必填字段（如「根本原因」），必须随流转一起提交，
 * 否则会报「xxx 不能留空」——不要让用户去界面手动填。
 */
async function runJiraTransitionIssue(input: any, signal?: AbortSignal): Promise<any> {
  const cfg = loadConfig()
  assertConfigured(cfg)
  const issueKey = needStr(input, 'issueKey', '工单号').toUpperCase()
  let transitionId = String(input?.transitionId ?? '').trim()

  const listTransitions = async (): Promise<any[]> => {
    const lr = await jsmFetch(cfg, 'GET',
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`, null, signal)
    if (lr.status !== 200) return []
    return (Array.isArray(lr.json?.transitions) ? lr.json.transitions : [])
      .map((t: any) => ({ id: String(t.id), name: t.name, to: t.to?.name }))
  }

  // 允许用户/模型直接给目标状态名（比记 id 更常见）
  if (transitionId && !/^\d+$/.test(transitionId)) {
    const list = await listTransitions()
    const lc = transitionId.toLowerCase()
    const hit = list.find(t => t.name.toLowerCase() === lc)
      || list.find(t => String(t.to || '').toLowerCase() === lc)
      || list.find(t => t.name.toLowerCase().includes(lc))
    if (hit) transitionId = hit.id
  }
  const available = await listTransitions()
  if (!transitionId) {
    return {
      ok: false,
      error: 'MISSING_TRANSITION',
      transitions: available,
      message: '缺少 transitionId（也可直接给状态名）。请把可用流转列给用户选择。'
    }
  }
  if (available.length && !available.some(t => t.id === transitionId)) {
    return {
      ok: false,
      error: 'BAD_TRANSITION',
      transitions: available,
      message: `工单 ${issueKey} 当前没有 id=${transitionId} 的流转。请从 transitions 里重新选择。`
    }
  }

  const body: any = { transition: { id: transitionId } }
  if (String(input?.comment || '').trim()) {
    const m = await applyMentions(cfg, String(input.comment), null, signal)
    body.update = { comment: [{ add: { body: mdToJiraWiki(m.text) } }] }
  }

  let setFields: Record<string, any> = {}
  const unresolvedFields: string[] = []
  if (input?.fields && typeof input.fields === 'object' && Object.keys(input.fields).length) {
    const resolved = await resolveWritableFields(cfg, input.fields, signal)
    setFields = resolved.fields
    unresolvedFields.push(...resolved.unresolved)
    body.fields = setFields
  }

  let r = await jsmFetch(cfg, 'POST',
    `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`, body, signal)
  // 回退：部分工作流只接受 update.fields 形式（顶层 fields 会被判为未提供）
  if (r.status === 400 && Object.keys(setFields).length) {
    const alt: any = {
      transition: body.transition,
      update: { fields: Object.entries(setFields).map(([k, v]) => ({ add: { [k]: v } })) }
    }
    if (body.update?.comment) alt.update.comment = body.update.comment
    const retry = await jsmFetch(cfg, 'POST',
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`, alt, signal)
    if (retry.status < 400) r = retry
  }
  if (r.status >= 400) {
    return {
      ok: false,
      error: jsmErrorText(r),
      status: r.status,
      transitions: available,
      hint: r.status === 400
        ? '常见原因：该流转界面有必填字段没提交。请把字段名（如「根本原因」）放进 fields 一起提交，不要为此让用户手动操作。'
        : undefined
    }
  }

  const done = available.find(t => t.id === transitionId)
  jiraLog(`[transition] ${issueKey} -> ${done?.name || transitionId}`)
  return {
    ok: true,
    issueKey,
    url: `${r.base}/browse/${issueKey}`,
    transitionId,
    transitionName: done?.name,
    to: done?.to,
    ...(unresolvedFields.length ? { unresolvedFields } : {}),
    message: `已流转到「${done?.to || done?.name || transitionId}」`
  }
}

// ── 工具定义（下发给模型）────────────────────────────────
const ISSUE_KEY_SCHEMA = { type: 'string', description: '工单号，如 ETESC-119' }

export const JIRA_CONFIG_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'jira_config',
    description:
      '查看/初始化 JSM 凭据配置。action=view 查看配置状态（邮箱与 token 均为掩码）；' +
      'action=init 生成配置模板并打开目录（email 与 apiToken 留空，由用户自己填写，' +
      '**不要把 token 发到聊天里**）；action=open 只打开配置目录。首次使用（配置文件不存在）时 view 会自动建模板并打开目录。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['view', 'init', 'open'], description: '默认 view' }
      }
    }
  }
}

export const JIRA_PANEL_STATUS_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'jira_panel_status',
    description:
      '查看工单面板取数凭据（cURL）的状态：是否已配置、当初从哪个工单抓的、contextToken 还有多少秒过期。' +
      '不返回 token / cookie 本身。用户问「为什么查不到 RDMS」时先看这个。',
    parameters: { type: 'object', properties: {} }
  }
}

export const JIRA_SAVE_PANEL_CURL_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'jira_save_panel_curl',
    description:
      '保存用户粘贴的工单面板 cURL 作为本机取数凭据（用于按工单号批量查 RDMS 关联）。' +
      '用户会在浏览器 F12 → Network 里筛 useInvokeExtensionRelayMutation 后 Copy as cURL，' +
      '把整段文本发过来；原样传进 curl 参数即可，不要试图改写或截断。' +
      '工具会校验请求结构、contextToken 是否过期（15 分钟），失败会明确告知要重新复制。',
    parameters: {
      type: 'object',
      properties: {
        curl: { type: 'string', description: '用户粘贴的完整 cURL（含 --data-raw 与 cookie）' }
      },
      required: ['curl']
    }
  }
}

export const JIRA_CURRENT_USER_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'jira_current_user',
    description: '查看当前 API Token 对应的 JSM 账号（显示名、打码邮箱、时区）。验证凭据是否配好时用。',
    parameters: { type: 'object', properties: {} }
  }
}

export const JIRA_SERVICE_DESKS_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'jira_service_desks',
    description:
      '列出可用的 JSM 服务台（id、项目 key、名称）。创建工单前必须先拿到 serviceDeskId。' +
      '可按 keyword 过滤名称。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '名称/项目 key 关键字（可选）' },
        limit: { type: 'number', description: '返回条数，1-100，默认 50' }
      }
    }
  }
}

export const JIRA_REQUEST_TYPES_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'jira_request_types',
    description:
      '列出某服务台下可用的 Request Type（工单类型）。创建工单必须用返回的 id，不能只给名称。',
    parameters: {
      type: 'object',
      properties: {
        serviceDeskId: { type: 'string', description: '服务台 id（来自 jira_service_desks）' },
        keyword: { type: 'string', description: '类型名关键字（可选）' }
      },
      required: ['serviceDeskId']
    }
  }
}

export const JIRA_REQUEST_TYPE_FIELDS_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'jira_request_type_fields',
    description:
      '查某服务台 + 某 Request Type 的表单字段定义：哪些必填、优先级可选值、组织字段与组织列表。' +
      '创建工单项前先用它，把缺的必填项一次问清（漏项会 422）。也给出 hint 话术可直接转述。',
    parameters: {
      type: 'object',
      properties: {
        serviceDeskId: { type: 'string', description: '服务台 id' },
        requestTypeId: { type: 'string', description: 'Request Type id' }
      },
      required: ['serviceDeskId', 'requestTypeId']
    }
  }
}

export const JIRA_SEARCH_ISSUES_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'jira_search_issues',
    description:
      '用 JQL 检索工单（该站点禁止无条件 JQL，必须带 project/status/时间等过滤条件）。' +
      '返回清单含 key/标题/状态/类型/经办人/优先级/时间/可点击链接。' +
      '需要自定义字段（如 RDMS ID）时用 extraFields 一次带出来，**不要**对结果逐条再调用 jira_get_issue。' +
      '「未关闭」优先写 statusCategory != Done，不要猜中文状态名。',
    parameters: {
      type: 'object',
      properties: {
        jql: { type: 'string', description: 'JQL，例如 project = ETESC AND statusCategory != Done ORDER BY updated DESC' },
        maxResults: { type: 'number', description: '返回条数，1-50，默认 10' },
        extraFields: {
          type: 'array', items: { type: 'string' },
          description: '（可选）要一起带出的自定义字段名，如 ["RDMS ID","根本原因"]'
        }
      },
      required: ['jql']
    }
  }
}

export const JIRA_GET_ISSUE_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'jira_get_issue',
    description:
      '读取单个工单详情：标题/状态/状态分类/类型/经办人/报告人/优先级/描述/附件/评论数，' +
      '以及可用的流转动作（transitions）与从描述+评论里扫出的 RDMS 引用（rdmsRefs，含 kind 与 url）。' +
      '找 RDMS 编号优先用它：rdmsRefs 有就直接用，不必再抓面板。',
    parameters: {
      type: 'object',
      properties: {
        issueKey: ISSUE_KEY_SCHEMA,
        extraFields: {
          type: 'array', items: { type: 'string' },
          description: '（可选）额外要读的自定义字段名，如 ["RDMS ID","客户"]'
        }
      },
      required: ['issueKey']
    }
  }
}

export const JIRA_REQUEST_STATUS_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'jira_request_status',
    description: '查工单在服务台视角的状态：当前状态、状态分类（判断是否 Done）、解决结果、请求类型、服务台、客户门户链接。',
    parameters: {
      type: 'object',
      properties: { issueKey: ISSUE_KEY_SCHEMA },
      required: ['issueKey']
    }
  }
}

export const JIRA_PANEL_RDMS_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'jira_panel_rdms',
    description:
      '按工单号批量查面板里的 RDMS 关联（第三方 Forge 面板数据，不在 Jira REST 里）。' +
      '返回 rmId（= RDMS ID）、rdmsKind（bug|story，识别不出时为 null）、rdmsUrl（已按 kind 拼好的链接）。' +
      'rdmsKind 为 null 时**不要猜**，直接问用户是 Bug 还是 Story；rmId 为空表示该工单未关联。' +
      '需要先有凭据（见 jira_panel_status / jira_save_panel_curl），过期时提示用户重新复制 cURL。',
    parameters: {
      type: 'object',
      properties: {
        issueKeys: {
          type: 'array', items: { type: 'string' },
          description: '工单号列表，如 ["ETESC-119","ETESC-120"]'
        }
      },
      required: ['issueKeys']
    }
  }
}

export const JIRA_CREATE_TICKET_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'jira_create_ticket',
    description:
      '在 JSM 服务台创建工单（写操作）。**执行前必须先在回复里复述服务台、工单类型、标题、描述要点、优先级/组织，' +
      '并等待用户明确确认；未确认不得调用。**' +
      'serviceDeskId / requestTypeId 必须来自 jira_service_desks / jira_request_types；' +
      '不确定必填项时先调 jira_request_type_fields。描述用 Markdown 写，服务端会转成 Jira Wiki；' +
      '长文档可传 descriptionFile（本机文本文件绝对路径）避免占用上下文。',
    parameters: {
      type: 'object',
      properties: {
        serviceDeskId: { type: 'string', description: '服务台 id' },
        requestTypeId: { type: 'string', description: 'Request Type id' },
        summary: { type: 'string', description: '工单标题' },
        description: { type: 'string', description: '工单描述，Markdown 格式' },
        descriptionFile: { type: 'string', description: '（可选）本机 Markdown/文本文件绝对路径，作为描述正文；描述为空时才读取' },
        priority: { type: 'string', description: '（可选）优先级，可给名称（High/高）或 id' },
        organization: { type: 'string', description: '（可选）组织名称或 id' },
        organizations: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } }
          ],
          description: '（可选）多个组织名称/id'
        },
        fields: {
          type: 'object',
          description: '（可选）其它字段，键可为字段名（如 "根本原因"）或 customfield_11205，值按字段类型给'
        },
        attachments: {
          type: 'array', items: { type: 'string' },
          description: '（可选）随工单上传的本机文件绝对路径列表'
        }
      },
      required: ['serviceDeskId', 'requestTypeId', 'summary']
    }
  }
}

export const JIRA_ADD_COMMENT_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'jira_add_comment',
    description:
      '给工单加评论，可同时附带本机文件作为附件（写操作）。**执行前必须先复述评论正文、公开/内部、附件路径并等待用户确认。**' +
      '评论用 Markdown 写，服务端转 Jira Wiki；图片附件会自动用 !文件名! 内嵌到正文，不需要你手写引用语法；' +
      'PDF/日志等作为普通附件。要 @人 时正文正常写 @姓名，同时把姓名放进 mentions，' +
      '服务端会换成 Jira 认可的提及语法并通知对方（不要自己手写 [~accountid:...]）。',
    parameters: {
      type: 'object',
      properties: {
        issueKey: ISSUE_KEY_SCHEMA,
        comment: { type: 'string', description: '评论正文，Markdown' },
        isPublic: { type: 'boolean', description: '是否对客户公开，默认 true' },
        mentions: {
          type: 'array', items: { type: 'string' },
          description: '（可选）要 @ 的人（显示名或邮箱），如 ["Baran Karataş"]'
        },
        attachments: {
          type: 'array', items: { type: 'string' },
          description: '（可选）随评论上传的本机文件绝对路径（图片会内嵌进正文）'
        }
      },
      required: ['issueKey', 'comment']
    }
  }
}

export const JIRA_TRANSITION_ISSUE_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'jira_transition_issue',
    description:
      '流转工单状态（写操作）。**执行前必须先复述目标状态、附带评论、要写入的字段并等待用户确认。**' +
      'transitionId 可用 jira_get_issue 返回的 transitions[].id，也可直接传目标状态名。' +
      '若流转界面有必填字段（如「这个问题的根本原因是什么？」），必须把该字段放进 fields 一起提交，' +
      '否则会报「字段不能留空」——不要因此让用户去界面手动填。',
    parameters: {
      type: 'object',
      properties: {
        issueKey: ISSUE_KEY_SCHEMA,
        transitionId: { type: 'string', description: '流转动作 id（或目标状态名）' },
        comment: { type: 'string', description: '（可选）流转时附带的评论，Markdown' },
        fields: {
          type: 'object',
          description: '（可选）流转时同时写入的字段，键可为字段名或 customfield_xxx，用于满足流转必填项'
        }
      },
      required: ['issueKey', 'transitionId']
    }
  }
}

/** 供 toolRegistry 直接注册的 map（键与 SKILL_TOOLS['jira-jsm'] 一一对应） */
export const JIRA_TOOL_ENTRIES: Record<string, { definition: any; run: (input: any, ctx: any) => Promise<any> }> = {
  jira_config: { definition: JIRA_CONFIG_TOOL_DEFINITION, run: (input) => runJiraConfig(input) },
  jira_panel_status: { definition: JIRA_PANEL_STATUS_TOOL_DEFINITION, run: async () => runJiraPanelStatus() },
  jira_save_panel_curl: { definition: JIRA_SAVE_PANEL_CURL_TOOL_DEFINITION, run: async (input) => runJiraSavePanelCurl(input) },
  jira_current_user: { definition: JIRA_CURRENT_USER_TOOL_DEFINITION, run: (input, ctx) => runJiraCurrentUser(ctx?.signal) },
  jira_service_desks: { definition: JIRA_SERVICE_DESKS_TOOL_DEFINITION, run: (input, ctx) => runJiraServiceDesks(input, ctx?.signal) },
  jira_request_types: { definition: JIRA_REQUEST_TYPES_TOOL_DEFINITION, run: (input, ctx) => runJiraRequestTypes(input, ctx?.signal) },
  jira_request_type_fields: {
    definition: JIRA_REQUEST_TYPE_FIELDS_TOOL_DEFINITION,
    run: (input, ctx) => runJiraRequestTypeFields(input, ctx?.signal)
  },
  jira_search_issues: { definition: JIRA_SEARCH_ISSUES_TOOL_DEFINITION, run: (input, ctx) => runJiraSearchIssues(input, ctx?.signal) },
  jira_get_issue: { definition: JIRA_GET_ISSUE_TOOL_DEFINITION, run: (input, ctx) => runJiraGetIssue(input, ctx?.signal) },
  jira_request_status: { definition: JIRA_REQUEST_STATUS_TOOL_DEFINITION, run: (input, ctx) => runJiraRequestStatus(input, ctx?.signal) },
  jira_panel_rdms: { definition: JIRA_PANEL_RDMS_TOOL_DEFINITION, run: async (input) => runJiraPanelRdms(input) },
  jira_create_ticket: { definition: JIRA_CREATE_TICKET_TOOL_DEFINITION, run: (input, ctx) => runJiraCreateTicket(input, ctx?.signal) },
  jira_add_comment: { definition: JIRA_ADD_COMMENT_TOOL_DEFINITION, run: (input, ctx) => runJiraAddComment(input, ctx?.signal) },
  jira_transition_issue: {
    definition: JIRA_TRANSITION_ISSUE_TOOL_DEFINITION,
    run: (input, ctx) => runJiraTransitionIssue(input, ctx?.signal)
  }
}
