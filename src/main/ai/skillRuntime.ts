import { app } from 'electron'
import { spawn, execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { execFile } from 'child_process'

const execFileAsync = promisify(execFile)

export const SKILL_MATERIAL = 'mc-material-query-local'
export const SKILL_FILE = 'file-office-local'

/**
 * skill 根目录解析。
 * 优先查 userData/skills/<name>：为「按需下载 / 热更新 skill」预留，
 * 将来把 skill 包解压到这里即可覆盖内置版本，无需重新发版。
 * 回退到随安装包分发的 resources/skills/<name>。
 */
export function getSkillRoot(name: string): string {
  try {
    const userDir = join(app.getPath('userData'), 'skills', name)
    if (existsSync(join(userDir, 'scripts'))) return userDir
  } catch { /* userData 不可用时直接走内置目录 */ }

  return app.isPackaged
    ? join(process.resourcesPath, 'skills', name)
    : join(app.getAppPath(), 'resources', 'skills', name)
}

export function getSkillScript(name: string, script: string): string {
  return join(getSkillRoot(name), 'scripts', script)
}

export function skillExists(name: string, script: string): boolean {
  return existsSync(getSkillScript(name, script))
}

/**
 * 把 Promise 与 AbortSignal 绑定。skill 脚本可能长时间阻塞（下载 Node、
 * 解析大文件），用户点「停止」时必须能真正中断，而不是等它自己跑完。
 */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v) },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e) }
    )
  })
}

/**
 * 取得 node 可执行文件路径。
 * Windows 上优先跑 skill 自带的 ensure_node.ps1 自举（缺失时自动下载 Node 22），
 * 保证脚本运行环境与 skill 的要求一致；失败则退回当前 Electron 的 node。
 */
export async function getNodePath(skillRoot: string, signal?: AbortSignal): Promise<string> {
  if (process.platform === 'win32') {
    try {
      const out = await abortable(execFileAsync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        join(skillRoot, 'scripts', 'ensure_node.ps1')
      ], { timeout: 120000 }), signal)
      const lines = String(out.stdout).trim().split(/\r?\n/)
      const nodePath = lines.filter(Boolean).pop()
      if (nodePath && existsSync(nodePath)) return nodePath
    } catch (e: any) {
      if (e.name === 'AbortError') throw e
      // 自举失败不致命：退回 Electron 内置 node
    }
  }
  return process.execPath
}

/**
 * 杀掉整个进程树。
 * Windows 上 child.kill() 只杀直接子进程（如 powershell.exe），
 * 它启动的孙进程（node / npm）会变成孤儿继续运行，
 * 必须 taskkill /t 才能连根拔掉。
 */
function killTree(child: ReturnType<typeof spawn>) {
  const pid = child.pid
  if (!pid || child.killed) return
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      return
    } catch { /* 落到下面的通用 kill */ }
  }
  try { child.kill('SIGTERM') } catch { /* 已退出 */ }
  setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }, 3000)
}

export interface RunSkillOptions {
  skillName: string
  script: string
  args?: string[]
  /** 额外环境变量（会与 process.env 合并） */
  env?: Record<string, string>
  /** 超时毫秒数，默认 120s */
  timeoutMs?: number
  signal?: AbortSignal
  /** 脚本工作目录，默认 skill 根目录 */
  cwd?: string
}

export interface SkillResult {
  /** stdout 中 ===JSON_BEGIN===/===JSON_END=== 之间解析出的对象 */
  json: any
  /** 脚本原始 stdout（不含 JSON 标记块） */
  stdout: string
  stderr: string
  exitCode: number | null
}

/**
 * 执行 skill 脚本并提取结构化结果。
 * 契约：脚本必须把结果 JSON 打印在 ===JSON_BEGIN=== / ===JSON_END=== 之间
 * （与 mc_query.js 一致），其余 stdout 内容视为进度日志。
 */
export async function runSkill(opts: RunSkillOptions): Promise<SkillResult> {
  const { skillName, script, args = [], env, timeoutMs = 120000, signal } = opts
  const skillRoot = getSkillRoot(skillName)
  const scriptPath = getSkillScript(skillName, script)
  if (!existsSync(scriptPath)) {
    throw new Error(`内置技能脚本缺失：${skillName}/${script}（目录：${skillRoot}）`)
  }

  const node = await getNodePath(skillRoot, signal)
  const child = spawn(node, [scriptPath, ...args], {
    cwd: opts.cwd || skillRoot,
    windowsHide: true,
    env: { ...process.env, ...(env || {}) }
  })

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', chunk => { stdout += chunk.toString() })
  child.stderr?.on('data', chunk => { stderr += chunk.toString() })

  const cleanupAbort = () => killTree(child)
  signal?.addEventListener('abort', cleanupAbort, { once: true })

  const timer = timeoutMs > 0
    ? setTimeout(() => killTree(child), timeoutMs)
    : null

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('error', () => resolve(null))
    child.on('close', resolve)
  })

  signal?.removeEventListener('abort', cleanupAbort)
  if (timer) clearTimeout(timer)

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  const match = stdout.match(/===JSON_BEGIN===\s*([\s\S]*?)\s*===JSON_END===/)
  const log = stdout.replace(/===JSON_BEGIN===[\s\S]*?===JSON_END===/, '').trim()

  if (!match) {
    // 没有 JSON 标记说明脚本崩了或超时被杀：把日志尾部带出去便于排查
    const tail = (stderr || stdout || '').trim().split(/\r?\n/).slice(-12).join('\n')
    throw new Error(`技能未返回结构化结果（${skillName} exit=${exitCode}）\n${tail}`)
  }

  let json: any
  try {
    json = JSON.parse(match[1])
  } catch (e: any) {
    throw new Error(`技能返回结果解析失败：${e.message}\n${match[1].slice(0, 500)}`)
  }

  return { json, stdout: log, stderr, exitCode }
}
