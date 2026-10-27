/**
 * Outlook 工作邮箱助手 · 执行层（1.0.61）
 *
 * 来源：外部 Python 技能 `email-auto`（约 3.7k 行，msal + requests）。
 * 本文件把它重写为 mc-tool 主进程的原生工具，**不随包分发任何脚本或运行时**：
 *   - 授权：Device Code Flow（公开客户端，无 client secret）
 *   - 数据：Microsoft Graph v1.0（node 原生 fetch，零新增 npm 依赖）
 *   - 边界：只读 + 只写草稿，绝不发送；权限硬校验只允许 Mail.ReadWrite / offline_access
 *
 * 与源技能逐条对齐的点：
 *   - `inReplyTo` / `references` 在该租户返回 400 UnableToDeserializePostBody → 去掉重投一次；
 *   - 回复正文的引用块必须保留（源技能因只取第一个 text/plain 分片而静默丢失过）。
 * 刻意不做：定时任务、dashboard、附件下载、自动发送。
 */
import { shell } from 'electron'
import {
  clearToken, configView, DEFAULT_CONFIG, emailLog, loadConfig, loadToken, maskMail,
  saveConfig, saveToken, type EmailConfig, type EmailToken
} from './emailStore'
import {
  countHtmlStructure, normalizeReplyBody, previewBody, toHtml, toQuotedBlock
} from './emailCompose'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const LOGIN_BASE = 'https://login.microsoftonline.com'
const DINGTALK_API_URL = 'https://api-deap.dingtalk.com/v1/assistant/responses'

/**
 * 我们**主动申请**的权限集合。源技能 `ensure_auth` 只接受 `Mail.ReadWrite`，这里保持：
 * Mail.Read 需要管理员同意、任何 Application 权限都需要管理员同意、
 * Mail.Send 等于绕过人工审核 —— 一律不申请。
 *
 * ⚠️ 1.0.62 修正：这个白名单**只用于校验我们发出去的 scope 请求**，
 * 绝不能用它去校验 Entra 返回的 `scope` 字段。因为应用注册里可能由管理员授予了
 * 额外权限（例如 AuditLog.Read.All），Graph 会把这些已授予项一并写进令牌的 `scope`，
 * 于是旧实现会把一份完全可用的令牌判为非法并丢弃 —— 用户侧表现就是
 * 「账号明明同意了，却反复提示未授权」（1.0.61 实测踩到，连续三次）。
 */
const ALLOWED_SCOPES = new Set(['mail.readwrite', 'offline_access'])
const SCOPE_STRING = 'offline_access Mail.ReadWrite'

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

// ── 错误类型 ─────────────────────────────────────────────
class MailAuthRequired extends Error {
  code = 'MAIL_AUTH_REQUIRED'
  // 错误码写进 message：dispatchTool 只回传 error 字符串，模型靠它判断该走 re-auth
  constructor(msg = '未授权或授权已失效，请调用 mail_auth action=start 重新授权') {
    super(`MAIL_AUTH_REQUIRED: ${msg}`)
  }
}
class MailHttpError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, msg: string) {
    super(`${code}（HTTP ${status}）：${msg}`)
    this.status = status
    this.code = code
  }
}

function isAbort(e: any): boolean {
  return e?.name === 'AbortError' || e?.message === 'ABORTED'
}

// ── HTTP ────────────────────────────────────────────────
interface HttpOpts {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  signal?: AbortSignal
}
interface HttpResult {
  status: number
  json: any
  text: string
}

async function httpJson(url: string, opts: HttpOpts = {}): Promise<HttpResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
  const onAbort = (): void => ctrl.abort()
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers,
      body: opts.body,
      signal: ctrl.signal
    })
    const text = await res.text()
    let json: any = null
    try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON（如图片/空响应） */ }
    return { status: res.status, json, text }
  } catch (e: any) {
    if (opts.signal?.aborted) throw new Error('ABORTED')
    if (timedOut) throw new MailHttpError(0, 'TIMEOUT', `请求超时（${Math.round(timeoutMs / 1000)}s）`)
    throw new MailHttpError(0, 'NETWORK', e?.message || String(e))
  } finally {
    clearTimeout(timer)
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
  }
}

// ── 授权（Device Code）────────────────────────────────────
interface DeviceSession {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresAt: number
  intervalMs: number
  polling: boolean
  error?: string
  declined?: boolean
}
let deviceSession: DeviceSession | null = null

/** 校验「我们将要申请的」scope（只用于 SCOPE_STRING 这类我们自己构造的常量） */
function assertRequestedScope(scope: string): void {
  const parts = String(scope || '').split(/\s+/).filter(Boolean)
  for (const p of parts) {
    if (!ALLOWED_SCOPES.has(p.toLowerCase())) {
      throw new Error(`拒绝申请权限: ${p}（只允许 Mail.ReadWrite + offline_access）`)
    }
  }
}

/**
 * 解析 Entra 返回的 `scope`，把「应用注册里额外授予的权限」单独列出来。
 * 这些权限我们**从不使用**（代码里没有任何 send / audit 调用），只作信息展示 ——
 * 绝不能因为它们就丢掉令牌（1.0.61 的 bug）。
 */
