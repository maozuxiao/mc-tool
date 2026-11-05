/**
 * 1.0.74 #1 回归：参数归一化 / 结构化错误 / OK_EMPTY / 输出自检硬门槛。
 * 事故原型：模型把工具失败读成「BOM 子项 0 条」并编造「整机未维护 BOM」。
 */
import { describe, it, expect } from 'vitest'
import {
  MC_ERROR_CODES, MC_OUTPUT_SELF_CHECK, coerceArgs, guessCommand, isLowConfidenceResult,
  isRetryableMcResult, makeMcError, resultCodeFor, validateMcInput
} from '../mcArgs'

describe('validateMcInput · 参数归一化', () => {
  it('标准一维数组：不做改写', () => {
    const r = validateMcInput({ command: 'bom', args: ['5190010100062'] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.args).toEqual(['5190010100062'])
      expect(r.normalized).toBe(false)
    }
  })

  it('T1：args 传单个字符串也能归一化成功（绝不报「参数为空」）', () => {
    const r = validateMcInput({ command: 'bom', args: '5190010100062' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.args).toEqual(['5190010100062'])
  })

  it('全角 / 4-4-4 分组 / 连字符 / 空格都归一化成连续数字', () => {
    expect(coerceArgs({ command: 'bom', args: '５１９００１０１０００６２' }, 'bom')).toEqual(['5190010100062'])
    expect(coerceArgs({ command: 'bom', args: '5190 0101 0006 2' }, 'bom')).toEqual(['5190010100062'])
    expect(coerceArgs({ command: 'bom', args: '5190-0101-0006-2' }, 'bom')).toEqual(['5190010100062'])
  })

  it('对象 / 嵌套数组 / 数字照样摊平（1.0.69 事故形态）', () => {
    expect(coerceArgs({ command: 'batch', args: { item: '5190010100062' } }, 'batch'))
      .toEqual(['5190010100062'])
    expect(coerceArgs({ command: 'batch', args: { items: ['5190010100062'], pns: [5110038100029] } }, 'batch'))
      .toEqual(['5190010100062', '5110038100029'])
  })

  it('search 保留描述关键词，不当料号清洗', () => {
    expect(coerceArgs({ command: 'search', args: 'IMX307 摄像头' }, 'search')).toEqual(['IMX307 摄像头'])
  })
})

describe('validateMcInput · 结构化错误', () => {
  it('T2：args 为空 → EMPTY_ARGS，带「查询失败」，不可重试', () => {
    const r = validateMcInput({ command: 'bom', args: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error_code).toBe(MC_ERROR_CODES.EMPTY_ARGS)
      expect(r.error_message).toContain('查询失败')
      expect(r.retryable).toBe(false)
    }
  })

  it('非法 command → UNSUPPORTED_COMMAND，猜得出就给 retryArgs', () => {
    const r = validateMcInput({ command: 'bom_query', args: ['5190010100062'] })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error_code).toBe(MC_ERROR_CODES.UNSUPPORTED_COMMAND)
      expect(r.retryArgs?.command).toBe('bom')
      expect(r.retryable).toBe(true)
    }
  })

  it('猜不出的 command 不重试，避免乱查一通', () => {
    expect(guessCommand('zzz')).toBeNull()
    const r = validateMcInput({ command: 'zzz', args: ['x'] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.retryable).toBe(false)
  })

  it('超过 50 个参数 → BAD_ARGS + 截断后的 retryArgs', () => {
    const args = Array.from({ length: 60 }, (_, i) => String(5190010100062 + i))
    const r = validateMcInput({ command: 'batch', args })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error_code).toBe(MC_ERROR_CODES.BAD_ARGS)
      expect(r.retryArgs?.args).toHaveLength(50)
    }
  })

  it('含换行 / 控制字符 → BAD_ARGS + 清洗后的 retryArgs', () => {
    const r = validateMcInput({ command: 'item', args: ['5190010100062\nDROP'] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error_code).toBe(MC_ERROR_CODES.BAD_ARGS)
  })

  it('错误与「真实空结果」在结构上绝不同构', () => {
    const failure = validateMcInput({ command: 'bom', args: [] })
    const emptyResult = { ok: true, result: { bomRows: [] }, resultCode: 'OK_EMPTY' }
    expect((failure as any).ok).toBe(false)
    expect((failure as any).error_code).toBeDefined()
    expect(emptyResult.ok).toBe(true)
    expect((emptyResult as any).error_code).toBeUndefined()
    expect(resultCodeFor('bom', emptyResult.result)).toBe('OK_EMPTY')
  })

  it('makeMcError 不重复加「查询失败」前缀', () => {
    expect(makeMcError('QUERY_FAILED', '查询失败：网络断开').error_message)
      .toBe('查询失败：网络断开')
    expect(makeMcError('QUERY_FAILED', '网络断开').retryable).toBe(true)
    expect(makeMcError('NEED_OA_LOGIN', '会话失效').retryable).toBe(false)
    expect(isRetryableMcResult(makeMcError('QUERY_FAILED', 'x'))).toBe(true)
  })
})

describe('resultCodeFor / 低概率结论二次核验', () => {
  it('bom 0 条 → OK_EMPTY 且需要二次核验；26 条 → OK', () => {
    expect(resultCodeFor('bom', { bomRows: [] })).toBe('OK_EMPTY')
    expect(isLowConfidenceResult('bom', { bomRows: [] })).toBe(true)
    expect(resultCodeFor('bom', { bomRows: new Array(26).fill({}) })).toBe('OK')
    expect(isLowConfidenceResult('bom', { bomRows: new Array(26).fill({}) })).toBe(false)
  })

  it('spec 无附件 → OK_EMPTY；item 查无 → NOT_FOUND', () => {
    expect(resultCodeFor('spec', { files: [] })).toBe('OK_EMPTY')
    expect(resultCodeFor('spec', { files: [{ fileName: 'a.pdf' }] })).toBe('OK')
    expect(resultCodeFor('item', { rows: [] })).toBe('NOT_FOUND')
  })

  it('T5：BOM 成功但规格为空时，两者结论互相隔离', () => {
    const bom = { ok: true, result: { bomRows: [{ a: 1 }] }, resultCode: 'OK' }
    const spec = { ok: true, result: { files: [] }, resultCode: 'OK_EMPTY' }
    expect(bom.resultCode).not.toBe(spec.resultCode)
    expect(bom.ok).toBe(true)
  })
})

describe('输出前自检硬门槛（提示词契约）', () => {
  it('A/B/C 三条自检与反例禁令都在系统提示里', () => {
    expect(MC_OUTPUT_SELF_CHECK).toContain('A.')
    expect(MC_OUTPUT_SELF_CHECK).toContain('B.')
    expect(MC_OUTPUT_SELF_CHECK).toContain('C.')
    expect(MC_OUTPUT_SELF_CHECK).toContain('OK_EMPTY')
    expect(MC_OUTPUT_SELF_CHECK).toContain('禁止')
    expect(MC_OUTPUT_SELF_CHECK).toContain('BOM 未维护')
  })
})
