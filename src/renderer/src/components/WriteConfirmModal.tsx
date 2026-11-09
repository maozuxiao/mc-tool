import { useEffect, useState } from 'react'
import { Button, Icon, Modal } from 'animal-island-ui'

interface WriteConfirmRequest {
  id: string
  title: string
  message: string
  detail: string[]
  okText: string
  cancelText: string
}

/**
 * 1.0.75：AI 写已有文件前的确认框，改用与「关于 / 批量删除确认 / 全局提示」同款的
 * animal-island-ui 暖米色 `<Modal>`，替代主进程 `dialog.showMessageBox` 的原生弹窗。
 *
 * 链路：主进程 `setWriteConfirmHandler` → `IPC.WRITE_CONFIRM` 发请求（挂起工具调用）
 * → 本组件排队展示 → 用户点按钮 → `IPC.WRITE_CONFIRM_REPLY` 回传 {id, ok} 唤醒主进程。
 * 文案由主进程 `uiLang` 翻译好随请求带来，这里只排版；按钮用库 `<Button>` 保证双语。
 */
export function WriteConfirmModal() {
  const [queue, setQueue] = useState<WriteConfirmRequest[]>([])
  const req = queue[0] || null

  useEffect(() => {
    const off = window.mcApi.onWriteConfirm?.((p: WriteConfirmRequest) => {
      if (p?.id) setQueue(q => [...q, p])
    })
    return () => { off?.() }
  }, [])

  const decide = (ok: boolean) => {
    if (!req) return
    window.mcApi.replyWriteConfirm?.(req.id, ok)
    setQueue(q => q.slice(1))
  }

  return (
    <Modal
      open={!!req}
      onClose={() => decide(false)}
      onOk={() => decide(true)}
      typewriter={false}
      width="480px"
      maskClosable={false}
      footer={
        <>
          <Button onClick={() => decide(false)}>{req?.cancelText || '取消'}</Button>
          <Button type="primary" onClick={() => decide(true)}>{req?.okText || '确认写入'}</Button>
        </>
      }
    >
      <div className="mc-write-confirm">
        <div className="mc-write-confirm__head">
          <div className="mc-notice__icon"><Icon name="Edit" size={26} /></div>
          <div className="mc-write-confirm__headtext">
            <div className="mc-write-confirm__title">{req?.title}</div>
            <div className="mc-write-confirm__msg">{req?.message}</div>
          </div>
        </div>
        <div className="mc-write-confirm__detail">
          {(req?.detail || []).map((line, i) => (
            <div key={i} className={line ? '' : 'is-gap'}>{line || '\u00a0'}</div>
          ))}
        </div>
      </div>
    </Modal>
  )
}
