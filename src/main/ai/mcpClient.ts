import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { appendFileSync, accessSync, constants, cpSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'
import { bareSkillId } from '@shared/ai-types'
import type { McpEvent, McpServerConfig, McpState, McpStatus } from '@shared/ai-types'
import { ensureNodeWithNpm, killTree, resolveNodeBinary, resolveNpmCli } from './skillRuntime'
import { getServerRaw, listServers, saveServer, serversForSkillKeys } from './mcpStore'
import { builtinRoot, skillDirOf } from './skillRegistry'
import { ensureRuntimeConfig } from './mcpConfigGen'

/**
 * MCP 客户端（1.0.46）—— 自研最小实现：stdio + 换行分隔 JSON-RPC 2.0。
 *
 * 为什么不用官方 `@modelcontextprotocol/sdk`：客户端只需要 initialize / tools/list /
 * tools/call 三个方法与 notifications/cancelled，自研约 300 行；引 SDK 会带来打包体积与
 * ESM/CJS 互操作成本，收益不成正比。
 *
 * 生命周期：
 * - 「技能启用时下发」（用户决策）：`prepareForSkills(enabledSkills)` 在进入对话轮次循环前调用，
 *   并行建立连接（单飞：同一服务并发请求只起一个进程），结果缓存在内存里供
 *   `cachedToolDefinitions()` **同步**读取（chatService 每轮是同步组装 tools 数组的）。
 * - 空闲回收：默认 10 分钟无调用自动断开；应用退出统一断开（will-quit）。
 * - 进程树杀法复用 skillRuntime.killTree（Windows 必须 taskkill /t，否则 node/npm 孤儿进程）。
 *
 * Node 解析：优先本机已自举的 Node 22（自带 npm）；回退 Electron 主程序 + `ELECTRON_RUN_AS_NODE=1`
 * （只能跑、没有 npm，此时「一键准备依赖」不可用并给出原因）。
 *
 * 日志：`userData/mcp/<serverId>.log`（stderr + 协议异常 + 启停事件，超过 512KB 自动重开）。
 * **不记录 env 值**。
 */

const PROTOCOL_VERSION = '2024-11-05'
const INIT_TIMEOUT_MS = 20000
const LIST_TIMEOUT_MS = 15000
const IDLE_DISCONNECT_MS = 10 * 60 * 1000
const LOG_CAP = 512 * 1024

const LOG_DIR = () => join(app.getPath('userData'), 'mcp')

/** 某个服务的日志文件路径（渲染层「查看日志」用） */
export function logPath(id: string): string {
  return join(LOG_DIR(), `${String(id || '').replace(/[^\w-]/g, '_')}.log`)
}

/**
 * 展开路径里的环境变量占位符（`%APPDATA%` / `%USERPROFILE%` …）。
 *
 * 为什么必须做：登记表单与「粘贴 JSON」经常直接写 `%APPDATA%\...`（技能文档就是这么给的），
 * 不展开的话目录不存在 → `spawn` 抛 **ENOENT**，而错误信息指向的是 node.exe，
 * 看起来像「Node 路径不对」，实际根因是 cwd/env 无效（1.0.46 实测踩到）。
 */
export function expandVars(value: string): string {
  const s = String(value || '')
  if (!s.includes('%')) return s
  return s.replace(/%([A-Za-z0-9_]+)%/g, (all, name) => {
    for (const [k, v] of Object.entries(process.env)) {
      if (k.toLowerCase() === String(name).toLowerCase() && v) return v
    }
    return all
  })
}

/** 展开后的真实工作目录（空 = 未设置） */
/**
 * 解析一个 MCP 服务的工作目录（1.0.50，1.0.55 修正回退条件）。
 *
 * 先用登记里填的 `cwd`（展开 `%APPDATA%` 等占位符）；**没填**时回退到「该服务所绑定技能
 * 自带的 runtime 目录」—— 在 `<技能目录>/runtime` 下递归找第一个含 `package.json` 的目录
 * （层级由技能包自己决定：tech-agent-skill 是 `runtime/mcp-dingtalk-v1-template`，两层）。
 *
 * 为什么要有回退：内置技能 tech-agent-skill 的 runtime **已随安装包分发**
 * （`resources/skills/<id>/runtime/…`），但那条路径在安装版位于 Program Files 下、
 * 开发版位于仓库目录 —— 两种形态的绝对路径都不一样，还随打包/部署变化。
 * 让用户手填这么一条路径，必然出现「填了旧位置 → 工作目录不存在」（本机实测：
 * 填的是导入技能的位置 `%APPDATA%/mc-material-query/skills/…`，而导入副本早已删除）。
 * 绑定技能本来就是必填项，由它推断 cwd 既准确又免去一项用户负担。
 *
 * 1.0.55：**填了但目录不存在时也先试推断**。此前的回退条件写的是「没填才推断」，
 * 而分发实测的故障恰是「填了」—— 内置示例 JSON 曾预填 `%APPDATA%\...\skills\<id>\runtime\...`
 * （用户导入技能的位置，新机器上不存在），用户照示例导入后点「准备依赖」必报
 * 「工作目录不存在」且无从下手。回退只作用于本次运行、**不静默改写存储**（日志留痕，
 * 用户可自行纠正登记值；安装流程本身会把 cwd 持久化成可写副本路径）；推断不到才返回原值，
 * 让报错如实指向登记的那一项。
 *
 * 注意「dev 下推断出仓库路径」是**预期行为**而非异常：那正是 `skillDirOf` 在未打包时
 * 按 `app.getAppPath()/resources/skills` 定位的结果，打包后会自然指向安装目录。
 */
function resolvedCwd(cfg: McpServerConfig): string {
  const filled = expandVars(String(cfg.cwd || ''))
  if (filled && existsSync(filled)) return filled
  const inferred = inferRuntimeDir(cfg.skillKey)
  if (inferred) {
    if (filled) {
      logLine(cfg.id, `[cwd] 登记的 cwd 不存在，本次回退到技能自带 runtime：${inferred}（原值 ${filled}）`)
    }
    return inferred
  }
  return filled
}

/** 由绑定技能的技能目录推断其自带 runtime 的**可运行目录**（找不到返回空串） */
function inferRuntimeDir(skillKey: string): string {
  try {
    const dir = skillDirOf(String(skillKey || ''))
    if (!dir) return ''
    return findPkgDir(join(dir, 'runtime'), 0)
  } catch { /* 技能目录定位失败就用登记值 */ }
  return ''
}

/**
 * 在有限深度内递归找**第一个含 package.json 的目录**。
 *
 * 为什么要递归而不是直接用 `<技能>/runtime`：runtime 里的层级由技能包自己决定 ——
 * tech-agent-skill 是 `runtime/mcp-dingtalk-v1-template/package.json`（**两层**）。
 * 早先实现直接返回 `<技能>/runtime`，少了那一层，于是报「工作目录没有 package.json」。
 * 限深 3 层足够，又不会在目录树里乱钻（node_modules 直接跳过）。
 */
function findPkgDir(dir: string, depth: number): string {
  if (depth > 3 || !existsSync(dir)) return ''
  if (existsSync(join(dir, 'package.json'))) return dir
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return '' }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue
    const hit = findPkgDir(join(dir, e.name), depth + 1)
    if (hit) return hit
  }
  return ''
}

