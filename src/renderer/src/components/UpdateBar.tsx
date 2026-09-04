import { useStore } from '../store'
import { Button, Icon, Progress } from 'animal-island-ui'

const setUpdateInfo = useStore.getState().setUpdateInfo

export function UpdateBar() {
  const update = useStore(s => s.updateInfo)
  const startDownload = useStore(s => s.startDownload)
  const t = useStore(s => s.t)
  const install = () => window.mcApi.installUpdate()
  const dismiss = () => setUpdateInfo({ hasUpdate: false, checking: false, error: undefined, latest: false })

  // 检测失败：显示错误提示（如网络不通 / 服务器文件缺失）
  if (update.error) {
    return (
      <div className="update-bar update-bar--error">
        {/* animal-island-ui 的 IconName 里没有 error/warning 类图标，
            合法值只有 miles/camera/chat/critterpedia/design/diy/helicopter/map/shopping/variant。
            原先写的 icon-error 不在其中（图标其实一直没渲染出来），此处取语义最中性的 variant。 */}
        <Icon name="icon-variant" size={16} />
        <span className="update-bar__text">{t('updateError', { m: update.error })}</span>
        <Button size="small" onClick={dismiss}>{t('updateDismiss')}</Button>
      </div>
    )
  }

  // 已是最新版本：手动检查（关于面板 / 托盘菜单）后给出明确反馈
  if (update.latest) {
    return (
      <div className="update-bar">
        <Icon name="icon-design" size={16} />
        <span className="update-bar__text">{t('updateLatest')}</span>
        <Button size="small" onClick={dismiss}>{t('updateDismiss')}</Button>
      </div>
    )
  }

  if (!update.hasUpdate) return null

  const pct = Math.min(100, Math.max(0, update.progress ?? 0))
  // 满了也算「收尾中」：pct>=100 但还没收到 update-downloaded 时，
  // 不把「下载」按钮交回用户（否则再点一次就是整包重下）
  const downloading = !update.downloaded && (update.downloading || pct > 0)

  return (
    <div className="update-bar">
      <Icon name="icon-design" size={16} />
      <span className="update-bar__text">
        {update.downloaded
          ? t('updateDownloaded')
          : downloading
            ? t('updateDownloading', { v: update.version || '', p: pct })
            : t('updateAvailable', { v: update.version || '' })}
      </span>

      {!update.downloaded && (
        <div className="update-bar__progress">
          {downloading ? (
            <Progress percent={pct} size="large" infoPosition="right" showInfo />
          ) : (
            <Button type="primary" size="small" onClick={startDownload}>{t('updateDownload')}</Button>
          )}
        </div>
      )}

      {update.downloaded && (
        <Button type="primary" size="small" onClick={install}>{t('updateInstall')}</Button>
      )}
    </div>
  )
}
