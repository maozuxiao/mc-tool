import { Fragment } from 'react'
import { useStore } from '../store'
import { escapeHtml, fixLinks } from '@shared/query'
import { OA_ORIGIN } from '@shared/constants'

// 空值兜底显示「—」（对齐用户脚本 v4.1）
const v = (x: any) => (x === undefined || x === null || x === '') ? '—' : escapeHtml(String(x))

export function BomTable() {
  const t = useStore(s => s.t)
  const bomData = useStore(s => s.bomData)
  const bomFiltered = useStore(s => s.bomFiltered)
  const searchBom = useStore(s => s.searchBom)
  const searchFile = useStore(s => s.searchFile)
  const exportCSV = useStore(s => s.exportBomCSV)
  // 行展开状态持久化到 store：切换 tab 后仍能保留展开行与按钮点击事件
  const expandedKeys = useStore(s => s.bomExpandedKeys)
  const toggle = useStore(s => s.toggleBomExpanded)

  if (!bomData.length) return <div className="empty-box" dangerouslySetInnerHTML={{ __html: t('emptyBom') }} />
  if (!bomFiltered.length) return <div className="empty-box">{t('emptyFiltered')}</div>

  return (
    <div>
      <div className="count-line">
        <span>{t('countBom', { f: bomFiltered.length, s: bomData.length })}</span>
        <div className="count-actions">
          <button className="mq-mini-btn" onClick={exportCSV}>{t('exportCsv')}</button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="mq bom">
          <thead>
            <tr>
              <th style={{ width: 46 }}>{t('thLevel')}</th>
              <th style={{ width: 142 }}>{t('thCompItem')}</th>
              <th>{t('thCompDesc')}</th>
              <th style={{ width: 110 }}>{t('thK3')}</th>
              <th style={{ width: 58 }}>{t('thUnit')}</th>
              <th style={{ width: 72 }}>{t('thLossRate')}</th>
              <th style={{ width: 58 }}>{t('thQty')}</th>
              <th style={{ width: 70 }}>{t('thRef')}</th>
              <th style={{ width: 70 }}>{t('thStock')}</th>
              <th style={{ width: 56 }}>{t('thAttachment')}</th>
            </tr>
          </thead>
          <tbody>
            {bomFiltered.map((r: any, i: number) => {
              const key = i
              const expanded = expandedKeys.has(key)
              return (
                <Fragment key={key}>
                  {/* 点击只展开/收起本地详情，不发起查询、不切换 tab（对齐用户脚本 bomTog） */}
                  <tr className="data-row" onClick={() => toggle(key)}>
                    <td>{v(r.BOM_LEVEL)}</td>
                    <td className="td-item">{v(r.COMPONENT_ITEM)}</td>
                    <td className="td-desc" title={String(r.COMPONENT_ITEM_DESC ?? '')}>{v(r.COMPONENT_ITEM_DESC)}</td>
                    <td>{v(r.K3_ITEM_NUMBER)}</td>
                    <td>{v(r.PRIMARY_UOM_CODE)}</td>
                    <td className="td-qty">{v(r.LOSS_RATE)}</td>
                    <td className="td-qty">{v(r.INVERSE_QUANTITY)}</td>
                    <td>{v(r.COMPONENT_REFERENCE_DESIGNATOR)}</td>
                    <td className="td-qty">{v(r.ON_HAND_QTY)}</td>
                    <td>
                      {r.HAS_FILE
                        ? <span dangerouslySetInnerHTML={{ __html: fixLinks(String(r.HAS_FILE), OA_ORIGIN) }} />
                        : '—'}
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="mq-expand">
                      <td colSpan={10}>
                        <div className="mq-expand-inner">
                          <div className="mq-expand-line"><strong>{t('asmDesc')}</strong>{v(r.ASSEMBLY_ITEM_DESC)}</div>
                          <div className="mq-expand-line"><strong>{t('bomClass')}</strong>{v(r.BOM_CLASS)}&emsp;<strong>{t('remarks')}</strong>{v(r.COMPONENT_REMARKS)}</div>
                          <div className="mq-expand-line">
                            <strong>{t('rndStock')}</strong>{v(r.DEVELOPMENT_SUB)}&emsp;
                            <strong>{t('trackStock')}</strong>{v(r.TRACK_SUB)}&emsp;
                            <strong>{t('prodOrder')}</strong>{v(r.PRODUCT_ORDER_SUB)}&emsp;
                            <strong>{t('rectifyOrder')}</strong>{v(r.UPDATE_ORDER_SUB)}&emsp;
                            <strong>{t('pickQty')}</strong>{v(r.SHIP_LOT_QTY)}
                          </div>
                          <div className="mq-expand-actions">
                            <button className="mq-mini-btn" onClick={(e: any) => { e.stopPropagation(); searchBom(r.COMPONENT_ITEM) }}>🌳 {t('viewBomComp')}</button>
                            <button className="mq-mini-btn" onClick={(e: any) => { e.stopPropagation(); searchFile(r.COMPONENT_ITEM) }}>📎 {t('viewFileComp')}</button>
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
}