function logLine(id: string, line: string): void {
  try {
    mkdirSync(LOG_DIR(), { recursive: true })
    const p = join(LOG_DIR(), `${id}.log`)
    try { if (statSync(p).size > LOG_CAP) unlinkSync(p) } catch { /* 首次不存在 */ }
    appendFileSync(p, `[${new Date().toISOString()}] ${line}\n`)
  } catch { /* 日志失败不影响功能 */ }
}

// ── 事件（主进程 → 渲染层）───────────────────────────────────────────────────────
type Listener = (e: McpEvent) => void
const listeners = new Set<Listener>()
export function onMcpEvent(cb: Listener): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
function emit(e: McpEvent): void {
  for (const l of listeners) { try { l(e) } catch { /* 单个订阅者异常不影响其它 */ } }
}

// ── 连接状态 ────────────────────────────────────────────────────────────────────
interface Pending {
  resolve: (v: any) => void
  reject: (e: Error) => void
  /** 结算时统一清理：定时器 / pending 表 / abort 监听（防止在 signal 上积累） */
  cleanup: () => void
}

interface Conn {
  cfg: McpServerConfig
  child: ChildProcessWithoutNullStreams | null
  state: McpState
  error?: string
  /** 服务声明的工具（tools/list 原始名） */
  tools: { originalName: string; description?: string; inputSchema: any }[]
  /** 与 tools 对齐的对外名（重名时加 `<serverId>_` 前缀） */
  exposed: string[]
  pending: Map<number, Pending>
  buffer: string
  nextId: number
  lastUsed: number
  connecting?: Promise<void>
  /** 主动断开标记：exit 时不再当成失败 */
  closing?: boolean
}

const conns = new Map<string, Conn>()
const installs = new Map<string, AbortController>()
/** 对外工具名 → 服务与原始名（dispatchTool 据此路由） */
const exposedMap = new Map<string, { serverId: string; originalName: string }>()
/** 内置工具名（toolRegistry 注入），MCP 工具重名时让位 */
let reservedNames = new Set<string>()
let idleTimer: ReturnType<typeof setInterval> | null = null

/** 注入「不可被 MCP 工具占用」的名字（内置工具名），由 toolRegistry 在模块加载时调用 */
export function setReservedNames(names: string[]): void {
  reservedNames = new Set(names)
  rebuildExposed()
}

function emitStatus(id: string): void {
  emit({ type: 'status', id, status: statusById(id) })
}

