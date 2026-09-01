import type { AIAgentMode, AIExtraRoot } from '@shared/ai-types'
import { MC_QUERY_TOOL_DEFINITION, runMcQuery, type McRunSink } from './mcSkill'
import {
  FILE_TOOL_DEFINITIONS, fileSkillRead, runFileSkillCommand,
  FILE_READ_BATCH_TOOL_DEFINITION, FILE_OPEN_FOLDER_TOOL_DEFINITION
} from './fileSkill'

export interface OpenFolderResult {
  ok: boolean
  alias?: string
  path?: string
  error?: string
  message?: string
}

/**
 * 工具执行上下文。
 * onRun 由调用方构造（已绑定本次工具运行的 run id），工具只需按需回调，
 * 不必关心 UI 卡片是怎么落库的。
 */
export interface ToolContext {
  signal: AbortSignal
  /** Build 模式的已授权目录白名单（多根）：文件/命令工具据此限制范围 */
  allowedRoots: AIExtraRoot[]
  /**
   * 打开目录的控制回调（会话级）。open_folder 工具调用它做校验 + 用户确认，
   * 并把新目录加入本会话的白名单。由 chatService 注入（需 conversationId）。
   */
  requestRoot?: (path: string) => Promise<OpenFolderResult>
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
      const p = String(input?.path || '').trim()
      if (!p) return { ok: false, error: 'MISSING_ARG', message: '缺少 path 参数' }
      return fileSkillRead({
        roots: ctx.allowedRoots,
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
      const args = []
      if (input?.path) args.push(input.path)
      if (typeof input?.depth === 'number') args.push('--depth', String(input.depth))
      return runFileSkillCommand('list', args, ctx.allowedRoots, ctx.signal, 30000)
    }
  },
  file_search: {
    definition: FILE_TOOL_DEFINITIONS[2],
    run: async (input, ctx) => {
      const args = [String(input?.query || '')]
      if (input?.path) args.push(input.path)
      if (input?.nameOnly) args.push('--name-only')
      if (input?.regex) args.push('--regex')
      if (input?.glob) args.push('--glob', String(input.glob))
      if (input?.ext) args.push('--ext', String(input.ext))
      if (input?.index === true) args.push('--index')
      return runFileSkillCommand('search', args, ctx.allowedRoots, ctx.signal, 30000)
    }
  },
  file_write: {
    definition: FILE_TOOL_DEFINITIONS[3],
    run: async (input, ctx) => {
      const p = String(input?.path || '').trim()
      if (!p) return { ok: false, error: 'MISSING_ARG', message: '缺少 path 参数' }
      const content = String(input?.content ?? '')
      const args = [p, '--content', content]
      if (input?.append) args.push('--append')
      if (input?.update) args.push('--update')
      if (input?.newsheet && input.newsheet !== 'false' && input.newsheet !== 'False') {
        const ns = typeof input.newsheet === 'string' && input.newsheet.toLowerCase() !== 'true'
          ? input.newsheet
          : undefined
        if (ns) args.push('--newsheet', ns)
        else args.push('--newsheet')
      }
      return runFileSkillCommand('write', args, ctx.allowedRoots, ctx.signal, 30000)
    }
  },
  // 批量读取：一次读多个文件，只消耗 1 轮
  [FILE_READ_BATCH_TOOL_DEFINITION.function.name]: {
    definition: FILE_READ_BATCH_TOOL_DEFINITION,
    run: async (input, ctx) => {
      const paths = Array.isArray(input?.paths) ? input.paths.map(String) : []
      if (!paths.length) return { ok: false, error: 'MISSING_ARG', message: '缺少 paths 参数' }
      return runFileSkillCommand('read_batch', paths, ctx.allowedRoots, ctx.signal, 60000)
    }
  },
  // 会话级打开目录：校验 + 用户确认，由 chatService 的 requestRoot 实现
  [FILE_OPEN_FOLDER_TOOL_DEFINITION.function.name]: {
    definition: FILE_OPEN_FOLDER_TOOL_DEFINITION,
    run: async (input, ctx) => {
      const p = String(input?.path || '').trim()
      if (!p) return { ok: false, error: 'MISSING_ARG', message: '缺少 path 参数' }
      if (!ctx.requestRoot) return { ok: false, error: 'NO_REQUEST_ROOT', message: '当前环境不支持打开目录' }
      return ctx.requestRoot(p)
    }
  }
}

/** 该模式下允许调用的工具名，用于兜底拦截模型臆造的工具调用 */
export function toolNamesForMode(mode: AIAgentMode, hasWorkspace: boolean): string[] {
  if (mode === 'ask') return []
  if (mode === 'mc') return ['mc_query']
  // build：文件工具 + 打开目录 + mc_query 全量下发；未授权目录时文件工具会引导用 open_folder
  void hasWorkspace
  return [...FILE_TOOL_DEFINITIONS.map(t => t.function.name), 'mc_query']
}

/**
 * 按模式生成下发给大模型的 tools 数组。
 * ask 模式必须返回空数组：不下发工具定义，模型才不会去「调用」不存在的工具。
 */
export function toolsForMode(mode: AIAgentMode, hasWorkspace: boolean): any[] {
  if (mode === 'ask') return []
  if (mode === 'mc') return [MC_QUERY_TOOL_DEFINITION]
  // build：文件工具 + 打开目录 + mc_query 全量下发（不再强制先选工作区）
  void hasWorkspace
  return [...FILE_TOOL_DEFINITIONS, MC_QUERY_TOOL_DEFINITION]
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
    case 'file_read_batch': return `已批量读取 ${result.count ?? 0} 个文件`
    case 'open_folder':
      return result.ok ? `已打开目录（别名 ${result.alias}）` : `打开目录被拒绝：${result.error || ''}`
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
