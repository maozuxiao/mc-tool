import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Icon } from 'animal-island-ui'

export interface McSelectOption {
  key: string
  label: string
}

interface McSelectProps {
  options: McSelectOption[]
  value: string | null | undefined
  onChange: (key: string) => void
  placeholder?: string
  disabled?: boolean
  ariaLabel?: string
  /** 外层附加类名（宽度/布局用，例如 mc-select--provider、mc-select--block） */
  className?: string
  /** 触发器附加类名（mc-select__trigger--sm 用于 34px 紧凑变体） */
  triggerClassName?: string
  /** 面板附加类名（mc-select__panel--right 右对齐到触发器右边缘） */
  panelClassName?: string
}

/** 面板与触发器 / 视口边缘的间距 */
const PANEL_GAP = 6
const VIEWPORT_PAD = 8
/** 面板最大宽度，与 .mc-select__panel 的 max-width 一致 */
const PANEL_MAX_W = 360

interface Anchor { top: number; bottom: number; left: number; right: number; width: number }

/**
 * 自绘单选下拉，用来替掉库 <Select>。
 *
 * 为什么不用库的：
 *   1. 库的下拉面板是 #ffeea0 底 + 28px 圆角 + 条目居中 + 黄色药丸高亮 + 橙色三角光标，
 *      并且从触发器的**右侧**弹出（Select.js 把 left:100% 写成了内联样式）：放在整行的
 *      协议下拉上会直接落到容器外——新增自定义供应商弹窗（.ai-prompt-modal overflow:hidden、
 *      body overflow-y:auto）里整块面板被裁掉，点了像没反应；设置面板里则挪到别处去。
 *   2. 库组件不接受 className，也拿不到内部哈希类名，改不动外观。
 * 所以这里自绘一份：面板规格与 .ai-model-panel 逐条一致（surface 底、1px 描边、14px 圆角、
 * 6px 内边距、条目 6px 8px + 主题色 14% 悬停、选中为主色渐变），触发器沿用
 * .lifecycle-trigger 的 40px / 12px / 2px 规格，与相邻控件天然齐平（见 styles.css 的 .mc-select 段）。
 *
 * 面板用 position: fixed + 运行时定位（见下方 panelStyle）：祖先带 overflow: hidden|auto
 * 或层叠上下文时，absolute 面板会被裁掉/压住；fixed 面板以视口为包含块，不受祖先裁剪。
 * 打开后会跟随触发器的滚动与窗口缩放，下方空间不够时自动向上展开。
 *
 * 交互按库的行为对齐：点击外部关闭、Esc 关闭、Enter/Space/上下键开合并选择、方向键移动高亮。
 */