function statusById(id: string): McpStatus {
  const cfg = listServers().find(s => s.id === id)
  const conn = conns.get(id)
  // 1.0.52：**必须带上 skillKey**。此前只传 cwd，而 `checkDependencies` 在 cwd 为空时
  // 要靠 skillKey 去推断技能自带 runtime 目录 —— 于是徽标走一遍「推断不出目录」的分支、
  // 恒判needsInstall=false，而真正 connect 时 cfg 是完整的、能推断到目录。
  // 结果就是用户界面上从来看不到「需要安装」提示，只在用到一半时收到
  // `Cannot find module` / `MODULE_NOT_FOUND`，只能自己去点「一键准备依赖」。
  const dep = checkDependencies({ cwd: cfg?.cwd || '', skillKey: cfg?.skillKey || '' })
  return {
    id,
    name: cfg?.name || id,
    skillKey: cfg?.skillKey || '',
    enabled: cfg?.enabled !== false,
    state: conn?.state || 'stopped',
    toolCount: conn?.tools.length || 0,
    tools: conn?.exposed ? [...conn.exposed] : undefined,
    error: conn?.error,
    needsInstall: dep.needsInstall
  }
}

export function listStatuses(): McpStatus[] {
  return listServers().map(s => statusById(s.id))
}

export function checkDependencies(cfg: { cwd?: string; skillKey?: string }): { needsInstall: boolean; hasPackageJson: boolean; cwd: string } {
  // 与 resolvedCwd 走同一套解析（含「cwd 没填时按绑定技能推断自带 runtime 目录」），
  // 否则会出现「徽标说不用装、实际连接时却解析到别的目录」这类不一致。
  const cwd = resolvedCwd(cfg as McpServerConfig)
  const hasPkg = !!cwd && existsSync(join(cwd, 'package.json'))
  const hasNm = !!cwd && existsSync(join(cwd, 'node_modules'))
  return { needsInstall: hasPkg && !hasNm, hasPackageJson: hasPkg, cwd }
}

// ── JSON-RPC 收发 ───────────────────────────────────────────────────────────────
function rawSend(conn: Conn, msg: Record<string, unknown>): void {
  if (!conn.child || !conn.child.stdin.writable) throw new Error('MCP 进程未在运行')
  conn.child.stdin.write(JSON.stringify(msg) + '\n')
}

function request<T = any>(conn: Conn, method: string, params: any, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const id = ++conn.nextId
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let settled = false
    const onAbort = () => {
      // 通知服务端取消该请求（MCP 规范的 notifications/cancelled）
      try { rawSend(conn, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }) } catch { /* 进程可能已退出 */ }
      entry.reject(new DOMException('Aborted', 'AbortError'))
    }
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      conn.pending.delete(id)
      signal?.removeEventListener('abort', onAbort)
    }
    const entry: Pending = {
      // 双结算保护：定时器 / abort / 正常返回三者只让第一个生效
      resolve: v => { if (settled) return; settled = true; cleanup(); resolve(v) },
      reject: e => { if (settled) return; settled = true; cleanup(); reject(e) },
      cleanup
    }
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
    timer = setTimeout(() => entry.reject(new Error(`MCP 请求超时（${Math.round(timeoutMs / 1000)}s）：${method}`)), timeoutMs)
    conn.pending.set(id, entry)
    signal?.addEventListener('abort', onAbort)
    try {
      rawSend(conn, { jsonrpc: '2.0', id, method, params: params || {} })
    } catch (e: any) {
      entry.reject(new Error(`MCP 请求发送失败：${e?.message || e}`))
    }
  })
}

function notify(conn: Conn, method: string, params?: any): void {
  try { rawSend(conn, { jsonrpc: '2.0', method, params: params || {} }) } catch { /* ignore */ }
}

function handleLine(conn: Conn, line: string): void {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg: any
  try { msg = JSON.parse(trimmed) } catch {
    logLine(conn.cfg.id, `[protocol] 非 JSON 行（忽略）：${trimmed.slice(0, 200)}`)
    return
  }
  // 响应：带 id
  if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
    const p = conn.pending.get(msg.id)
    if (!p) return
    if (msg.error) p.reject(new Error(`MCP 错误 ${msg.error.code ?? ''}：${msg.error.message ?? JSON.stringify(msg.error)}`))
    else p.resolve(msg.result)
    return
  }
  // 服务端主动通知/请求：目前只记日志（部分服务会发 logging/message）
  const method = String(msg.method || '')
  if (method) logLine(conn.cfg.id, `[notify] ${method}${msg.params ? ' ' + JSON.stringify(msg.params).slice(0, 200) : ''}`)
}

function rejectAllPending(conn: Conn, error: Error): void {
  for (const [, p] of conn.pending) p.reject(error)
  conn.pending.clear()
}

// ── 连接管理 ────────────────────────────────────────────────────────────────────
function detectNeedsInstall(stderrTail: string): string | undefined {
  if (/Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/i.test(stderrTail)) {
    return '疑似缺少依赖：工作目录有 package.json 但没有 node_modules，请先「一键准备依赖」'
  }
  return undefined
}

