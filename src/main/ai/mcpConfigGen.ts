import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import type { McpServerConfig } from '@shared/ai-types'
import { getServerRaw, saveServer } from './mcpStore'
import { skillDirOf as registrySkillDir } from './skillRegistry'

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

/**
 * 看起来像「他人凭证」的键；*_path / *_dir / *_file / *_hours 只保留路径或配置，不删。
 *
 * 1.0.57：从名单里去掉 `chat_user_id` —— 它是**路由 id**（私聊/群的默认对象），
 * 不是密钥。此前把它当凭证剥掉，用户自己那份配置作为来源时会被静默丢弃，
 * 表现为「生成完配置，机器人不知道该跟谁说话」。
 */
const SECRET_KEY = /(cookie|token|password|passwd|secret|credential|api[_-]?key|session)/i
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
  // 1.0.57：cwd 为空（示例就是空，靠应用推断内置 runtime）时，光看 userData/skills 找不到
  // **内置**技能目录 —— 内置的在 `resources/skills`（打包后 `process.resourcesPath/skills`）。
  // 这里统一交给 skillRegistry.skillDirOf 解析（它同时认 builtin: / user: 两种来源）。
  return registrySkillDir(String(cfg.skillKey || ''))
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
 * 技能可选的「运行配置声明」：`<技能目录>/mcp.json`
 *
 * ```json
 * { "config": { "env": "DINGDING_CONFIG_PATH", "template": "templates/config.tech-agent.json" } }
 * ```
 *
 * 为什么要这个文件（1.0.57）：运行时要读哪个环境变量、默认落到哪个路径，只有技能自己知道。
 * 应用若靠「猜 env 名 / 猜默认路径」，换个技能就失效，或者把某家的路径写死进通用逻辑。
 * 有声明就按声明办；没有声明才回落到「从 env 里找 .json / 从 templates/ 找 config*.json」的老办法。
 */
interface ConfigDecl { env?: string; template?: string }

function readConfigDecl(skillDir: string): ConfigDecl | null {
  const j = readJson(join(skillDir, 'mcp.json'))
  const c = j && typeof j === 'object' ? (j as any).config : null
  if (!c || typeof c !== 'object') return null
  return {
    env: typeof c.env === 'string' && c.env.trim() ? c.env.trim() : undefined,
    template: typeof c.template === 'string' && c.template.trim() ? c.template.trim() : undefined
  }
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
  const skillDir = skillDirOf(cfg)
  const decl = skillDir ? readConfigDecl(skillDir) : null
  let sources: string[] = []

  if (envCfgPath && existsSync(envCfgPath)) {
    sources = [envCfgPath]
  } else if (skillDir) {
    // 声明里指定的模板优先（它能连同 `_merge_auth_from` 的 base 一起被合并）
    const declared = decl?.template ? join(skillDir, decl.template) : ''
    sources = declared && existsSync(declared)
      ? [declared]
      : templatesOf(skillDir, envCfgPath || undefined)
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

  // 输出位置（1.0.57）：
  // - 登记里给了**绝对路径**就写到那儿 —— 运行时要读的就是它，示例里用的
  //   `%APPDATA%\mc-material-query\mcp\tech-agent-config.json` 展开后就是绝对路径，
  //   这样「示例写的路径」和「实际生成的路径」一致，不会生出没人读的孤儿文件；
  // - 没给路径才落到 userData/mcp/<id>-config.json，再把 env 指过去。
  const outPath = envCfgPath && isAbsolute(envCfgPath)
    ? envCfgPath
    : join(app.getPath('userData'), 'mcp', `${cfg.id}-config.json`)
  try { mkdirSync(dirname(outPath), { recursive: true }) } catch { /* 下面写盘会报错并回报 */ }
  try {
    writeFileSync(
      outPath,
      JSON.stringify({ ...out, _generated_by: `MC Tool ${app.getVersion()} 生成本机运行配置` }, null, 2),
      'utf8'
    )
  } catch (e: any) {
    return { ok: false, reason: 'error', rerooted, stripped, createdDirs, error: e?.message || String(e) }
  }

  // 改登记：确保运行时读的是刚生成的这份
  // 顺序：登记里已有的配置类 env（值以 .json 结尾）→ 技能声明的 env 名 → 名字像 config 的键
  let envKey = cfgEnvKey?.key || decl?.env
  if (!envKey) {
    envKey = Object.keys(cfg.env || {}).find(k => /config/i.test(k))
  }
  if (envKey && (cfg.env || {})[envKey] !== outPath) {
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

export interface EnsureConfigResult {
  /** 这次真的生成/落位了配置（连接与安装时各检查一次，已经是幂等的） */
  created: boolean
  path?: string
  /** 没生成时的原因，仅用于日志 */
  skipped?: 'config-exists' | 'no-env' | 'no-template' | 'no-skill-dir' | 'error'
  error?: string
}

/**
 * 「连接前 / 装依赖前」的一次幂等检查：运行时要读的配置在不在？不在就从技能模板生成一份。
 *
 * 1.0.57 的动机：1.0.55 把示例里的 `DINGDING_CONFIG_PATH` 去掉之后，「生成本机运行配置」
 * 生成的文件没人读（env 为空 → 无法改指），运行时报「配置文件不存在」直接退出，
 * 而界面上只显示「MCP 进程已退出」。现在把这一步做成自动前置：
 *   - 有配置且文件存在 → 什么都不做（`skipped: 'config-exists'`）；
 *   - 没有配置但有技能模板 → 生成，并在日志留痕；
 *   - 既没配置也没模板 → 跳过，让上层报**原始**错误（不伪造成功）。
 */
export function ensureRuntimeConfig(cfg: McpServerConfig): EnsureConfigResult {
  try {
    const cfgEnvKey = configEnvKeyOf(cfg.env)
    const envPath = cfgEnvKey?.value ? resolve(expandVars(cfgEnvKey.value)) : ''
    if (envPath && existsSync(envPath)) return { created: false, path: envPath, skipped: 'config-exists' }

    const skillDir = skillDirOf(cfg)
    if (!skillDir) return { created: false, skipped: 'no-skill-dir' }

    const decl = readConfigDecl(skillDir)
    const declared = decl?.template ? join(skillDir, decl.template) : ''
    const hasTemplate = (declared && existsSync(declared)) || templatesOf(skillDir, envPath || undefined).length > 0
    if (!hasTemplate) return { created: false, skipped: 'no-template' }

    // 没有配置类 env、技能也没声明该用哪个变量 → 生成了也没人读，别造孤儿文件
    if (!cfgEnvKey && !decl?.env) return { created: false, skipped: 'no-env' }

    const r = generateLocalConfig(cfg.id)
    return r.ok
      ? { created: true, path: r.configPath }
      : { created: false, skipped: 'error', error: r.error }
  } catch (e: any) {
    return { created: false, skipped: 'error', error: e?.message || String(e) }
  }
}
