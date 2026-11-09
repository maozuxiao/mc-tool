import { Icon, Modal } from 'animal-island-ui'
import { useStore } from '../store'

/**
 * 1.0.75：「帮助 → 关于」改用与「批量删除确认」同款的 animal-island-ui `<Modal>`
 * （暖米色底 / 22px 圆角 / 胶囊立体按钮），替代主进程 `dialog.showMessageBox`
 * 的 Windows 原生蓝标题栏弹窗（用户截图里那个带「→ 确定」的方框）。
 *
 * 文案继续复用已有的双语 `aboutInfo`（含 `{v}` 版本占位），不新增 i18n key：
 * 第一行是应用名，单独做标题；其余段落用 pre-line 原样排版。
 */
export function AboutModal({ open, onClose, appVersion }: {
  open: boolean
  onClose: () => void
  appVersion: string
}) {
  const t = useStore(s => s.t)
  const lines = t('aboutInfo', { v: appVersion }).split('\n')
  const appName = lines[0] || ''
  const body = lines.slice(1).join('\n').replace(/^\n+/, '')

  return (
    <Modal
      open={open}
      onClose={onClose}
      onOk={onClose}
      typewriter={false}
      width="480px"
      maskClosable
    >
      <div className="mc-about">
        <div className="mc-about__head">
          <div className="mc-notice__icon"><Icon name="Leaf" size={28} /></div>
          <div className="mc-about__name">{appName}</div>
        </div>
        <div className="mc-about__body">{body}</div>
      </div>
    </Modal>
  )
}
