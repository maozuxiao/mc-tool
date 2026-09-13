import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { Tabs, Button, Input, Icon, Tag, Switch, Background, Time, BackTop, Tooltip, Collapse } from 'animal-island-ui'
import { McSelect } from './McSelect'
import { parseBatchItemNos } from '@shared/query'
import { FilterBar } from './FilterBar'
import { MaterialTable } from './MaterialTable'
import { BomTable } from './BomTable'
import { FileTable } from './FileTable'
import { WorkCountdown } from './WorkCountdown'
import { THEMES, getThemePreset } from '../theme'

import { NOOK_ICON } from './nookIcon'
// 叶子图片：从 animal-island-ui@1.4.0（即 1.0.38 使用的版本）的
// dist/files/icon-leaf.40329f03.png 拷进项目，见 TabLabel 处的说明。
// 走 import 而不是引用外链/库内路径，打包时由构建器决定产物名，避免资源失效。
import leafIcon from '../assets/icon-leaf.png'

import { OA_LOGIN_URL } from '@shared/constants'

// 「打开 OA」的目标地址：与主进程应用内窗口(OA_LOGIN_URL)保持一致，都指向工作台首页
const OA_HOME_URL = OA_LOGIN_URL

/**
 * Tab 文案 + 选中态右侧的小叶子装饰。
 *
 * 库 1.4 的 Tabs 在选中项右上角插一片会摇摆的叶子，1.12 起该装饰被移除
 * （`leafAnimation` 已标记 deprecated，DOM 里也不再渲染），那一处动效随之消失。
 * 这里按 1.0.38 的原样补回：1.4 用的是**一张 PNG 图片**（icon-leaf.png，
 * 已连带拷进 src/renderer/src/assets/），而不是矢量 <Icon>，所以形状更柔和。
 * 定位基准也照抄 1.4：叶子相对 tab 按钮（position:relative）定位，
 * 而我们的节点只能塞进库渲染的 label 里 —— 故 CSS 把 label 改回 static，
 * 让定位基准回到按钮上，详见 styles.css 的 .mq-tab-leaf 一段。
 */
function TabLabel({ text }: { text: string }) {
  return (
    <span className="mq-tab-label">
      {text}
      <img className="mq-tab-leaf" src={leafIcon} alt="" aria-hidden />
    </span>
  )
}

/**
 * 带历史记录下拉的输入框 —— 替代原生 <datalist>。
 *
 * 原生 datalist 的弹出层由 Chromium 自己绘制，CSS 完全够不到：它永远是白底直角，
 * 于是「已换肤的圆角输入框」旁边贴着一个直角列表，两套语言同屏。
 * 这里改为自己渲染下拉面板，圆角 / 描边 / 悬停色 / 阴影全部走主题 token，
 * 与筛选栏的 .lifecycle-panel 保持同一套视觉；键盘 ↑↓ 选择、Enter 确认、Esc 收起。
 */