function splitGrantedScopes(scope: string): { granted: string[]; extra: string[] } {
  const granted = String(scope || '').split(/\s+/).filter(Boolean)
  const extra = granted.filter(s => !ALLOWED_SCOPES.has(s.toLowerCase()))
  return { granted, extra }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('ABORTED'))
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => { clearTimeout(t); reject(new Error('ABORTED')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function parseTokenResponse(json: any, fallbackAccount: string): EmailToken {
  const now = Date.now()
  const expiresIn = Number(json?.expires_in) || 3600
  // 注意：这里**不校验**返回的 scope（见 ALLOWED_SCOPES 注释），只记录，供 status 展示
  const scope = String(json?.scope || SCOPE_STRING)
  return {
    accessToken: String(json?.access_token || ''),
    refreshToken: String(json?.refresh_token || ''),
    scope,
    expiresAt: now + expiresIn * 1000,
    account: String(json?.id_token_hint || fallbackAccount || '')
  }
}

/** 启动 Device Code：返回验证码并**自动打开系统浏览器**授权页 */
async function startDeviceAuth(cfg: EmailConfig): Promise<{
  userCode: string; verificationUri: string; expiresIn: number; opened: boolean; reused: boolean
}> {
  if (deviceSession && deviceSession.polling && deviceSession.expiresAt > Date.now()) {
    return {
      userCode: deviceSession.userCode,
      verificationUri: deviceSession.verificationUri,
      expiresIn: Math.round((deviceSession.expiresAt - Date.now()) / 1000),
      opened: false,
      reused: true
    }
  }

  // 校验「我们自己要申请的」scope 常量（不是校验 Entra 返回的 scope）
  assertRequestedScope(SCOPE_STRING)

  const url = `${LOGIN_BASE}/${cfg.tenantId}/oauth2/v2.0/devicecode`
  const res = await httpJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, scope: SCOPE_STRING }).toString(),
    timeoutMs: 20_000
  })
  if (res.status !== 200 || !res.json?.device_code) {
    const detail = res.json?.error_description || res.json?.error || res.text.slice(0, 200)
    throw new MailHttpError(res.status, 'DEVICE_CODE_FAILED', `申请授权码失败：${detail}`)
  }

  deviceSession = {
    deviceCode: String(res.json.device_code),
    userCode: String(res.json.user_code),
    verificationUri: String(res.json.verification_uri || 'https://microsoft.com/devicelogin'),
    expiresAt: Date.now() + (Number(res.json.expires_in) || 900) * 1000,
    intervalMs: Math.max(5, Number(res.json.interval) || 5) * 1000,
    polling: true
  }
  emailLog(`[auth] device code issued userCode=${deviceSession.userCode} expireIn=${Math.round((deviceSession.expiresAt - Date.now()) / 60000)}min`)

  let opened = false
  try {
    await shell.openExternal(deviceSession.verificationUri)
    opened = true
  } catch (e: any) {
    emailLog('[auth] 打开浏览器失败：' + (e?.message || e))
  }

  void pollDeviceAuth(cfg)
  return {
    userCode: deviceSession.userCode,
    verificationUri: deviceSession.verificationUri,
    expiresIn: Math.round((deviceSession.expiresAt - Date.now()) / 1000),
    opened,
    reused: false
  }
}

/** 后台轮询（不阻塞工具调用）：用户在浏览器完成授权后自动落盘令牌 */
async function pollDeviceAuth(cfg: EmailConfig): Promise<void> {
  const sess = deviceSession
  if (!sess) return
  const url = `${LOGIN_BASE}/${cfg.tenantId}/oauth2/v2.0/token`
  try {
    while (deviceSession === sess && Date.now() < sess.expiresAt) {
      await sleep(sess.intervalMs)
      if (deviceSession !== sess) return
      const res = await httpJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: cfg.clientId,
          device_code: sess.deviceCode
        }).toString(),
        timeoutMs: 20_000
      })
      if (res.status === 200 && res.json?.access_token) {
        const token = parseTokenResponse(res.json, '')
        // 先落盘，再记录附加信息 —— 任何后续动作失败都不能让一份有效令牌被丢弃
        saveToken(token)
        const { extra } = splitGrantedScopes(token.scope)
        if (extra.length) {
          // 应用注册里额外授予的权限：我们从不使用，但必须让用户/IT 看得见，而不是报错
          emailLog(`[auth] 令牌附带额外已授予权限（未使用）: ${extra.join(' ')}`)
        }
        token.account = await resolveAccount(token.accessToken).catch(() => '')
        if (token.account) saveToken(token)
        emailLog(`[auth] 授权成功 account=${maskMail(token.account)}`)
        sess.polling = false
        sess.error = undefined
        return
      }
      const err = String(res.json?.error || '')
      if (err === 'authorization_pending') continue
      if (err === 'slow_down') { sess.intervalMs += 5000; continue }
      if (err === 'authorization_declined') {
        sess.polling = false
        sess.declined = true
        sess.error = '用户拒绝了授权'
        emailLog('[auth] authorization_declined')
        return
      }
      if (err === 'expired_token') {
        sess.polling = false
        sess.error = '授权码已过期，请重新发起授权'
        emailLog('[auth] device code expired')
        return
      }
      // 其它错误（bad_verification_code / invalid_grant 等）：记一次继续，避免无限刷
      emailLog(`[auth] poll error status=${res.status} error=${err || 'unknown'}`)
      await sleep(2000)
    }
    sess.polling = false
    if (!sess.error) sess.error = '授权超时，请重新发起授权'
    emailLog('[auth] device code polling timed out')
  } catch (e: any) {
    sess.polling = false
    sess.error = e?.message || String(e)
    if (!isAbort(e)) emailLog('[auth] poll failed: ' + sess.error)
  }
}

/** 用 access token 换一次 /me，拿到账号名（仅用于展示） */
async function resolveAccount(accessToken: string): Promise<string> {
  const res = await httpJson(`${GRAPH_BASE}/me?$select=mail,userPrincipalName`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeoutMs: 15_000
  })
  if (res.status !== 200) return ''
  return String(res.json?.mail || res.json?.userPrincipalName || '')
}

