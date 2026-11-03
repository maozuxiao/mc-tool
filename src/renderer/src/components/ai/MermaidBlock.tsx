import { createContext, memo, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../../store'

/**
 * AI 回复里的 Mermaid 图（1.0.71）。
 *
 * 背景：模型很爱用 ```mermaid 画流程/时序/状态图，此前只能看到一坨源码 —— 因为
 * react-markdown 只挂了 rehypeSanitize + rehype-highlight，没有任何 code 级渲染。
 *
 * 三条关键实现约束（都是踩过的坑，改动前先读）：
 *
 * 1) **不能走 rehype-sanitize**。它会把 SVG 里的 style / 属性全部剥掉，图直接散架。
 *    所以图是在 `code` 组件的**自定义渲染**里生成的：sanitize 只作用于 Markdown 转出的
 *    hast，组件返回的 JSX 不受影响，等于我们自己接管了这段 DOM。安全性由
 *    mermaid 的 `securityLevel: 'strict'` 负责（它会净化 label 里的 HTML / 事件属性），
 *    `htmlLabels: false` 再压掉一部分 HTML label，最后过一道自研的 `hardenSvg`
 *    （见下）—— 三层叠加，不依赖任何单一环节。
 *
 * 2) **mermaid 必须懒加载**。它整包 ~3MB（本项目 renderer 还关了 minify），首屏加载
 *    会被拖慢；`import('mermaid')` 让 rollup 单独切一个 chunk，只有真的出现图表时才请求。
 *
 * 3) **渲染要串行**。mermaid 的 render 依赖模块级全局状态（内部有临时容器与当前配置），
 *    多条历史消息里的多个图同时渲染会互相串味（实测报 "Diagram already exists" 或
 *    串图）。这里用一条 Promise 链把它们排队。
 */

type MermaidAPI = {
  initialize: (config: Record<string, unknown>) => void
  parse: (text: string) => Promise<unknown>
  render: (id: string, text: string) => Promise<{ svg: string }>
}

/** 流式生成中标记：true 时只显示源码，不尝试渲染（半截语法必然报错，且每来一个字都会重渲） */
export const MermaidLiveContext = createContext(false)

let mermaidLoader: Promise<MermaidAPI> | null = null

function loadMermaid(): Promise<MermaidAPI> {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid')
      .then((m: any) => (m?.default || m) as MermaidAPI)
      .catch((e) => {
        // 失败不缓存：磁盘/打包异常恢复后下一次还能重试
        mermaidLoader = null
        throw e
      })
  }
  return mermaidLoader
}

/** 串行队列：保证同一时刻只有一张图在 render */
let renderChain: Promise<unknown> = Promise.resolve()

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = renderChain.then(fn, fn)
  renderChain = next.catch(() => undefined)
  return next
}

/** 主题跟随 <html data-mode>（applyTheme 写入），暗色用 mermaid 的 dark 预设 */
function isDarkMode(): boolean {
  return document.documentElement.dataset.mode === 'dark'
}

/**
 * 渲染结果的最后一道闸。
 *
 * 即便 mermaid 已经是 `securityLevel: 'strict'`（内部会净化 label 里的 HTML），也不要
 * 直接把它的字符串塞进 dangerouslySetInnerHTML —— 这段 HTML 的源头是模型输出，
 * 而渲染层是唯一还持有 preload API 的地方。这里做纯白名单式清理（只删不加）：
 *   - 干掉 script / iframe / object / embed / link / meta / base / form
 *   - 干掉所有 on* 事件属性与 javascript: 协议
 * 解析失败（非严格 XML）就原样返回：mermaid 的 cleanUpSvgCode 已保证 <br> 等已闭合，
 * 走不到这里基本只有 svg 为空这一种情况。
 */
const DANGEROUS_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form'])

function hardenSvg(svg: string): string {
  try {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    if (doc.getElementsByTagName('parsererror').length) return svg
    const nodes = Array.from(doc.getElementsByTagName('*'))
    for (const el of nodes) {
      if (DANGEROUS_TAGS.has(el.tagName.toLowerCase())) {
        el.remove()
        continue
      }
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase()
        if (name.startsWith('on')) {
          el.removeAttribute(attr.name)
          continue
        }
        if ((name === 'href' || name === 'xlink:href' || name === 'src')
          && /^\s*(javascript|data:text\/html)/i.test(attr.value)) {
          el.removeAttribute(attr.name)
        }
      }
    }
    return new XMLSerializer().serializeToString(doc.documentElement)
  } catch {
    return svg
  }
}

