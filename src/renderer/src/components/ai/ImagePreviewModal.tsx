import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon, Modal } from 'animal-island-ui'
import { useStore } from '../../store'

const MIN_SCALE = 0.2
const MAX_SCALE = 8
const WHEEL_FACTOR = 1.12

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/**
 * AI 回复大图预览（1.0.51）—— 全屏弹窗。
 *
 * 曾经试过改成右侧分栏（用户要求「看图的同时还能滚动看回答」），实测后**恢复为弹窗**：
 * 分栏会把对话区压到半宽，窄窗口下几乎没法读文字，而弹窗还有独立窗口感。
 * 翻页能力保留 —— 它不依赖分栏，在弹窗里同样成立。
 *
 * 交互：
 *  - 默认**完整适应窗口**：注意尺寸基准必须是**内容区**而不是视口。用 `vw` 会比内容区
 *    宽出一个内边距，底部就挂出横向滚动条（用户反馈）；也不能再用 vh 去「猜」高度，
 *    因为 Modal 的 body 还要扣掉 header/footer/工具条 —— 交给 flex 链算（见 CSS）。
 *  - **上一张 / 下一张**：在「当前这条消息的所有图片」间切换（srcs 由 MessageItem 传入），
 *    支持按钮、键盘 `←/→`、到头自动环绕；
 *  - **滚轮缩放，以左上角为锚点**（用户明确要求；详见滚轮处理处的注释）、放大后**按住拖动**平移、
 *    **双击**复位；
 *  - `ESC` / 点遮罩 / 取消 / 确定 都能关闭。
 */
