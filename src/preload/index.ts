import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/types'

// 暴露给渲染进程的安全 API
contextBridge.exposeInMainWorld('mcApi', {
  // ── 登录态 ──
  openOALogin: () => ipcRenderer.invoke(IPC.OA_NAVIGATE),
  reloadLogin: () => ipcRenderer.invoke(IPC.OA_RELOAD),
  getLoginUrl: (): Promise<string> => ipcRenderer.invoke(IPC.OA_GET_LOGIN_URL),
  clearLogin: () => ipcRenderer.invoke(IPC.COOKIE_CLEAR),
  onLoginChecked: (cb: (s: { loggedIn: boolean }) => void) =>
    ipcRenderer.on(IPC.OA_CHECK_LOGGED, (_e, s) => cb(s)),
  onLoginReady: (cb: (s: { loggedIn: boolean }) => void) =>
    ipcRenderer.on(IPC.OA_LOGIN_READY, (_e, s) => cb(s)),
  onLoginState: (cb: (s: { state: string }) => void) =>
    ipcRenderer.on(IPC.OA_LOGIN_STATE, (_e, s) => cb(s)),
  onLoginLanding: (cb: () => void) =>
    ipcRenderer.on(IPC.OA_LOGIN_LANDING, () => cb()),

  // ── OA HTTP 请求（主进程代理，自动带 Cookie）──
  fetchOA: (url: string): Promise<any> => ipcRenderer.invoke(IPC.OA_FETCH, url),
  // ── 在 app 内下载规格文件（复用已登录 OA 会话，避免跳浏览器未登录）──
  downloadFile: (payload: { url: string; filename?: string }): Promise<any> =>
    ipcRenderer.invoke(IPC.OA_FILE_DOWNLOAD, payload),
  // ── 重新预热 OA 会话（901 时前端调用，消除重复重新登录）──
  refreshOaSession: (): Promise<any> => ipcRenderer.invoke(IPC.OA_REFRESH_SESSION),
  // forceQr=true 时跳过主进程自动认证判断，直接进入获取二维码流程（手动刷新用）
  startQrLogin: (forceQr?: boolean): Promise<any> => ipcRenderer.invoke(IPC.OA_QR_LOGIN_START, { forceQr: !!forceQr }),
  pollQrLogin: (payload: { qrToken: string; authChainCode: string; lck: string; entityId?: string }): Promise<any> =>
    ipcRenderer.invoke(IPC.OA_QR_LOGIN_POLL, payload),

  // 渲染进程上报崩溃日志
  logError: (msg: string) => ipcRenderer.send(IPC.LOG_ERROR, msg),

  // ── 自动更新 ──
  checkForUpdates: () => ipcRenderer.invoke(IPC.CHECK_UPDATE),
  startDownload: () => ipcRenderer.invoke(IPC.START_DOWNLOAD),
  onUpdateAvailable: (cb: (p: any) => void) => ipcRenderer.on('update-available', (_e, p) => cb(p)),
  onUpdateDownloaded: (cb: (p: any) => void) => ipcRenderer.on('update-downloaded', (_e, p) => cb(p)),
  onUpdateProgress: (cb: (p: { percent: number; transferred: number; total: number }) => void) =>
    ipcRenderer.on('update-progress', (_e, p) => cb(p)),
  onUpdateNotAvailable: (cb: (p: any) => void) => ipcRenderer.on('update-not-available', (_e, p) => cb(p)),
  onUpdateError: (cb: (p: any) => void) => ipcRenderer.on('update-error', (_e, p) => cb(p)),
  installUpdate: () => ipcRenderer.invoke(IPC.INSTALL_UPDATE),

  // ── 导出 CSV ──
  saveCsv: (content: string, defaultName: string) =>
    ipcRenderer.invoke('dialog:saveCsv', content, defaultName),

  // ── 应用版本 ──
  appVersion: (): string => ipcRenderer.sendSync(IPC.APP_VERSION),

  // ── 系统浏览器 / 页面缩放 ──
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('mc-open-external', url),
  getZoom: (): Promise<number> => ipcRenderer.invoke('mc-get-zoom'),
  setZoom: (factor: number): Promise<void> => ipcRenderer.invoke('mc-set-zoom', factor),
  resetZoom: (): Promise<void> => ipcRenderer.invoke('mc-reset-zoom')
})
