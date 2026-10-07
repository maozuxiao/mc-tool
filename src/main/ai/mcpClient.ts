import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { appendFileSync, accessSync, constants, cpSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { bareSkillId } from '@shared/ai-types'
import type { McpEvent, McpServerConfig, McpState, McpStatus } from '@shared/ai-types'
import { ensureNodeWithNpm, killTree, resolveNodeBinary, resolveNpmCli } from './skillRuntime'
import { getServerRaw, listServers, saveServer, serversForSkillKeys } from './mcpStore'
import { skillDirOf } from './skillRegistry'

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
 * 解析一个 MCP 服务的工作目录（1.0.50）。
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
 * 注意「dev 下推断出仓库路径」是**预期行为**而非异常：那正是 `skillDirOf` 在未打包时
 * 按 `app.getAppPath()/resources/skills` 定位的结果，打包后会自然指向安装目录。
 */
function resolvedCwd(cfg: McpServerConfig): string {
  const filled = expandVars(String(cfg.cwd || ''))
  if (filled && existsSync(filled)) return filled
  if (!filled) {
    // 没填才推断：避免把「填错了」静默改写成别处、让用户找不到问题出在哪
    const inferred = inferRuntimeDir(cfg.skillKey)
    if (inferred) return inferred
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
  const dep = checkDependencies({ cwd: cfg?.cwd || '' })
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
        rejectAllPending(conn, new Error('MCP 进程已退出'))
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
      conn.error = aborted
        ? '连接被中止'
        : `${e?.message || e}${detectNeedsInstall(stderrTail) ? '；' + detectNeedsInstall(stderrTail) : ''}`
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
 * 为「一键准备依赖」准备一个**可写**的工作目录（1.0.50）。
 *
 * 为什么要这一步：内置技能的 runtime 源码随安装包分发在 `process.resourcesPath/skills/…`，
 * 打包后位于 Program Files，普通用户**没有写权限** —— 在那里跑 `npm install` 必然失败
 * （EPERM / EACCES）。而 dev 模式下同一个路径是仓库目录、**是可写的**，
 * 所以「dev 能装上依赖」完全不能证明「安装版能装」，必须用运行时探测而非版本分支来判断。
 *
 * - 可写（dev、或用户已把服务放在自己的可写目录）→ 原地安装，行为不变，也**不会覆盖已有依赖**；
 * - 不可写 → 把运行/安装所需的**最小集合**复制到 `userData/mcp/<id>/runtime`，
 *   并把登记项的 cwd 切到该副本，之后「测试连接」与后续重装都落在副本上。
 *
 * 用白名单拷贝而不是整目录递归：万一今后有人把 node_modules 塞进内置包，
 * 也不会被原样复制放大成几十 MB。
 */
function prepareWritableRuntime(
  cfg: McpServerConfig,
  cwd: string
): { dir: string; migrated: boolean; error?: string } {
  try {
    accessSync(cwd, constants.W_OK)
    return { dir: cwd, migrated: false }
  } catch { /* 不可写 → 走迁移 */ }

  const dst = join(LOG_DIR(), cfg.id, 'runtime')
  const items = ['package.json', 'package-lock.json', 'src']
  try {
    mkdirSync(dst, { recursive: true })
    for (const name of items) {
      const from = join(cwd, name)
      if (!existsSync(from)) continue
      cpSync(from, join(dst, name), { recursive: true, force: true })
    }
    logLine(cfg.id, `[install] 工作目录只读，已复制到可写副本：${dst}`)
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
