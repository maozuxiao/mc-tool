/**
 * 1.0.75：主进程侧的界面语言（单一来源）。
 *
 * 主进程里的弹窗、注入到第三方页面的提示条、子窗口标题等文案以前是硬编码中文，
 * 切到英文界面后一半中文一半英文。这里把语言收敛成一个模块级变量，由
 * `index.ts` 的 `dialog:setLang` 同步，其它主进程模块统一用 `tr(key)` 取词。
 * 渲染层仍走自己的 `useStore.t`，不经过这里。
 */
import { translate, type Lang } from '@shared/i18n'

let current: Lang = 'zh'

export function setUiLang(lang: string): void {
  current = lang === 'en' ? 'en' : 'zh'
}

export function getUiLang(): Lang {
  return current
}

/** 按当前界面语言翻译；缺 key 时 `translate` 会回落中文 / key 本身 */
export function tr(key: string, vars?: Record<string, string | number>): string {
  return translate(current, key, vars)
}
