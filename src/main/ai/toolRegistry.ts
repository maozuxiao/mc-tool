import type { AIAgentMode } from '@shared/ai-types'
import { MC_QUERY_TOOL_DEFINITION, runMcQuery, type McRunSink } from './mcSkill'
import { FILE_TOOL_DEFINITIONS, fileSkillRead, runFileSkillCommand } from './fileSkill'

/**
 * 工具执行上下文。
 * onRun 由调用方构造（已绑定本次工具运行的 run id），工具只需按需回调，
 * 不必关心 UI 卡片是怎么落库的。
 */
export interface ToolContext {
  signal: AbortSignal
  /** Build 模式的工作区根目录，文件/命令工具据此限制范围 */
  workspaceRoot?: string
  onRun?: McRunSink
}

interface ToolEntry {
  definition: any
  run: (input: any, ctx: ToolContext) => Promise<any>
}

const REGISTRY: Record<string, ToolEntry> = {
  mc_query: {
    definition: MC_QUERY_TOOL_DEFINITION,
    run: (input, ctx) => runMcQuery(input, ctx.onRun, ctx.signal)
  },
  file_read: {
    definition: FILE_TOOL_DEFINITIONS[0],
    run: async (input, ctx) => {
      const root = ctx.workspaceRoot
      if (!root) {
        return { ok: false, error: 'NO_WORKSPACE', message: '未选择工作区目录，无法读取文件。请先在工具栏选择工作区。' }
      }
      const p = String(input?.path || '').trim()
      if (!p) return { ok: false, error: 'MISSING_ARG', message: '缺少 path 参数' }
      return fileSkillRead({
        root,
        path: p,
        offset: Number.isFinite(Number(input?.offset)) ? Number(input.offset) : undefined,
        limit: Number.isFinite(Number(input?.limit)) ? Number(input.limit) : undefined,
        signal: ctx.signal
      })
    }
  },
  file_list: {
    definition: FILE_TOOL_DEFINITIONS[1],
    run: async (input, ctx) => {
      if (!ctx.workspaceRoot) return { ok: false, error: 'NO_WORKSPACE', message: '未选择工作区目录。' }
      const args = []
      if (input?.path) args.push(input.path)
      return runFileSkillCommand('list', args, ctx.workspaceRoot, ctx.signal, 30000)
    }
  },
  file_search: {
    definition: FILE_TOOL_DEFINITIONS[2],
    run: async (input, ctx) => {
      if (!ctx.workspaceRoot) return { ok: false, error: 'NO_WORKSPACE', message: '未选择工作区目录。' }
      const args = [String(input?.query || '')]
      if (input?.path) args.push(input.path)
      if (input?.nameOnly) args.push('--name-only')
      return runFileSkillCommand('search', args, ctx.workspaceRoot, ctx.signal, 30000)
    }
  },
  file_write: {
    definition: FILE_TOOL_DEFINITIONS[3],
    run: async (input, ctx) => {
      if (!ctx.workspaceRoot) return { ok: false, error: 'NO_WORKSPACE', message: '未选择工作区目录。' }
      const p = String(input?.path || '').trim()
      if (!p) return { ok: false, error: 'MISSING_ARG', message: '缺少 path 参数' }
      const content = String(input?.content ?? '')
      const args = [p, '--content', content]
      if (input?.append) args.push('--append')
      return runFileSkillCommand('write', args, ctx.workspaceRoot, ctx.signal, 30000)
    }
  }
}

/** 该模式下允许调用的工具名，用于兜底拦截模型臆造的工具调用 */
export function toolNamesForMode(mode: AIAgentMode, hasWorkspace: boolean): string[] {
  if (mode === 'ask') return []
  if (mode === 'mc') return ['mc_query']
  return hasWorkspace ? ['mc_query', ...FILE_TOOL_DEFINITIONS.map(t => t.function.name)] : ['mc_query']
}

/**
 * 按模式生成下发给大模型的 tools 数组。
 * ask 模式必须返回空数组：不下发工具定义，模型才不会去「调用」不存在的工具。
 */
export function toolsForMode(mode: AIAgentMode, hasWorkspace: boolean): any[] {
  if (mode === 'ask') return []
  if (mode === 'mc') return [MC_QUERY_TOOL_DEFINITION]
  // build：没选工作区时只保留 mc_query，避免模型调用必定失败的文件工具
  return hasWorkspace ? [MC_QUERY_TOOL_DEFINITION, ...FILE_TOOL_DEFINITIONS] : [MC_QUERY_TOOL_DEFINITION]
}

// 非 mc_query 工具没有 runMcQuery 那种「内部回调 onRun」机制，
// 这里统一在结束时补发一次终态，让 UI 工具卡片能从转圈变成完成。
function buildFileSummary(name: string, result: any): string {
  if (!result || result.ok === false) return `失败：${result?.error || '未知错误'}`
  switch (name) {
    case 'file_read': return `已读取 ${result.relative || result.path}`
    case 'file_list': return `已列出 ${result.count ?? 0} 项`
    case 'file_search': return `找到 ${result.count ?? 0} 个匹配`
    case 'file_write': return `已写入 ${result.relative || result.path}`
    default: return `已完成 ${name}`
  }
}

/**
 * 分发工具调用。
 * - 用户中止（AbortError）必须向上抛，让调用方中断整个循环；
 * - 其余错误转成结构化结果回给模型，让它知道失败原因并自行改策略
 *   （例如换个路径、分段读取），而不是让整轮对话直接崩掉；
 * - mc_query 在 runMcQuery 内部已自行回调 onRun，这里跳过避免重复。
 */
export async function dispatchTool(name: string, input: any, ctx: ToolContext): Promise<any> {
  const entry = REGISTRY[name]
  if (!entry) return { error: `不支持的工具：${name}` }
  const start = Date.now()
  const finish = (result: any, status: 'done' | 'error') => {
    if (ctx.onRun && name !== 'mc_query') {
      ctx.onRun({
        toolName: name,
        input,
        status,
        summary: buildFileSummary(name, result),
        output: result,
        durationMs: Date.now() - start
      })
    }
  }
  try {
    const result = await entry.run(input, ctx)
    finish(result, result && result.ok === false ? 'error' : 'done')
    return result
  } catch (e: any) {
    if (e?.name === 'AbortError' || /aborted/i.test(String(e?.message))) throw e
    const errResult = { ok: false, error: e?.message || String(e) }
    finish(errResult, 'error')
    return errResult
  }
}
