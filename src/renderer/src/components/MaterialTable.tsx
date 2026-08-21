import { useRef, Fragment } from 'react'
import { useStore } from '../store'
import { useColResize } from '../hooks/useColResize'
import { escapeHtml } from '@shared/query'
import { Button, Tag } from 'animal-island-ui'

// 生命周期值 → 组件库合法 Tag 颜色（对齐用户脚本 SC 映射，使用 animal-island-ui 主题色）
const STATUS_TAG_COLOR: Record<string, any> = {
  // 绿：正常/推荐
  '正常': 'app-green',
  '量产': 'app-green',
  '批量-推荐': 'app-green',
  // 蓝：研发样品/未承样/冻结
  '研发样品': 'app-blue',
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

export function MaterialTable() {
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

  const sortIcon = (k: string) => {
    if (matSortKey !== k) return t('sortIco')
    return matSortAsc ? '↑' : '↓'
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

  return (
    <div>
      {/* 统计行：只保留 CSV 导出按钮 */}
      <div className="count-line">
        <span>
          {t('countMat', { f: matFiltered.length, s: matData.length, h: useStore.getState().dedup ? t('countMatDedup') : '' })}
        </span>
        <div className="count-actions">
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
                >
                  {c.label}
                  {c.sort && (
                    <span className="sort-ico">{sortIcon(c.k)}</span>
                  )}
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
                  <tr className="data-row" onClick={() => toggleExpand(rowKey)}>
                    {cols.map(c => {
                      if (c.k === '#') return <td key="#" className="td-num">{i + 1}</td>
                      if (c.k === 'ITEM_NUMBER') return <td key={c.k} className="td-item">{escapeHtml(itemNo)}</td>
                      if (c.k === 'ITEM_DESC') return <td key={c.k} className="td-desc" title={escapeHtml(String(r.ITEM_DESC ?? ''))}>{escapeHtml(String(r.ITEM_DESC ?? ''))}</td>
                      if (c.k === 'ITEM_TYPE') return <td key={c.k} className="td-type">{escapeHtml(String(r.ITEM_TYPE ?? ''))}</td>
                      if (c.k === 'INV_STATUS_NAME') {
                        const st = String(r.INV_STATUS_NAME ?? '')
                        return <td key={c.k} className="td-status"><Tag color={STATUS_TAG_COLOR[st] || 'default'}>{st}</Tag></td>
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
                        <strong>{t('fullDesc')}</strong>{escapeHtml(String(r.ITEM_DESC ?? ''))}<br />
                        <strong>{t('itemNo')}</strong>{escapeHtml(itemNo)}&emsp;
                        <strong>{t('k3')}</strong>{escapeHtml(String(r.K3_CODE ?? '—'))}&emsp;
                        <strong>{t('devSub')}</strong>{formatQty(r.DEV_SUB_QTY)}&emsp;
                        <strong>{t('trackSub')}</strong>{formatQty(r.TRACK_SUB_QTY)}&emsp;
                        <strong>{t('prodOrder')}</strong>{formatQty(r.PROD_ORDER)}&emsp;
                        <strong>{t('fixOrder')}</strong>{formatQty(r.REWORK_ORDER)}
                        <div className="mq-expand-actions">
                          <button className="mq-mini-btn" onClick={(e) => { e.stopPropagation(); viewBomFor(itemNo) }}>
                            🌳 {t('viewBomThis')}
                          </button>
                          <button className="mq-mini-btn" onClick={(e) => { e.stopPropagation(); viewFileFor(itemNo) }}>
                            📎 {t('viewFileThis')}
                          </button>
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
}
