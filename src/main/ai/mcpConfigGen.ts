import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import type { McpServerConfig } from '@shared/ai-types'
import { getServerRaw, saveServer } from './mcpStore'

/**
 * 「生成本机运行配置」（1.0.46）。
 *
 * 为什么需要它：不少 MCP 技能把**作者本机的绝对路径**写进了自带配置里。
 * 实测 Tech-agent 技能：`templates/config.base.json` / `config.tech-agent.json` 里
 *   cache.cookie_path / session_path = `C:\Users\admin\.workbuddy\skills\Tech-agent-skill\runtime\.cache\...`
 * 换到别的机器（本机真实用户是 streamax，没有 `C:\Users\admin`）就会出现
 *   `EPERM: operation not permitted, mkdir 'C:\Users\admin\.workbuddy\...'`
 * ——登录态根本写不进去，连扫码都到不了。同一份配置里还带着**他人的 cookie_string**
 * （既是别人的登录态，也违反该技能自己「禁止硬编码 Cookie / 本机绝对路径」的规则）。
 *
 * 做法：不改技能包（同 id 重新导入＝更新，会被覆盖回去），而是在
 * `userData/mcp/<服务 id>-config.json` 生成一份本机可用的配置：
 *   ① 合并来源配置（含 `_merge_auth_from` 指向的 base）；
 *   ② **剔除他人凭证**（cookie / token / password / secret / session_id 等，但保留 *_path 这类路径配置）；
 *   ③ 把**别人家目录的绝对路径改指本机真实用户目录**，并把这些目录建出来；
 *   ④ 把服务登记里指向配置的环境变量（如 DINGDING_CONFIG_PATH）改指到新配置。
 * 生成的配置**不含任何 Cookie**：登录态由 mcp_auth 扫码后写入，本来就该是本机自己的。
 */

export interface GenConfigReport {
  ok: boolean
  /** 失败原因码：界面据此选文案 */
  reason?: 'not-found' | 'no-source' | 'no-env-key' | 'error'
  configPath?: string
  /** 被改指到本机的配置环境变量名（可能为 undefined：没找到配置类变量） */
  envKey?: string
  fromPath?: string
  /** 路径改指记录：`旧 → 新` */
  rerooted: { from: string; to: string }[]
  /** 被剔除的键（点分路径，如 `auth.cookie_string`） */
  stripped: string[]
  /** 顺手建出来的目录 */
  createdDirs: string[]
  error?: string
}

/** 看起来像「他人凭证」的键；*_path / *_dir / *_file / *_hours 只是路径或配置，不删 */
const SECRET_KEY = /(cookie|token|password|passwd|secret|credential|api[_-]?key|chat_user_id|session)/i
/** 名字里带凭证词、但其实只是路径 / 开关 / 说明文字的键，不能删（删了会丢配置或留下噪音） */
const KEEP_KEY = /(_path|_dir|_file|_hours|_ttl|placeholder|comment|note|description)$/i

/** 家目录形态：`C:\Users\xxx`、`/Users/xxx`、`/home/xxx` */
const HOME_WIN = /^([A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/]+)([\\/]|$)/i
const HOME_POSIX = /^(\/(?:Users|home)\/[^/]+)(\/|$)/

function realHome(): string {
  return process.env.USERPROFILE || process.env.HOME || ''
}

/** 展开 `%VAR%` / `$VAR` / `${VAR}` / `~`（配置里的占位符运行时不一定帮我们展开） */
function expandVars(input: string): string {
  let s = String(input || '')
  s = s.replace(/%([A-Za-z0-9_]+)%/g, (m, n) => process.env[n] ?? process.env[n.toUpperCase()] ?? m)
  s = s.replace(/\$\{([A-Za-z0-9_]+)\}/g, (m, n) => process.env[n] ?? m)
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = realHome() + s.slice(1)
  return s
}

