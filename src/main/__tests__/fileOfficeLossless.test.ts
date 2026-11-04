import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * 这里守的是 xlsx「无损写回」的几个纯函数：
 * 只增/改必需部件，绝不重排样式索引、绝不动形状/图片/打印设置。
 * ExcelJS 之前整本重写，会把 <xdr:sp> 形状全部吃掉，这里用最小补丁替代。
 */
const req = createRequire(join(process.cwd(), 'index.js'))
const fo = req(join(process.cwd(), 'resources/skills/file-office-local/scripts/file_office.js'))

const { xmlEsc, xmlUnesc, xlsxIndex, xlsxStyles, xlsxMakeCell, xlsxCellXmlOf, xlsxParseRows, xlsxPatchSheetXml } = fo

const WORKBOOK = `<?xml version="1.0"?>
<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Truck" sheetId="1" r:id="rId1"/>
    <sheet name="A &amp; B" sheetId="3" state="hidden" r:id="rId7"/>
  </sheets>
</workbook>`

const RELS = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId7" Type="worksheet" Target="/xl/worksheets/sheet9.xml"/>
</Relationships>`

describe('xmlEsc / xmlUnesc', () => {
  it('转义五类字符并可逆', () => {
    const raw = 'a<b>&"c"'
    expect(xmlEsc(raw)).toBe('a&lt;b&gt;&amp;&quot;c&quot;')
    expect(xmlUnesc(xmlEsc(raw))).toBe(raw)
  })

  it('剔除 XML 1.0 非法控制字符', () => {
    expect(xmlEsc('a\u0000b\u0008c\u001Fd')).toBe('abcd')
    expect(xmlEsc('\t\n\r')).toBe('\t\n\r')
  })

  it('还原数字实体', () => {
    expect(xmlUnesc('&#65;&#x4E2D;')).toBe('A中')
  })
})

describe('xlsxIndex', () => {
  it('把 r:id 解成包内部件路径，并处理绝对路径写法', () => {
    const { sheets } = xlsxIndex(WORKBOOK, RELS)
    expect(sheets).toHaveLength(2)
    expect(sheets[0]).toMatchObject({ name: 'Truck', sheetId: 1, part: 'worksheets/sheet1.xml' })
    expect(sheets[1]).toMatchObject({ name: 'A & B', sheetId: 3, state: 'hidden', part: 'worksheets/sheet9.xml' })
  })

  it('rels 缺失时 part 为空，不抛错', () => {
    const { sheets } = xlsxIndex(WORKBOOK, '<Relationships/>')
    expect(sheets.map((s: { part: string }) => s.part)).toEqual(['', ''])
  })
})

const STYLES = `<?xml version="1.0"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="164" fontId="3" fillId="1" borderId="2" xfId="0" applyNumberFormat="1"><alignment horizontal="right"/></xf>
  </cellXfs>
