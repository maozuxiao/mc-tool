import rocketRaw from 'naive-icons/svg/rocket.svg?raw'
import pencilRaw from 'naive-icons/svg/pencil.svg?raw'
import trashRaw from 'naive-icons/svg/trash.svg?raw'
import playRaw from 'naive-icons/svg/play.svg?raw'
import closeRaw from 'naive-icons/svg/close.svg?raw'

/**
 * naive-icons（手绘 naive folk art 风，MIT，v1.1.0）图标 —— AI 面板里的「操作类」小图标统一走这里。
 *
 * 为什么用它的 `svg/*.svg` 原始资源、而不是它的 React 组件：
 * 组件版 `dist/index.mjs` 把 116 枚图标统统用顶层 `forwardRef(...)` 包了一层，且**没有 `@__PURE__` 标注**，
 * 打包器摇不动树 —— 实测只引 5 枚也会把整包（134KB）带进产物（renderer 1324KB → 1469KB，
 * 产物里还能搜到 CatIcon / PenguinIcon 等没用的图标）。直接引 `svg/*.svg?raw`
 * （该包 package.json 的 exports 已开放 `./svg/*`）只有几百字节一枚，产物几乎零增长。
 *
 * 上色：库里的 SVG 是「描边 `#2A2A2A` + 内部固定 9 色填充」，直接塞进主题色药丸 / 小按钮里会显得花。
 * 这里在渲染前统一改色 —— 描边换 `currentColor`，彩色填充换成同色淡染（20%）：
 * 形状仍是手绘的，整体颜色跟随所在主题（与项目其它地方的 currentColor 用法一致）。
 */
const RAW = {
  rocket: rocketRaw,
  pencil: pencilRaw,
  trash: trashRaw,
  play: playRaw,
  close: closeRaw
} as const

export type NaiveIconName = keyof typeof RAW

function themeize(svg: string): string {
  return svg
    .replace(/stroke="#2A2A2A"/gi, 'stroke="currentColor"')
    // 只动彩色填充；根节点上的 fill="none" 与没有 fill 的元素不受影响
    .replace(/fill="#[0-9A-Fa-f]{3,8}"/g, 'fill="currentColor" fill-opacity="0.2"')
}

const SRC: Record<NaiveIconName, string> = {
  rocket: themeize(RAW.rocket),
  pencil: themeize(RAW.pencil),
  trash: themeize(RAW.trash),
  play: themeize(RAW.play),
  close: themeize(RAW.close)
}

export function NaiveIcon({ name, size = 14, className, title }: {
  name: NaiveIconName
  size?: number
  className?: string
  title?: string
}) {
  return (
    <span
      className={`naive-icon${className ? ' ' + className : ''}`}
      style={{ width: size, height: size }}
      title={title}
      aria-hidden={title ? undefined : true}
      // 内容是自己打包进来的静态 SVG（无任何用户输入），不存在注入面
      dangerouslySetInnerHTML={{ __html: SRC[name] }}
    />
  )
}
