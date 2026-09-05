import { useStore } from '../store'
import { Button, Icon } from 'animal-island-ui'

/**
 * OA 登录失效提示条（1.0.34）。
 *
 * 结构与样式完全复用 UpdateBar：主窗口顶部横幅，左侧图标 + 中部文案 + 右侧操作按钮。
 *
 * 存在意义：历史缺陷是 store.error 在渲染层没有任何组件消费——查询因会话失效失败时，
 * 错误只被写进 error 字段，界面上一个字都不显示，用户以为「点了查询没反应」。
 * 这里给出明确提示与一键重新登录入口；即便扫码层因 IAM 半登录态拉码失败，
 * 本提示条依然可见可用，用户可随时点「重新登录」重试。
 */
export function SessionExpiredBar() {
  const expired = useStore(s => s.sessionExpired)
  const t = useStore(s => s.t)

  if (!expired) return null

  // 重新登录：置为未登录并请主进程重新检测登录态，渲染层会自动拉起扫码层并出码
  const relogin = () => useStore.getState().reLogin()

  return (
    <div className="update-bar update-bar--error">
      <Icon name="icon-variant" size={16} />
      <span className="update-bar__text">{t('sessionExpired')}</span>
      <Button type="primary" size="small" onClick={relogin}>{t('reLogin')}</Button>
    </div>
  )
}