export function McSelect({
  options,
  value,
  onChange,
  placeholder,
  disabled,
  ariaLabel,
  className = '',
  triggerClassName = '',
  panelClassName = ''
}: McSelectProps) {
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // 触发器在视口里的位置 + 视口尺寸 + 是否向上翻：面板 fixed 定位的三个输入
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [viewport, setViewport] = useState({ w: 0, h: 0 })
  const [flipped, setFlipped] = useState(false)

  const syncAnchor = useCallback(() => {
    const t = triggerRef.current
    if (!t) return
    const r = t.getBoundingClientRect()
    setAnchor({ top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width })
    setViewport({ w: window.innerWidth, h: window.innerHeight })
  }, [])

  // 点击组件外部关闭
  useEffect(() => {
    if (!open) return
    const onDocDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [open])

  // 展开时取一次触发器位置；滚动/缩放时跟着更新（fixed 面板不会自己跟着走）
  useEffect(() => {
    if (!open) {
      setAnchor(null)
      setFlipped(false)
      return
    }
    syncAnchor()
    window.addEventListener('resize', syncAnchor)
    window.addEventListener('scroll', syncAnchor, true)
    return () => {
      window.removeEventListener('resize', syncAnchor)
      window.removeEventListener('scroll', syncAnchor, true)
    }
  }, [open, syncAnchor])

  // 每次展开时把高亮定位到当前值（options 是调用处内联的数组，不能进依赖，否则每渲染都会重置）
  useEffect(() => {
    if (open) setHover(value ?? options[0]?.key ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 面板挂载后量一次高度：下方放不下、上方放得下就翻到触发器上方（弹窗与设置面板都在窗口下沿附近）
  useLayoutEffect(() => {
    if (!open) return
    const t = triggerRef.current
    const p = panelRef.current
    if (!t || !p) return
    const r = t.getBoundingClientRect()
    const h = p.offsetHeight
    const needFlip = r.bottom + PANEL_GAP + h > window.innerHeight - VIEWPORT_PAD
      && r.top - PANEL_GAP - h >= VIEWPORT_PAD
    if (needFlip !== flipped) setFlipped(needFlip)
  }, [open, flipped, anchor])

  const current = options.find(o => o.key === value)

  // 整行变体（--block）：面板与触发器等宽；其余按内容撑开，至少与触发器同宽
  const isBlock = className.includes('mc-select--block')
  const alignRight = panelClassName.includes('--right')
  const availableW = viewport.w ? viewport.w - VIEWPORT_PAD * 2 : PANEL_MAX_W
  let panelStyle: CSSProperties | undefined
  if (anchor && viewport.w) {
    const blockW = Math.min(anchor.width, availableW)
    // 右边缘超出视口时整体左移（--right 变体反过来对齐右边缘）
    const left = alignRight
      ? 'auto'
      : Math.max(VIEWPORT_PAD, Math.min(anchor.left, viewport.w - VIEWPORT_PAD - (isBlock ? blockW : Math.min(PANEL_MAX_W, availableW))))
    panelStyle = {
      position: 'fixed',
      left,
      right: alignRight ? Math.max(VIEWPORT_PAD, viewport.w - anchor.right) : 'auto',
      ...(isBlock
        ? { width: blockW, minWidth: blockW, maxWidth: availableW }
        : { minWidth: anchor.width, maxWidth: Math.min(PANEL_MAX_W, availableW) }),
      ...(flipped
        ? { top: 'auto', bottom: Math.max(VIEWPORT_PAD, viewport.h - anchor.top + PANEL_GAP) }
        : { top: anchor.bottom + PANEL_GAP, bottom: 'auto' })
    }
  }

  const choose = (key: string) => {
    onChange(key)
    setOpen(false)
  }

  const onTriggerKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = options.length
      if (!n) return
      const i = options.findIndex(o => o.key === hover)
      const step = e.key === 'ArrowDown' ? 1 : -1
      const next = i < 0 ? (step === 1 ? 0 : n - 1) : (i + step + n) % n
      setHover(options[next].key)
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (hover) choose(hover)
    }
  }

  return (
    <div className={`mc-select${className ? ' ' + className : ''}`} ref={rootRef}>
      <div
        ref={triggerRef}
        className={`mc-select__trigger${open ? ' open' : ''}${disabled ? ' disabled' : ''}${triggerClassName ? ' ' + triggerClassName : ''}`}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        onClick={() => !disabled && setOpen(v => !v)}
        onKeyDown={onTriggerKey}
      >
        <span className={`mc-select__value${current ? '' : ' placeholder'}`}>
          {current?.label ?? placeholder ?? ''}
        </span>
        {/* 展开三角：库 Play 图标（实心三角）旋转 90° 得到 ▼，展开时转回 ▶，
            与 .lifecycle-arrow 同一套做法，不再用「▼」字符（字体间粗细/基线不一致） */}
        <span className="mc-select__arrow"><Icon name="Play" size={10} /></span>
      </div>
      {open && (
        <div
          ref={panelRef}
          className={`mc-select__panel${panelClassName ? ' ' + panelClassName : ''}`}
          // 首次渲染时还没量到触发器坐标，先隐藏占位，避免面板闪一帧到错误位置
          style={anchor ? panelStyle : { visibility: 'hidden' }}
          role="listbox"
          aria-label={ariaLabel}
        >
          {options.map(o => (
            <div
              key={o.key}
              role="option"
              aria-selected={o.key === value}
              className={`mc-select__option${o.key === value ? ' active' : ''}${o.key === hover ? ' hover' : ''}`}
              onMouseEnter={() => setHover(o.key)}
              // 用 mousedown 而不是 click：避免「点击外部关闭」的 document 监听先于选择触发
              onMouseDown={e => {
                e.preventDefault()
                choose(o.key)
              }}
            >
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