</styleSheet>`

describe('xlsxStyles 只追加、不改既有索引', () => {
  it('复用已有同色 fill，并以 base xf 为模板克隆', () => {
    const st = xlsxStyles(STYLES)
    // 黄色已存在（index 1），不应新增 fill
    const idx = st.styleFor('FFFFFF00', 0)
    expect(idx).toBe(2) // cellXfs 原有 2 条，新 xf 索引为 2
    const xml = st.toXml()
    expect(xml.match(/<fill>/g)).toHaveLength(2) // 没多出 fill
    expect(xml).toContain('<cellXfs count="3">') // count 2 -> 3
    expect(xml).toContain('<xf numFmtId="0" fontId="0" borderId="0" xfId="0" fillId="1" applyFill="1"/>')
  })

  it('新颜色时追加 fill 并换成新 fillId，字体/边框/数字格式保持', () => {
    const st = xlsxStyles(STYLES)
    const idx = st.styleFor('FFE2EFDA', 1)
    const xml = st.toXml.call(st)
    expect(idx).toBe(2)
    expect(xml).toContain('rgb="FFE2EFDA"')
    // 模板 xf(1) 的 numFmtId / fontId / borderId 必须原样保留，只换 fillId
    expect(xml).toContain(
      '<xf numFmtId="164" fontId="3" borderId="2" xfId="0" applyNumberFormat="1" fillId="2" applyFill="1">'
    )
    expect(xml.match(/<xf /g)).toHaveLength(3)
  })

  it('同色同 base 命中缓存，不重复追加', () => {
    const st = xlsxStyles(STYLES)
    const a = st.styleFor('FF00FF00', 0)
    const b = st.styleFor('FF00FF00', 0)
    expect(a).toBe(b)
    const xml = st.toXml.call(st)
    expect(xml.match(/<xf /g)).toHaveLength(3)
    expect(xml.match(/rgb="FF00FF00"/g)).toHaveLength(1)
  })

  it('没上色时原样返回，不改动 styles.xml', () => {
    const st = xlsxStyles(STYLES)
    expect(st.styleFor('', 5)).toBe(5)
    expect(st.styleFor(undefined, 0)).toBe(0)
    expect(st.dirty).toBe(false)
    expect(st.toXml.call(st)).toBe(STYLES)
  })

  it('小写颜色也能命中已有 fill', () => {
    const st = xlsxStyles(STYLES)
    const idx = st.styleFor('ffffff00', 2)
    expect(idx).toBe(2)
    expect(st.toXml.call(st).match(/<fill>/g)).toHaveLength(2)
  })
})

describe('xlsxMakeCell / 单元格序列化', () => {
  it('数字写成 <v>，字符串写成 inlineStr，空值自闭合', () => {
    expect(xlsxCellXmlOf(xlsxMakeCell('M15', 145.5, 151))).toBe('<c r="M15" s="151"><v>145.5</v></c>')
    expect(xlsxCellXmlOf(xlsxMakeCell('B2', 'a<b', 0))).toBe(
      '<c r="B2" t="inlineStr"><is><t xml:space="preserve">a&lt;b</t></is></c>'
    )
    expect(xlsxCellXmlOf(xlsxMakeCell('D4', '', 143))).toBe('<c r="D4" s="143"/>')
  })
})

const SHEET = `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:D3"/>
  <sheetData>
    <row r="1" spans="1:4"><c r="A1" s="1"><v>1</v></c><c r="B1" s="1" t="s"><v>0</v></c><c r="M1" s="1"><f>SUM(A1:A3)</f><v>6</v></c></row>
    <row r="2" spans="1:4"><c r="A2" s="1"/><c r="B2" s="1"/></row>
    <row r="3" spans="1:4"><c r="A3" s="1"/></row>
  </sheetData>
  <mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>
</worksheet>`

describe('xlsxPatchSheetXml 单元格级补丁', () => {
  const noStyle = () => 0

  it('只改目标单元格，其它行、mergeCells 原样保留', () => {
    const out = xlsxPatchSheetXml(SHEET, [{ r: 2, c: 2, value: '新值', fill: null }], noStyle)
    expect(out).toContain('<c r="B2" t="inlineStr"><is><t xml:space="preserve">新值</t></is></c>')
    expect(out).toContain('<c r="A1" s="1"><v>1</v></c>')
    expect(out).toContain('<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>')
    expect(out).toContain('<c r="M1" s="1"><f>SUM(A1:A3)</f><v>6</v></c>')
  })

  it('fillOnly 只换 s，公式与值不能变成死值', () => {
    const out = xlsxPatchSheetXml(SHEET, [{ r: 1, c: 13, fill: 'FFFF0000', fillOnly: true }], () => 9)
    expect(out).toContain('<c r="M1" s="9"><f>SUM(A1:A3)</f><v>6</v></c>')
  })

  it('追加新行时更新 dimension，行号保持升序', () => {
    const out = xlsxPatchSheetXml(SHEET, [{ r: 4, c: 3, value: 12.5, fill: null }], noStyle)
    // SHEET 里除 A/B 列外还有 M1，dimension 末列应扩到 M
    expect(out).toContain('<dimension ref="A1:M4"/>')
    expect(out.indexOf('<row r="3"')).toBeLessThan(out.indexOf('<row r="4"'))
    expect(out).toContain('<c r="C4"><v>12.5</v></c>')
  })

  it('sheetData 为空标签时也能写入第一行', () => {
    const empty = '<worksheet><dimension ref="A1"/><sheetData/></worksheet>'
    const out = xlsxPatchSheetXml(empty, [{ r: 1, c: 1, value: 'x', fill: null }], noStyle)
    expect(out).toContain('<sheetData><row r="1"><c r="A1" t="inlineStr">')
    expect(out).toContain('<dimension ref="A1:A1"/>')
  })

  it('xlsxParseRows 能正确拆出已有单元格地址', () => {
    const rows = xlsxParseRows('<row r="1"><c r="A1" s="1"/><c r="B1" s="1" t="s"><v>0</v></c></row>')
    expect(rows).toHaveLength(1)
    expect(rows[0].num).toBe(1)
    expect(rows[0].cells.map((c: { addr: string }) => c.addr)).toEqual(['A1', 'B1'])
  })
})
