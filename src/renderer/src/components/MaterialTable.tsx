import { memo, useRef, Fragment } from 'react'
import { useStore } from '../store'
import { useColResize } from '../hooks/useColResize'
import { escapeHtml } from '@shared/query'
import { Button, Icon, Tag } from 'animal-island-ui'
import { translateItemType, translateLifecycle } from '@shared/i18n'

// 生命周期值 → 组件库合法 Tag 颜色（对齐用户脚本 SC 映射，使用 animal-island-ui 主题色）
const STATUS_TAG_COLOR: Record<string, any> = {
  // 绿：正常/推荐
  '正常': 'app-green',
  '量产': 'app-green',
  '批量-推荐': 'app-green',
  // 蓝：研发样品/试产样品/未承样/冻结（都属「未量产」阶段）
  '研发样品': 'app-blue',
  '试产样品': 'app-blue',
  '未承样': 'app-blue',
  '冻结': 'app-blue',
  // 黄：预释放
  '预释放': 'app-yellow',
  // 橙：停产
  '停产': 'app-orange',
  // 红：退市/淘汰/不推荐/禁购/禁用
  '预退市': 'app-red',
  '逐步淘汰': 'app-red',
  '批量-不推荐': 'app-red',
  '退市': 'app-red',
  '禁购': 'app-red',
  '禁用': 'app-red',
  '淘汰': 'app-red',
}

/**
 * 1.0.42 性能优化：组件没有任何 props，数据全部来自 store —— memo 之后，
 * 只有 store 里它真正订阅的字段（结果集 / 排序 / 展开态等）变化才会重渲染。
 * 此前父组件 QueryPanel 的任何一次重渲染（在料号、批量、搜索条件输入框里打字、
 * 切 Tab、主题或语言变化）都会把整张表连同「结果集行数」个 <tr> 重渲染一遍。
 */
