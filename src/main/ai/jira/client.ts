/**
 * Jira / JSM 工单助手 · HTTP 层（1.0.71）
 *
 * 来源：外部工具 `E:\工具\Jira_Jsm\server.js`（零依赖 Node 代理）。
 * 这里改写为 Electron 主进程原生实现，**不引入新依赖**：用全局 fetch（Electron 33 自带 Node 20）。
 *
 * 与源实现对齐的关键点：
 *   - Basic Auth（email:apiToken，base64）+ `X-ExperimentalApi: opt-in`（JSM 部分接口需要预览头）；
 *   - 站点地址必须 https 且 `*.atlassian.net`：令牌等同账号密码，绝不允许明文或任意域名；
 *   - 附件上传走 multipart/form-data 手拼 + `X-Atlassian-Token: no-check`（Jira 的 CSRF 放行头）；
 *   - 服务台工单用平台接口被拒（403/404）时回退到 JSM 的「临时附件」两段式通道。
 */
import { readFileSync, statSync } from 'fs'
import { basename } from 'path'
import { randomBytes } from 'crypto'
import { gzipSync } from 'zlib'
import { jiraLog, type JiraConfig } from './config'

/** 单次 JSM 请求超时（源实现 45s） */
const JSM_TIMEOUT_MS = 45_000
/** 单个附件上限 200MB：超过直接拒绝，避免无谓的内存占用 */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024
/** 工具结果最大字符数（防止超长 JSON 把上下文吃光） */
const TOOL_RESULT_LIMIT = 12000

export interface HttpResult {
  status: number
  text: string
  json: any
  base?: string
}

interface HttpOpts {
  method?: string
  headers?: Record<string, string>
  /** JSON 请求体 */
  body?: any
  /** 已序列化的二进制体（multipart / 原始字节） */
  rawBody?: Buffer
  timeoutMs?: number
  signal?: AbortSignal
}

function isAbort(e: any): boolean {
  return e?.name === 'AbortError' || e?.message === 'ABORTED'
}

