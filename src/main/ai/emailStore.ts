/**
 * Outlook 工作邮箱助手 · 本地存储层（1.0.61）
 *
 * 为什么单独一层：内置技能目录在安装后被放在 `resources/skills/`（Program Files 内），
 * **只读**，而 OAuth 令牌、配置、日志都需要可写 —— 统一落在 `userData/email-auto/` 下，
 * 与 `mcpClient.prepareWritableRuntime` 把技能拷到 userData 的思路一致。
 *
 * 敏感数据（access/refresh token、钉钉访问令牌）用 `safeStorage` 加密后再落盘；
 * 加密不可用（少数 Linux/无 keyring 环境）时退化为明文并**在日志里明确告警**，
 * 绝不静默降级。
 */
import { app, safeStorage } from 'electron'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync
} from 'fs'
import { join } from 'path'

/** 技能 id（目录名）—— 工具绑定、日志前缀都用它 */
export const EMAIL_SKILL_ID = 'email-auto'

/** 租户内已预置的公开客户端（Device Code，无需 client secret） */
const BUILTIN_CLIENT_ID = '0c476cb4-f74e-430c-a0ab-194ccc6513be'
const BUILTIN_TENANT_ID = '4ffefe45-ab8c-4b8e-91cf-3da057bf1914'

export interface EmailConfig {
  clientId: string
  tenantId: string
  /** 报告里展示时间的 IANA 时区（内部筛选恒按 UTC） */
  displayTimezone: string
  /** mail_search 未传 days 时的默认值 */
  defaultDays: number
  /** mail_search 未传 count 时的默认条数 */
  defaultCount: number
  /** local=用当前对话模型写正文；dingtalk=调用钉钉技服智能体 */
  draftMode: 'local' | 'dingtalk'
  dingtalkAccessToken: string
  dingtalkAssistantId: string
  dingtalkUnionId: string
  /** 落款签名（两行，\n 分隔） */
  signature: string
}

export const DEFAULT_CONFIG: EmailConfig = {
  clientId: BUILTIN_CLIENT_ID,
  tenantId: BUILTIN_TENANT_ID,
  // 面向国内同事：默认按北京时间展示；海外客户往来可按需改 IANA 名称
  displayTimezone: 'Asia/Shanghai',
  defaultDays: 7,
  defaultCount: 20,
  draftMode: 'local',
  dingtalkAccessToken: '',
  // 团队内部固定值（与源技能一致），一般不用改
  dingtalkAssistantId: '6ecae008-5346-49ad-a94d-68b04d3418e3',
  dingtalkUnionId: 'J7pEygMOPquc6HGKBCh4vgiEiE',
  signature: 'Sean Mao\nTechnical Support Engineer | Streamax Technology'
}

export interface EmailToken {
  accessToken: string
  refreshToken: string
  scope: string
  /** epoch ms；过期前 5 分钟即视为需要刷新 */
  expiresAt: number
  /** 授权账号（upn / mail），仅用于展示 */
  account: string
}

function dataDir(): string {
  return join(app.getPath('userData'), 'email-auto')
}
function configPath(): string {
  return join(dataDir(), 'config.json')
}
function tokenPath(): string {
  return join(dataDir(), 'token.json')
}

function ensureDir(): void {
  try { mkdirSync(dataDir(), { recursive: true }) } catch { /* 已存在 */ }
}

// ── 日志（超 2MB 滚动一份备份；只记元信息，不记正文）──────────────
const LOG_MAX_BYTES = 2 * 1024 * 1024
let logRotateDay = ''

function rotateLog(path: string): void {
  const day = new Date().toISOString().slice(0, 10)
  if (day === logRotateDay) return
  logRotateDay = day
  try {
    if (!existsSync(path) || statSync(path).size < LOG_MAX_BYTES) return
    const bak = path + '.1'
    if (existsSync(bak)) unlinkSync(bak)
    renameSync(path, bak)
  } catch { /* ignore */ }
}

export function emailLog(msg: string): void {
  ensureDir()
  const path = join(dataDir(), 'email.log')
  rotateLog(path)
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { appendFileSync(path, line) } catch { /* ignore */ }
  console.log('[email] ' + msg)
}

/** 日志脱敏：邮箱只留首字母与域名，令牌只留长度 */
export function maskMail(addr: string): string {
  const [name, domain] = String(addr || '').split('@')
  if (!domain) return addr ? String(addr).slice(0, 3) + '***' : ''
  return `${name.slice(0, 2)}***@${domain}`
}
export function maskSecret(v: string): string {
  if (!v) return '(空)'
  return `已配置(${v.length} 字符)`
}

// ── 加解密 ──────────────────────────────────────────────
const ENC_PREFIX = 'enc:'
const PLAIN_PREFIX = 'plain:'
let warnedPlaintext = false

function encryptString(plain: string): string {
  if (!plain) return ''
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
    }
  } catch { /* 落到明文分支 */ }
  if (!warnedPlaintext) {
    warnedPlaintext = true
    emailLog('[store] WARN safeStorage 不可用，敏感字段将以明文保存（仅本机用户目录可读）')
  }
  return PLAIN_PREFIX + plain
}

