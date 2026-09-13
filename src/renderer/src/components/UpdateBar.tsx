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
        {/* 1.12.0 起 IconName 为 101 个帕斯卡命名的内置图标（Bell/Check/Download/Lock…），
            旧的小写短横线名（icon-error / icon-variant / icon-design）已非法并会静默不渲染。
            失败态用 Bell 表达「有提醒」，与右侧的关闭按钮在语义上区分开。 */}
        <Icon name="Bell" size={16} />
        <span className="update-bar__text">{t('updateError', { m: update.error })}</span>
        <Button size="small" onClick={dismiss}>{t('updateDismiss')}</Button>
      </div>
    )
  }

  // 已是最新版本：手动检查（关于面板 / 托盘菜单）后给出明确反馈
  if (update.latest) {
    return (
      <div className="update-bar">
        <Icon name="Check" size={16} />
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
      <Icon name="Download" size={16} />
      <span className="update-bar__text">
        {update.downloaded
          ? t('updateDownloaded')
          : downloading
            ? t('updateDownloading', { v: update.version || '', p: pct })
            : t('updateAvailable', { v: update.version || '' })}
      </span>

      {!update.downloaded && (
        <div className="update-bar__progress">
          {/* 1.12.0 的 Progress 已移除 infoPosition，百分比固定显示在右侧 */}
          {downloading ? (
            <Progress percent={pct} size="small" showInfo />
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
