import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

const sharedAlias = {
  '@shared': resolve('shared')
}

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
    build: {
      lib: {
        entry: 'src/main/index.ts'
      }
    }
  },
  preload: {
    resolve: { alias: sharedAlias },
    build: {
      lib: {
        entry: 'src/preload/index.ts'
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@shared': resolve('shared'),
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    build: {
      // 临时关闭压缩，便于定位 React 运行时错误（#62 等）
      minify: false
    }
  }
})