function shortError(e: unknown): string {
  const raw = String((e as any)?.message || e || '').trim()
  if (!raw) return ''
  // mermaid 的报错常带一大段「我这里期望 X 却遇到 Y」的多行说明 + 位置标记，取首行即可看懂
  return raw.split('\n').find((l) => l.trim()) || raw
}

const MermaidBlock = memo(function MermaidBlock({ code }: { code: string }) {
  const t = useStore((s) => s.t)
  // 只用来在换肤时触发重算（真正的取值在 isDarkMode 里读 DOM）
  const theme = useStore((s) => s.theme)
  const live = useContext(MermaidLiveContext)
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const seqRef = useRef(0)
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  const [zoom, setZoom] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | null>(null)

  useEffect(() => {
    if (live) return
    const src = String(code || '').trim()
    if (!src) return
    const seq = ++seqRef.current
    // 刻意不清空上一张图：切换深浅色主题时会重渲染，先清空会闪一下空白
    setError('')

    let alive = true
    const dark = isDarkMode()
    serialize(async () => {
      const mermaid = await loadMermaid()
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        // 浅色用 neutral（灰白节点 + 深灰连线），比 default 的淡紫更贴麦芽色 UI；
        // 深色用 dark（neutral 在深底上对比度不够）
        theme: dark ? 'dark' : 'neutral',
        // 背景交给外层卡片（.ai-mermaid）：mermaid 默认会给 svg 画一块白/深灰底，
        // 在浅色主题里比卡片底色更白、暗色主题里更黑，边界会很明显
        themeVariables: { background: 'transparent' },
        fontFamily: 'inherit',
        // htmlLabels:false 能压掉一部分 HTML label，但 mermaid 11 的 classic 节点
        // 仍会用 foreignObject 包一层 <span>（实测），所以外部还得有 hardenSvg 兜底
        flowchart: { htmlLabels: false, useMaxWidth: true },
        sequence: { useMaxWidth: true },
        gantt: { useMaxWidth: true },
        timeline: { useMaxWidth: true }
      })
      await mermaid.parse(src)
      return mermaid.render(`mmd-${uid}-${seq}`, src)
    })
      .then((res) => {
        if (!alive || seq !== seqRef.current) return
        setSvg(res?.svg ? hardenSvg(res.svg) : '')
      })
      .catch((e) => {
        if (!alive || seq !== seqRef.current) return
        setError(shortError(e) || 'render failed')
      })

    return () => {
      alive = false
    }
  }, [code, live, theme, uid])

  useEffect(() => () => { if (copyTimer.current) window.clearTimeout(copyTimer.current) }, [])

  const handleCopy = useCallback(async () => {
    try { await navigator.clipboard.writeText(code) } catch { /* 忽略：只影响复制反馈 */ }
    setCopied(true)
    if (copyTimer.current) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500)
  }, [code])

  // 流式中 / 还没渲染出图 / 语法有误 → 统一退回源码块，保证用户随时能看到内容
  if (!svg) {
    return (
      <div className="ai-mermaid ai-mermaid--src">
        {(live || error) && (
          <div className={`ai-mermaid__note${error ? ' is-error' : ''}`}>
            {error ? `${t('aiMermaidError')}：${error}` : t('aiMermaidRendering')}
          </div>
        )}
        <pre className="ai-mermaid__pre">{code}</pre>
      </div>
    )
  }

  const canvas = <div className="ai-mermaid__svg" dangerouslySetInnerHTML={{ __html: svg }} />

  return (
    <div className="ai-mermaid">
      <div className="ai-mermaid__canvas" onClick={() => setZoom(true)} title={t('aiMermaidZoom')}>
        {canvas}
      </div>
      <div className="ai-mermaid__acts">
        <button type="button" className="ai-mermaid__btn" onClick={handleCopy}>
          {copied ? t('aiMermaidCopied') : t('aiMermaidCopy')}
        </button>
        <button type="button" className="ai-mermaid__btn" onClick={() => setZoom(true)}>
          {t('aiMermaidZoom')}
        </button>
      </div>
      {zoom && createPortal(
        <div className="ai-mermaid-zoom" onClick={() => setZoom(false)}>
          <div className="ai-mermaid-zoom__bar">
            <button type="button" className="ai-mermaid__btn" onClick={handleCopy}>
              {copied ? t('aiMermaidCopied') : t('aiMermaidCopy')}
            </button>
            <button type="button" className="ai-mermaid__btn" onClick={() => setZoom(false)}>
              {t('aiMermaidClose')}
            </button>
          </div>
          <div
            className="ai-mermaid-zoom__inner"
            onClick={(e) => e.stopPropagation()}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>,
        document.body
      )}
    </div>
  )
})

export default MermaidBlock