export async function connect(cfg: McpServerConfig): Promise<void> {
  const old = conns.get(cfg.id)
  if (old?.connecting) return old.connecting
  if (old) disconnect(cfg.id)

  const conn: Conn = {
    cfg,
    child: null,
    state: 'connecting',
    tools: [],
    exposed: [],
    pending: new Map(),
    buffer: '',
    nextId: 0,
    lastUsed: Date.now()
  }
  conns.set(cfg.id, conn)
  emitStatus(cfg.id)
  logLine(cfg.id, `[lifecycle] connecting command=${cfg.command} args=${JSON.stringify(cfg.args)} cwd=${cfg.cwd || '(默认)'}`)

  // 1.0.57：连接前先确保运行配置就位（幂等）。缺配置时运行时（如 dingtalk MCP 的
  // ConfigLoader）会直接退出，界面却只剩一句「MCP 进程已退出」，用户无从下手。
  try {
    const cfgPrep = ensureRuntimeConfig(cfg)
    if (cfgPrep.created) {
      logLine(cfg.id, `[config] 已自动生成本机配置 → ${cfgPrep.path}`)
      // 生成过程会回写登记（补上 / 改写配置类 env），必须重新取一份再 spawn，
      // 否则子进程拿到的还是旧 env —— 又会去读那个不存在的默认路径。
      cfg = getServerRaw(cfg.id) || cfg
      conn.cfg = cfg
    } else if (cfgPrep.skipped === 'error') {
      logLine(cfg.id, `[config] 自动生成失败：${cfgPrep.error || ''}`)
    }
  } catch (e: any) {
    logLine(cfg.id, `[config] 自动生成失败：${e?.message || e}`)
  }

  conn.connecting = (async () => {
    const node = resolveNodeBinary()
    // command 填 `node`（或留空）= 由应用解析真实 node；其它命令原样使用（都做一次变量展开）
    const useResolved = !cfg.command || /^(node|node\.exe)$/i.test(cfg.command.trim())
    const command = useResolved ? node.path : expandVars(cfg.command)
    const env: Record<string, string> = { ...(process.env as Record<string, string>) }
    // 显式带上真实用户目录：不少 MCP 运行时用 os.homedir() / USERPROFILE 拼缓存路径，
    // 万一应用是在异常的用户上下文里被拉起（实测见过 MCP 把家目录算成不存在的 C:\Users\admin），
    // 子进程也应拿到真实用户目录，而不是继承到错的那个。
    if (process.env.USERPROFILE) env.USERPROFILE = process.env.USERPROFILE
    if (process.env.HOME) env.HOME = process.env.HOME
    if (process.env.APPDATA) env.APPDATA = process.env.APPDATA
    if (useResolved && node.electronAsNode) env.ELECTRON_RUN_AS_NODE = '1'
    for (const [k, v] of Object.entries(cfg.env || {})) env[k] = expandVars(v)

    // 工作目录先校验再 spawn：目录不存在时 Windows 上的报错是 ENOENT 且指向 node.exe，
    // 极易误导成「Node 路径不对」（登记表单/粘贴 JSON 里的 %APPDATA% 未展开就是这个症状）
    const cwd = resolvedCwd(cfg)
    if (cwd && !existsSync(cwd)) {
      throw new Error(`工作目录不存在：${cwd}（登记时填的路径无效，或环境变量未展开）`)
    }

    const child = spawn(command, (cfg.args || []).map(a => expandVars(String(a))), {
      cwd: cwd || undefined,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams
    conn.child = child

    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderrTail = (stderrTail + text).slice(-4000)
      logLine(cfg.id, `[stderr] ${text.trimEnd()}`)
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      conn.buffer += chunk.toString()
      const lines = conn.buffer.split(/\r?\n/)
      conn.buffer = lines.pop() || ''
      for (const line of lines) handleLine(conn, line)
    })

    const exitCode: Promise<number | null> = new Promise(resolve => {
      child.on('error', (e: Error) => {
        conn.state = 'failed'
        conn.error = `进程启动失败：${e.message}`
        rejectAllPending(conn, new Error(conn.error))
        emitStatus(cfg.id)
        logLine(cfg.id, `[lifecycle] spawn error: ${e.message}`)
        resolve(-1)
      })
      child.on('close', (code) => {
        const wasClosing = conn.closing
        if (conn.state !== 'failed') conn.state = wasClosing ? 'stopped' : 'failed'
        if (!wasClosing) {
          conn.error = conn.error
            || `进程退出（code=${code}）。${detectNeedsInstall(stderrTail) || 'stderr 末尾见日志'}`
          logLine(cfg.id, `[lifecycle] exit code=${code} state=${conn.state} error=${conn.error || '-'}`)
        }
        conn.child = null
        conn.tools = []
        conn.exposed = []
        rebuildExposed()
        // 把 close 处理器已经算好的具体原因带出去（如「配置文件不存在: …」），
        // 否则调用方只能拿到一句通用的「MCP 进程已退出」（1.0.57 修）
        rejectAllPending(conn, new Error(conn.error || 'MCP 进程已退出'))
        emitStatus(cfg.id)
        resolve(code)
      })
    })

    // 握手：initialize → initialized → tools/list
    try {
      await request(conn, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'mc-tool', version: app.getVersion() }
      }, INIT_TIMEOUT_MS)
      notify(conn, 'notifications/initialized')
      const listed = await request<{ tools?: { name: string; description?: string; inputSchema?: any }[] }>(
        conn, 'tools/list', {}, LIST_TIMEOUT_MS
      )
      conn.tools = (listed?.tools || []).map(t => ({
        originalName: String(t.name || ''),
        description: t.description,
        inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} }
      })).filter(t => t.originalName)
      conn.state = 'connected'
      conn.error = undefined
      conn.lastUsed = Date.now()
      rebuildExposed()
      emitStatus(cfg.id)
      logLine(cfg.id, `[lifecycle] connected, tools=${conn.tools.length} [${conn.exposed.join(', ')}]`)
    } catch (e: any) {
      const aborted = e?.name === 'AbortError'
      conn.state = 'failed'
      // 保序（1.0.57）：close 处理器往往先跑，写下的原因更具体（退出码 + stderr 归因）；
      // 这里的 e 只是 pending 的拒绝原因，别用它在后面把真因覆盖成一句「进程已退出」。
      conn.error = conn.error || (aborted
        ? '连接被中止'
        : `${e?.message || e}${detectNeedsInstall(stderrTail) ? '；' + detectNeedsInstall(stderrTail) : ''}`)
      logLine(cfg.id, `[lifecycle] connect failed: ${conn.error}`)
      killTree(child)
      // 让上面注册的 close 处理器收尾（state 已是 failed，exit 时不会再改写 error）
      conn.closing = true
      emitStatus(cfg.id)
      throw new Error(conn.error)
    }
    // 进程若在此期间退出，交给 close 处理器标记 failed
    void exitCode
  })()

  // 失败时清掉单飞标记，允许下次重试。
  //
  // ⚠️ 这里**不能用 .finally()**：它返回的是**另一个** Promise，会跟着 reject 而且没人 catch ——
  // 于是每次连接失败都会抛一次 UnhandledPromiseRejectionWarning（2026-10-07 实测复现：
  // 「工作目录不存在」只是业务错误，却被 Node 报成未处理拒绝，Electron 主进程随时可能崩）。
  // 改用 then(成功, 失败) 双分支处理，衍生 Promise 不会 reject。
  const clearSingleFlight = () => { if (conns.get(cfg.id) === conn) conn.connecting = undefined }
  conn.connecting.then(clearSingleFlight, clearSingleFlight).catch(() => { /* 双分支都不抛，这里只是兜底 */ })
  // 另外 conn.connecting 本身也可能先于任何调用方的 await 被 reject（并发复用时尤甚），
  // 挂一个空 catch 只消除 Node 的未处理拒绝警告 —— 真实错误仍由调用方的 try/catch 原样拿到。
  conn.connecting.catch(() => { /* noop */ })
  return conn.connecting
}