function decryptString(stored: string): string {
  const s = String(stored || '')
  if (!s) return ''
  if (s.startsWith(ENC_PREFIX)) {
    try {
      return safeStorage.decryptString(Buffer.from(s.slice(ENC_PREFIX.length), 'base64'))
    } catch (e: any) {
      emailLog('[store] 解密失败（可能换了机器/用户）：' + (e?.message || e))
      return ''
    }
  }
  if (s.startsWith(PLAIN_PREFIX)) return s.slice(PLAIN_PREFIX.length)
  // 兼容手写明文
  return s
}

function writeJsonAtomic(path: string, obj: any): void {
  ensureDir()
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  renameSync(tmp, path)
}

// ── 配置 ────────────────────────────────────────────────
/**
 * 读配置。文件不存在时返回内置默认值（不落盘，等第一次 set 再写）。
 * `dingtalkAccessToken` 在内存里是明文，落盘时由 saveConfig 加密。
 */
export function loadConfig(): EmailConfig {
  try {
    if (!existsSync(configPath())) return { ...DEFAULT_CONFIG }
    const raw = JSON.parse(readFileSync(configPath(), 'utf8')) || {}
    const cfg: EmailConfig = { ...DEFAULT_CONFIG, ...raw }
    cfg.dingtalkAccessToken = decryptString(raw.dingtalkAccessToken)
    // 兜底：文件里若被写成非法值，回到默认，避免下游 switch 走空
    if (cfg.draftMode !== 'dingtalk') cfg.draftMode = 'local'
    if (!Number.isFinite(cfg.defaultDays) || cfg.defaultDays < 0) cfg.defaultDays = DEFAULT_CONFIG.defaultDays
    if (!Number.isFinite(cfg.defaultCount) || cfg.defaultCount <= 0) cfg.defaultCount = DEFAULT_CONFIG.defaultCount
    return cfg
  } catch (e: any) {
    emailLog('[store] 读配置失败，使用默认值：' + (e?.message || e))
    return { ...DEFAULT_CONFIG }
  }
}

/** 局部覆盖保存；返回保存后的完整配置（令牌仍为明文，只给内部用） */
export function saveConfig(patch: Partial<EmailConfig>): EmailConfig {
  const cur = loadConfig()
  const next: EmailConfig = { ...cur }
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined || v === null) continue
    if (k === 'defaultDays' || k === 'defaultCount') {
      const n = Number(v)
      if (Number.isFinite(n)) (next as any)[k] = k === 'defaultDays' ? Math.max(0, n) : Math.max(1, Math.min(50, n))
      continue
    }
    if (k === 'draftMode') {
      next.draftMode = v === 'dingtalk' ? 'dingtalk' : 'local'
      continue
    }
    if (k in DEFAULT_CONFIG) (next as any)[k] = String(v)
  }
  const onDisk = { ...next, dingtalkAccessToken: encryptString(next.dingtalkAccessToken) }
  writeJsonAtomic(configPath(), onDisk)
  emailLog(`[store] 配置已更新: ${Object.keys(patch || {}).join(',') || '(none)'}`)
  return next
}

/** 给工具/UI 的脱敏视图：令牌只回"是否已配置" */
export function configView(cfg: EmailConfig): Record<string, any> {
  return {
    ...cfg,
    dingtalkAccessToken: cfg.dingtalkAccessToken ? maskSecret(cfg.dingtalkAccessToken) : '(未配置)',
    dingtalkAccessTokenConfigured: !!cfg.dingtalkAccessToken
  }
}

// ── 令牌 ────────────────────────────────────────────────
export function loadToken(): EmailToken | null {
  try {
    if (!existsSync(tokenPath())) return null
    const raw = JSON.parse(readFileSync(tokenPath(), 'utf8')) || {}
    const accessToken = decryptString(raw.accessToken)
    const refreshToken = decryptString(raw.refreshToken)
    if (!accessToken && !refreshToken) return null
    return {
      accessToken,
      refreshToken,
      scope: String(raw.scope || ''),
      expiresAt: Number(raw.expiresAt) || 0,
      account: String(raw.account || '')
    }
  } catch (e: any) {
    emailLog('[store] 读令牌失败：' + (e?.message || e))
    return null
  }
}

export function saveToken(t: EmailToken): void {
  writeJsonAtomic(tokenPath(), {
    v: 1,
    accessToken: encryptString(t.accessToken),
    refreshToken: encryptString(t.refreshToken),
    scope: t.scope,
    expiresAt: t.expiresAt,
    account: t.account
  })
  emailLog(`[store] 令牌已保存 account=${maskMail(t.account)} expires=${new Date(t.expiresAt).toISOString()}`)
}

export function clearToken(): void {
  try { if (existsSync(tokenPath())) unlinkSync(tokenPath()) } catch { /* ignore */ }
  emailLog('[store] 令牌已清除')
}
