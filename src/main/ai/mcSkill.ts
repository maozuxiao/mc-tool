import { app } from 'electron'
import { spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { execFile } from 'child_process'
import type { AIToolRun } from '@shared/ai-types'

const execFileAsync = promisify(execFile)

// 系统提示语。uiLang 只作为「提问语言无法判断时」的兜底，
// 主规则是「回复语言跟随提问语言」，所以英文提问就该英文回复。
export function mcSkillSystemPrompt(uiLang: 'zh' | 'en' = 'zh'): string {
  const uiLangName = uiLang === 'en' ? 'English' : '中文'
  return `你是 MC Tool 的 AI 物料助手。
你可以调用 mc_query 工具查询锐明 OA MC 物料数据。请遵守：
1. 涉及料号、物料描述、库存、生命周期、BOM、规格文件、物料对比时，必须优先调用 mc_query，不要凭记忆编造。
2. 生命周期为退市、禁购、禁用时，必须给出明显风险警告。
3. 描述含 IMX307 的物料，必须提示替代料号信息；如果查询结果中 imx307_replacement 为空数组，要明确说明未找到映射记录。
4. 批量查询时不要并发，一次 mc_query 可传入多个料号参数。
5. 回复语言：默认与用户提问所用语言保持一致（英文提问用英文回复，中文提问用中文回复）。
   - 用户明确指定回复语言时，以用户指定为准。
   - 提问语言无法判断时（例如只有一个料号、一串编码），使用应用界面语言：${uiLangName}。
   - 物料字段值（生命周期状态、单位、型号等）保留原始返回值，必要时在括号中给出翻译。
6. 结果适合业务人员阅读；表格使用 Markdown。
7. 规格文件默认只查询列表，不主动下载；如需下载，先向用户确认保存位置。

再次强调：除用户明确指定外，回复语言必须与用户本轮提问的语言一致。`
}

// 兼容旧引用：不带界面语言时的默认提示语
export const MC_SKILL_SYSTEM_PROMPT = mcSkillSystemPrompt('zh')

function getSkillRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'skills', 'mc-material-query-local')
    : join(app.getAppPath(), 'resources', 'skills', 'mc-material-query-local')
}

export function getMcSkillDescription(): string {
  const path = join(getSkillRoot(), 'SKILL.md')
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
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

async function getNodePath(signal?: AbortSignal): Promise<string> {
  if (process.platform === 'win32') {
    try {
      const out = await abortable(execFileAsync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        join(getSkillRoot(), 'scripts', 'ensure_node.ps1')
      ], { timeout: 120000 }), signal)
      const lines = String(out.stdout).trim().split(/\r?\n/)
      const nodePath = lines.filter(Boolean).pop()
      if (nodePath && existsSync(nodePath)) return nodePath
    } catch (e: any) {
      if (e.name === 'AbortError') throw e
    }
  }
  return process.execPath
}

export const MC_QUERY_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'mc_query',
    description: '查询锐明 OA MC 物料系统。支持 search（描述搜索）、item（单料号）、batch（批量料号）、bom（BOM）、spec（规格文件列表）。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['search', 'item', 'batch', 'bom', 'spec'] },
        args: { type: 'array', items: { type: 'string' }, description: '子命令参数，例如料号或描述关键词' }
      },
      required: ['command', 'args']
    }
  }
}

function validateInput(input: any): { command: string; args: string[] } {
  const allowed = new Set(['search', 'item', 'batch', 'bom', 'spec'])
  const command = String(input?.command || '')
  if (!allowed.has(command)) throw new Error(`不支持的 MC 查询命令: ${command}`)
  const args = Array.isArray(input?.args) ? input.args.map((x: any) => String(x)) : []
  if (!args.length) throw new Error('MC 查询参数不能为空')
  if (args.length > 50) throw new Error('单次最多查询 50 个参数')
  if (args.some((x: any) => !x.trim() || x.length > 500 || /[\r\n\0]/.test(x))) throw new Error('MC 查询参数包含非法字符')
  return { command, args }
}

// onRun 同时承担「创建」与「更新」两个职责：首次调用传入 running 态、回传落库后的 id；
// 后续调用传入带 id 的完整 run 做更新。因此入参允许可选 id，返回值保证带 id。
type McRunSink = (run: Omit<AIToolRun, 'id'> & { id?: string }) => { id: string }

export async function runMcQuery(input: any, onRun?: McRunSink, signal?: AbortSignal): Promise<any> {
  const { command, args } = validateInput(input)
  const started = Date.now()
  const run = {
    toolName: 'mc_query',
    input: { command, args },
    status: 'running' as const,
    summary: `正在查询 MC：${command} ${args.join(' ')}`
  }
  const persisted = onRun ? { ...run, ...onRun({ ...run }) } : { ...run, id: 'temp' }
  if (signal?.aborted) {
    const patch = { output: { error: '已取消' }, summary: '已取消', status: 'error' as const, durationMs: 0 }
    if (onRun) onRun({ ...persisted, ...patch })
    throw new DOMException('Aborted', 'AbortError')
  }
  try {
    const node = await getNodePath(signal)
    const script = join(getSkillRoot(), 'scripts', 'mc_query.js')
    if (!existsSync(script)) throw new Error('内置 MC 查询脚本不存在')

    const child = spawn(node, [script, command, ...args, '--json'], {
      cwd: getSkillRoot(),
      windowsHide: true,
      env: { ...process.env, MC_TOOL_AUTH_MODE: 'app' }
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })

    const cleanupAbort = () => {
      if (!child.killed) {
        child.kill('SIGTERM')
        setTimeout(() => { if (!child.killed) child.kill('SIGKILL') }, 5000)
      }
    }
    signal?.addEventListener('abort', cleanupAbort, { once: true })

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })

    signal?.removeEventListener('abort', cleanupAbort)
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    const match = stdout.match(/===JSON_BEGIN===\s*([\s\S]*?)\s*===JSON_END===/)
    if (exitCode !== 0 || !match) {
      const errorText = `${stderr}\n${stdout}`.trim()
      if (/session|cookie|登录|auth/i.test(errorText)) throw new Error('OA 登录状态已失效，请重新扫码登录后再试')
      throw new Error(errorText || `MC 查询失败（exit ${exitCode}）`)
    }
    const result = JSON.parse(match[1])
    const summary = summarize(command, result)
    const patch = { output: result, summary, status: 'done' as const, durationMs: Date.now() - started }
    if (onRun) onRun({ ...persisted, ...patch })
    return { result, toolRunId: persisted.id, summary }
  } catch (e: any) {
    if (e.name === 'AbortError') {
      const patch = { output: { error: '已取消' }, summary: '已取消', status: 'error' as const, durationMs: Date.now() - started }
      if (onRun) onRun({ ...persisted, ...patch })
      throw e
    }
    const patch = { output: { error: e.message }, summary: e.message, status: 'error' as const, durationMs: Date.now() - started }
    if (onRun) onRun({ ...persisted, ...patch })
    throw e
  }
}

function summarize(command: string, result: any): string {
  if (command === 'batch') {
    const items = result?.items || []
    return `批量查询完成：${items.filter((x: any) => x.found).length}/${items.length} 个料号命中`
  }
  if (command === 'bom') return `BOM 查询完成：${(result?.bomRows || []).length} 个子项`
  if (command === 'spec') return `规格文件查询完成：${(result?.files || []).length} 个文件`
  return `物料查询完成：${(result?.rows || []).length} 条记录`
}