/** 通用 HTTP 请求（支持 JSON 与二进制体） */
export async function httpJson(urlStr: string, opts: HttpOpts = {}): Promise<HttpResult> {
  let u: URL
  try { u = new URL(urlStr) } catch { throw new Error('非法的 URL: ' + urlStr) }
  const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  if (u.protocol !== 'https:' && !isLocal) {
    throw new Error('仅支持 https 地址（本机测试除外）: ' + urlStr)
  }

  const timeoutMs = opts.timeoutMs ?? JSM_TIMEOUT_MS
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
  const onAbort = (): void => ctrl.abort()
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })
  }

  const hasJsonBody = opts.body !== undefined && opts.body !== null
  const payload: Buffer | undefined = opts.rawBody
    ? opts.rawBody
    : (hasJsonBody ? Buffer.from(JSON.stringify(opts.body), 'utf8') : undefined)

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(payload ? { 'Content-Length': String(payload.length) } : {}),
    ...(opts.rawBody ? {} : (hasJsonBody ? { 'Content-Type': 'application/json' } : {})),
    ...(opts.headers || {})
  }

  try {
    const res = await fetch(u.toString(), {
      method: opts.method || 'GET',
      headers,
      body: opts.rawBody ? new Uint8Array(opts.rawBody) : (hasJsonBody ? JSON.stringify(opts.body) : undefined),
      signal: ctrl.signal
    })
    const text = await res.text()
    let json: any = null
    try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON 响应（附件下载等） */ }
    return { status: res.status, text, json }
  } catch (e: any) {
    if (opts.signal?.aborted) throw new Error('ABORTED')
    if (timedOut) throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`)
    if (isAbort(e)) throw new Error('ABORTED')
    throw new Error(e?.message || String(e))
  } finally {
    clearTimeout(timer)
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
  }
}

// ── 配置校验 / 鉴权头 ────────────────────────────────────
export function validateConfig(cfg: JiraConfig): { base: string; errors: string[] } {
  const errors: string[] = []
  const base = String(cfg?.siteUrl || '').trim().replace(/\/+$/, '')
  if (!base) {
    errors.push('JSM URL 不能为空')
  } else {
    try {
      const u = new URL(base)
      if (u.protocol !== 'https:') errors.push('JSM URL 必须是 https')
      if (!u.hostname.endsWith('.atlassian.net')) errors.push('JSM URL 必须是 *.atlassian.net 域名')
    } catch {
      errors.push('JSM URL 格式不正确')
    }
  }
  if (!String(cfg?.email || '').trim()) errors.push('JSM 账号邮箱未填写')
  if (!String(cfg?.apiToken || '').trim()) errors.push('JSM API Token 未填写')
  return { base, errors }
}

function jsmHeaders(cfg: JiraConfig): Record<string, string> {
  const auth = Buffer.from(`${String(cfg.email).trim()}:${String(cfg.apiToken).trim()}`).toString('base64')
  return { Authorization: 'Basic ' + auth, 'X-ExperimentalApi': 'opt-in' }
}

/** 未配置时抛出带引导的错误（模型据此提示用户去填 config.json） */
export function assertConfigured(cfg: JiraConfig): void {
  const { errors } = validateConfig(cfg)
  if (errors.length) {
    throw new Error(
      `${errors.join('；')}。凭据不通过对话索取：请用 jira_config action=init 生成配置模板并打开目录，` +
      '由用户自己把工作邮箱与 API Token 填进 config.json（%APPDATA%\\mc-material-query\\jira-jsm\\config.json）后再重试。'
    )
  }
}

/** 调用 Jira / JSM REST 接口 */
export async function jsmFetch(
  cfg: JiraConfig,
  method: string,
  apiPath: string,
  body: any = null,
  signal?: AbortSignal
): Promise<HttpResult> {
  const { base, errors } = validateConfig(cfg)
  if (errors.length) assertConfigured(cfg)
  const url = base + (apiPath.startsWith('/') ? apiPath : '/' + apiPath)
  const resp = await httpJson(url, {
    method,
    headers: jsmHeaders(cfg),
    body: body === null ? undefined : body,
    timeoutMs: JSM_TIMEOUT_MS,
    signal
  })
  return { ...resp, base }
}

/** 把 JSM 错误响应转成可读文本（errorMessages / errors / 纯文本兜底） */
export function jsmErrorText(resp: HttpResult | null): string {
  if (!resp) return '未知错误'
  const j = resp.json
  if (j) {
    const msgs: string[] = []
    if (Array.isArray(j.errorMessages)) msgs.push(...j.errorMessages.map((m: any) => String(m)))
    if (j.errors && typeof j.errors === 'object') {
      for (const [k, v] of Object.entries(j.errors)) msgs.push(`${k}: ${v}`)
    }
    if (j.errorMessage) msgs.push(String(j.errorMessage))
    if (j.message) msgs.push(String(j.message))
    if (msgs.length) return msgs.join('；')
  }
  return resp.text ? resp.text.slice(0, 500) : `HTTP ${resp.status}`
}

/** 结果裁剪：超长 JSON 截断，避免把上下文一次性吃光 */
export function clip(s: string): string {
  return s.length > TOOL_RESULT_LIMIT ? s.slice(0, TOOL_RESULT_LIMIT) + '\n...[内容过长已截断]' : s
}

export function pick(o: any, keys: string[]): Record<string, any> {
  const out: Record<string, any> = {}
  for (const k of keys) {
    if (o && o[k] !== undefined && o[k] !== null) out[k] = o[k]
  }
  return out
}

// ── 附件上传（multipart/form-data）───────────────────────
function mimeOf(filename: string): string {
  const ext = String(filename).toLowerCase().split('.').pop() || ''
  const map: Record<string, string> = {
    zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
    gz: 'application/gzip', tgz: 'application/gzip',
    pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', log: 'text/plain', xml: 'application/xml',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    rtf: 'application/rtf', md: 'text/markdown', markdown: 'text/markdown'
  }
  return map[ext] || 'application/octet-stream'
}

function buildMultipart(fieldName: string, filename: string, content: Buffer, mimeType: string): {
  body: Buffer
  contentType: string
} {
  const boundary = '----JSMApp' + randomBytes(16).toString('hex')
  const safeName = String(filename).replace(/["\r\n]/g, '_')
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${safeName}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`, 'utf8')
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  return { body: Buffer.concat([head, content, tail]), contentType: `multipart/form-data; boundary=${boundary}` }
}

