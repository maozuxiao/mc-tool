/**
 * MC 查询：参数归一化 + 结构化错误码（1.0.74）
 *
 * 背景（用户实测复盘）：模型把参数传成非数组 / 空 args 时，工具抛纯文本错误，
 * 模型却把「调用失败」当成「BOM 子项 0 条」输出，还编了「整机未维护 BOM / 需权限」。
 * 止血办法是让**失败与空结果在结构上绝不同构**：任何失败都返回
 * `{ ok:false, error_code, error_message, retryable }`，成功且确实无数据返回 `OK_EMPTY`。
 *
 * 这里只放纯函数（不 import electron），方便 vitest 直接单测；
 * `mcSkill.ts` 负责 spawn 与工具卡片，协议文案集中在本文件，避免提示词与实现两处漂移。
 */
import { isItemNo, normalizeItemNo, parseBatchItemNos } from '@shared/query'

/** 与 mc_query.js 的 printError 一一对应；新增错误码时两边一起改 */
export const MC_ERROR_CODES = {
  EMPTY_ARGS: 'EMPTY_ARGS',
  BAD_ARGS: 'BAD_ARGS',
  UNSUPPORTED_COMMAND: 'UNSUPPORTED_COMMAND',
  NOT_FOUND: 'NOT_FOUND',
  OK_EMPTY: 'OK_EMPTY',
  NEED_OA_LOGIN: 'NEED_OA_LOGIN',
  NETWORK_ERROR: 'NETWORK_ERROR',
  QUERY_FAILED: 'QUERY_FAILED'
} as const

export type McErrorCode = typeof MC_ERROR_CODES[keyof typeof MC_ERROR_CODES]

/** 参数类 / 网络类失败可重试；登录失效、料号不存在、真实空结果一律不重试 */
const RETRYABLE_CODES: ReadonlySet<string> = new Set<string>([
  MC_ERROR_CODES.EMPTY_ARGS,
  MC_ERROR_CODES.BAD_ARGS,
  MC_ERROR_CODES.UNSUPPORTED_COMMAND,
  MC_ERROR_CODES.NETWORK_ERROR,
  MC_ERROR_CODES.QUERY_FAILED
])

export interface McQueryFailure {
  ok: false
  error_code: string
  /** 统一带「查询失败」前缀：措辞由工具给，不由模型自由描述 */
  error_message: string
  retryable: boolean
  /** 编排层自动重试时使用的参数；没有则只报告失败 */
  retryArgs?: Record<string, any>
  source?: string
  status?: number
}

export interface McQueryInputOk {
  ok: true
  command: string
  args: string[]
  /** 参数被工具侧改写过（模型传的不是标准一维数组），最终回复里可注明 */
  normalized: boolean
}

export type McQueryInputResult = McQueryInputOk | McQueryFailure

export function makeMcError(
  code: string,
  message: string,
  opts: { retryable?: boolean; retryArgs?: Record<string, any>; source?: string; status?: number } = {}
): McQueryFailure {
  const text = String(message || '').trim()
  return {
    ok: false,
    error_code: code,
    error_message: /查询失败/.test(text) ? text : `查询失败：${text || code}`,
    retryable: opts.retryable ?? RETRYABLE_CODES.has(code),
    ...(opts.retryArgs ? { retryArgs: opts.retryArgs } : {}),
    ...(opts.source ? { source: opts.source } : {}),
    ...(typeof opts.status === 'number' ? { status: opts.status } : {})
  }
}

export function isRetryableMcResult(r: any): boolean {
  return !!(r && r.ok === false && r.retryable === true)
}

const ALLOWED_COMMANDS = ['search', 'item', 'batch', 'bom', 'spec'] as const

/** 把明显写错的 command 猜回合法值；猜不出就返回 null（不重试，避免乱查一通） */
export function guessCommand(raw: string): string | null {
  const s = String(raw || '').toLowerCase()
  if (ALLOWED_COMMANDS.includes(s as any)) return s
  if (/bom/i.test(s)) return 'bom'
  if (/spec|规格|图纸|文件/i.test(s)) return 'spec'
  if (/batch|批量/i.test(s)) return 'batch'
  if (/item|料号|物料/i.test(s)) return 'item'
  if (/search|搜索|查找/i.test(s)) return 'search'
  return null
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of list) {
    const s = String(x).trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

/** 递归收集字符串（数组 / 嵌套对象 / 数字都摊平），用于宽容解析模型传的料号 */
export function collectStrings(v: any, out: string[], depth = 0): void {
  if (v == null || depth > 6) return
  if (typeof v === 'string' || typeof v === 'number') {
    const s = String(v).trim()
    if (s) out.push(s)
    return
  }
  if (Array.isArray(v)) {
    for (const x of v) collectStrings(x, out, depth + 1)
    return
  }
  if (typeof v === 'object') {
    for (const x of Object.values(v)) collectStrings(x, out, depth + 1)
  }
}

/**
 * 宽容解析 args（1.0.69 引入，1.0.74 搬到纯函数模块）。
 * 字符串 / 数组 / 对象 / {item:...} / 全角 / 4-4-4 分组 / 连字符，统一摊平成料号数组。
 */
export function coerceArgs(input: any, command: string): string[] {
  const { command: _cmd, ...rest } = (input && typeof input === 'object') ? input : {}
  const raw = input?.args !== undefined ? input.args : rest
  const itemCmds = command !== 'search'

  if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s) return []
    if (!itemCmds) return [s]
    return dedupe(parseBatchItemNos(s).map(normalizeItemNo).filter(Boolean))
  }

  const flat: string[] = []
  collectStrings(raw, flat)
  const uniq = dedupe(flat)
  if (!uniq.length) return []
  if (!itemCmds) return uniq.slice(0, 1)
  const items = uniq.map(x => normalizeItemNo(x)).filter(x => isItemNo(x))
  return dedupe(items.length ? items : uniq)
}