export function disconnect(id: string, reason = '手动断开'): void {
  const conn = conns.get(id)
  if (!conn) return
  conn.closing = true
  conn.state = 'stopped'
  logLine(id, `[lifecycle] disconnect: ${reason}`)
  if (conn.child) killTree(conn.child)
  conn.child = null
  conn.tools = []
  conn.exposed = []
  rejectAllPending(conn, new Error('MCP 连接已断开'))
  conns.delete(id)
  rebuildExposed()
  emitStatus(id)
}

export function disconnectAll(): void {
  for (const id of [...conns.keys()]) disconnect(id, '应用退出')
}

/** 全局名字重排：内置工具名让位，MCP 之间按登记顺序先到先得，冲突方加 `<serverId>_` 前缀 */
function rebuildExposed(): void {
  exposedMap.clear()
  const used = new Set(reservedNames)
  for (const conn of conns.values()) {
    conn.exposed = conn.tools.map(t => {
      let name = t.originalName
      if (used.has(name)) name = `${conn.cfg.id}_${t.originalName}`
      used.add(name)
      exposedMap.set(name, { serverId: conn.cfg.id, originalName: t.originalName })
      return name
    })
  }
}

/** 确保给定技能（已勾选）绑定的服务都已连接；失败不抛，收集在 failed 里 */
export async function prepareForSkills(
  enabledSkills: string[],
  overallTimeoutMs = 30000
): Promise<{ ok: string[]; failed: McpStatus[] }> {
  const cfgs = serversForSkillKeys(enabledSkills)
  const ok: string[] = []
  const failed: McpStatus[] = []
  if (!cfgs.length) return { ok, failed }

  const jobs = cfgs.map(async cfg => {
    try {
      await connect(cfg)
      ok.push(cfg.id)
    } catch (e: any) {
      failed.push(statusById(cfg.id))
      logLine(cfg.id, `[prepare] failed: ${e?.message || e}`)
    }
  })
  // 总时长有上限：某个服务一直连不上也不能拖住对话（后台继续重试由下一轮 prepare 接手）
  const guard = new Promise(res => setTimeout(res, overallTimeoutMs))
  await Promise.race([Promise.allSettled(jobs), guard])
  return { ok, failed }
}

/** 同步读取：已连接服务暴露的工具定义（OpenAI function 格式） */
export function cachedToolDefinitions(enabledSkills: string[]): any[] {
  // 按**裸 id** 比较（1.0.50）：服务登记里存的是绑定那一刻的来源前缀（user:/builtin:），
  // 而用户勾选的是当前这一份（同一技能加了内置版后 key 就从 user: 变 builtin:）。
  // 按完整 key 比较会让「已连接的工具」凭空消失 —— 表现为勾了技能却一个 MCP 工具都没有。
  const keys = new Set((enabledSkills || []).map(bareSkillId).filter(Boolean))
  const out: any[] = []
  for (const conn of conns.values()) {
    if (conn.state !== 'connected' || !conn.cfg.skillKey) continue
    if (!keys.has(bareSkillId(conn.cfg.skillKey))) continue
    conn.tools.forEach((t, i) => {
      out.push({
        type: 'function',
        function: {
          name: conn.exposed[i],
          description: t.description || `MCP 工具（服务：${conn.cfg.name}）`,
          parameters: t.inputSchema || { type: 'object', properties: {} }
        }
      })
    })
  }
  return out
}