async function jsmUpload(
  cfg: JiraConfig,
  apiPath: string,
  buffer: Buffer,
  contentType: string,
  extraHeaders: Record<string, string>,
  signal?: AbortSignal
): Promise<HttpResult> {
  const { base, errors } = validateConfig(cfg)
  if (errors.length) assertConfigured(cfg)
  const url = base + (apiPath.startsWith('/') ? apiPath : '/' + apiPath)
  const resp = await httpJson(url, {
    method: 'POST',
    headers: { ...jsmHeaders(cfg), 'Content-Type': contentType, ...extraHeaders },
    rawBody: buffer,
    timeoutMs: 5 * 60 * 1000,
    signal
  })
  return { ...resp, base }
}

function attachError(status: number, text: string): Error & { status?: number } {
  const e: Error & { status?: number } = new Error(text)
  e.status = status
  return e
}

/** 是否为「附件超过站点上限」类错误（Jira 常回 413 或 400 + 文字说明） */
function isTooLargeError(e: any): boolean {
  if (!e) return false
  if (e.status === 413) return true
  return /too large|exceeds|exceeded|maximum (allowed )?size|file size limit|size limit|过大|超出.{0,6}上限/i
    .test(String(e?.message || e))
}

/** gzip 压缩；压了没变小就返回 null（说明压了也没意义） */
function gzipBuffer(buf: Buffer): Buffer | null {
  try {
    const gz = gzipSync(buf, { level: 9 })
    return gz && gz.length < buf.length ? gz : null
  } catch { return null }
}

/**
 * 附件名规范化。
 * 评论里用 Jira wiki 的 `!文件名!` 内嵌图片，而 mdToJiraWiki 会把 `_ * [ ] { }` 转义，
 * 文件名带这些字符会导致图片语法失效、页面上显示成原始文本 → 统一换成连字符（保留中文与扩展名）。
 */
