import React from 'react'
import ReactDOM from 'react-dom/client'
import { Cursor } from 'animal-island-ui'
import { App } from './App'
import { ErrorBoundary } from './ErrorBoundary'
import { applyTheme, readStoredTheme, persistTheme } from './theme'
import 'animal-island-ui/style'
import './styles.css'
import './cursor.css'
import './components/ai/ai-chat.css'

// 首屏同步应用主题。
// 必须在 createRoot().render() 之前执行：否则会先按默认主题渲染一帧、
// 再被 React 的 effect 切成用户主题，出现一次可见的闪色。
// 这里只做「读 localStorage + 写 html 属性与 CSS 变量」，无异步、无网络、无磁盘。
// 样式表引入顺序也很关键：库样式在前、自有样式在后，自有 token 才能覆盖库默认值。
//
// 首次打开时 localStorage 里还没有主题记录，readStoredTheme() 会回落到 DEFAULT_THEME
// （奶油波点），所以「首启 = 奶油波点」；这里再把解析结果写回存储，
// 让「用户选过就一直是它」这条规则在存储层可见，而不是每次启动都依赖回落分支。
const initialTheme = readStoredTheme()
applyTheme(initialTheme)
persistTheme(initialTheme)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {/* 全局光标：库 <Cursor type="default"> 的 default 手指箭头。
          样式本体走 ./cursor.css（库的聚合样式表没有带上 Cursor，见该文件顶部说明）。
          forceAll 默认 true，会对所有后代生效；输入框的 text 光标由 cursor.css 补回。 */}
      <Cursor type="default">
        <App />
      </Cursor>
    </ErrorBoundary>
  </React.StrictMode>
)