export function cachedToolNames(enabledSkills: string[]): string[] {
  return cachedToolDefinitions(enabledSkills).map(d => d.function.name)
}

/** 该对外名是否是 MCP 工具 */
export function isMcpTool(exposedName: string): boolean {
  return exposedMap.has(exposedName)
}

/** 查询 MCP 工具的归属（dispatchTool 据此校验「绑定的技能是否在本会话启用」） */
export function getMcpToolRoute(exposedName: string): { serverId: string; originalName: string; skillKey: string } | undefined {
  const route = exposedMap.get(exposedName)
  if (!route) return undefined
  const conn = conns.get(route.serverId)
  return { ...route, skillKey: conn?.cfg.skillKey || getServerRaw(route.serverId)?.skillKey || '' }
}

/** 转发 tools/call。AbortError 向上抛（与内置工具的中止约定一致） */
export async function callTool(
  exposedName: string,
  input: unknown,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<{ ok: boolean; text: string; raw?: any }> {
  const route = exposedMap.get(exposedName)
  if (!route) throw new Error(`MCP 工具不存在或服务未连接：${exposedName}`)
  const conn = conns.get(route.serverId)
  if (!conn || conn.state !== 'connected' || !conn.child) {
    throw new Error(`MCP 服务未连接：${route.serverId}（可在 Skills → MCP 服务里测试连接）`)
  }
  conn.lastUsed = Date.now()
  const cfgTimeout = Number(conn.cfg.timeoutMs) > 0 ? Number(conn.cfg.timeoutMs) : 60000
  const result = await request<any>(conn, 'tools/call', {
    name: route.originalName,
    arguments: input && typeof input === 'object' ? input : {}
  }, timeoutMs || cfgTimeout, signal)

  const parts: string[] = []
  for (const c of Array.isArray(result?.content) ? result.content : []) {
    if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text)
    else if (c?.type === 'image' && c.data) parts.push(`![图片](data:${c.mimeType || 'image/png'};base64,${c.data})`)
    else if (c?.type === 'resource') parts.push(`[resource] ${JSON.stringify(c.resource || {}).slice(0, 2000)}`)
  }
  const text = parts.join('\n\n') || (result?.structuredContent ? JSON.stringify(result.structuredContent) : '')
  return { ok: result?.isError !== true, text, raw: result }
}

// ── 依赖一键准备 ────────────────────────────────────────────────────────────────
export function cancelInstall(id: string): void {
  installs.get(id)?.abort(new DOMException('Aborted', 'AbortError'))
}

/**
 * 判断 `dir` 是否位于内置技能根目录下（1.0.52）。
 *
 * 用 `relative` 而不是 `startsWith`：后者会把 `…/skills-backup` 误判成在 `…/skills` 内。
 * Windows 上 `path.win32.relative` 大小写不敏感，所以无需另行规范化大小写。
 */
function isInsideBuiltinRoot(dir: string): boolean {
  if (!dir) return false
  try {
    const rel = relative(resolve(builtinRoot()), resolve(dir))
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  } catch { return false }
}

/**
 * 为「一键准备依赖」准备一个**能跑、且不会随应用更新被抹掉**的工作目录。
 *
 * ── 1.0.50 的原判据（已废弃）──
 * 用「是否可写」决定要不要迁移到 `userData` 副本：不可写（Program Files）就迁移。
 *
 * ── 1.0.52 为什么必须改（用户实测「装好了、过几天又被要求重新安装」）──
 * per-user NSIS 默认装到 `%LOCALAPPDATA%\Programs\<productName>`，**这个目录用户是有写权限的**，
 * 于是 `accessSync(W_OK)` 判定通过 → 原地 `npm install` → `node_modules` 直接落进
 * `<安装目录>\resources\skills\<skill>\runtime\`。而下一次应用更新时 electron-builder
 * 会用新包覆盖 `resources/`，且 `electron-builder.yml` 里该技能的 filter 明确排除了
 * node_modules（`**` + `node_modules` + `**`）—— 覆盖后依赖必然消失，
 * `checkDependencies`（有 package.json、没 node_modules）于是又判定「需要安装」。
 * 用户填的 `createdAt` 是 2026-10-06、跨了一次 1.0.50→1.0.51 更新后症状复现，时间线吻合。
 *
 * ── 判据为什么是「有没有 node_modules」而不是「在不在安装目录内」──
 * 内置技能分两类，`electron-builder.yml` 对它们的处理**故意不同**：
 *   - `tech-agent-skill`：filter 排除 node_modules → 装不了 → **必须**用副本；
 *   - `file-office-local`：node_modules 随包分发 → 开箱即用 → **不能**迁移。
 * 若按「在安装目录内就迁移」一刀切，后者会被复制到副本，而白名单拷贝里没有 node_modules
 * （见下方 items），副本就没了依赖，只能重装全部 —— 这会让「随包分发省掉安装」的设计彻底失效，
 * 并给所有 file-office-local 用户凭空加一个「升级后要重装依赖」的新问题。
 *
 * 所以第一条判据是**这个目录能不能直接跑**（node_modules 在不在）；只有在它跑不起来时，
 * 才去判断「该不该落到用户目录」（是不是安装内容 / 是不是不可写）。前者是主判据，后者是兜底。
 *
 * 用白名单拷贝而不是整目录递归：既避免放大成几十 MB，也正是上面那条例外成立的前提。
 */
