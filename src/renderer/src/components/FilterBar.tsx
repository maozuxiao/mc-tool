import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { Input, Select, Button, Icon } from 'animal-island-ui'
import { translateLifecycle } from '@shared/i18n'

function LifecycleDropdown({
  disabled,
  options,
  selected,
  toggle,
  clear,
  label
}: {
  disabled?: boolean
  options: string[]
  selected: string[]
  toggle: (v: string) => void
  clear: () => void
  label: string
}) {
  const t = useStore(s => s.t)
  const lang = useStore(s => s.lang)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  const triggerLabel =
    selected.length === 0 ? label : t('lifecycleSelected').replace('{n}', String(selected.length))

  return (
    <div className="lifecycle-dropdown" ref={ref}>
      <div
        className={`lifecycle-trigger${open ? ' open' : ''}${disabled ? ' disabled' : ''}`}
        onClick={() => !disabled && setOpen(!open)}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            !disabled && setOpen(!open)
          }
        }}
      >
        <span>{triggerLabel}</span>
        {/* 库 Play 图标是实心三角，靠 CSS 旋转 90° 得到 ▼（展开时转回 ▶），
            不再用「▼」字符 —— 字符箭头在不同字体下粗细/基线都不一致。 */}
        <span className="lifecycle-arrow"><Icon name="Play" size={10} /></span>
      </div>
      {open && (
        <div className="lifecycle-panel">
          {options.length === 0 && (
            <div className="lifecycle-empty">{t('previewEmpty')}</div>
          )}
          {options.map((st) => {
            const on = selected.includes(st)
            return (
              <button
                key={st}
                type="button"
                className={`lifecycle-option${on ? ' on' : ''}`}
                aria-pressed={on}
                onClick={() => toggle(st)}
              >
                <span className={`lifecycle-option__check${on ? '' : ' off'}`}>
                  <Icon name="Check" size={14} />
                </span>
                {/* 选项文案按语言翻译；勾选态、过滤、导出仍用原始值 st */}
                <span>{translateLifecycle(lang, st)}</span>
              </button>
            )
          })}
          {selected.length > 0 && (
            <button type="button" className="lifecycle-clear" onClick={clear}>
              {t('msClear')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function FilterBar({ disabled, target = 'mat' }: { disabled: boolean; target?: 'mat' | 'bom' }) {
  const t = useStore(s => s.t)
  const allData = useStore(s => s.allData) || []
  const kw = useStore(s => s.kw)
  const setKw = useStore(s => s.setKw)
  const kwNot = useStore(s => s.kwNot)
  const setKwNot = useStore(s => s.setKwNot)
  const bomKw = useStore(s => s.bomKw)
  const setBomKw = useStore(s => s.setBomKw)
  const bomKwNot = useStore(s => s.bomKwNot)
  const setBomKwNot = useStore(s => s.setBomKwNot)
  const typeFilter = useStore(s => s.typeFilter)
  const setTypeFilter = useStore(s => s.setTypeFilter)
  const selectedStatuses = useStore(s => s.selectedStatuses)
  const toggleStatus = useStore(s => s.toggleStatus)
  const clearStatus = useStore(s => s.clearStatus)
  const dedup = useStore(s => s.dedup)
  const toggleDedup = useStore(s => s.toggleDedup)

  // 阻止输入框 mousedown 冒泡，确保内部文本可正常拖动选中
  const stopDragOnInput = (e: React.MouseEvent<HTMLInputElement>) => e.stopPropagation()

  const isBom = target === 'bom'

  // 从当前搜索结果中动态收集实际出现的生命周期值
  const statusOptions = Array.from(
    new Set((allData || []).map((r: any) => String(r.INV_STATUS_NAME ?? '')).filter(Boolean))
  ).sort()

  const typeOptions = [
    { key: '', label: t('typeAll') },
    { key: '采购', label: t('typePurchase') },
    { key: '制造', label: t('typeManufacture') },
  ]

  // BOM 筛选：仅关键词 + 排除词
  if (isBom) {
    return (
      <div className="filter-bar">
        <div className="filter-group filter-kw-group">
          <label className="filter-group-label">{t('filterLabel')}</label>
          <div className="filter-kw-row">
            <Input
              className="mq-input"
              placeholder={t('kwPh')}
              value={bomKw}
              onChange={e => setBomKw(e.target.value)}
              onMouseDown={stopDragOnInput}
              disabled={disabled}
            />
            <Input
              className="mq-input"
              placeholder={t('kwNotPh')}
              value={bomKwNot}
              onChange={e => setBomKwNot(e.target.value)}
              onMouseDown={stopDragOnInput}
              disabled={disabled}
            />
          </div>
        </div>
      </div>
    )
  }

  // 物料筛选：关键词 + 排除词 + 类型 + 生命周期 + 去重
  return (
    <div className="filter-bar">
      <div className="filter-group filter-kw-group">
        <label className="filter-group-label">{t('filterLabel')}</label>
        <div className="filter-kw-row">
          <Input
            className="mq-input"
            placeholder={t('kwPh')}
            value={kw}
            onChange={e => setKw(e.target.value)}
            onMouseDown={stopDragOnInput}
            disabled={disabled}
          />
          <Input
            className="mq-input"
            placeholder={t('kwNotPh')}
            value={kwNot}
            onChange={e => setKwNot(e.target.value)}
            onMouseDown={stopDragOnInput}
            disabled={disabled}
          />
        </div>
      </div>

      <div className="filter-group filter-type-group">
        <label className="filter-group-label">{t('typeLabel')}</label>
        <Select
          options={typeOptions}
          value={typeFilter}
          onChange={setTypeFilter}
          aria-label={t('typeLabel')}
        />
      </div>

      <div className="filter-group filter-lifecycle-group">
        <label className="filter-group-label">{t('lifecycleLabel')}</label>
        <LifecycleDropdown
          disabled={disabled}
          options={statusOptions}
          selected={selectedStatuses}
          toggle={toggleStatus}
          clear={clearStatus}
          label={t('lifecycleAll')}
        />
      </div>

      <Button
        type={dedup ? 'primary' : 'default'}
        className="filter-dedup-btn"
        onClick={toggleDedup}
        disabled={disabled}
        title={t('dedupTitle')}
      >
        {dedup ? t('dedupOn') : t('dedup')}
      </Button>
    </div>
  )
}
