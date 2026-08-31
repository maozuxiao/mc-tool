import type { AIAgentMode } from '@shared/ai-types'
import { MC_QUERY_TOOL_DEFINITION, runMcQuery, type McRunSink } from './mcSkill'
import { FILE_READ_TOOL_DEFINITION, FILE_TOOL_DEFINITIONS, fileSkillRead } from './fileSkill'

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
    definition: FILE_READ_TOOL_DEFINITION,
    run: async (input, ctx) => {
      const root = ctx.workspaceRoot
      if (!root) {
        return { ok: false, error: 'NO_WORKSPACE', message: '未选择工作区目录，无法读取文件。请先在工具栏选择工作区。' }
      }
      const path = String(input?.path || '').trim()
      if (!path) return { ok: false, error: 'MISSING_ARG', message: '缺少 path 参数' }
      return fileSkillRead({
        root,
        path,
        offset: Number.isFinite(Number(input?.offset)) ? Number(input.offset) : undefined,
        limit: Number.isFinite(Number(input?.limit)) ? Number(input.limit) : undefined,
        signal: ctx.signal
      })
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

/**
 * 分发工具调用。
 * - 用户中止（AbortError）必须向上抛，让调用方中断整个循环；
 * - 其余错误转成结构化结果回给模型，让它知道失败原因并自行改策略
 *   （例如换个路径、分段读取），而不是让整轮对话直接崩掉。
 */
export async function dispatchTool(name: string, input: any, ctx: ToolContext): Promise<any> {
  const entry = REGISTRY[name]
  if (!entry) return { error: `不支持的工具：${name}` }
  try {
    return await entry.run(input, ctx)
  } catch (e: any) {
    if (e?.name === 'AbortError' || /aborted/i.test(String(e?.message))) throw e
    return { ok: false, error: e?.message || String(e) }
  }
}
