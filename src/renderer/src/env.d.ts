// 静态资源模块声明。
//
// 项目用 Vite 打包渲染进程，`import img from './x.png'` 会被替换成产物里的 URL 字符串。
// 但 tsconfig 的 `types` 只列了 node/electron，没有引入 `vite/client` 的全局类型，
// 因此需要显式声明图片模块，否则这类 import 会报 TS2307（找不到模块）。
declare module '*.png' {
  const src: string
  export default src
}

declare module '*.jpg' {
  const src: string
  export default src
}

declare module '*.jpeg' {
  const src: string
  export default src
}

declare module '*.webp' {
  const src: string
  export default src
}

declare module '*.gif' {
  const src: string
  export default src
}

declare module '*.svg' {
  const src: string
  export default src
}

// Vite 的 `?raw` 后缀：把文件内容当字符串导入（图标内联用，见 components/NaiveIcon.tsx）
declare module '*?raw' {
  const src: string
  export default src
}
