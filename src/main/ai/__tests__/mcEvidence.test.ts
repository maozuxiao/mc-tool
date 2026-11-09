/**
 * 1.0.75 #8：物料查询「证据不足时不得输出业务结论」回归集。
 * 事故原型：把「本次没检索到（工具失败 / 参数形态错 / 通道异常）」当成「数据不存在」。
 */
import { describe, expect, it } from 'vitest'
import {
  MC_ERROR_CODES, MC_OUTPUT_SELF_CHECK, assertEmptyConclusion,
  isLowConfidenceResult, makeMcError, validateMcInput
} from '../mcArgs'

const evidence = {
  channel: 'wuliao',
  queryString: 'bom 5190010100062',
  scannedRows: 27,
  scanCalls: 2,
  matchCount: 0,
  sampleHits: []
}

describe('P0-1 强证据闸门', () => {
  it('OK_EMPTY + verifiedTwice + matchCount=0 + 凭证齐备 → 允许陈述无数据', () => {
    const v = assertEmptyConclusion({ ok: true, resultCode: 'OK_EMPTY', verifiedTwice: true, evidence })
    expect(v.allowed).toBe(true)
    expect(v.reason).toContain('齐备')
  })
  it('工具失败（ok:false）一律拒绝', () => {
    expect(assertEmptyConclusion({ ok: false, error_code: 'QUERY_FAILED' }).allowed).toBe(false)
    expect(assertEmptyConclusion(null).allowed).toBe(false)
  })
  it('缺 resultCode:OK_EMPTY 拒绝', () => {
    expect(assertEmptyConclusion({ ok: true, resultCode: 'OK', verifiedTwice: true, evidence }).allowed).toBe(false)
  })
  it('未经二次核验（缺 verifiedTwice）拒绝', () => {
    expect(assertEmptyConclusion({ ok: true, resultCode: 'OK_EMPTY', evidence }).allowed).toBe(false)
  })
  it('缺检索凭证 evidence 拒绝', () => {
    expect(assertEmptyConclusion({ ok: true, resultCode: 'OK_EMPTY', verifiedTwice: true }).allowed).toBe(false)
    expect(assertEmptyConclusion({
      ok: true, resultCode: 'OK_EMPTY', verifiedTwice: true, evidence: { matchCount: 0 }
    }).allowed).toBe(false)
  })
  it('matchCount 与「无数据」矛盾时拒绝', () => {
    const v = assertEmptyConclusion({
      ok: true, resultCode: 'OK_EMPTY', verifiedTwice: true,
      evidence: { ...evidence, matchCount: 3 }
    })
    expect(v.allowed).toBe(false)
    expect(v.reason).toContain('matchCount=3')
  })
  it('scanWarning 存在但其它证据齐备 → 放行但在 reason 里带警告', () => {
    const v = assertEmptyConclusion({
      ok: true, resultCode: 'OK_EMPTY', verifiedTwice: true,
      evidence: { ...evidence, scannedRows: 0, scanWarning: '本次未解析到任何记录' }
    })
    expect(v.allowed).toBe(true)
    expect(v.reason).toContain('注意')
  })
})

describe('P1-1 空结果复核覆盖面', () => {
  it('search 空结果也必须二次核验（原来恒 false 是缺口）', () => {
    expect(isLowConfidenceResult('search', { rows: [] })).toBe(true)
    expect(isLowConfidenceResult('search', { rows: [{ ITEM_NUMBER: '1' }] })).toBe(false)
  })
  it('bom / spec / item / batch 空结果仍需复核，有数据则不复核', () => {
    expect(isLowConfidenceResult('bom', { bomRows: [] })).toBe(true)
    expect(isLowConfidenceResult('bom', { bomRows: [{}] })).toBe(false)
    expect(isLowConfidenceResult('spec', { files: [] })).toBe(true)
    expect(isLowConfidenceResult('item', { rows: [] })).toBe(true)
    expect(isLowConfidenceResult('batch', { items: [{ found: false }] })).toBe(true)
    expect(isLowConfidenceResult('batch', { items: [{ found: true }] })).toBe(false)
  })
})

describe('P0-4 文案审计', () => {
  const banned = ['位数不对', '可能是 xlsx', '需要权限', '系统没数据', 'BOM 未维护', '料号可能抄错']
  it('所有错误码的措辞都不含让用户返工的臆测', () => {
    const text = Object.values(MC_ERROR_CODES)
      .map(code => makeMcError(code, `模拟 ${code} 失败`).error_message)
      .join('\n')
    for (const w of banned) expect(text).not.toContain(w)
    expect(text).toContain('查询失败')
  })
  it('CONFLICT 已进错误码表且默认不可重试', () => {
    const e = makeMcError(MC_ERROR_CODES.CONFLICT, '证据不足')
    expect(e.error_code).toBe('CONFLICT')
    expect(e.retryable).toBe(false)
  })
  it('输出前自检硬门槛包含新证据要求', () => {
    for (const k of ['resultCode:OK_EMPTY', 'verifiedTwice:true', 'matchCount', 'evidence.channel',
      'evidence.scannedRows', 'CONFLICT', '禁止输出业务结论']) {
      expect(MC_OUTPUT_SELF_CHECK).toContain(k)
    }
  })
})

/** 30 条「看似无数据、实际有数据」：参数形态错曾被当成「查无此料」 */
describe('回归集：6 个料号 × 5 种传参形态', () => {
  const pns = [
    '5190010100062', '5110038100029', '515402210148',
    '5196009100105', '5154021100051', '5110038100030'
  ]
  const forms: Array<[string, (pn: string) => any]> = [
    ['标准数组', pn => [pn]],
    ['单字符串', pn => pn],
    ['对象 {item:...}', pn => ({ item: pn })],
    ['嵌套对象', pn => ({ args: { items: [pn], pns: [pn] } })],
    ['4-4-4 分组', pn => pn.replace(/^(\d{4})(\d{4})(\d+)$/, '$1 $2 $3')]
  ]
  const cases = pns.flatMap(pn => forms.map(([name, make]) => ({ pn, name, args: make(pn) })))
  it(`共 ${cases.length} 条，全部归一化成功且不得被判为无数据`, () => {
    expect(cases).toHaveLength(30)
    for (const c of cases) {
      const r = validateMcInput({ command: 'item', args: c.args })
      expect(r.ok, `${c.pn} / ${c.name} 应归一化成功`).toBe(true)
      if (r.ok) expect(r.args.length).toBeGreaterThan(0)
    }
  })
})