function HistoryInput({
  value,
  onChange,
  onPick,
  onBlur,
  options,
  className,
  inputId,
  placeholder,
  disabled,
  onEnter,
  onMouseDown
}: {
  value: string
  onChange: (v: string) => void
  /** 从下拉里选中某条历史（调用方自行决定是否同时记入历史） */
  onPick: (v: string) => void
  onBlur?: (v: string) => void
  options: string[]
  className?: string
  inputId?: string
  placeholder?: string
  disabled?: boolean
  /** 面板未展开时按回车的行为（沿用原输入框的提交语义） */
  onEnter?: () => void
  onMouseDown?: (e: React.MouseEvent<HTMLInputElement>) => void
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const ref = useRef<HTMLDivElement>(null)

  // 点击组件外部收起（与 FilterBar 的 LifecycleDropdown 同一套交互）
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setActive(-1)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  // 只列出与当前输入相关的历史项，最多 8 条；与输入完全同值的那条不再重复提示
  const items = useMemo(() => {
    const q = value.trim().toLowerCase()
    return options.filter(o => o !== value && (!q || o.toLowerCase().includes(q))).slice(0, 8)
  }, [options, value])

  const choose = (v: string) => {
    onPick(v)
    setOpen(false)
    setActive(-1)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false)
      setActive(-1)
      return
    }
    if (open && items.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive(i => (i + 1) % items.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive(i => (i <= 0 ? items.length - 1 : i - 1))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        choose(items[active >= 0 ? active : 0])
        return
      }
    }
    if (e.key === 'Enter') onEnter?.()
  }

  return (
    <div className={`hist-input${className ? ` ${className}` : ''}`} ref={ref}>
      <Input
        className="mq-input"
        id={inputId}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={e => {
          onChange(e.target.value)
          setOpen(true)
          setActive(-1)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        onBlur={e => onBlur?.(e.target.value)}
        onMouseDown={onMouseDown}
      />
      {open && !disabled && items.length > 0 && (
        <div className="hist-panel" role="listbox">
          {items.map((o, i) => (
            <button
              key={o}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`hist-item${i === active ? ' active' : ''}`}
              // 拦掉 mousedown 的默认行为：否则输入框会先失焦、面板随即关闭，click 就丢了
              onMouseDown={e => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(o)}
            >
              {o}
            </button>
          ))}
        </div>
      )}
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

  // 页面滚动容器（.panel-body）。本应用不滚动窗口本身，滚动都发生在 panel-body 内部，
  // 所以 <BackTop> 必须显式绑定这个目标（否则它会去监听 window 的滚动，永远不出现）。
  const bodyRef = useRef<HTMLDivElement | null>(null)
  // 传给 <BackTop> 的 target 必须是稳定引用：库内部以它作为 effect 依赖，
  // 每次渲染换新函数会导致滚动监听反复解绑/重绑。
  const getScrollTarget = useCallback(() => bodyRef.current ?? window, [])

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
    { key: 'mat', label: <TabLabel text={t('tabMat')} /> },
    { key: 'bom', label: <TabLabel text={t('tabBom')} /> },
    { key: 'file', label: <TabLabel text={t('tabFile')} /> },
  ]

  // V1.0.6：查料号独立查询（仅按料号 ITEM_NUMBER），不与描述条件组合
  const submitItem = useCallback(() => {
    if (itemNo.trim()) { pushHist('item', itemNo); searchByItemNo() }
  }, [itemNo, searchByItemNo])

  // 字段区交互
  const updateField = (id: string, v: string) => setFieldVal(id, v)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  // 当前拖拽悬停到的行：只用于画落点提示，松手/离开即清空
  const [overIdx, setOverIdx] = useState<number | null>(null)
  const onDrop = (i: number) => {
    if (dragIdx === null || dragIdx === i) return
    reorderField(dragIdx, i)
    setDragIdx(null)
  }
  const preview = fields.map(f => f.val.trim()).filter(Boolean).map(v => `(${v})`).join(' && ') || t('previewEmpty')

  // 对普通（非 draggable 父级）输入框，阻止 mousedown 冒泡，避免任何潜在拖拽干扰
  const stopDragOnInput = (e: React.MouseEvent<HTMLInputElement | HTMLTextAreaElement>) => e.stopPropagation()

  // 主题：与语言/托盘同级放在设置面板里。
  // 主题值本身由 store 持有并落 localStorage，这里只负责选择器的展开状态。
  const theme = useStore(s => s.theme)
  const setTheme = useStore(s => s.setTheme)
  const [themeOpen, setThemeOpen] = useState(false)
  const themePreset = getThemePreset(theme)

  // 「设置」面板状态（真实值持久化在主进程 app-prefs.json，这里仅镜像显示）
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 设置面板收起时把主题网格一并复位：否则「关掉设置 → 再点开设置」会保留上次的展开态，
  // 第二次打开时图案网格依旧是铺开的，与「面板收起即复位」的预期不符。
  useEffect(() => {
    if (!settingsOpen) setThemeOpen(false)
  }, [settingsOpen])
  const [trayMin, setTrayMin] = useState(true)
  const [closeTray, setCloseTray] = useState(true)
  const [autoL, setAutoL] = useState(false)
  useEffect(() => {
    try {
      window.mcApi.getAppPrefs().then(p => {
        setTrayMin(!!p.minimizeToTray)
        setCloseTray(!!p.closeToTray)
        setAutoL(!!p.autoLaunch)
      }).catch(() => {})
    } catch { /* 忽略 */ }
  }, [])
  const updateSetting = async (key: 'minimizeToTray' | 'closeToTray' | 'autoLaunch', v: boolean) => {
    if (key === 'minimizeToTray') setTrayMin(v)
    else if (key === 'closeToTray') setCloseTray(v)
    else setAutoL(v)
    try { await window.mcApi.setSetting(key, v) } catch { /* 忽略 */ }
  }

  // 「帮助」菜单（关于 / 检查更新）。
  // 原来这里是库 <Select>：它的 wrapper 写死 min-width:140px，夹在一行按钮里明显过宽，
  // 展开后又是一块黄色大圆角菜单，与周围奶油色的控件不是同一套语言。
  // 现在改为「与设置按钮同款」的 trigger + 面板，度量、描边、悬停色全部复用设置那一套。
  const [helpOpen, setHelpOpen] = useState(false)

  const onHelp = async (key: 'about' | 'check') => {
    setHelpOpen(false)
    if (key === 'about') {
      void window.mcApi.showMessage({ message: t('aboutInfo', { v: appVersion }), lang })
      return
    }
    // 手动检查：弹窗返回结果；有更新则提供「立即下载」入口
    const res: any = await checkUpdate()
    if (!res) return
    if (res.ok && res.hasUpdate) {
      // 下载状态防重：已下载完成直接提示安装；进行中提示正在下载，
      // 两种情况都不再触发 startDownload（主进程也有重入保护兜底）
      const st = useStore.getState().updateInfo
      if (st.downloaded) {
        void window.mcApi.showMessage({ message: t('updateDownloaded'), lang })
        return
      }
      if (st.downloading) {
        void window.mcApi.showMessage({ message: t('updateDownloading', { p: st.progress ?? 0 }), lang })
        return
      }
      const ok = await window.mcApi.showConfirm({
        message: t('updateConfirmDownload', { v: res.version || '' }),
        lang
      })
      if (ok) {
        // 用户确认 → 开始下载（顶部 UpdateBar 显示进度）
        startDownload()
      }
    } else if (res.ok && res.latest) {
      void window.mcApi.showMessage({ message: t('updateLatest'), lang })
    } else if (!res.ok) {
      // 服务器未上传 latest.yml 等场景显示友好提示，不暴露原始 404 堆栈
      const msg = String(res.error || 'unknown')
      const isServiceMissing = /404|Cannot find channel|latest\.yml|update info/i.test(msg)
      void window.mcApi.showMessage({
        type: isServiceMissing ? 'info' : 'error',
        message: isServiceMissing ? t('updateServiceUnavailable') : t('updateError', { m: msg }),
        lang
      })
    }
  }

  return (
    <div className={`panel${disabled ? ' panel-locked' : ''}`}>
      {/* 标题栏 */}
      <div className="panel-header">
        <div className="brand">
          {/* 品牌图标用原生 <img> 而不是库 <Icon src>：
              库 1.12 的 Icon 传 src 时会退化成 <span> + backgroundImage，
              既没有 background-size/position，span 又比图形（94×104）小，
              于是图形被裁掉一角并平铺重复 —— 这就是顶栏图标显示异常的原因。
              <img> + object-fit: contain 不依赖库实现，跨版本稳定。
              animal-island-ui 的 Icon 不支持 title/onClick，故外层 button 承载点击与 tooltip。 */}
          {/* 提示改用库 <Tooltip variant="default">：原生 title 的浏览器气泡方头方脑、
              出现延迟长，跟整站风格无关（文档 #/tooltip 的 default 风格）。 */}
          <Tooltip variant="default" placement="bottom-start" title={t('brandOpenOa')}>
            <button
              type="button"
              className="brand-btn"
              onClick={e => {
                // 默认打开应用内窗口：它复用登录 partition 的 OA 会话，所以是真免登录；
                // Ctrl/⌘+点击保留旧行为，交给系统默认浏览器（需要重新登录）。
                if (e.ctrlKey || e.metaKey) void window.mcApi?.openExternal?.(OA_HOME_URL)
                else void window.mcApi?.openOaWindow?.()
              }}
            >
              <img className="brand-icon" src={NOOK_ICON} alt="" />
              {/* 标题下方挂「距离下班还有 hh:mm:ss」；周末与中国法定节假日不出倒计时，
                  改显示一句祝福（判断逻辑与放假表见 WorkCountdown.tsx / @shared/holidays）。
                  这两行现在也在按钮内，于是点标题/倒计时同样打开 OA。 */}
              <span className="brand-text">
                <span className="brand-title">{t('appTitle')}</span>
                <WorkCountdown />
              </span>
            </button>
          </Tooltip>
        </div>
        <div className="header-actions">
          {/* 时钟改用库 <Time>（文档 #/time 同款）：HH:MM 带闪烁冒号 + 星期/日期胶囊，
              比自绘版本语言更统一。库版本是按展示页设计的大卡片，
              这里用 .mc-time-compact 压到顶栏尺寸（见 styles.css）。 */}
          <span className="header-time"><Time className="mc-time-compact" /></span>
          <div className="header-tools">
            {zoomToast && (
              <span className="zoom-badge" title={t('zoomHint')}>{zoom}%</span>
            )}
            {/* 设置按钮 + 弹出面板：主题 / 语言 / 最小化到托盘 / 关闭按钮行为 / 开机自启 */}
            <div className="settings-wrap">
              <button
                type="button"
                className={`settings-trigger${settingsOpen ? ' open' : ''}`}
                aria-label={t('settings')}
                aria-expanded={settingsOpen}
                onClick={() => setSettingsOpen(v => !v)}
              >
                <Icon name="Settings" size={16} />
                {t('settings')}
              </button>
              {settingsOpen && (
                <>
                  <div className="settings-overlay" onClick={() => setSettingsOpen(false)} />
                  <div className="settings-panel">
                    <div className="settings-panel-title">{t('settings')}</div>
                    {/* 主题：默认只显示「当前图案色块 + 名称」，点开才是图案选择器
                        （库内置 18 种背景全覆盖）。
                        缩略图直接用库 <Background> 自身渲染，所见即所得，不会与真实壁纸有偏差。 */}
                    <div className="settings-row settings-row--stack">
                      <div className="settings-row-head">
                        <span className="settings-label">{t('themeLabel')}</span>
                        <span className="settings-hint">{t('themePickerHint')}</span>
                      </div>
                      <button
                        type="button"
                        className="theme-summary"
                        aria-expanded={themeOpen}
                        title={t(themeOpen ? 'themeCollapse' : 'themeExpand')}
                        onClick={() => setThemeOpen(v => !v)}
                      >
                        <Background type={theme} className="theme-summary__dot" />
                        <span className="theme-summary__text">{t(themePreset.labelKey)}</span>
                        <span className={`theme-arrow${themeOpen ? ' open' : ''}`}>
                          <Icon name="Play" size={12} />
                        </span>
                      </button>
                      {themeOpen && (
                        <div className="theme-picker" role="radiogroup" aria-label={t('themeLabel')}>
                          {THEMES.map(p => (
                            <button
                              key={p.id}
                              type="button"
                              role="radio"
                              aria-checked={p.id === theme}
                              className={`theme-swatch${p.id === theme ? ' active' : ''}`}
                              title={t(p.labelKey)}
                              onClick={() => setTheme(p.id)}
                            >
                              <Background type={p.id} className="theme-swatch__bg" />
                              <span className="theme-swatch__name">{t(p.labelKey)}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="settings-row">
                      <span className="settings-label">{t('langLabel')}</span>
                      <div className="settings-seg">
                        <button type="button" className={lang === 'zh' ? 'active' : ''} onClick={() => setLang('zh')}>中文</button>
                        <button type="button" className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')}>English</button>
                      </div>
                    </div>
                    <div className="settings-row">
                      <span className="settings-label">{t('trayMinimize')}</span>
                      <Switch size="small" checked={trayMin} aria-label={t('trayMinimize')}
                        onChange={v => void updateSetting('minimizeToTray', v)} />
                    </div>
                    <div className="settings-row">
                      <span className={`settings-label${trayMin ? '' : ' disabled'}`}>{t('closeBehavior')}</span>
                      {/* 自绘 .mc-select（原为库 <Select>）：面板与 AI 页的供应商/模型下拉同一套风格，
                          紧凑变体与设置面板里其它控件同高 */}
                      <McSelect
                        ariaLabel={t('closeBehavior')}
                        className="mc-select--setting"
                        triggerClassName="mc-select__trigger--sm"
                        value={trayMin && closeTray ? 'tray' : 'quit'}
                        disabled={!trayMin}
                        options={[
                          { key: 'tray', label: t('closeToTray') },
                          { key: 'quit', label: t('closeQuit') }
                        ]}
                        onChange={key => void updateSetting('closeToTray', key === 'tray')}
                      />
                    </div>
                    <div className="settings-row">
                      <span className="settings-label">{t('autoLaunch')}</span>
                      <Switch size="small" checked={autoL} aria-label={t('autoLaunch')}
                        onChange={v => void updateSetting('autoLaunch', v)} />
                    </div>
                  </div>
                </>
              )}
            </div>
            {/* 帮助：与「设置」完全同款的 trigger + 面板，只换文案与两个菜单项 */}
            <div className="settings-wrap">
              <button
                type="button"
                className={`settings-trigger${helpOpen ? ' open' : ''}`}
                aria-label={t('help')}
                aria-expanded={helpOpen}
                onClick={() => setHelpOpen(v => !v)}
              >
                <Icon name="Bulb" size={16} />
                {t('help')}
              </button>
              {helpOpen && (
                <>
                  <div className="settings-overlay" onClick={() => setHelpOpen(false)} />
                  <div className="settings-panel help-panel">
                    <button type="button" className="help-item" onClick={() => void onHelp('about')}>
                      <Icon name="Bulb" size={15} />
                      {t('about')}
                    </button>
                    <button type="button" className="help-item" onClick={() => void onHelp('check')}>
                      <Icon name="Refresh" size={15} />
                      {updateInfo.checking ? t('updateChecking') : t('checkForUpdate')}
                    </button>
                  </div>
                </>
              )}
            </div>
            {loggedIn && (
              /* 退出登录改用与「设置 / 帮助」同一个 .settings-trigger：
                 原来是库 <Button type="default" ghost size="small">，描边更细、圆角更小、
                 字重更轻，和左右两个按钮明显不是一套语言。
                 换成原生 button 复用同一个类，三个按钮的度量（min-width 96px、
                 8px 13px 内边距、2px 描边、12px 圆角、同字重）与悬停反馈就完全一致了。
                 不带图标是有意的：库里没有语义合适的「退出」图标，
                 硬塞一个 Key/Bulb 反而更乱，纯文字在 96px 最小宽度下与另两个等宽。 */
              <button type="button" className="settings-trigger" onClick={clearLogin}>
                {t('logout')}
              </button>
            )}
          </div>
        </div>
      </div>

      {disabled && <div className="panel-lock-mask" />}

      <div className="panel-body" ref={bodyRef}>
        {/* 返回顶部（库 <BackTop>，文档 #/backtop）：绑定 .panel-body，滚过 240px 出现。
            位置用 .mc-backtop 上移，避开右下角的视图切换胶囊。 */}
        <BackTop className="mc-backtop" visibilityHeight={240} target={getScrollTarget} />

        {/* 单个料号 / BOM / 规格文件 */}
        <div className="mq-itemno-section card itemno-card">
          <div className="mq-itemno-label">{t('itemnoLabel')}</div>
          <div className="mq-itemno-row">
            {/* HistoryInput 内层仍是库 <Input>（className 落在外层 span 上，用于输入框外观），
                外层 .hist-input 只负责定位自绘的历史下拉面板。
                mq-grow 让整组占满行内剩余宽度，与下方多条件字段的输入框同宽。 */}
            <HistoryInput
              className="mq-grow"
              inputId="mq-itemno"
              placeholder={t('itemnoPh')}
              value={itemNo}
              options={itemHist}
              onChange={setItemNo}
              onPick={v => { setItemNo(v); pushHist('item', v) }}
              onEnter={submitItem}
              onMouseDown={stopDragOnInput}
              disabled={disabled || loading}
            />
            <Button
              type="primary"
              id="mq-itemno-search-btn"
              icon={<Icon name="Search" size={16} />}
              onClick={submitItem}
              disabled={disabled || loading || !itemNo.trim()}
            >
              {t('btnItemno')}
            </Button>
            <Button
              id="mq-bom-search-btn"
              icon={<Icon name="Tree" size={16} />}
              onClick={() => { pushHist('item', itemNo); searchBom(itemNo.trim()) }}
              disabled={disabled || loading || !itemNo.trim()}
            >
              {t('btnBom')}
            </Button>
            <Button
              className="mq-file-btn"
              id="mq-file-search-btn"
              icon={<Icon name="File" size={16} />}
              onClick={() => { pushHist('item', itemNo); searchFile(itemNo.trim()) }}
              disabled={disabled || loading || !itemNo.trim()}
            >
              {t('btnFile')}
            </Button>
          </div>
          <div className="mq-itemno-hint">{t('itemnoHint')}</div>

          {/* 批量查询：折叠壳改用库 <Collapse>（文档 #/collapse 同款问答卡），
              展开/收起、箭头旋转、内容高度过渡全部交给库，取代原先自绘的
              button + 条件渲染面板（含 .mq-disclosure 三角与 batchOpen 状态）。
              注意：库的 answer 始终在 DOM 里（靠 grid-template-rows 收起），
              所以 textarea 不再随展开而挂载/卸载。
              旧控件留下的 #mq-batch-toggle / #mq-batch-panel 已无引用（全仓检索确认），
              但输入框 / 计数 / 搜索按钮的 id 保留，外部脚本仍可定位。 */}
          <Collapse
            className="mc-collapse mq-batch-collapse"
            question={
              <span className="mq-batch-q">
                <Icon name="Folder" size={16} />
                {t('batchToggle')}
              </span>
            }
            answer={
              <>
                {/* 库 1.12.0 没有多行输入组件（Input 只渲染单行 input），
                    故这里保留原生 textarea —— 它是正确的语义标签，并非 div 模拟控件。 */}
                <textarea
                  className="mq-batch-textarea"
                  id="mq-batch-textarea"
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
                  <Button
                    type="primary"
                    className="mq-batch-search-btn"
                    id="mq-batch-search-btn"
                    icon={<Icon name="Search" size={16} />}
                    onClick={() => batchSearch()}
                    disabled={disabled || loading || !batchText.trim()}
                  >
                    {loading ? (batchMsg ? batchMsg : t('searching')) : t('btnBatch')}
                  </Button>
                </div>
                <div className="mq-batch-hint">{t('batchHint')}</div>
                {/* 未命中标记 */}
                {notFound.length > 0 && (
                  <div className="not-found-list">
                    {notFound.map(n => (
                      <Tag key={n} color="app-red" size="small">{n}</Tag>
                    ))}
                  </div>
                )}
              </>
            }
          />
        </div>

        {/* 描述多条件搜索 fields */}
        <div className="card">
          <div className="fields-label">{t('fieldsLabel')}</div>
          <div className="fields-list">
            {fields.map((f, i) => (
              <div
                key={f.id}
                className={`field-row${dragIdx === i ? ' dragging' : ''}${overIdx === i && dragIdx !== null && dragIdx !== i ? ' dragover' : ''}`}
                onDragOver={e => {
                  // 必须 preventDefault：否则浏览器不认为这里是合法落点，也就不会派发 drop
                  e.preventDefault()
                  if (dragIdx === null) return
                  if (overIdx !== i) setOverIdx(i)
                }}
                onDragLeave={() => setOverIdx(v => (v === i ? null : v))}
                onDrop={e => {
                  e.preventDefault()
                  onDrop(i)
                  setDragIdx(null)
                  setOverIdx(null)
                }}
              >
                {/* 拖拽手柄：仅此处 draggable，输入框内仍可正常选词。
                    原为 Unicode 字符「⋮⋮」，现由带主题底色的序号徽标承载拖拽与序号。 */}
                <span
                  className="mq-seq"
                  draggable
                  title={t('dragHint')}
                  onDragStart={e => {
                    setDragIdx(i)
                    setOverIdx(null)
                    // 光标改成「移动」而不是默认的「复制」，与整行搬运的语义一致
                    e.dataTransfer.effectAllowed = 'move'
                    // 必须写入数据：否则部分拖拽实现不派发 drop 事件，排序会静默失效
                    e.dataTransfer.setData('text/plain', String(i))
                  }}
                  onDragEnd={() => { setDragIdx(null); setOverIdx(null) }}
                >
                  {i + 1}
                </span>
                <HistoryInput
                  className="mq-grow"
                  value={f.val}
                  options={fieldHist}
                  onChange={v => updateField(f.id, v)}
                  onPick={v => { updateField(f.id, v); pushHist('field', v) }}
                  onBlur={v => pushHist('field', v)}
                  onMouseDown={stopDragOnInput}
                  placeholder={t('fieldPh')}
                  disabled={disabled || loading}
                />
                <Button type="text" size="small" onClick={() => removeField(f.id)} disabled={disabled || loading}>
                  {t('delete')}
                </Button>
              </div>
            ))}
          </div>
          <div className="fields-foot">
            <Button type="dashed" size="small" onClick={addField} disabled={loading}>{t('addField')}</Button>
            <span className="preview">{preview}</span>
          </div>
          <div className="fields-actions">
            {/* 主查询按钮直接使用库 type="primary"：主色由 --mc-accent 驱动，
                原先 .mq-act-green + 4 条 !important 写死 #138a7e 的覆盖已删除。 */}
            <Button type="primary" icon={<Icon name="Search" size={16} />} onClick={runSearch} disabled={disabled || loading}>
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
