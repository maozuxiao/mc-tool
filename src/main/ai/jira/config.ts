/**
 * Jira / JSM 工单助手 · 本地存储层（1.0.71）
 *
 * 为什么单独一层：内置技能目录在安装后位于 `resources/skills/`（Program Files 内，只读，
 * 且随应用更新被整体覆盖），而配置与凭据必须可写、且要跨版本保留 ——
 * 统一落在 `userData/jira-jsm/` 下，与 email-auto（1.0.61）保持同一套约定。
 *
 * 安全约定：
 *   - `apiToken` 用 `safeStorage` 加密后落盘；不可用时退化为明文并**在日志里明确告警**；
 *   - 任何返回给模型/UI 的视图都只给掩码（邮箱打码、token 只留末 4 位）；
 *   - 面板取数凭据（`panel-request.json`，含浏览器 Cookie 与 contextToken）同样只留在本机，
 *     不写进调试日志、不回显完整值。
 */
import { app, safeStorage, shell } from 'electron'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync
} from 'fs'
import { join } from 'path'

/** 技能 id（目录名）—— 工具绑定、日志前缀都用它 */
export const JIRA_SKILL_ID = 'jira-jsm'

/** 公司 JSM 站点：固定默认值，用户可在 config.json 里改成别的 *.atlassian.net 站点 */
export const DEFAULT_SITE_URL = 'https://streamaxamerica.atlassian.net'

export interface JiraConfig {
  siteUrl: string
  email: string
  apiToken: string
}

export const DEFAULT_CONFIG: JiraConfig = {
  siteUrl: DEFAULT_SITE_URL,
  email: '',
  apiToken: ''
}

/** 面板取数凭据：原样保存用户从 DevTools 复制的请求（只在本机使用） */
export interface PanelRequest {
  url: string
  headers: Record<string, string>
  cookie: string
  body: any
  savedAt?: string
}

function dataDir(): string {
  return join(app.getPath('userData'), JIRA_SKILL_ID)
}
export function jiraDir(): string {
  return dataDir()
}
function configPath(): string {
  return join(dataDir(), 'config.json')
}
function panelReqPath(): string {
  return join(dataDir(), 'panel-request.json')
}
function panelCachePath(): string {
  return join(dataDir(), 'panel-rdms-cache.json')
}

function ensureDir(): void {
  try { mkdirSync(dataDir(), { recursive: true }) } catch { /* 已存在 */ }
}

// ── 日志（只记元信息；超 2MB 滚动一份）───────────────────────────
const LOG_MAX_BYTES = 2 * 1024 * 1024

export function jiraLog(msg: string): void {
  ensureDir()
  const path = join(dataDir(), 'jira.log')
  try {
    if (existsSync(path) && statSync(path).size > LOG_MAX_BYTES) {
      const bak = path + '.1'
      if (existsSync(bak)) unlinkSync(bak)
      renameSync(path, bak)
    }
  } catch { /* 滚动失败不影响写日志 */ }
  try { appendFileSync(path, `[${new Date().toISOString()}] ${msg}\n`) } catch { /* ignore */ }
  console.log('[jira] ' + msg)
}

/** 邮箱打码：`se***@streamax.com` */
export function maskEmail(addr: string): string {
  const s = String(addr || '')
  if (!s) return ''
  const at = s.indexOf('@')
  if (at < 0) return s.slice(0, 3) + '***'
  return `${s.slice(0, Math.min(2, at))}***${s.slice(at)}`
}

/** token 绝不回显：只给末 4 位，用于确认「填的是不是同一份」 */
export function maskToken(tok: string): string {
  const s = String(tok || '')
  if (!s) return '(未配置)'
  return `****${s.slice(-4)}（共 ${s.length} 字符）`
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
    jiraLog('[store] WARN safeStorage 不可用，apiToken 将以明文保存（仅本机用户目录可读）')
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
      // 换机器 / 换系统用户后旧密文解不开：如实提示重填，而不是静默当成空
      jiraLog('[store] 解密失败（可能换了机器/系统用户），需要在 config.json 里重新填写 apiToken：' + (e?.message || e))
      return ''
    }
  }
  if (s.startsWith(PLAIN_PREFIX)) return s.slice(PLAIN_PREFIX.length)
  return s
}

function writeJsonAtomic(path: string, obj: any): void {
  ensureDir()
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  renameSync(tmp, path)
}

// ── 配置 ────────────────────────────────────────────────
/** 配置文件是否存在 */
export function configExists(): boolean {
  return existsSync(configPath())
}

/**
 * 读配置。文件不存在时返回内置默认值（siteUrl 已给公司站点，邮箱/token 为空）。
 * 空邮箱或空 token 由调用方判定为「未配置完成」。
 */
