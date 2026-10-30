import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

/**
 * 只跑渲染进程里可以脱离 Electron 的纯逻辑用例。
 * 用 jsdom 是因为内联附件要真的操作 Range / contenteditable DOM。
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    reporters: ['default']
  },
  resolve: {
    alias: {
      '@shared': resolve(process.cwd(), 'shared')
    }
  }
})
