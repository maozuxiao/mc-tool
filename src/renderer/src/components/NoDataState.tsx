import { Icon } from 'animal-island-ui'
import { useStore } from '../store'

/**
 * 1.0.75：MC 物料查询「查询成功但 0 条」的空状态。
 *
 * 以前 0 条和「从未查询」共用 `.empty-box` 的引导语（「请输入料号后点击…」），
 * 用户查完没结果却看不到任何「No Data」反馈。现在由 store 的 `xxxQueried`
 * 区分两种状态，查过且为空时渲染本组件。
 *
 * 观感参考 animal-island-ui 的 no-data：暖米色纸面、有机 blob、库内置矢量图标、
 * 大圆角、软浮动动效；配色全部取 --mc-* 主题变量（见 styles.css 的 .mc-nodata）。
 */
export function NoDataState() {
  const t = useStore(s => s.t)
  return (
    <div className="mc-nodata" role="status" aria-live="polite">
      <div className="mc-nodata__blob">
        <Icon name="Search" size={44} className="mc-nodata__icon" />
      </div>
      <div className="mc-nodata__title">{t('noDataTitle' as any)}</div>
      <div className="mc-nodata__hint">{t('noDataHint' as any)}</div>
    </div>
  )
}