export default function ImagePreviewModal() {
  const preview = useStore(s => s.imgPreview)
  const closeImgPreview = useStore(s => s.closeImgPreview)
  const stepImgPreview = useStore(s => s.stepImgPreview)
  const t = useStore(s => s.t)

  const boxRef = useRef<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(1)
  // 滚轮回调里要用「最新」缩放值算补偿，但不能用 setState 的 updater 做副作用
  // （StrictMode 会双调用 updater），所以另存一份 ref。
  const scaleRef = useRef(1)
  const [panning, setPanning] = useState(false)
  const panRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null)

  const src = preview?.srcs[preview.index] || ''
  const total = preview?.srcs.length || 0
  const open = !!preview

  const applyScale = useCallback((next: number) => {
    const v = clamp(next, MIN_SCALE, MAX_SCALE)
    scaleRef.current = v
    setScale(v)
  }, [])

  // 换图或重新打开时复位到 100%（换图还保留着上次的放大倍数会让人困惑）
  useEffect(() => {
    if (!open) return
    scaleRef.current = 1
    setScale(1)
    panRef.current = null
    setPanning(false)
    // ⚠️ 必须连**滚动位置**一起复位（2026-10-11 用户反馈）：
 // 上一张若被放大并拖到右边缘，scrollLeft 会停在几百像素处；此时切到默认 100% 的新图，
    // 它的内容宽度小于容器宽度却仍带着 scrollLeft → 一闪而过的横向滚动条 + 画面停在图右侧。
    // 表现为「按→ 切换时先看到左右滚动一下，才真正切过去」。
    const box = boxRef.current
    if (box) { box.scrollLeft = 0; box.scrollTop = 0 }
  }, [open, src])

  // ESC 关闭 / ←→ 翻页（ModalProps 没有 onEsc，只能自己兜底）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { closeImgPreview(); return }
      if (e.key === 'ArrowRight') { stepImgPreview(1); return }
      if (e.key === 'ArrowLeft') { stepImgPreview(-1); return }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, closeImgPreview, stepImgPreview])

  // 滚轮缩放：必须用非passive 监听，否则 preventDefault 无效（页面会跟着一起滚）
  useEffect(() => {
    const box = boxRef.current
    if (!open || !box) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const prev = scaleRef.current
      const next = clamp(
        prev * (e.deltaY < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR),
        MIN_SCALE,
        MAX_SCALE
      )
      if (next === prev) return
            // **以左上角为锚点**缩放（2026-10-11 用户明确要求）。
            //
            // 为什么这样最自然：图片的 `max-width: 100%` 使它的**布局盒子恰好等于容器宽度**，
            // 所以 `transform: scale()` 无论以中心还是左上为原点，布局盒子都不动 ——
            // 以中心缩放时图片会往右溢出容器、被裁掉右半边，反而更糟（实测）。
            // 从左上角缩放则始终「往右下生长」，图纸类图片从左上开始阅读也最自然。
            // 因此缩放后直接把滚动位置归零，让视口回到左上角。
            applyScale(next)
            requestAnimationFrame(() => {
              box.scrollLeft = 0
              box.scrollTop = 0
            })
          }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [open, applyScale])

  const onMouseDown = (e: React.MouseEvent) => {
    const box = boxRef.current
    // 未放大时容器没有可滚动的余量，拖动没意义（也就不该显示 grab 光标）
    if (!box || scaleRef.current <= 1) return
    e.preventDefault()
    panRef.current = { x: e.clientX, y: e.clientY, sl: box.scrollLeft, st: box.scrollTop }
    setPanning(true)
  }

  const onMouseMove = (e: React.MouseEvent) => {
    const box = boxRef.current
    const p = panRef.current
    if (!box || !p) return
    box.scrollLeft = p.sl - (e.clientX - p.x)
    box.scrollTop = p.st - (e.clientY - p.y)
  }

  const endPan = () => {
    if (!panRef.current) return
    panRef.current = null
    setPanning(false)
  }

  if (!preview) return null

  // 库无 chevron 图标，沿用项目既有约定：Play 三角 + 旋转 180° 表示反向。
  //
  // 这里用**原生 title** 而不是库 `<Tooltip>`：Tooltip 是 absolute 定位，而 Modal body 带
  // `overflow-y:auto`，提示气泡会被**裁掉**（实测「上一张图片」被截成「一张图片」，用户反馈）。
  // 翻页按钮已是纯图标，原生提示够用且零裁剪风险。
  const navBtn = (delta: number, title: string) => (
    <button
      type="button"
      className="ai-img-nav-btn"
      // 只有一张图时禁用：此时「下一张」毫无意义，别让用户点了个寂寞
      disabled={total < 2}
      onClick={() => stepImgPreview(delta)}
      aria-label={title}
      title={title}
    >
      <Icon name="Play" size={14} className={delta > 0 ? '' : 'ai-rot-180'} />
    </button>
  )

  return (
    <Modal
      open
      onClose={closeImgPreview}
      //「确定」必须显式接：ModalProps 里 onOk 与 onClose 是**两个独立回调**，
      // 不传 onOk 时按钮照样渲染、点击却没有反应（用户反馈「确认按钮无功能」）。
      // 预览是纯粹的查看器，没有「确认」语义 —— 等同于「看完关掉」。
      onOk={closeImgPreview}
      typewriter={false}
      width="94vw"
      maskClosable
    >
      <div className="ai-img-preview-wrap">
        <div className="ai-img-preview-bar">
          {/* 只有一张图时不渲染计数（2026-10-30 用户反馈「100% 左边那条白色的横是什么」）。
              此前是无条件渲染、只把文本置空，而 CSS 给了 `.ai-img-preview-count`
              `min-width:46px` + `background` + `border-radius:999px` —— 空文本照样画出
              一条 46px 的浅色胶囊，看起来就是一根没来由的白条。
              这里改成条件渲染而不是「空文本 + 取消样式」：多图时它本就该占位，
              少一个元素比多一套 `.is-empty` 覆盖规则更干净。 */}
          {total > 1 && (
            <span className="ai-img-preview-count">{preview.index + 1} / {total}</span>
          )}
          {/* 缩放比例：滚轮缩放后用户需要一个数值反馈，否则不知道当前是 100% 还是 400%。
              scale 在 useState 里，缩放时本组件重渲染 → 比例实时更新。 */}
          <span className="ai-img-preview-ratio">{Math.round(scale * 100)}%</span>
          <span className="ai-img-preview-tip">{t('aiImgZoomTip')}</span>
          <span className="ai-img-preview-actions">
            {/* 「复位」刻意用**原生 button**而不是库 <Button>：库 Button 在 flex 容器里
                悬停时会被自己的 hover 样式压扁成一条竖线（用户反馈「鼠标悬停时显示不全」），
                切图时也会被挤出容器右边界被裁掉。原生按钮样式完全可控，也与两侧翻页按钮一致。 */}
            {/* disabled 判据必须是「恰好 100%」而不是 `scale <= 1`（2026-10-30 用户反馈：
                缩到 45% 时「复位」按钮是灰的，恰恰最需要它的时候点不动）。滚轮从 1 开始
                乘/除 1.12，所以回到 1 时会有浮点残差，用 1e-6 容差比较。 */}
            <button
              type="button"
              className="ai-img-reset-btn"
              onClick={() => applyScale(1)}
              title={t('aiImgReset')}
              disabled={Math.abs(scale - 1) < 1e-6}
            >
              {t('aiImgReset')}
            </button>
          </span>
        </div>
        <div className="ai-img-preview-stage">
          {total > 1 && navBtn(-1, t('aiImgPrev'))}
          <div
            ref={boxRef}
            className={`ai-img-preview${panning ? ' panning' : ''}${scaleRef.current > 1 ? ' zoomed' : ''}`}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={endPan}
            onMouseLeave={endPan}
            onDoubleClick={() => applyScale(1)}
          >
            <img
              className="ai-img-preview__img"
              src={src}
              alt={preview.alt || t('aiImgAltFallback')}
              draggable={false}
              style={{ transform: `scale(${scale})` }}
            />
          </div>
          {total > 1 && navBtn(1, t('aiImgNext'))}
        </div>
      </div>
    </Modal>
  )
}