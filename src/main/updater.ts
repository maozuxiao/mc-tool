import { autoUpdater } from 'electron-updater'
import { BrowserWindow } from 'electron'
import { app } from 'electron'

function debugLog(msg: string) {
  try {
    if (app.isPackaged) {
      const fs = require('fs')
      const path = require('path')
      const logPath = path.join(app.getPath('userData'), 'app.log')
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`)
    }
  } catch { /* ignore */ }
  // eslint-disable-next-line no-console
  console.log(msg)
}

export interface UpdatePayload {
  hasUpdate: boolean
  version?: string
  releaseNotes?: string
  downloaded?: boolean
  message?: string
}

export function initAutoUpdater(win: BrowserWindow) {
  // 不自动下载：检测到更新后由用户在 UI 中点击「下载」再开始下载
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  // 私有仓库 + GitHub Releases：Release 附件公开可下载（无需仓库读权限/token），
  // 因此自动更新对协作者以外的人也可用；源码仍保持私有。
  autoUpdater.setFeedURL({ provider: 'github', owner: 'maozuxiao', repo: 'mc-tool' })

  autoUpdater.on('update-available', (info) => {
    // 仅在服务器版本高于本地时才视为有更新，避免低版本误报
    const na = (info.version || '').split('.').map(n => parseInt(n, 10) || 0)
    const nb = app.getVersion().split('.').map(n => parseInt(n, 10) || 0)
    const len = Math.max(na.length, nb.length)
    let newer = false
    for (let i = 0; i < len; i++) {
      const x = na[i] || 0, y = nb[i] || 0
      if (x > y) { newer = true; break }
      if (x < y) break
    }
    if (!newer) {
      debugLog(`[AUTO_UPDATE] server version ${info.version} not higher than local ${app.getVersion()}, ignore`)
      return
    }
    win.webContents.send('update-available', {
      hasUpdate: true,
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined
    } as UpdatePayload)
  })

  autoUpdater.on('download-progress', (progress) => {
    win.webContents.send('update-progress', {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total
    })
  })

  autoUpdater.on('update-downloaded', () => {
    win.webContents.send('update-downloaded', { hasUpdate: true, downloaded: true } as UpdatePayload)
  })

  autoUpdater.on('update-not-available', () => {
    win.webContents.send('update-not-available', { hasUpdate: false } as UpdatePayload)
  })

  autoUpdater.on('error', (err) => {
    // 自动更新错误不再弹到 UI 顶部；只记录日志，避免 latest.yml 缺失等场景打扰用户
    debugLog('[AUTO_UPDATE] error: ' + (err?.message || String(err)))
  })

  // 启动后延迟检查，避免阻塞首屏；失败时只记录日志，不显示 UI
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      debugLog('[AUTO_UPDATE] check failed: ' + (err?.message || String(err)))
    })
  }, 3000)
}