export function loadConfig(): JiraConfig {
  try {
    if (!existsSync(configPath())) return { ...DEFAULT_CONFIG }
    const raw = JSON.parse(readFileSync(configPath(), 'utf8')) || {}
    return {
      siteUrl: String(raw.siteUrl || DEFAULT_SITE_URL).trim().replace(/\/+$/, ''),
      email: String(raw.email || '').trim(),
      apiToken: decryptString(raw.apiToken)
    }
  } catch (e: any) {
    jiraLog('[store] 读配置失败，使用默认值：' + (e?.message || e))
    return { ...DEFAULT_CONFIG }
  }
}

/** 是否已填写邮箱与 token */
export function configReady(cfg: JiraConfig = loadConfig()): boolean {
  return !!cfg.email && !!cfg.apiToken
}

/** 给工具/UI 的脱敏视图 */
export function configView(cfg: JiraConfig = loadConfig()): Record<string, any> {
  return {
    siteUrl: cfg.siteUrl || DEFAULT_SITE_URL,
    email: cfg.email ? maskEmail(cfg.email) : '(未填写)',
    apiToken: maskToken(cfg.apiToken),
    emailConfigured: !!cfg.email,
    tokenConfigured: !!cfg.apiToken,
    ready: configReady(cfg),
    configPath: configPath(),
    configExists: configExists()
  }
}

/**
 * 生成配置模板（**不覆盖**已有文件）。
 * 模板里 email / apiToken 留空 + 带填写说明：凭据不经过对话，由用户自己在文件里填。
 */
export function writeConfigTemplate(): { created: boolean; path: string } {
  ensureDir()
  const path = configPath()
  if (existsSync(path)) return { created: false, path }
  const template = {
    _说明: [
      '1. siteUrl 默认是公司 JSM 站点，一般不用改（必须是 https 且以 .atlassian.net 结尾）',
      '2. email 填你的 Streamax 工作邮箱（登录 Jira 用的那个）',
      '3. apiToken 请到 https://id.atlassian.com/manage-profile/security/api-tokens 创建后整段粘贴到这里',
      '4. 填完保存文件即可，无需重启应用；token 属于敏感信息，不要发到聊天里或提交到代码仓库'
    ],
    siteUrl: DEFAULT_SITE_URL,
    email: '',
    apiToken: ''
  }
  writeJsonAtomic(path, template)
  jiraLog('[store] 已生成配置模板 ' + path)
  return { created: true, path }
}

/** 打开配置目录（资源管理器），供用户自己填 token */
export async function openConfigDir(): Promise<{ ok: boolean; path: string; error?: string }> {
  ensureDir()
  try {
    const err = await shell.openPath(dataDir())
    if (err) return { ok: false, path: dataDir(), error: err }
    return { ok: true, path: dataDir() }
  } catch (e: any) {
    return { ok: false, path: dataDir(), error: e?.message || String(e) }
  }
}

// ── 面板取数凭据（cURL）─────────────────────────────────
export function loadPanelRequest(): PanelRequest | null {
  try {
    if (!existsSync(panelReqPath())) return null
    const raw = JSON.parse(readFileSync(panelReqPath(), 'utf8'))
    if (!raw || !raw.url || !raw.body) return null
    return {
      url: String(raw.url),
      headers: raw.headers && typeof raw.headers === 'object' ? raw.headers : {},
      cookie: String(raw.cookie || ''),
      body: raw.body,
      savedAt: raw.savedAt ? String(raw.savedAt) : undefined
    }
  } catch {
    return null
  }
}

export function savePanelRequest(req: PanelRequest): void {
  writeJsonAtomic(panelReqPath(), { ...req, savedAt: new Date().toISOString() })
  // 日志只记结构信息：cookie / contextToken 一律不落日志
  jiraLog(`[panel] 凭据已更新（headers=${Object.keys(req.headers).length}，cookie=${req.cookie ? '有' : '无'}）`)
}

export function clearPanelRequest(): void {
  try { if (existsSync(panelReqPath())) unlinkSync(panelReqPath()) } catch { /* ignore */ }
  jiraLog('[panel] 凭据已清除')
}

// ── 面板 RDMS 缓存（12 小时）─────────────────────────────
export function loadPanelCache(): Record<string, any> {
  try {
    if (!existsSync(panelCachePath())) return {}
    return JSON.parse(readFileSync(panelCachePath(), 'utf8')) || {}
  } catch {
    return {}
  }
}

export function savePanelCache(cache: Record<string, any>): void {
  try {
    writeJsonAtomic(panelCachePath(), cache)
  } catch { /* 缓存写不进去不影响本次查询 */ }
}