/** 把别人家目录开头的路径改指本机真实用户目录 */
function reRoot(p: string, log: { from: string; to: string }[]): string {
  const home = realHome()
  if (!home) return p
  const m = HOME_WIN.exec(p) || HOME_POSIX.exec(p)
  if (!m) return p
  const found = m[1]
  if (found.toLowerCase() === home.toLowerCase()) return p
  const sep = found.includes('\\') ? '\\' : '/'
  const out = home + sep + p.slice(found.length).replace(/^[\\/]+/, '')
  log.push({ from: p, to: out })
  return out
}

/** 递归：改指路径 + 剔除他人凭证；返回被剔除的键（点分路径） */
function sanitize(node: any, prefix: string, log: { from: string; to: string }[], stripped: string[]): any {
  if (Array.isArray(node)) return node.map(v => sanitize(v, prefix, log, stripped))
  if (!node || typeof node !== 'object') {
    return typeof node === 'string' ? reRoot(expandVars(node), log) : node
  }
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v !== 'object' && SECRET_KEY.test(k) && !KEEP_KEY.test(k)) {
      stripped.push(path)
      continue
    }
    if (k === '_merge_auth_from') continue // 已合并，不再让运行时去读别人那份
    out[k] = sanitize(v, path, log, stripped)
  }
  return out
}

