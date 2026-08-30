import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { Tabs, Button, Input, Select, Icon, Tag } from 'animal-island-ui'
import { parseBatchItemNos } from '@shared/query'
import { FilterBar } from './FilterBar'
import { MaterialTable } from './MaterialTable'
import { BomTable } from './BomTable'
import { FileTable } from './FileTable'

import { NOOK_ICON } from './nookIcon'

const OA_HOME_URL = 'http://oa.streamax.com:8080/ruiming/mc/'

function CurrentTime() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase()
  const monthDay = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const clock = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  return (
    <div className="mc-time">
      <div className="mc-time-date">
        <span className="mc-time-weekday">{weekday}</span>
        <span className="mc-time-monthday">{monthDay}</span>
      </div>
      <div className="mc-time-clock">{clock}</div>
    </div>
  )
}

export function QueryPanel({ disabled }: { disabled: boolean }) {
  const t = useStore(s => s.t)
  const lang = useStore(s => s.lang)
  const setLang = useStore(s => s.setLang)
  const loggedIn = useStore(s => s.loggedIn)
  const appVersion = useStore(s => s.appVersion)
  const clearLogin = useStore(s => s.clearLogin)
  const checkUpdate = useStore(s => s.checkUpdate)
  const startDownload = useStore(s => s.startDownload)
  const updateInfo = useStore(s => s.updateInfo)
  const itemNo = useStore(s => s.itemNo)
  const setItemNo = useStore(s => s.setItemNo)
  const batchText = useStore(s => s.batchText)
  const setBatchText = useStore(s => s.setBatchText)
  const batchMsg = useStore(s => s.batchMsg)
  const notFound = useStore(s => s.notFound)
  const loading = useStore(s => s.loading)
  const searchMaterial = useStore(s => s.searchMaterial)
  const searchByItemNo = useStore(s => s.searchByItemNo)
  const searchBom = useStore(s => s.searchBom)
  const searchFile = useStore(s => s.searchFile)
  const batchSearch = useStore(s => s.batchSearch)
  const activeTab = useStore(s => s.activeTab)
  const setActiveTab = useStore(s => s.setActiveTab)

  // fields 多条件描述搜索
  const fields = useStore(s => s.fields)
  const addField = useStore(s => s.addField)
  const removeField = useStore(s => s.removeField)
  const setFieldVal = useStore(s => s.setFieldVal)
  const reorderField = useStore(s => s.reorderField)
  const runSearch = useStore(s => s.searchMaterial)
  const resetAll = useStore(s => s.reset)

  // 批量折叠
  const [batchOpen, setBatchOpen] = useState(false)

  // 页面缩放状态与全局快捷键（Ctrl+滚轮缩放 / Ctrl+0 复位）
  const [zoom, setZoom] = useState(100)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  // 缩放百分比临时浮层：仅在缩放操作时显示 1 秒，不常驻标题栏
  const [zoomToast, setZoomToast] = useState(false)
  const zoomToastTimer = useRef<number | null>(null)
  const flashZoom = () => {
    setZoomToast(true)
    if (zoomToastTimer.current) window.clearTimeout(zoomToastTimer.current)
    zoomToastTimer.current = window.setTimeout(() => setZoomToast(false), 1000)
  }
  useEffect(() => {
    if (!window.mcApi?.getZoom) return
    window.mcApi.getZoom().then(z => setZoom(Math.round(z * 100)))
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const delta = e.deltaY < 0 ? 0.1 : -0.1
      const next = Math.max(0.5, Math.min(2.0, zoomRef.current / 100 + delta))
      window.mcApi.setZoom(next).then(() => { setZoom(Math.round(next * 100)); flashZoom() })
    }
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return
      if (e.key === '0') {
        e.preventDefault()
        window.mcApi.resetZoom().then(() => { setZoom(100); flashZoom() })
      }
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('wheel', onWheel as any)
      window.removeEventListener('keydown', onKey)
      if (zoomToastTimer.current) window.clearTimeout(zoomToastTimer.current)
    }
  }, [])

  // 输入框历史记录记忆
  const [itemHist, setItemHist] = useState<string[]>(
    () => { try { return JSON.parse(localStorage.getItem('mq_itemno_hist') || '[]') } catch { return [] } }
  )
  const [fieldHist, setFieldHist] = useState<string[]>(
    () => { try { return JSON.parse(localStorage.getItem('mq_field_hist') || '[]') } catch { return [] } }
  )
  const pushHist = (kind: 'item' | 'field', v: string) => {
    const val = v.trim()
    if (!val) return
    const key = kind === 'item' ? 'mq_itemno_hist' : 'mq_field_hist'
    const cur = kind === 'item' ? itemHist : fieldHist
    const next = [val, ...cur.filter(x => x !== val)].slice(0, 12)
    localStorage.setItem(key, JSON.stringify(next))
    if (kind === 'item') setItemHist(next); else setFieldHist(next)
  }

  // 批量料号去重统计
  const batchNos = useMemo(() => parseBatchItemNos(batchText), [batchText])
  const batchTotal = batchNos.length
  const batchUnique = new Set(batchNos).size
  const batchDup = batchTotal - batchUnique
  const batchCountText = batchTotal > 0 ? t('batchCount', { total: batchTotal, dup: batchDup }) : ''

  // Tab items（对齐 4.0：物料结果 / BOM结果 / 规格文件）
  const tabItems = [
    { key: 'mat', label: t('tabMat') },
    { key: 'bom', label: t('tabBom') },
    { key: 'file', label: t('tabFile') },
  ]

  const langOptions = [
    { key: 'zh', label: '中文' },
    { key: 'en', label: 'EN' },
  ]

  // V1.0.6：查料号独立查询（仅按料号 ITEM_NUMBER），不与描述条件组合
  const submitItem = useCallback(() => {
    if (itemNo.trim()) { pushHist('item', itemNo); searchByItemNo() }
  }, [itemNo, searchByItemNo])

  // 字段区交互
  const updateField = (id: string, v: string) => setFieldVal(id, v)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const onDrop = (i: number) => {
    if (dragIdx === null || dragIdx === i) return
    reorderField(dragIdx, i)
    setDragIdx(null)
  }
  const preview = fields.map(f => f.val.trim()).filter(Boolean).map(v => `(${v})`).join(' && ') || t('previewEmpty')

  // 对普通（非 draggable 父级）输入框，阻止 mousedown 冒泡，避免任何潜在拖拽干扰
  const stopDragOnInput = (e: React.MouseEvent<HTMLInputElement | HTMLTextAreaElement>) => e.stopPropagation()

  return (
    <div className={`panel${disabled ? ' panel-locked' : ''}`}>
      {/* 标题栏 */}
      <div className="panel-header">
        <div className="brand">
          {/* animal-island-ui 的 Icon 只支持 name/src/size/className/style/bounce，
              不支持 title 与 onClick，故用 button 包一层承载点击与 tooltip。 */}
          <button
            type="button"
            className="brand-icon-btn"
            title={OA_HOME_URL}
            onClick={() => window.mcApi?.openExternal?.(OA_HOME_URL)}
          >
            <Icon src={NOOK_ICON} size={72} className="brand-icon" />
          </button>
          <div className="brand-text">
            <span className="brand-title">{t('appTitle')}</span>
          </div>
        </div>
        <div className="header-actions">
          <span className="header-time"><CurrentTime /></span>
          <div className="header-tools">
            {zoomToast && (
              <span className="zoom-badge" title={t('zoomHint')}>{zoom}%</span>
            )}
            <Select
              options={langOptions}
              value={lang}
              onChange={(key) => setLang(key as 'zh' | 'en')}
              aria-label={t('langLabel') || 'language'}
            />
            <Select
              value=""
              placeholder={t('help')}
              options={[
                { key: 'about', label: t('about') },
                { key: 'check', label: updateInfo.checking ? t('updateChecking') : t('checkForUpdate') }
              ]}
              onChange={(key) => {
                if (key === 'about') alert(t('aboutInfo', { v: appVersion }))
                if (key === 'check') {
                  // 手动检查：弹窗返回结果；有更新则提供「立即下载」入口
                  checkUpdate().then((res: any) => {
                    if (!res) return
                    if (res.ok && res.hasUpdate) {
                      const ok = confirm(t('updateConfirmDownload', { v: res.version || '' }))
                      if (ok) {
                        // 用户确认 → 开始下载（顶部 UpdateBar 显示进度）
                        startDownload()
                      }
                    } else if (res.ok && res.latest) {
                      alert(t('updateLatest'))
                    } else if (!res.ok) {
                      // 服务器未上传 latest.yml 等场景显示友好提示，不暴露原始 404 堆栈
                      const msg = String(res.error || 'unknown')
                      const isServiceMissing = /404|Cannot find channel|latest\.yml|update info/i.test(msg)
                      alert(isServiceMissing ? t('updateServiceUnavailable') : t('updateError', { m: msg }))
                    }
                  })
                }
              }}
            />
            {loggedIn && (
              <Button type="default" ghost size="small" onClick={clearLogin}>
                {t('logout')}
              </Button>
            )}
          </div>
        </div>
      </div>

      {disabled && <div className="panel-lock-mask" />}

      <div className="panel-body">
        {/* 单个料号 / BOM / 规格文件 */}
        <div className="mq-itemno-section card itemno-card">
          <div className="mq-itemno-label" data-i18n="itemnoLabel">{t('itemnoLabel')}</div>
          <div className="mq-itemno-row">
            <input
              className="mq-itemno-input animal-input-12WUn"
              id="mq-itemno"
              data-i18n-ph="itemnoPh"
              placeholder={t('itemnoPh')}
              value={itemNo}
              list="mq-itemno-list"
              onChange={e => setItemNo(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitItem() }}
              onMouseDown={stopDragOnInput}
              disabled={disabled || loading}
            />
            <datalist id="mq-itemno-list">
              {itemHist.map(h => <option key={h} value={h} />)}
            </datalist>
            <button
              className="mq-btn accent"
              id="mq-itemno-search-btn"
              data-i18n="btnItemno"
              style={{ height: 34 }}
              onClick={submitItem}
              disabled={disabled || loading || !itemNo.trim()}
            >
              🔍 {t('btnItemno')}
            </button>
            <button
              className="mq-btn"
              id="mq-bom-search-btn"
              data-i18n="btnBom"
              style={{ height: 34 }}
              onClick={() => { pushHist('item', itemNo); searchBom(itemNo.trim()) }}
              disabled={disabled || loading || !itemNo.trim()}
            >
              🌳 {t('btnBom')}
            </button>
            <button
              className="mq-btn mq-file-btn"
              id="mq-file-search-btn"
              data-i18n="btnFile"
              style={{ height: 34 }}
              onClick={() => { pushHist('item', itemNo); searchFile(itemNo.trim()) }}
              disabled={disabled || loading || !itemNo.trim()}
            >
              📎 {t('btnFile')}
            </button>
          </div>
          <div className="mq-itemno-hint" data-i18n="itemnoHint">{t('itemnoHint')}</div>

          {/* 批量查询（折叠） */}
          <div
            className="mq-batch-toggle"
            id="mq-batch-toggle"
            data-i18n="batchToggle"
            onClick={() => setBatchOpen(!batchOpen)}
          >
            📋 {batchOpen ? t('batchToggleClose') : t('batchToggle')}
          </div>
          {batchOpen && (
            <div className="mq-batch-panel" id="mq-batch-panel">
              <textarea
                className="mq-batch-textarea ai-textarea"
                id="mq-batch-textarea"
                data-i18n-ph="batchPh"
                placeholder={t('batchPh')}
                value={batchText}
                onChange={e => setBatchText(e.target.value)}
                onMouseDown={stopDragOnInput}
                disabled={disabled || loading}
              />
              <div className="mq-batch-row">
                <span className="mq-batch-count" id="mq-batch-count">
                  {batchCountText}
                </span>
                <button
                  className="mq-btn accent mq-batch-search-btn"
                  id="mq-batch-search-btn"
                  data-i18n="btnBatch"
                  onClick={() => batchSearch()}
                  disabled={disabled || loading || !batchText.trim()}
                >
                  🔍 {loading ? (batchMsg ? batchMsg : t('searching')) : t('btnBatch')}
                </button>
              </div>
              <div className="mq-batch-hint" data-i18n="batchHint">{t('batchHint')}</div>
              {/* 未命中标记 */}
              {notFound.length > 0 && (
                <div className="not-found-list">
                  {notFound.map(n => (
                    <Tag key={n} color="app-red" size="small">{n}</Tag>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 描述多条件搜索 fields */}
        <div className="card">
          <div className="fields-label">{t('fieldsLabel')}</div>
          <div className="fields-list">
            {fields.map((f, i) => (
              <div
                key={f.id}
                className="field-row"
                onDragOver={e => e.preventDefault()}
                onDrop={() => onDrop(i)}
              >
                <span className="drag-handle" title={t('dragHint')}>
                  <span
                    className="mq-seq"
                    draggable
                    onDragStart={() => setDragIdx(i)}
                    onDragEnd={() => setDragIdx(null)}
                  >
                    <span className="grip">⋮⋮</span> {i + 1}
                  </span>
                </span>
                <Input
                  value={f.val}
                  onChange={e => updateField(f.id, e.target.value)}
                  onBlur={e => pushHist('field', e.target.value)}
                  onMouseDown={stopDragOnInput}
                  placeholder={t('fieldPh')}
                  list="mq-field-list"
                  disabled={disabled || loading}
                />
                <Button type="text" size="small" onClick={() => removeField(f.id)} disabled={disabled || loading}>
                  {t('delete')}
                </Button>
              </div>
            ))}
          </div>
          <datalist id="mq-field-list">
            {fieldHist.map(h => <option key={h} value={h} />)}
          </datalist>
          <div className="fields-foot">
            <Button type="dashed" size="small" onClick={addField} disabled={loading}>{t('addField')}</Button>
            <span className="preview">{preview}</span>
          </div>
          <div className="fields-actions">
            <Button type="primary" className="mq-act-green" onClick={runSearch} disabled={disabled || loading}>
              {loading ? t('searching') : t('search')}
            </Button>
            <Button onClick={resetAll} disabled={disabled || loading}>{t('reset')}</Button>
          </div>
        </div>

        {/* Tabs + 筛选 + 表格区域（对齐 4.0：物料结果 / BOM结果 / 规格文件）
            filter-bar 与 table-wrap 通过 Tabs 的 children 渲染在 tabpanel 内部 */}
        <div className="tabs-area">
          <Tabs
            activeKey={activeTab}
            onChange={(key) => setActiveTab(key as any)}
            items={tabItems.map(item => ({
              ...item,
              children: (
                <div className="tab-body">
                  {item.key === 'mat' && <FilterBar disabled={disabled} target="mat" />}
                  {item.key === 'bom' && <FilterBar disabled={disabled} target="bom" />}
                  {/* 规格文件不显示筛选 */}
                  <div className="table-area">
                    {item.key === 'mat' && <MaterialTable />}
                    {item.key === 'bom' && <BomTable />}
                    {item.key === 'file' && <FileTable />}
                  </div>
                </div>
              ),
            }))}
          />
        </div>
      </div>
    </div>
  )
}
