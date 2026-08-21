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

export function initAutoUpdater(win: BrowserWindow, feedUrl: string) {
  // 不自动下载：检测到更新后由用户在 UI 中点击「下载」再开始下载
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })

  autoUpdater.on('update-available', (info) => {
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