/** 返回结构化结果，不抛异常 —— 抛异常会被上层碾成 `{error: 纯文本}`，错误码就丢了 */
export function validateMcInput(input: any): McQueryInputResult {
  const command = String(input?.command || '').trim()
  if (!ALLOWED_COMMANDS.includes(command as any)) {
    const guessed = guessCommand(command)
    return makeMcError(
      MC_ERROR_CODES.UNSUPPORTED_COMMAND,
      `不支持的 MC 查询命令: ${command || '(空)'}。command 只能是 ${ALLOWED_COMMANDS.join(' / ')} 之一`,
      guessed
        ? { retryable: true, retryArgs: { ...input, command: guessed } }
        : { retryable: false }
    )
  }

  const args = coerceArgs(input, command)
  if (!args.length) {
    const got = JSON.stringify(input?.args ?? null).slice(0, 200)
    return makeMcError(
      MC_ERROR_CODES.EMPTY_ARGS,
      `MC 查询参数不能为空（实际收到 args = ${got}）。正确写法：` +
        '{"command":"batch","args":["515402210148","5110038100029"]} —— args 必须是字符串数组',
      { retryable: false }
    )
  }
  if (args.length > 50) {
    return makeMcError(MC_ERROR_CODES.BAD_ARGS, '单次最多查询 50 个参数', {
      retryable: true,
      retryArgs: { ...input, command, args: args.slice(0, 50) }
    })
  }
  if (args.some(x => !x.trim() || x.length > 500 || /[\r\n\0]/.test(x))) {
    const cleaned = args
      .map(x => String(x).replace(/[\r\n\0]+/g, '').trim().slice(0, 500))
      .filter(Boolean)
    return makeMcError(MC_ERROR_CODES.BAD_ARGS, 'MC 查询参数包含非法字符', {
      retryable: cleaned.length > 0,
      ...(cleaned.length ? { retryArgs: { ...input, command, args: cleaned } } : {})
    })
  }
  const isPlainArray = Array.isArray(input?.args)
    && input.args.every((x: any) => typeof x === 'string')
  return { ok: true, command, args, normalized: !isPlainArray }
}

/**
 * 成功结果也要区分「真的没数据」与「有数据」。
 * OK_EMPTY 是事实，允许模型陈述；error 一律不允许被改写成业务结论。
 */
export function resultCodeFor(command: string, result: any): 'OK' | 'OK_EMPTY' | 'NOT_FOUND' {
  if (command === 'bom') return (result?.bomRows || []).length ? 'OK' : 'OK_EMPTY'
  if (command === 'spec') return (result?.files || []).length ? 'OK' : 'OK_EMPTY'
  if (command === 'item') return (result?.rows || []).length ? 'OK' : 'NOT_FOUND'
  if (command === 'batch') {
    const items = result?.items || []
    return items.some((x: any) => x.found) ? 'OK' : 'OK_EMPTY'
  }
  return (result?.rows || []).length ? 'OK' : 'OK_EMPTY'
}

/** 反常识的空结论（整机 BOM 0 条 / 规格 0 文件 / 料号查无）需要自动二次核验 */
export function isLowConfidenceResult(command: string, result: any): boolean {
  if (command === 'bom') return !(result?.bomRows || []).length
  if (command === 'spec') return !(result?.files || []).length
  if (command === 'item') return !(result?.rows || []).length
  if (command === 'batch') return !(result?.items || []).some((x: any) => x.found)
  return false
}

/** 输出前自检硬门槛：与 mcSkillSystemPrompt 里的 A/B/C 清单逐字对应 */
export const MC_OUTPUT_SELF_CHECK =
  '【输出前自检 · 硬门槛】输出任何物料结论前逐条勾选：\n' +
  'A. 本轮是否至少有一次 ok:true 的 mc_query 结果？\n' +
  'B. 我引用的每个字段（料号、BOM 子项、库存、规格文件）能否在该次返回值中逐字找到？\n' +
  'C. 若我要说「无 BOM / 无库存 / 无规格文件」，该返回值是否明确标了 resultCode:OK_EMPTY（或 verifiedTwice:true），而不是 ok:false / error_code？\n' +
  '任一条为「否」→ 禁止输出业务结论，改为重试或明确声明「查询失败」。\n' +
  '【反例禁令】EMPTY_ARGS / BAD_ARGS / UNSUPPORTED_COMMAND / QUERY_FAILED 一律只能说「查询失败」，' +
  '禁止描述成「料号可能抄错 / 位数不对 / BOM 未维护 / 需要权限 / 系统没数据」；' +
  '只有 NOT_FOUND 才允许提示料号可能有问题。error_message 里的措辞照抄，不要自行改写。'