export function safeAttachmentName(name: string): string {
  const raw = String(name || '').split(/[\\/]/).pop() || 'file'
  const dot = raw.lastIndexOf('.')
  const ext = dot > 0 ? raw.slice(dot).toLowerCase() : ''
  const base = (dot > 0 ? raw.slice(0, dot) : raw)
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[{}[\]*_|!^~<>"'`\\/]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'file'
  return base + ext
}

/** 把一段 buffer 作为附件推到工单（含服务台临时附件通道回退） */
export async function pushAttachment(
  cfg: JiraConfig,
  issueKey: string,
  buf: Buffer,
  name: string,
  signal?: AbortSignal
): Promise<any> {
  const { body, contentType } = buildMultipart('file', name, buf, mimeOf(name))
  const r = await jsmUpload(
    cfg,
    `/rest/api/2/issue/${encodeURIComponent(issueKey)}/attachments`,
    body,
    contentType,
    { 'X-Atlassian-Token': 'no-check' },
    signal
  )

  // 回退：服务台工单用平台接口被拒时，改走 JSM 的临时附件通道
  if (r.status === 403 || r.status === 404) {
    const detail = await jsmFetch(cfg, 'GET', `/rest/servicedeskapi/request/${encodeURIComponent(issueKey)}`, null, signal)
    const serviceDeskId = detail.status === 200 && detail.json ? detail.json.serviceDeskId : null
    if (serviceDeskId) {
      const tmp = await jsmUpload(
        cfg,
        `/rest/servicedeskapi/servicedesk/${encodeURIComponent(serviceDeskId)}/attachTemporaryFile`,
        body,
        contentType,
        { 'X-Atlassian-Token': 'no-check' },
        signal
      )
      if (tmp.status >= 400) throw attachError(tmp.status, jsmErrorText(tmp))
      const tmpIds = ((tmp.json && tmp.json.temporaryAttachments) || [])
        .map((t: any) => t.temporaryAttachmentId)
        .filter(Boolean)
      if (tmpIds.length) {
        const add = await jsmFetch(cfg, 'POST', `/rest/servicedeskapi/request/${encodeURIComponent(issueKey)}/attachment`, {
          temporaryAttachmentIds: tmpIds,
          public: true
        }, signal)
        if (add.status >= 400) throw attachError(add.status, jsmErrorText(add))
        const arr = (add.json && add.json.attachments) || []
        return {
          ok: true,
          issueKey,
          via: 'servicedeskapi',
          uploaded: arr.map((a: any) => ({
            id: a.id,
            filename: a.filename,
            size: a.size,
            url: (a._links && a._links.content) || `${add.base}/browse/${issueKey}`
          }))
        }
      }
    }
  }

  if (r.status >= 400) throw attachError(r.status, jsmErrorText(r))
  const list = Array.isArray(r.json) ? r.json : []
  return {
    ok: true,
    issueKey,
    uploaded: list.map((a: any) => ({
      id: a.id,
      filename: a.filename,
      size: a.size,
      url: `${r.base}/secure/attachment/${a.id}/${encodeURIComponent(a.filename || name)}`
    }))
  }
}

/** 上传单个本机文件（超站点上限自动 gzip 重传） */
export async function uploadLocalFile(
  cfg: JiraConfig,
  issueKey: string,
  filePath: string,
  filename?: string,
  signal?: AbortSignal
): Promise<any> {
  const raw = String(filePath || '').trim();
  if (!raw) throw new Error('filePath 不能为空')
  let st
  try { st = statSync(raw) } catch { throw new Error('文件不存在或无法访问：' + raw) }
  if (!st.isFile()) throw new Error('目标不是文件：' + raw)
  if (st.size === 0) throw new Error('文件为空：' + raw)
  if (st.size > MAX_UPLOAD_BYTES) {
    throw new Error(`文件过大（${(st.size / 1048576).toFixed(1)}MB），超过 ${Math.round(MAX_UPLOAD_BYTES / 1048576)}MB 上限`)
  }
  const buf = readFileSync(raw)
  const name = String(filename || safeAttachmentName(basename(raw)))

  try {
    return await pushAttachment(cfg, issueKey, buf, name, signal)
  } catch (e) {
    // 站点附件上限（Jira 默认 10MB）小于文件大小：自动 gzip 成 .gz 重传，
    // 否则 12MB 日志这类文件会直接失败，用户只能自己压缩。
    if (!isTooLargeError(e)) throw e
    const gz = gzipBuffer(buf)
    if (!gz) throw e
    const gzName = name + '.gz'
    const ret = await pushAttachment(cfg, issueKey, gz, gzName, signal)
    jiraLog(`[attach] ${name} 超过站点上限，已 gzip 上传 ${gz.length} 字节`)
    return {
      ...ret,
      compressed: true,
      originalSize: buf.length,
      size: gz.length,
      note: `原文件 ${(buf.length / 1048576).toFixed(1)}MB 超过站点附件上限，已 gzip 压缩为 ${gzName}`
        + `（${(gz.length / 1024).toFixed(0)}KB）上传；下载后解压即为原文件。`
    }
  }
}

/** 把一组本机文件上传到工单：单个失败不中断其余，失败原因逐个回传 */
export async function attachLocalFiles(
  cfg: JiraConfig,
  issueKey: string,
  attachments: any,
  signal?: AbortSignal
): Promise<{ attachments?: any[]; attachmentFailures?: string[] }> {
  const paths = (Array.isArray(attachments) ? attachments : (attachments != null ? [attachments] : []))
    .map(x => String(x == null ? '' : x).trim())
    .filter(Boolean)
  if (!paths.length) return {}
  const uploaded: any[] = []
  const failures: string[] = []
  for (const p of paths) {
    try {
      const up = await uploadLocalFile(cfg, issueKey, p, undefined, signal)
      uploaded.push(...(up.uploaded || []))
    } catch (e: any) {
      failures.push(`${p}：${e?.message || e}`)
    }
  }
  return {
    ...(uploaded.length ? { attachments: uploaded } : {}),
    ...(failures.length ? { attachmentFailures: failures } : {})
  }
}