function prepareWritableRuntime(
  cfg: McpServerConfig,
  cwd: string
): { dir: string; migrated: boolean; error?: string } {
  // ① 已经有 node_modules → 直接用它：不装、不迁、不动登记的 cwd。
  //    命中两类：随包分发的 file-office-local；dev 下仓库里已 npm install 过的副本。
  if (existsSync(join(cwd, 'node_modules'))) return { dir: cwd, migrated: false }

  const inBuiltin = isInsideBuiltinRoot(cwd)
  let writable = false
  try {
    accessSync(cwd, constants.W_OK)
    writable = true
  } catch { /* 不可写 → 走迁移 */ }
  // ② 用户自己指定的目录 → 原地安装，行为与 1.0.50 一致
  if (!inBuiltin && writable) return { dir: cwd, migrated: false }

  const dst = join(LOG_DIR(), cfg.id, 'runtime')

  /**
   * ③ 幂等短路：副本里已经有 package.json + node_modules → 直接复用。
   *
   * 为什么需要：迁移只该发生一次，但「一键准备依赖」是用户随时能点的按钮。没有短路时
   * 每次点击都会重跑一遍拷贝 + 完整 `npm install`（钉钉技能带 playwright，要几十秒），
   * 而结果其实早就有了。顺带把登记的 cwd 纠正到副本 —— 1.0.50 那批
   * 「装完但 cwd 仍指向只读目录」的老数据靠这一步纠正回来。
   */
  if (existsSync(join(dst, 'package.json')) && existsSync(join(dst, 'node_modules'))) {
    const alreadyOnCopy = !!String(cfg.cwd || '').trim() && resolve(String(cfg.cwd)) === resolve(dst)
    if (!alreadyOnCopy) {
      try {
        saveServer({ id: cfg.id, cwd: dst })
        logLine(cfg.id, `[install] 依赖已就绪，复用可写副本并纠正登记的 cwd：${dst}`)
      } catch (e: any) {
        return { dir: dst, migrated: true, error: `副本已就绪（${dst}），但更新登记的工作目录失败：${e?.message || e}` }
      }
    }
    return { dir: dst, migrated: !alreadyOnCopy }
  }

  // ④ 安装内容内 / 不可写 → 复制最小集合到 userData 副本
  const items = ['package.json', 'package-lock.json', 'src']
  try {
    mkdirSync(dst, { recursive: true })
    for (const name of items) {
      const from = join(cwd, name)
      if (!existsSync(from)) continue
      cpSync(from, join(dst, name), { recursive: true, force: true })
    }
    logLine(cfg.id, `[install] 工作目录位于安装内容内（或只读），已复制到可写副本：${dst}`)
  } catch (e: any) {
    return { dir: cwd, migrated: false, error: `复制到可写目录失败：${e?.message || e}` }
  }
  // 持久化：把登记的 cwd 切到副本，否则这次装完，下次连接仍指向只读目录、直接启动失败
  try {
    saveServer({ id: cfg.id, cwd: dst })
  } catch (e: any) {
    return { dir: dst, migrated: true, error: `已复制到 ${dst}，但更新登记的工作目录失败：${e?.message || e}` }
  }
  return { dir: dst, migrated: true }
}

/**
 * 在服务工作目录执行依赖安装（默认 `npm install --no-audit --no-fund`，走 npmmirror 镜像，
 * 与该技能自带的 install:fast 一致；可用条目的 installArgs 覆盖）。
 * 进度按行推给 onProgress；可取消（杀整棵进程树）；不静默执行（由 UI 先征求用户同意）。
 */