/** 刷新令牌；失败抛 MAIL_AUTH_REQUIRED */
async function refreshAccessToken(cfg: EmailConfig, token: EmailToken): Promise<EmailToken> {
  if (!token.refreshToken) throw new MailAuthRequired()
  const url = `${LOGIN_BASE}/${cfg.tenantId}/oauth2/v2.0/token`
  const res = await httpJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cfg.clientId,
      refresh_token: token.refreshToken,
      scope: SCOPE_STRING
    }).toString(),
    timeoutMs: 20_000
  })
  if (res.status !== 200 || !res.json?.access_token) {
    emailLog(`[auth] refresh failed status=${res.status} error=${res.json?.error || 'unknown'}`)
    throw new MailAuthRequired()
  }
  const next = parseTokenResponse(res.json, token.account)
  // 刷新响应可能不返回新的 refresh_token，沿用旧的
  if (!next.refreshToken) next.refreshToken = token.refreshToken
  if (!next.account) next.account = token.account
  saveToken(next)
  emailLog(`[auth] token refreshed account=${maskMail(next.account)}`)
  return next
}

async function ensureAccessToken(cfg: EmailConfig, force = false): Promise<string> {
  const token = loadToken()
  if (!token) throw new MailAuthRequired()
  if (!force && token.accessToken && token.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
    return token.accessToken
  }
  const next = await refreshAccessToken(cfg, token)
  return next.accessToken
}

// ── Graph 调用 ──────────────────────────────────────────
interface GraphOpts {
  method?: string
  body?: any
  signal?: AbortSignal
  timeoutMs?: number
  /** 额外请求头，主要用来发 `Prefer: outlook.body-content-type="html"` */
  headers?: Record<string, string>
}

async function graphRequest(path: string, opts: GraphOpts = {}): Promise<any> {
  const cfg = loadConfig()
  let token = await ensureAccessToken(cfg)
  const needBody = opts.body !== undefined
  const doCall = async (at: string): Promise<HttpResult> => httpJson(`${GRAPH_BASE}${path}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${at}`,
      ...(needBody ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {})
    },
    body: needBody ? JSON.stringify(opts.body) : undefined,
    timeoutMs: opts.timeoutMs ?? 30_000,
    signal: opts.signal
  })

  let res = await doCall(token)
  if (res.status === 401) {
    token = await ensureAccessToken(cfg, true)
    res = await doCall(token)
  }
  // 限流：最多退避重试 2 次
  for (let attempt = 0; attempt < 2 && (res.status === 429 || res.status === 503); attempt++) {
    const wait = Math.min(30, 3 * (attempt + 1)) * 1000
    emailLog(`[graph] ${res.status} rate limited, retry after ${wait / 1000}s`)
    await sleep(wait, opts.signal)
    res = await doCall(token)
  }
  if (res.status >= 400) {
    const code = String(res.json?.error?.code || res.json?.error || `HTTP_${res.status}`)
    // 401 与 InvalidAuthenticationToken 都按「令牌失效」处理（前者是状态码，后者是 Graph 错误码）
    if (res.status === 401 || /InvalidAuthenticationToken|InvalidAuthentication/i.test(code)) {
      throw new MailAuthRequired()
    }
    throw new MailHttpError(res.status, code, String(res.json?.error?.message || res.text.slice(0, 300)))
  }
  return res.json
}

/** 取原始响应文本：`/messages/{id}/$value` 返回的是 MIME，不是 JSON */
async function graphRequestRaw(path: string, opts: GraphOpts = {}): Promise<string> {
  const cfg = loadConfig()
  const token = await ensureAccessToken(cfg)
  const res = await httpJson(`${GRAPH_BASE}${path}`, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    timeoutMs: opts.timeoutMs ?? 30_000,
    signal: opts.signal
  })
  if (res.status >= 400) {
    throw new MailHttpError(res.status, `HTTP_${res.status}`, res.text.slice(0, 200))
  }
  return res.text
}

/**
 * 从 MIME 原文里取 `text/html` 部分（1.0.63）。
 *
 * 为什么需要：Graph 的 `body` 可能被服务端降级成纯文本 —— 消费方只要发了
 * `Prefer: outlook.body-content-type="text"`，返回的 HTML 就被转成 text，
 * 于是「草稿里到底有没有 `<p>` 段落」这件事在 JSON 里根本看不出来。
 * 拿 MIME（`/$value`）解出真正的 text/html 才能做可靠校验。
 */
function extractMimeHtml(mime: string): string {
  const src = String(mime || '')
  if (!src) return ''
  // 按分隔行 `--boundary` 切段，找第一个 text/html
  const chunks = src.split(/\r?\n--[^\r\n]+/)
  for (const chunk of chunks) {
    const sep = chunk.search(/\r?\n\r?\n/)
    if (sep < 0) continue
    const head = chunk.slice(0, sep).toLowerCase()
    if (!/content-type:\s*text\/html/.test(head)) continue
    let body = chunk.slice(sep).replace(/^\r?\n\r?\n/, '')
    if (/content-transfer-encoding:\s*base64/.test(head)) {
      try { return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8') } catch { return '' }
    }
    if (/content-transfer-encoding:\s*quoted-printable/.test(head)) {
      body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    }
    return body
  }
  return ''
}

// ── 工具函数 ────────────────────────────────────────────
function clampInt(v: any, def: number, min: number, max: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

function formatDateTime(iso: string, timeZone: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso || '')
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timeZone || 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(d)
  } catch {
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  }
}