function readJson(p: string): any {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

/** 深合并（后者覆盖前者），数组整体覆盖 */
function deepMerge(a: any, b: any): any {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return b
  if (!b || typeof b !== 'object' || Array.isArray(b)) return a
  return { ...a, ...Object.fromEntries(Object.entries(b).map(([k, v]) =>
    [k, k in a ? deepMerge(a[k], v) : v])) }
}

/** 从服务登记里找出「指向配置文件」的环境变量（值以 .json 结尾） */
function configEnvKeyOf(env: Record<string, string> | undefined): { key: string; value: string } | undefined {
  const entries = Object.entries(env || {})
  const hit = entries.filter(([, v]) => /\.json$/i.test(expandVars(String(v || ''))))
  if (!hit.length) return undefined
  const named = hit.find(([k]) => /config/i.test(k)) || hit[0]
  return { key: named[0], value: expandVars(String(named[1] || '')) }
}

/** 定位技能目录：优先从 cwd 往上找 SKILL.md（导入的技能目录名未必等于 skillKey） */
function skillDirOf(cfg: McpServerConfig): string | null {
  let dir = expandVars(String(cfg.cwd || '')).trim()
  if (dir) {
    for (let i = 0; i < 6 && dir; i++) {
      if (existsSync(join(dir, 'SKILL.md'))) return dir
      const up = dirname(dir)
      if (up === dir) break
      dir = up
    }
  }
  const bare = String(cfg.skillKey || '').split(':').pop() || ''
  if (bare) {
    const p = join(app.getPath('userData'), 'skills', bare)
    if (existsSync(join(p, 'SKILL.md'))) return p
  }
  return null
}

/** 在技能目录里挑配置模板：优先匹配 env 里提到的文件名，其次非 base 的 config*.json */
function templatesOf(skillDir: string, preferName?: string): string[] {
  const dirs = [join(skillDir, 'templates'), skillDir]
  for (const d of dirs) {
    if (!existsSync(d)) continue
    let files: string[] = []
    try { files = readdirSync(d).filter(f => /^config.*\.json$/i.test(f)).map(f => join(d, f)) } catch { continue }
    if (!files.length) continue
    if (preferName) {
      const want = basename(preferName).toLowerCase()
      const exact = files.find(f => basename(f).toLowerCase() === want)
      if (exact) { const rest = files.filter(f => f !== exact).filter(f => /base/i.test(basename(f))); return [...rest, exact] }
    }
    const nonBase = files.filter(f => !/base/i.test(basename(f)))
    const base = files.filter(f => /base/i.test(basename(f)))
    return [...base, ...(nonBase.length ? nonBase.slice(0, 1) : [])]
  }
  return []
}

/**
 * 为指定 MCP 服务生成本机运行配置。
 * 只做「生成 + 改登记」，不断连接（由调用方决定断开重连时机）。
 */
export function generateLocalConfig(id: string): GenConfigReport {
  const cfg = getServerRaw(String(id || ''))
  if (!cfg) return { ok: false, reason: 'not-found', rerooted: [], stripped: [], createdDirs: [], error: '服务不存在' }

  const cfgEnvKey = configEnvKeyOf(cfg.env)
  const envCfgPath = cfgEnvKey?.value ? resolve(expandVars(cfgEnvKey.value)) : ''
  let sources: string[] = []

  if (envCfgPath && existsSync(envCfgPath)) {
    sources = [envCfgPath]
  } else {
    const skillDir = skillDirOf(cfg)
    if (skillDir) sources = templatesOf(skillDir, envCfgPath || undefined)
  }
  // 兼容：env 指向的文件不存在时，也允许把技能模板当来源（上面已处理）；都没有才失败
  if (!sources.length && envCfgPath) sources = [envCfgPath]

  const loaded = sources.map(p => readJson(p)).filter(Boolean)
  if (!loaded.length) {
    return {
      ok: false, reason: 'no-source', rerooted: [], stripped: [], createdDirs: [],
      error: sources.length ? `配置文件读不出来：${sources.join(', ')}` : '找不到配置来源'
    }
  }

  // 合并（后者覆盖前者）；再补上 base 里 `_merge_auth_from` 指向的那份（最底层）
  let merged = loaded[0]
  for (let i = 1; i < loaded.length; i++) merged = deepMerge(merged, loaded[i])
  if (merged && typeof merged === 'object' && typeof merged._merge_auth_from === 'string') {
    const basePath = resolve(dirname(sources[0]), merged._merge_auth_from)
    const base = readJson(basePath)
    if (base) merged = deepMerge(base, merged)
  }

  const rerooted: { from: string; to: string }[] = []
  const stripped: string[] = []
  const out = sanitize(merged, '', rerooted, stripped)

  // 把配置里那些 *_path 指向的目录先建出来（缺目录正是 EPERM 的直接原因）
  const createdDirs: string[] = []
  const ensureDir = (p: unknown) => {
    const s = typeof p === 'string' ? expandVars(p) : ''
    if (!s || !/^([A-Za-z]:[\\/]|\/)/.test(s)) return
    const d = dirname(s)
    if (!d || existsSync(d)) return
    try { mkdirSync(d, { recursive: true }); createdDirs.push(d) } catch { /* 建不出来也先生成配置，界面会提示 */ }
  }
  const walkPaths = (node: any) => {
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && /(_path|_dir|_file)$/i.test(k)) ensureDir(v)
      else if (v && typeof v === 'object') walkPaths(v)
    }
  }
  walkPaths(out)

  const outDir = join(app.getPath('userData'), 'mcp')
  try { if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true }) } catch { /* 下面写盘会报错并回报 */ }
  const outPath = join(outDir, `${cfg.id}-config.json`)
  try {
    writeFileSync(outPath, JSON.stringify({ ...out, _generated_by: 'MC Tool 1.0.46 生成本机运行配置' }, null, 2), 'utf8')
  } catch (e: any) {
    return { ok: false, reason: 'error', rerooted, stripped, createdDirs, error: e?.message || String(e) }
  }

  // 改登记：把指向配置的 env 改指到新生成的文件
  let envKey = cfgEnvKey?.key
  if (!envKey) {
    // 没有 .json 结尾的配置变量时，退而求其次找名字像配置变量的那个
    envKey = Object.keys(cfg.env || {}).find(k => /config/i.test(k))
  }
  if (envKey) {
    saveServer({ ...cfg, env: { ...(cfg.env || {}), [envKey]: outPath } })
  }

  return {
    ok: true,
    ...(envKey ? {} : { reason: 'no-env-key' as const }),
    configPath: outPath,
    envKey,
    fromPath: sources[0],
    rerooted,
    stripped,
    createdDirs
  }
}
