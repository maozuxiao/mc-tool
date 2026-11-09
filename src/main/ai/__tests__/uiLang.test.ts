/** 1.0.75：新增 UI 提示语的中英双语契约，防止以后只加中文漏掉英文 */
import { afterEach, describe, expect, it } from 'vitest'
import { I18N, translate } from '@shared/i18n'
import { getUiLang, setUiLang, tr } from '../uiLang'

const NEW_KEYS = [
  'wjxtNoticeAlreadyH5', 'wjxtNoticeAlreadyQr', 'wjxtNoticeReQr',
  'wjxtTipBar', 'wjxtTipClose', 'wjxtLoading', 'wjxtH5Title',
  'wjxtAccountSelect', 'wjxtRemember',
  'writeConfirmTitle', 'writeConfirmOk', 'writeConfirmCancel', 'writeConfirmMsg',
  'writeConfirmTarget', 'writeConfirmExisting', 'writeConfirmMode',
  'writeConfirmLines', 'writeConfirmPreview', 'writeConfirmStartCol',
  'writeConfirmHeaderRow', 'writeConfirmBackup', 'writeCancelled',
  'writeModeUpdate', 'writeModeAppend', 'writeModeNewsSheet', 'writeModeOverwrite',
  'noDataTitle', 'noDataHint'
]

afterEach(() => setUiLang('zh'))

describe('新增提示语双语齐备', () => {
  it('每个 key 在 zh / en 都有非空文案', () => {
    for (const k of NEW_KEYS) {
      expect(typeof I18N.zh[k], `zh 缺 ${k}`).toBe('string')
      expect(typeof I18N.en[k], `en 缺 ${k}`).toBe('string')
      expect(String(I18N.en[k]).length, `en ${k} 为空`).toBeGreaterThan(0)
    }
  })
  it('en 文案确实是英文（不是回落中文）', () => {
    for (const k of NEW_KEYS) {
      expect(/[\u4e00-\u9fa5]/.test(String(I18N.en[k])), `en ${k} 仍是中文`).toBe(false)
    }
  })
  it('translate 对新增 key 按语言返回且支持 {var} 替换', () => {
    expect(translate('zh', 'wjxtNoticeAlreadyQr')).toContain('无需重复扫码')
    expect(translate('en', 'wjxtNoticeAlreadyQr')).toContain('no need to scan again')
    expect(translate('en', 'writeConfirmLines', { lines: 3, chars: 42 }))
      .toBe('This content: 3 lines / 42 characters')
  })
  it('setUiLang 会切换主进程 tr() 的取值', () => {
    setUiLang('en')
    expect(getUiLang()).toBe('en')
    expect(tr('wjxtTipClose')).toBe('Dismiss')
    expect(tr('wjxtH5Title')).toContain('Sign in to file system')
    setUiLang('zh')
    expect(tr('wjxtTipClose')).toBe('关闭提示')
    expect(getUiLang()).toBe('zh')
  })
})