/** HTML → 纯文本（Graph 返回的正文几乎都是 HTML，模型不需要标签噪音） */
function htmlToText(html: string): string {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function parseRecipients(input: any): Array<{ address: string; name?: string }> {
  const raw = Array.isArray(input) ? input : (input ? [input] : [])
  const out: Array<{ address: string; name?: string }> = []
  for (const item of raw) {
    if (!item) continue
    if (typeof item === 'object' && item.address) {
      out.push({ address: String(item.address), name: item.name ? String(item.name) : undefined })
      continue
    }
    const s = String(item).trim()
    if (!s) continue
    const m = /^(.*?)\s*<([^>]+)>$/.exec(s)
    if (m) out.push({ address: m[2].trim(), name: m[1].trim() || undefined })
    else if (/^[^@\s]+@[^@\s]+$/.test(s)) out.push({ address: s })
  }
  // 去重
  const seen = new Set<string>()
  return out.filter(r => {
    const k = r.address.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function toGraphRecipients(list: Array<{ address: string; name?: string }>): any[] {
  return list.map(r => ({ emailAddress: { address: r.address, ...(r.name ? { name: r.name } : {}) } }))
}

function fromGraphRecipient(r: any): { name: string; address: string } {
  return {
    name: String(r?.emailAddress?.name || ''),
    address: String(r?.emailAddress?.address || '')
  }
}

function stripRePrefix(subject: string): string {
  return String(subject || '').replace(/^\s*(?:(?:re|fw|fwd|答复|回复)\s*[:：]\s*)+/i, '').trim()
}

// ── 工具：mail_auth ─────────────────────────────────────
export interface MailAuthResult {
  [k: string]: any
}

async function runMailAuth(input: any): Promise<MailAuthResult> {
  const cfg = loadConfig()
  const action = String(input?.action || 'status')

  if (action === 'logout') {
    clearToken()
    deviceSession = null
    emailLog('[auth] logout')
    return { ok: true, action, authorized: false, message: '已清除本机保存的邮箱授权' }
  }

  if (action === 'start') {
    // 已经有有效令牌时不再发新设备码：避免「明明授权过却又被要求授权一次」
    const cur = loadToken()
    if (cur?.accessToken && cur.expiresAt > Date.now()) {
      return {
        ok: true,
        action,
        authorized: true,
        pending: false,
        account: maskMail(cur.account),
        message: '邮箱已授权，无需重新授权，可直接检索邮件'
      }
    }
    const r = await startDeviceAuth(cfg)
    // 回复模板刻意用纯文本、一行一个信息：模型直接照抄即可。
    // 1.0.61 的教训 —— 模板里带 `**加粗**` 又夹着链接/验证码时，模型容易再套一层
    // 强调标记，最终成对的 `**` 变成奇数个，CommonMark 按字面量渲染，
    // 回复里就出现「**…：**ABCD-EFGH**，…」这种糊成一团的样子（用户已截图反馈）。
    const replyTemplate = [
      `邮箱还没授权，需要你在浏览器里确认一次（${r.opened ? '浏览器已自动打开' : '请手动打开下面的地址'}）。`,
      '',
      `授权地址：${r.verificationUri}`,
      `验证码：${r.userCode}`,
      '',
      '在页面里粘贴验证码，用 Streamax 工作账号登录并同意授权。',
      '完成后回我一句「已授权」，我立刻核实并开始拉取邮件。'
    ].join('\n')
    return {
      ok: true,
      action,
      authorized: false,
      pending: true,
      userCode: r.userCode,
      verificationUri: r.verificationUri,
      expiresInSeconds: r.expiresIn,
      browserOpened: r.opened,
      reused: r.reused,
      // instruction 为纯文本（无 markdown 强调符号），SKILL.md 要求原样转述
      instruction: replyTemplate,
      replyTemplate,
      // 等价于 ms-365-mcp-server 的 `--list-permissions` 预检：把「本次实际申请的权限」
      // 明确摆出来，只有一个委托 Mail.ReadWrite（+ offline_access 用于续期）。
      // 多一个 scope 就可能触发管理员同意，所以这里是必看项，不是装饰。
      requestedScopes: SCOPE_STRING.split(' '),
      note: '验证码约 15 分钟内有效，过期需重新发起。不要把密码发回聊天里。'
    }
  }

  // status（默认）
  const token = loadToken()
  const authorized = !!token?.accessToken && token.expiresAt > Date.now() - 60_000
  const pending = !!deviceSession?.polling
  const { granted, extra } = splitGrantedScopes(token?.scope || '')
  return {
    ok: true,
    action: 'status',
    authorized,
    pending: !authorized && pending,
    account: token?.account ? maskMail(token.account) : undefined,
    tokenExpiresAt: token?.expiresAt ? new Date(token.expiresAt).toISOString() : undefined,
    userCode: !authorized && pending ? deviceSession?.userCode : undefined,
    verificationUri: !authorized && pending ? deviceSession?.verificationUri : undefined,
    // 只在「本次授权流程失败」时给 error，成功即清空
    error: authorized ? undefined : deviceSession?.error,
    requestedScopes: SCOPE_STRING.split(' '),
    grantedScopes: granted,
    // 应用注册里额外授予、但本工具从不使用的权限 —— 仅供知情，不构成失败原因
    extraGrantedScopes: extra.length ? extra : undefined,
    config: {
      tenantId: cfg.tenantId,
      clientId: cfg.clientId,
      displayTimezone: cfg.displayTimezone
    },
    message: authorized
      ? '邮箱已授权，可直接检索邮件'
      : (pending ? '授权尚未完成，请先在浏览器里粘贴验证码并同意' : '尚未授权邮箱，需要先执行 mail_auth action=start')
  }
}

// ── 工具：mail_config ───────────────────────────────────
async function runMailConfig(input: any): Promise<any> {
  const set = input?.set && typeof input.set === 'object' ? input.set : null
  if (set) {
    // 只允许 SKILL.md 里列出的键，避免模型把任意字段写进配置
    const allowed = Object.keys(DEFAULT_CONFIG)
    const clean: Record<string, any> = {}
    for (const [k, v] of Object.entries(set)) {
      if (allowed.includes(k)) clean[k] = v
    }
    const next = saveConfig(clean)
    return {
      ok: true,
      updated: Object.keys(clean),
      ignored: Object.keys(set).filter(k => !allowed.includes(k)),
      config: configView(next)
    }
  }
  return { ok: true, config: configView(loadConfig()) }
}

// ── 工具：mail_search ───────────────────────────────────
async function runMailSearch(input: any, signal?: AbortSignal): Promise<any> {
  const cfg = loadConfig()
  const days = clampInt(input?.days, cfg.defaultDays, 0, 365)
  const count = clampInt(input?.count, cfg.defaultCount, 1, 50)
  const skip = clampInt(input?.skip, 0, 0, 200)
  const unreadOnly = input?.unreadOnly === true
  const keyword = String(input?.keyword || '').trim()
  const fromFilter = String(input?.from || '').trim().toLowerCase()

  const params = new URLSearchParams()
  params.set('$select', 'id,subject,from,receivedDateTime,isRead,hasAttachments,bodyPreview,conversationId,webLink')
  // 不用 $skip：它与 $search 组合时行为不稳定。改为多取 skip+count+1 条后本地切片，
  // 既保证 hasMore 判定，也保证翻页在关键字模式下同样可用（Graph 单页上限 250 足够）。
  const requestTop = Math.min(count + 1 + skip, 250)
  params.set('$top', String(requestTop))

  const sinceIso = days > 0 ? new Date(Date.now() - days * 86400_000).toISOString() : ''

  if (keyword) {
    // Graph 限制：$search 不能与 $filter / $orderby 同时使用 → 时间与未读改在本地过滤
    params.set('$search', `"${keyword.replace(/"/g, '')}"`)
  } else {
    params.set('$orderby', 'receivedDateTime desc')
    const filters: string[] = []
    if (sinceIso) filters.push(`receivedDateTime ge ${sinceIso}`)
    if (unreadOnly) filters.push('isRead eq false')
    if (filters.length) params.set('$filter', filters.join(' and '))
  }

  const json = await graphRequest(`/me/messages?${params.toString()}`, { signal })
  let value: any[] = Array.isArray(json?.value) ? json.value : []

  if (keyword) {
    const since = days > 0 ? Date.now() - days * 86400_000 : 0
    value = value
      .filter(m => !since || new Date(m.receivedDateTime).getTime() >= since)
      .filter(m => !unreadOnly || m.isRead === false)
  }
  if (fromFilter) {
    value = value.filter(m => {
      const f = fromGraphRecipient(m.from)
      return `${f.name} ${f.address}`.toLowerCase().includes(fromFilter)
    })
  }

  // 本地切片：先跳 skip，再取 count，多出来的那一条用来判 hasMore
  const afterSkip = skip > 0 ? value.slice(skip) : value
  const hasMore = afterSkip.length > count
  const page = afterSkip.slice(0, count)
  emailLog(`[search] days=${days} count=${count} skip=${skip} kw=${keyword ? 'yes' : 'no'} -> ${page.length}${hasMore ? '+' : ''}`)

  return {
    ok: true,
    total: page.length,
    hasMore,
    skip,
    nextSkip: hasMore ? skip + page.length : undefined,
    timezone: cfg.displayTimezone,
    range: days > 0 ? `最近 ${days} 天` : '不限时间',
    items: page.map(m => {
      const f = fromGraphRecipient(m.from)
      return {
        id: m.id,
        subject: String(m.subject || '(无主题)'),
        from: f.name ? `${f.name} <${f.address}>` : f.address,
        receivedAt: formatDateTime(m.receivedDateTime, cfg.displayTimezone),
        isRead: m.isRead !== false,
        hasAttachments: m.hasAttachments === true,
        preview: String(m.bodyPreview || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        webLink: m.webLink
      }
    })
  }
}

// ── 工具：mail_read ─────────────────────────────────────
async function runMailRead(input: any, signal?: AbortSignal): Promise<any> {
  const cfg = loadConfig()
  const id = String(input?.id || '').trim()
  if (!id) return { ok: false, error: 'MISSING_ID', message: '需要传邮件 id（来自 mail_search 的 items[].id）' }
  const maxChars = clampInt(input?.maxChars, 6000, 500, 20000)

  const json = await graphRequest(
    `/me/messages/${encodeURIComponent(id)}` +
    '?$select=subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,internetMessageId,conversationId,webLink',
    // 显式要 HTML：否则服务端可能直接给纯文本，段落结构在读的时候就丢了
    { signal, headers: { Prefer: 'outlook.body-content-type="html"' } }
  )

  const rawBody = String(json?.body?.content || '')
  const isHtml = String(json?.body?.contentType || '').toLowerCase() === 'html'
  const text = isHtml ? htmlToText(rawBody) : rawBody.replace(/\r\n/g, '\n').trim()
  const truncated = text.length > maxChars

  let attachments: Array<{ name: string; size: number; contentType: string }> = []
  if (json?.hasAttachments) {
    try {
      const att = await graphRequest(`/me/messages/${encodeURIComponent(id)}/attachments?$select=name,size,contentType`, { signal })
      attachments = (att?.value || []).map((a: any) => ({
        name: String(a.name || ''),
        size: Number(a.size) || 0,
        contentType: String(a.contentType || '')
      }))
    } catch (e: any) {
      emailLog('[read] 附件列表获取失败：' + (e?.message || e))
    }
  }

  const f = fromGraphRecipient(json?.from)
  emailLog(`[read] id=${String(id).slice(0, 12)}… chars=${text.length}${truncated ? ' (truncated)' : ''} att=${attachments.length}`)

  return {
    ok: true,
    id,
    subject: String(json?.subject || '(无主题)'),
    from: f.name ? `${f.name} <${f.address}>` : f.address,
    to: (json?.toRecipients || []).map(fromGraphRecipient),
    cc: (json?.ccRecipients || []).map(fromGraphRecipient),
    receivedAt: formatDateTime(json?.receivedDateTime, cfg.displayTimezone),
    body: truncated ? text.slice(0, maxChars) : text,
    bodyChars: text.length,
    truncated,
    attachments,
    internetMessageId: json?.internetMessageId,
    conversationId: json?.conversationId,
    webLink: json?.webLink,
    ...(truncated ? { note: `正文共 ${text.length} 字符，已截断；需要更多请用 maxChars 重读` } : {})
  }
}

// ── 工具：mail_draft_save ───────────────────────────────
interface DraftStep {
  stage: string
  ok: boolean
  detail?: string
}

/** 钉钉技服智能体（可选回退）：把"邮件内容 + 回复要求"交给它写正文 */
async function composeWithDingtalk(cfg: EmailConfig, query: string, signal?: AbortSignal): Promise<string> {
  if (!cfg.dingtalkAccessToken) {
    throw new Error('draftMode=dingtalk 但未配置 dingtalkAccessToken，请先用 mail_config 设置，或改用 local 模式')
  }
  const res = await httpJson(DINGTALK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.dingtalkAccessToken}`
    },
    body: JSON.stringify({
      assistant_id: cfg.dingtalkAssistantId,
      union_id: cfg.dingtalkUnionId,
      input: query
    }),
    timeoutMs: 120_000,
    signal
  })
  if (res.status !== 200) {
    throw new MailHttpError(res.status, 'DINGTALK_FAILED', `钉钉智能体返回 ${res.status}：${res.text.slice(0, 200)}`)
  }
  const text = res.json?.output?.[0]?.content?.[0]?.text
  if (!text || !String(text).trim()) throw new Error('钉钉智能体返回空内容')
  return String(text).trim()
}

async function runMailDraftSave(input: any, signal?: AbortSignal): Promise<any> {
  const cfg = loadConfig()
  const steps: DraftStep[] = []
  const replyToId = String(input?.replyToId || '').trim()
  if (!replyToId) {
    return { ok: false, error: 'MISSING_REPLY_TO', message: '需要传 replyToId（要回复的那封邮件的 id）' }
  }

  // 1) 取原邮件（收件人、主题、线程头、引用正文都来自它）
  const original = await graphRequest(
    `/me/messages/${encodeURIComponent(replyToId)}` +
    '?$select=subject,from,toRecipients,ccRecipients,receivedDateTime,body,internetMessageId',
    { signal }
  )
  steps.push({ stage: 'fetch_original', ok: true })

  const originalFrom = fromGraphRecipient(original?.from)
  const originalText = String(original?.body?.contentType || '').toLowerCase() === 'html'
    ? htmlToText(original?.body?.content)
    : String(original?.body?.content || '').replace(/\r\n/g, '\n').trim()

  // 2) 正文来源：模型直写 / 钉钉智能体
  let bodyText = String(input?.body || '').trim()
  const useDingtalk = input?.useDingtalk === true || (cfg.draftMode === 'dingtalk' && input?.useDingtalk !== false)
  if (useDingtalk && !bodyText) {
    const query = [
      '请为下面这封客户邮件撰写一封专业回复的正文（英文，含称呼与落款，要点逐条独占一行，段落之间空行）：',
      `主题：${String(original?.subject || '')}`,
      `发件人：${originalFrom.name} <${originalFrom.address}>`,
      '正文：',
      originalText.slice(0, 4000)
    ].join('\n')
    bodyText = await composeWithDingtalk(cfg, query, signal)
    steps.push({ stage: 'compose_dingtalk', ok: true })
  }
  if (!bodyText) {
    return { ok: false, error: 'MISSING_BODY', message: '需要传 body（回复正文纯文本）；只有 draftMode=dingtalk 时才可以省略' }
  }

  // 3) 结构规范化 + 校验（解决"一整段纯文本"）
  const normalized = normalizeReplyBody(bodyText, { signature: cfg.signature })
  const hardFail = normalized.warnings.includes('WALL_OF_TEXT') ||
    (normalized.paragraphs < 2 && normalized.body.length > 400)
  if (hardFail && input?.dryRun !== true) {
    emailLog(`[draft] refused: format check failed warnings=${normalized.warnings.join(',')}`)
    return {
      ok: false,
      error: 'FORMAT_CHECK_FAILED',
      warnings: normalized.warnings,
      paragraphs: normalized.paragraphs,
      normalizedBody: normalized.body,
      message: '正文结构不合格（整段粘连）。请按 warnings 改写：要点逐条独占一行、段落之间空行、落款单独一行，然后重新调用。'
    }
  }
  steps.push({ stage: 'normalize', ok: true, detail: normalized.warnings.join(',') || 'ok' })

  // 4) 引用原文
  let finalBody = normalized.body
  const includeQuote = input?.includeQuote !== false
  if (includeQuote && originalText) {
    finalBody += '\n\n' + toQuotedBlock(originalText)
  }

  const htmlResult = toHtml(finalBody)
  const subject = `Re: ${stripRePrefix(String(input?.subject || original?.subject || ''))}`

  const toList = parseRecipients(input?.to)
  const toRecipients = toList.length
    ? toList
    : (originalFrom.address ? [{ address: originalFrom.address, name: originalFrom.name }] : [])
  if (!toRecipients.length) {
    return { ok: false, error: 'NO_RECIPIENT', message: '原邮件没有可用发件人地址，请用 to 显式指定收件人' }
  }
  const ccRecipients = parseRecipients(input?.cc)

  if (input?.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      subject,
      to: toRecipients.map(r => r.address),
      cc: ccRecipients.map(r => r.address),
      paragraphs: htmlResult.paragraphs,
      quotedBlocks: htmlResult.quotedBlocks,
      warnings: normalized.warnings,
      formatOk: normalized.warnings.length === 0,
      preview: previewBody(normalized.body),
      htmlPreview: htmlResult.html.slice(0, 1200)
    }
  }

  // 5) 投递（先带线程头；该租户会 400 UnableToDeserializePostBody → 去掉重投）
  const threadHeaders = original?.internetMessageId
    ? { inReplyTo: String(original.internetMessageId), references: [String(original.internetMessageId)] }
    : {}
  const payload: any = {
    subject,
    body: { contentType: 'html', content: htmlResult.html },
    toRecipients: toGraphRecipients(toRecipients),
    ...(ccRecipients.length ? { ccRecipients: toGraphRecipients(ccRecipients) } : {}),
    ...threadHeaders
  }

  let created: any = null
  try {
    created = await graphRequest('/me/messages', { method: 'POST', body: payload, signal })
    steps.push({ stage: 'create_with_thread_headers', ok: true })
  } catch (e: any) {
    const msg = String(e?.message || '')
    const isDeserialize = /UnableToDeserializePostBody|Unable to deserialize/i.test(msg) || e?.code === 'UnableToDeserializePostBody'
    if (!isDeserialize) throw e
    // 去掉线程头重投：代价是丢线程关联，但草稿能落地（主题仍带 Re:）
    const { inReplyTo: _i, references: _r, ...fallback } = payload
    created = await graphRequest('/me/messages', { method: 'POST', body: fallback, signal })
    steps.push({
      stage: 'create_without_thread_headers',
      ok: true,
      detail: '租户拒绝 inReplyTo/references，已去掉重投（线程关联丢失）'
    })
  }

  const draftId = String(created?.id || '')
  if (!draftId) {
    return { ok: false, error: 'NO_DRAFT_ID', message: 'Graph 未返回草稿 id，请重试', steps }
  }

  // 6) 回读校验：段落数、引用块、收件人 —— 只看"投递成功"是不够的。
  //
  //    1.0.63：回读显式要求 HTML（`Prefer: outlook.body-content-type="html"`）。
  //    原因见 docs：服务端只要带了 Prefer=text，就会把 body 转成纯文本，
  //    于是草稿里明明有 <p>/<blockquote> 也统计成 0，校验结论完全是假的。
  //    万一仍被降级成 text，则退到 MIME（`/$value`）里解析真正的 text/html 部分。
  let verified: {
    paragraphs: number; quotedBlocks: number; subject: string; to: string[]; source?: 'json' | 'mime'
  } | null = null
  try {
    const check = await graphRequest(
      `/me/messages/${encodeURIComponent(draftId)}?$select=subject,body,toRecipients`,
      { signal, headers: { Prefer: 'outlook.body-content-type="html"' } }
    )
    let htmlBody = String(check?.body?.content || '')
    let source: 'json' | 'mime' = 'json'
    const isHtml = String(check?.body?.contentType || '').toLowerCase() === 'html'
    if (!isHtml) {
      try {
        const mime = await graphRequestRaw(`/me/messages/${encodeURIComponent(draftId)}/$value`, { signal })
        const fromMime = extractMimeHtml(mime)
        if (fromMime) { htmlBody = fromMime; source = 'mime' }
      } catch (e: any) {
        emailLog('[draft] MIME 回读失败（继续用 JSON body 校验）：' + (e?.message || e))
      }
    }
    const struc = countHtmlStructure(htmlBody)
    verified = {
      paragraphs: struc.paragraphs,
      quotedBlocks: struc.quotedBlocks,
      subject: String(check?.subject || ''),
      to: (check?.toRecipients || []).map((r: any) => fromGraphRecipient(r).address),
      source
    }
    if (!isHtml && source === 'json') {
      // 两端都没拿到 HTML：不下"结构不对"的结论，只把事实回报给上层
      emailLog('[draft] 回读 body 为纯文本且 MIME 无 text/html，结构校验降级为不可判定')
    }
    steps.push({ stage: 'verify_readback', ok: true, detail: `via ${source}` })
  } catch (e: any) {
    steps.push({ stage: 'verify_readback', ok: false, detail: e?.message || String(e) })
  }

  const paragraphsOk = !verified || verified.paragraphs >= htmlResult.paragraphs
  const quoteOk = !includeQuote || !verified || verified.quotedBlocks >= 1
  const formatOk = paragraphsOk && quoteOk && normalized.warnings.length === 0
  emailLog(`[draft] created id=${draftId.slice(0, 12)}… paragraphs=${htmlResult.paragraphs}/${verified?.paragraphs ?? '-'} quote=${verified?.quotedBlocks ?? '-'} warnings=${normalized.warnings.join(',') || 'none'}`)

  return {
    ok: true,
    draftId,
    webLink: created?.webLink,
    subject,
    to: toRecipients.map(r => r.address),
    cc: ccRecipients.map(r => r.address),
    paragraphs: htmlResult.paragraphs,
    quotedBlocks: htmlResult.quotedBlocks,
    verified,
    formatOk,
    warnings: normalized.warnings,
    preview: previewBody(normalized.body),
    steps,
    message: formatOk
      ? '已写入 Outlook 草稿箱（未发送）。请在 Outlook 里人工审核后再发送。'
      : '草稿已写入，但回读校验发现结构可能与预期不符，请让用户在 Outlook 草稿箱确认后再发送。'
  }
}

// ── 工具：mail_drafts_list ──────────────────────────────
async function runMailDraftsList(input: any, signal?: AbortSignal): Promise<any> {
  const cfg = loadConfig()
  const count = clampInt(input?.count, 5, 1, 20)
  const json = await graphRequest(
    `/me/mailFolders/drafts/messages?$select=id,subject,receivedDateTime,toRecipients,bodyPreview&$top=${count}`,
    { signal }
  )
  const items = (json?.value || []).map((m: any) => ({
    id: m.id,
    subject: String(m.subject || '(无主题)'),
    savedAt: formatDateTime(m.receivedDateTime, cfg.displayTimezone),
    to: (m.toRecipients || []).map((r: any) => fromGraphRecipient(r).address),
    preview: String(m.bodyPreview || '').replace(/\s+/g, ' ').trim().slice(0, 160)
  }))
  return { ok: true, total: items.length, items }
}

// ── 工具定义（下发给模型）────────────────────────────────
const RECIPIENT_SCHEMA = {
  oneOf: [
    { type: 'string', description: '邮箱地址，或 "张三 <a@b.com>" 形式' },
    { type: 'array', items: { type: 'string' }, description: '多个收件人' }
  ]
}

export const MAIL_AUTH_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'mail_auth',
    description:
      '查看/发起 Outlook 邮箱授权（Device Code）。action=status 查看是否已授权（含 grantedScopes，' +
      '额外的已授予权限不影响使用）；action=start 申请验证码并自动打开浏览器授权页，返回 ' +
      'userCode/verificationUri 与 replyTemplate（请直接输出 replyTemplate 原文，不要加粗或用反引号）；' +
      'action=logout 清除本机令牌。已授权时 start 不会再要求重复授权。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'start', 'logout'], description: '默认 status' }
      }
    }
  }
}

export const MAIL_CONFIG_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'mail_config',
    description:
      '读取或局部修改邮箱助手配置（显示时区、默认检索条数、草稿来源 draftMode、钉钉令牌、签名）。' +
      '不传 set 即读取。',
    parameters: {
      type: 'object',
      properties: {
        set: {
          type: 'object',
          description: '要覆盖的键值，仅支持 displayTimezone/defaultDays/defaultCount/draftMode/dingtalkAccessToken/signature'
        }
      }
    }
  }
}

export const MAIL_SEARCH_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'mail_search',
    description:
      '按时间/未读/关键字/发件人检索 Outlook 邮箱，返回邮件清单（含 id、主题、发件人、时间、是否未读、摘要）。' +
      '只返回清单不返回正文；需要正文再用 mail_read。',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '最近多少天，0 表示不限；默认取配置（7）' },
        count: { type: 'number', description: '返回条数，1-50，默认 20' },
        skip: { type: 'number', description: '翻页偏移，配合 hasMore/nextSkip 使用' },
        unreadOnly: { type: 'boolean', description: '只看未读' },
        keyword: { type: 'string', description: '关键字（主题/正文/发件人模糊匹配）' },
        from: { type: 'string', description: '发件人包含的字符串（姓名或地址）' }
      }
    }
  }
}

export const MAIL_READ_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'mail_read',
    description: '读取单封邮件：正文（已去 HTML 标签）、收发件人、时间、附件名与大小。id 来自 mail_search。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '邮件 id' },
        maxChars: { type: 'number', description: '正文最大字符数，默认 6000' }
      },
      required: ['id']
    }
  }
}

export const MAIL_DRAFT_SAVE_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'mail_draft_save',
    description:
      '把回复写入 Outlook **草稿箱**（绝不发送）。会做结构校验与 HTML 段落化：正文必须分段、要点逐条独占一行，' +
      '否则返回 FORMAT_CHECK_FAILED 并要求改写。可用 dryRun 先自检。',
    parameters: {
      type: 'object',
      properties: {
        replyToId: { type: 'string', description: '要回复的邮件 id（来自 mail_search）' },
        body: { type: 'string', description: '回复正文纯文本（含称呼与落款，段落之间空行）' },
        to: RECIPIENT_SCHEMA as any,
        cc: RECIPIENT_SCHEMA as any,
        subject: { type: 'string', description: '可选，默认 Re: 原主题' },
        includeQuote: { type: 'boolean', description: '是否附上原邮件引用，默认 true' },
        dryRun: { type: 'boolean', description: '只做排版自检，不写草稿' },
        useDingtalk: { type: 'boolean', description: '改用钉钉技服智能体生成正文（需先配置令牌）' }
      },
      required: ['replyToId']
    }
  }
}

export const MAIL_DRAFTS_LIST_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'mail_drafts_list',
    description: '列出 Outlook 草稿箱最近几封草稿（用于回读核对是否写对）。',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: '条数，1-20，默认 5' }
      }
    }
  }
}

/** 供 toolRegistry 直接注册的 map */
export const MAIL_TOOL_ENTRIES: Record<string, { definition: any; run: (input: any, ctx: any) => Promise<any> }> = {
  mail_auth: { definition: MAIL_AUTH_TOOL_DEFINITION, run: (input) => runMailAuth(input) },
  mail_config: { definition: MAIL_CONFIG_TOOL_DEFINITION, run: (input) => runMailConfig(input) },
  mail_search: { definition: MAIL_SEARCH_TOOL_DEFINITION, run: (input, ctx) => runMailSearch(input, ctx?.signal) },
  mail_read: { definition: MAIL_READ_TOOL_DEFINITION, run: (input, ctx) => runMailRead(input, ctx?.signal) },
  mail_draft_save: { definition: MAIL_DRAFT_SAVE_TOOL_DEFINITION, run: (input, ctx) => runMailDraftSave(input, ctx?.signal) },
  mail_drafts_list: { definition: MAIL_DRAFTS_LIST_TOOL_DEFINITION, run: (input, ctx) => runMailDraftsList(input, ctx?.signal) }
}