export async function installDependencies(
  cfg: McpServerConfig,
  onProgress: (line: string) => void,
  signal?: AbortSignal
): Promise<{ ok: boolean; error?: string }> {
  if (installs.has(cfg.id)) return { ok: false, error: '该服务的依赖安装已在进行中' }
  const ac = new AbortController()
  installs.set(cfg.id, ac)
  const link = () => ac.abort(new DOMException('Aborted', 'AbortError'))
  signal?.addEventListener('abort', link, { once: true })
  const cwd = resolvedCwd(cfg)
  logLine(cfg.id, `[install] start cwd=${cwd}（原始值 ${String(cfg.cwd || '')}）`)

  try {
    if (!cwd) return { ok: false, error: '未设置工作目录：请在登记条目里填 MCP 服务所在目录（含 package.json）' }
    if (!existsSync(cwd)) return { ok: false, error: `工作目录不存在：${cwd}（环境变量未展开或路径无效）` }
    // 1.0.57：装依赖的同时把运行配置落位（幂等；此时 cwd 还指着技能目录，能读到 templates/）。
    // 「准备依赖」通常是新机器上的第一步，把配置一起备好，用户接着点「测试连接」就不会
    // 因为「配置文件不存在」直接失败。
    try {
      const cfgPrep = ensureRuntimeConfig(cfg)
      if (cfgPrep.created) {
        logLine(cfg.id, `[config] 已自动生成本机配置 → ${cfgPrep.path}`)
        onProgress(`> 已生成本机运行配置: ${cfgPrep.path}`)
        cfg = getServerRaw(cfg.id) || cfg
      } else if (cfgPrep.skipped === 'error') {
        logLine(cfg.id, `[config] 自动生成失败：${cfgPrep.error || ''}`)
      }
    } catch (e: any) {
      logLine(cfg.id, `[config] 自动生成失败：${e?.message || e}`)
    }
    // 只读目录（典型：安装版的内置技能目录）→ 先复制到 userData 可写副本再装
    const prep = prepareWritableRuntime(cfg, cwd)
    if (prep.error) return { ok: false, error: prep.error }
    const workDir = prep.dir
    if (prep.migrated) logLine(cfg.id, `[install] 改用可写副本安装：${workDir}`)
    if (!existsSync(join(workDir, 'package.json'))) {
      return { ok: false, error: `工作目录没有 package.json：${workDir}` }
    }
    const node = await ensureNodeWithNpm(ac.signal)
    if (!node) {
      return {
        ok: false,
        error: '没有可用的 npm（当前只有 Electron 内置 Node，且 Node 22 自举未完成）。请先在「MC 查询」技能里触发一次 Node 准备，或手动在服务目录执行 npm install'
      }
    }
    const npmCli = resolveNpmCli()
    if (!npmCli) return { ok: false, error: 'npm-cli.js 缺失，无法自动安装；请手动在服务目录执行 npm install' }

    const base = Array.isArray(cfg.installArgs) && cfg.installArgs.length
      ? cfg.installArgs
      : ['install', '--no-audit', '--no-fund', '--registry=https://registry.npmmirror.com']
    const argv = [npmCli, ...base]
    logLine(cfg.id, `[install] ${node.path} ${argv.join(' ')}（cwd=${workDir}）`)
    onProgress(`> ${base.join(' ')}`)

    const child = spawn(node.path, argv, {
      cwd: workDir,
      // playwright 的 postinstall 会**另外下载一份 Chromium（约 150MB）**。本技能登录时
      // 优先复用本机已装的 Google Chrome / Edge，两者都没有才需要浏览器
      //（见 skills/tech-agent-skill/references/setup-mcp.md），所以这里统一跳过浏览器下载。
      // 此前没设这个变量：装一次依赖会静默多下 150MB，与文档要求也不一致。
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const onAbort = () => killTree(child)
    ac.signal.addEventListener('abort', onAbort, { once: true })

    const code: number | null = await new Promise(resolve => {
      let tail = ''
      const pump = (chunk: Buffer) => {
        for (const line of chunk.toString().split(/\r?\n/)) {
          const t = line.trim()
          if (!t) continue
          tail = (tail + '\n' + t).slice(-2000)
          onProgress(t)
          logLine(cfg.id, `[install] ${t}`)
        }
      }
      child.stdout?.on('data', pump)
      child.stderr?.on('data', pump)
      child.on('error', (e: Error) => { onProgress(`启动失败：${e.message}`); resolve(-1) })
      child.on('close', resolve)
    })
    ac.signal.removeEventListener('abort', onAbort)

    if (ac.signal.aborted) return { ok: false, error: '已取消' }
    if (code !== 0) {
      return { ok: false, error: `npm install 退出码 ${code}（详见日志）` }
    }
    logLine(cfg.id, '[install] done')
    onProgress('依赖安装完成')
    return { ok: true }
  } catch (e: any) {
    const aborted = e?.name === 'AbortError'
    return aborted ? { ok: false, error: '已取消' } : { ok: false, error: String(e?.message || e) }
  } finally {
    installs.delete(cfg.id)
    signal?.removeEventListener('abort', link)
  }
}

// ── 空闲回收与退出清理 ──────────────────────────────────────────────────────────
function ensureIdleReaper(): void {
  if (idleTimer) return
  idleTimer = setInterval(() => {
    const now = Date.now()
    for (const [id, conn] of conns) {
      if (conn.state === 'connected' && now - conn.lastUsed > IDLE_DISCONNECT_MS) {
        disconnect(id, `空闲超过 ${Math.round(IDLE_DISCONNECT_MS / 60000)} 分钟`)
      }
    }
  }, 60 * 1000)
  // 不阻止进程退出
  if (idleTimer.unref) idleTimer.unref()
}

// 应用退出统一断开（含杀 MCP 子进程树）
app.on('will-quit', () => {
  try { disconnectAll() } catch { /* ignore */ }
  if (idleTimer) clearInterval(idleTimer)
})

export function touchMcpRuntime(): void {
  ensureIdleReaper()
}
