import { useEffect } from 'react'
import { Icon, Modal } from 'animal-island-ui'
import { useStore } from '../store'

/**
 * 1.0.75：全局信息提示弹窗。
 *
 * 以前新提示走 `window.mcApi.showMessage` → 主进程 `dialog.showMessageBox`，
 * 是 Windows 原生蓝标题栏弹窗，和界面里 animal-island-ui 的暖米色 Modal
 * （「批量删除确认」）完全不是一套语言。这里复用同一个库 `<Modal>`：
 * 暖米色底、22px 圆角、胶囊立体按钮，挂在 App 根组件上（不依赖 AI 页是否已挂载）。
 *
 * 1.0.75 追加：渲染层自己的提示（翻译失败 / 未配 Key / 已取消等）也统一走这里。
 * 现在所有来源都汇到 `store.notice` —— 主进程发 i18n key、渲染层直接给文案，
 * 由本组件按当前语言取词后展示，避免再冒出原生框。
 */
export function NoticeModal() {
  const t = useStore(s => s.t)
  const notice = useStore(s => s.notice)
  const clearNotice = useStore(s => s.clearNotice)

  useEffect(() => {
    const offNotice = window.mcApi.onMcNotice?.((key: string) => {
      if (key) useStore.getState().showNotice(t(key as any), 'info')
    })
    const offRestored = window.mcApi.onWjxtSessionRestored?.(() => {
      useStore.getState().showNotice(t('aiWjxtRestored'), 'info')
    })
    return () => { offNotice?.(); offRestored?.() }
  }, [t])

  const close = () => clearNotice()

  return (
    <Modal
      open={!!notice}
      onClose={close}
      onOk={close}
      typewriter={false}
      width="420px"
      maskClosable
    >
      <div className="mc-notice">
        <div className={`mc-notice__icon mc-notice__icon--${notice?.type || 'info'}`}>
          <Icon name="Leaf" size={30} />
        </div>
        <div className="mc-notice__text">{notice?.message || ''}</div>
      </div>
    </Modal>
  )
}
