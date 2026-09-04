import { contextBridge, ipcRenderer } from 'electron'
import { AI_IPC } from '@shared/ai-types'
import { IPC } from '@shared/types'

// 当前界面语言，随 setUiLang 更新，供原生弹窗（dialog:message/confirm）自动带上，
// 确保按钮与标题跟随界面语言，无需每个调用点手动传 lang。
let currentLang: 'zh' | 'en' = 'zh'

const mcApi = {
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

  fetchOA: (url: string): Promise<any> => ipcRenderer.invoke(IPC.OA_FETCH, url),
  downloadFile: (payload: { url: string; filename?: string }): Promise<any> =>
    ipcRenderer.invoke(IPC.OA_FILE_DOWNLOAD, payload),
  refreshOaSession: (): Promise<any> => ipcRenderer.invoke(IPC.OA_REFRESH_SESSION),
  startQrLogin: (forceQr?: boolean): Promise<any> => ipcRenderer.invoke(IPC.OA_QR_LOGIN_START, { forceQr: !!forceQr }),
  pollQrLogin: (payload: { qrToken: string; authChainCode: string; lck: string; entityId?: string }): Promise<any> =>
    ipcRenderer.invoke(IPC.OA_QR_LOGIN_POLL, payload),

  logError: (msg: string) => ipcRenderer.send(IPC.LOG_ERROR, msg),

  checkForUpdates: () => ipcRenderer.invoke(IPC.CHECK_UPDATE),
  startDownload: () => ipcRenderer.invoke(IPC.START_DOWNLOAD),
  onUpdateAvailable: (cb: (p: any) => void) => ipcRenderer.on('update-available', (_e, p) => cb(p)),
  onUpdateDownloaded: (cb: (p: any) => void) => ipcRenderer.on('update-downloaded', (_e, p) => cb(p)),
  onUpdateProgress: (cb: (p: { percent: number; transferred: number; total: number }) => void) =>
    ipcRenderer.on('update-progress', (_e, p) => cb(p)),
  onUpdateNotAvailable: (cb: (p: any) => void) => ipcRenderer.on('update-not-available', (_e, p) => cb(p)),
  onUpdateError: (cb: (p: any) => void) => ipcRenderer.on('update-error', (_e, p) => cb(p)),
  installUpdate: () => ipcRenderer.invoke(IPC.INSTALL_UPDATE),
  // 托盘右键菜单「检查更新」：通知渲染层复用已有的 checkUpdate() 流程（含完整 UI 反馈）
  onTrayCheckUpdate: (cb: () => void) => ipcRenderer.on('tray:check-update', () => cb()),

  saveCsv: (content: string, defaultName: string) =>
    ipcRenderer.invoke('dialog:saveCsv', content, defaultName),

  // 提示框一律走主进程 dialog.showMessageBox，不要用 window.alert / window.confirm。
  // 那两个是同步阻塞渲染进程的：弹窗一旦被主窗口挡住或用户没注意到，
  // 整个界面就会表现为「全局无法输入」，只能重启应用才恢复。
  showMessage: (opts: {
    message: string
    title?: string
    type?: 'none' | 'info' | 'error' | 'warning' | 'question'
    // 显式指定弹窗语言（优先于 currentLang）：调用方直接把界面语言带上，杜绝同步竞态
    lang?: 'zh' | 'en'
  }): Promise<void> => ipcRenderer.invoke('dialog:message', { ...opts, lang: opts.lang ?? currentLang }),
  showConfirm: (opts: { message: string; title?: string; lang?: 'zh' | 'en' }): Promise<boolean> =>
    ipcRenderer.invoke('dialog:confirm', { ...opts, lang: opts.lang ?? currentLang }),
  // 同步当前界面语言给主进程：dialog.showMessageBox 的按钮（确定/OK、取消/Cancel）
  // 与默认标题随语言切换（原生弹窗不会自己跟随应用内语言设置）
  setUiLang: (lang: 'zh' | 'en'): void => { currentLang = lang === 'en' ? 'en' : 'zh'; ipcRenderer.send('dialog:setLang', lang) },

  // 托盘 / 偏好设置（设置面板：最小化到托盘、关闭按钮行为、开机自启；持久化在主进程 app-prefs.json）
  getAppPrefs: (): Promise<{ minimizeToTray: boolean; closeToTray: boolean; autoLaunch: boolean }> =>
    ipcRenderer.invoke('app:getPrefs'),
  setSetting: (key: 'minimizeToTray' | 'closeToTray' | 'autoLaunch', v: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('app:setSetting', key, v),
  // 托盘右键菜单「物料查询 / AI 助手」→ 渲染层切换视图
  onTraySwitchView: (cb: (v: 'query' | 'ai') => void) =>
    ipcRenderer.on('tray:switch-view', (_e, v) => cb(v)),

  appVersion: (): string => ipcRenderer.sendSync(IPC.APP_VERSION),

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('mc-open-external', url),
  getZoom: (): Promise<number> => ipcRenderer.invoke('mc-get-zoom'),
  setZoom: (factor: number): Promise<void> => ipcRenderer.invoke('mc-set-zoom', factor),
  resetZoom: (): Promise<void> => ipcRenderer.invoke('mc-reset-zoom'),

  ai: {
    getProviders: () => ipcRenderer.invoke(AI_IPC.GET_PROVIDERS),
    saveProvider: (input: any) => ipcRenderer.invoke(AI_IPC.SAVE_PROVIDER, input),
    addCustomProvider: (input: any) => ipcRenderer.invoke(AI_IPC.ADD_CUSTOM_PROVIDER, input),
    deleteCustomProvider: (id: string) => ipcRenderer.invoke(AI_IPC.DELETE_CUSTOM_PROVIDER, id),
    resetProvider: (id: string) => ipcRenderer.invoke(AI_IPC.RESET_PROVIDER, id),
    listModels: (providerId: string) => ipcRenderer.invoke(AI_IPC.LIST_MODELS, providerId),
    testProvider: (input: { providerId: string; modelId?: string }) => ipcRenderer.invoke(AI_IPC.TEST_PROVIDER, input),
    listConversations: () => ipcRenderer.invoke(AI_IPC.LIST_CONVERSATIONS),
    getConversation: (id: string) => ipcRenderer.invoke(AI_IPC.GET_CONVERSATION, id),
    renameConversation: (id: string, title: string) => ipcRenderer.invoke(AI_IPC.RENAME_CONVERSATION, id, title),
    deleteConversation: (id: string) => ipcRenderer.invoke(AI_IPC.DELETE_CONVERSATION, id),
    sendMessage: (payload: any) => ipcRenderer.invoke(AI_IPC.SEND_MESSAGE, payload),
    stopMessage: (conversationId: string) => ipcRenderer.invoke(AI_IPC.STOP_MESSAGE, conversationId),
    selectWorkspace: (): Promise<any> => ipcRenderer.invoke(AI_IPC.SELECT_WORKSPACE),
    clearWorkspace: (): Promise<any> => ipcRenderer.invoke(AI_IPC.CLEAR_WORKSPACE),
    addExtraRoot: (): Promise<any> => ipcRenderer.invoke(AI_IPC.ADD_EXTRA_ROOT),
    removeExtraRoot: (input: { alias?: string; path?: string }): Promise<any> =>
      ipcRenderer.invoke(AI_IPC.REMOVE_EXTRA_ROOT, input),
    listPrompts: (): Promise<any> => ipcRenderer.invoke(AI_IPC.LIST_PROMPTS),
    savePrompt: (input: { text: string; title?: string }): Promise<any> =>
      ipcRenderer.invoke(AI_IPC.SAVE_PROMPT, input),
    updatePrompt: (input: { id: string; text: string; title?: string }): Promise<any> =>
      ipcRenderer.invoke(AI_IPC.UPDATE_PROMPT, input),
    deletePrompt: (id: string): Promise<any> => ipcRenderer.invoke(AI_IPC.DELETE_PROMPT, id),
    onEvent: (cb: (event: any) => void) => {
      const listener = (_e: any, event: any) => cb(event)
      ipcRenderer.on(AI_IPC.EVENT, listener)
      // 清理函数必须返回 void：removeListener 会返回 IpcRenderer，
      // 直接返回会让 React 的 useEffect 把它当成非法 cleanup 返回值（EffectCallback 不匹配）。
      return () => { ipcRenderer.removeListener(AI_IPC.EVENT, listener) }
    }
  }
}

contextBridge.exposeInMainWorld('mcApi', mcApi)

// 渲染层在 src/renderer/src/global.d.ts 中引用此类型。
// 从 preload 推导而非手写：preload 增删方法时类型自动跟随，不会像手写声明那样腐化。
export type McApi = typeof mcApi