export const MaterialTable = memo(function MaterialTable() {
  const t = useStore(s => s.t)
  const lang = useStore(s => s.lang)
  const matData = useStore(s => s.allData)
  const matFiltered = useStore(s => s.filtered)
  const matSortKey = useStore(s => s.sortKey)
  const matSortAsc = useStore(s => s.sortAsc)
  const matSortBy = useStore(s => s.sortBy)
  const setActiveTab = useStore(s => s.setActiveTab)
  const setItemNo = useStore(s => s.setItemNo)
  const searchBom = useStore(s => s.searchBom)
  const searchFile = useStore(s => s.searchFile)
  const exportCSV = useStore(s => s.exportMatCSV)
  // 1.0.54：物料描述 AI 译文（键是中文原文，值英文译文）与翻译进度。
  // 「有待翻译的描述」时才可点翻译；已有译文时才显示「原文/译文」切换。
  const descState = useStore(s => s.descTrans.mat)
  const translateDescs = useStore(s => s.translateDescs)
  const toggleDescVisible = useStore(s => s.toggleDescVisible)
  // 行展开状态持久化到 store：切换 tab 后仍能保留展开行与按钮点击事件
  const expandedKeys = useStore(s => s.matExpandedKeys)
  const toggleExpand = useStore(s => s.toggleMatExpanded)

  const tableRef = useRef<HTMLTableElement>(null)
  useColResize(tableRef, { storageKey: 'mc_mat_cols' })

  if (!matData.length) return <div className="empty-box" dangerouslySetInnerHTML={{ __html: t('emptyMat') }} />
  if (!matFiltered.length) return <div className="empty-box">{t('emptyFiltered')}</div>

  const cols = [
    { k: '#', label: t('thNum'), w: 40, cls: 'td-num', sort: false },
    { k: 'ITEM_NUMBER', label: t('thItemNo'), w: 140, cls: 'td-item', sort: true },
    { k: 'ITEM_DESC', label: t('thDesc'), w: 260, cls: 'td-desc', sort: true },
    { k: 'ITEM_TYPE', label: t('thType'), w: 63, cls: 'td-type', sort: true },
    { k: 'INV_STATUS_NAME', label: t('thLifecycle'), w: 120, cls: 'td-status', sort: true },
    { k: 'ON_HAND_QTY', label: t('thStock'), w: 100, cls: 'td-qty', sort: true },
  ]

  // 库没有排序箭头图标：用 Play 实心三角旋转表达升/降序（▲ / ▼），未排序时淡显
  const sortIcon = (k: string) => {
    const dir = matSortKey !== k ? 'none' : matSortAsc ? 'asc' : 'desc'
    return (
      <span className={`sort-ico ${dir}`} aria-hidden="true">
        <Icon name="Play" size={9} />
      </span>
    )
  }

  const viewBomFor = (itemNo: string) => {
    setItemNo(String(itemNo))
    setActiveTab('bom')
    searchBom(itemNo)
  }

  const viewFileFor = (itemNo: string) => {
    setItemNo(String(itemNo))
    setActiveTab('file')
    searchFile(itemNo)
  }

  const formatQty = (v: any) => {
    if (v === undefined || v === null || v === '') return '—'
    const n = Number(v)
    return Number.isNaN(n) ? escapeHtml(String(v)) : n.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')
  }

  // 翻译按钮三态：① 有待翻译描述 → 可点，开始翻译；② 翻译中 → **仍可点**（再次点击弹取消确认），
  //    所以不能置 disabled——禁用按钮不派发 click，上一版「翻译中无法取消」正是这么来的；
  //    库 loading 的 pointer-events:none 由 .mq-translate-btn 的 !important 覆盖解除；
  //    ③ 全部译过 → 禁用。
  const hasPendingDesc = matFiltered.some((r: any) => {
    const d = String(r.ITEM_DESC ?? '').trim()
    return !!d && !descState.map[d]
  })

  return (
    <div>
      {/* 统计行：只保留 CSV 导出按钮 */}
      <div className="count-line">
        <span>
          {t('countMat', { f: matFiltered.length, s: matData.length, h: useStore.getState().dedup ? t('countMatDedup') : '' })}
        </span>
        <div className="count-actions">
          {/* 翻译物料描述（1.0.54）：调用 AI 助手里配置的供应商把中文描述译成英文。
              loading 用库 Button 的甜甜圈动画，文案显示「翻译中 {i}/{n}」。
              loading 期间按钮仍可点击（.mq-translate-btn 覆盖了库的 pointer-events:none，
              且不置 disabled）：再次点击 = 弹确认取消剩余批次。
              仅当还有未翻译的描述时可点（全部译过则禁用）。 */}
          <Button
            type="default"
            size="small"
            className="mq-translate-btn"
            loading={descState.translating}
            disabled={!descState.translating && !hasPendingDesc}
            onClick={() => void translateDescs('mat')}
          >
            {descState.translating
              ? t('translatingN', { i: descState.progress?.done ?? 0, n: descState.progress?.total ?? 0 })
              : t('translateDesc')}
          </Button>
          {/* 已有译文时才出现「显示原文 / 显示译文」切换；导出 CSV 跟随当前显隐 */}
          {matFiltered.some((r: any) => descState.map[String(r.ITEM_DESC ?? '')]) && (
            <Button type="default" size="small" onClick={() => toggleDescVisible('mat')}>
              {descState.visible ? t('descShowOriginal') : t('descShowTranslated')}
            </Button>
          )}
          <Button type="default" size="small" onClick={exportCSV}>{t('exportCsv')}</Button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="mq" ref={tableRef}>
          <thead>
            <tr>
              {cols.map(c => (
                <th
                  key={c.k}
                  className={c.cls}
                  data-k={c.k === '#' ? undefined : c.k}
                  style={{ width: c.w }}
                  onClick={() => c.sort && matSortBy(c.k)}
                  data-cursor={c.sort ? 'pointer' : undefined}
                >
                  {c.label}
                  {c.sort && sortIcon(c.k)}
                  <span className="col-resizer" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matFiltered.map((r: any, i: number) => {
              // 料号可能重复，必须保证 key 唯一，否则 React diff 错乱会导致序号/行数异常
              const rowKey = `${String(r.ITEM_NUMBER ?? i)}-${i}`
              const expanded = expandedKeys.has(rowKey)
              const itemNo = String(r.ITEM_NUMBER ?? '')
              return (
                <Fragment key={rowKey}>
                  <tr className="data-row" data-cursor="pointer" onClick={() => toggleExpand(rowKey)}>
                    {cols.map(c => {
                      if (c.k === '#') return <td key="#" className="td-num">{i + 1}</td>
                      if (c.k === 'ITEM_NUMBER') return <td key={c.k} className="td-item">{escapeHtml(itemNo)}</td>
                      // 描述列：显译文态且有 AI 译文时显示英文，中文原文收进悬停提示；
                      // 显原文态一律显示中文（不破坏列格式）
                      if (c.k === 'ITEM_DESC') {
                        const zh = String(r.ITEM_DESC ?? '')
                        const en = descState.visible ? descState.map[zh] : undefined
                        return (
                          <td key={c.k} className="td-desc" title={en ? `${escapeHtml(en)}\n${escapeHtml(zh)}` : escapeHtml(zh)}>
                            {escapeHtml(en || zh)}
                          </td>
                        )
                      }
                      // 类型 / 生命周期是接口返回的中文枚举，显示时按语言取值翻译；
                      // Tag 的配色仍按**原始值**查表，所以换语言不会改变标签颜色。
                      if (c.k === 'ITEM_TYPE') return <td key={c.k} className="td-type">{escapeHtml(translateItemType(lang, String(r.ITEM_TYPE ?? '')))}</td>
                      if (c.k === 'INV_STATUS_NAME') {
                        const st = String(r.INV_STATUS_NAME ?? '')
                        // 取值可能带分类前缀（如 `[产品]量产`）：查配色前先去前缀，
                        // 否则会退化成默认灰色标签（文案侧的归一化见 @shared/i18n 的 lookupValue）
                        const stKey = st.replace(/^\[[^\]]*\]/, '')
                        return <td key={c.k} className="td-status"><Tag color={STATUS_TAG_COLOR[stKey] || 'default'}>{translateLifecycle(lang, st)}</Tag></td>
                      }
                      if (c.k === 'ON_HAND_QTY') {
                        const raw = r.ON_HAND_QTY
                        const qty = raw !== undefined && raw !== null && raw !== '' ? Number(raw).toLocaleString() : '-'
                        const qc = parseFloat(raw) > 0 ? 'qty-pos' : 'qty-zero'
                        return <td key={c.k} className="td-qty"><span className={qc}>{qty}</span></td>
                      }
                      return <td key={c.k}>{escapeHtml(String(r[c.k] ?? ''))}</td>
                    })}
                  </tr>
                  {expanded && (
                    <tr className="mq-expand">
                      <td colSpan={cols.length}>
                        {/* 展开区结构对齐 BomTable（.mq-expand-inner + .mq-expand-line）：
                            原先这里是「裸文本 + <br> + &emsp;」拼出来的，
                            .mq-expand-inner 的 12px 16px 内边距和 1.9 行高全都没吃到，
                            于是文字贴着单元格边、行距偏挤，「完整描述」与下面两个按钮
                            之间也只隔着一次 <br>，整体比 BOM 页窄一截。
                            改成块级行之后，两页的内边距 / 行距 / 按钮上边距
                            （.mq-expand-actions 的 10px）完全一致。
                            内容分组保持原样，仍是「完整描述」和「料号等字段」两行。 */}
                        <div className="mq-expand-inner">
                          <div className="mq-expand-line">
                            <strong>{t('fullDesc')}</strong>
                            {escapeHtml(descState.visible ? (descState.map[String(r.ITEM_DESC ?? '')] || String(r.ITEM_DESC ?? '')) : String(r.ITEM_DESC ?? ''))}
                            {/* 译文后面附中文原文（淡色小字），便于核对；未翻译 / 显原文态不渲染 */}
                            {descState.visible && descState.map[String(r.ITEM_DESC ?? '')] && (
                              <span className="mq-desc-origin">（{escapeHtml(String(r.ITEM_DESC ?? ''))}）</span>
                            )}
                          </div>
                          <div className="mq-expand-line">
                            <strong>{t('itemNo')}</strong>{escapeHtml(itemNo)}&emsp;
                            <strong>{t('k3')}</strong>{escapeHtml(String(r.K3_CODE ?? '—'))}&emsp;
                            <strong>{t('devSub')}</strong>{formatQty(r.DEV_SUB_QTY)}&emsp;
                            <strong>{t('trackSub')}</strong>{formatQty(r.TRACK_SUB_QTY)}&emsp;
                            <strong>{t('prodOrder')}</strong>{formatQty(r.PROD_ORDER)}&emsp;
                            <strong>{t('rectifyOrder')}</strong>{formatQty(r.REWORK_ORDER)}
                          </div>
                          <div className="mq-expand-actions">
                            <Button
                              type="primary"
                              size="small"
                              icon={<Icon name="Tree" size={14} />}
                              onClick={(e) => { e.stopPropagation(); viewBomFor(itemNo) }}
                            >
                              {t('viewBomThis')}
                            </Button>
                            <Button
                              type="primary"
                              size="small"
                              icon={<Icon name="File" size={14} />}
                              onClick={(e) => { e.stopPropagation(); viewFileFor(itemNo) }}
                            >
                              {t('viewFileThis')}
                            </Button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
})
