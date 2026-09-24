import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { AI_IPC } from '@shared/ai-types'
import { IPC } from '@shared/types'
import type { HolidayPlan } from '@shared/types'

// 当前界面语言，随 setUiLang 更新，供原生弹窗（dialog:message/confirm）自动带上，
// 确保按钮与标题跟随界面语言，无需每个调用点手动传 lang。
let currentLang: 'zh' | 'en' = 'zh'

/**
 * 订阅主进程事件并返回「取消订阅」函数。
 *
 * 1.0.42 性能优化：原先这些 on* 直接 `return ipcRenderer.on(...)`，返回的是 IpcRenderer
 * 对象（不可调用）—— 渲染层既无法清理监听，也不能把它当 cleanup 用；React StrictMode 下
 * effect 会「挂载→卸载→再挂载」，没有 cleanup 就会注册两份监听，同一条事件被处理两次
 * （登录态、更新进度都会重复触发）。统一收敛成返回 disposer。
 */
function subscribe(channel: string, cb: (...args: any[]) => void): () => void {
  const listener = (_e: unknown, ...args: any[]) => cb(...args)
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

const mcApi = {
  openOALogin: () => ipcRenderer.invoke(IPC.OA_NAVIGATE),
  reloadLogin: () => ipcRenderer.invoke(IPC.OA_RELOAD),
  getLoginUrl: (): Promise<string> => ipcRenderer.invoke(IPC.OA_GET_LOGIN_URL),
  clearLogin: () => ipcRenderer.invoke(IPC.COOKIE_CLEAR),
  onLoginChecked: (cb: (s: { loggedIn: boolean }) => void) => subscribe(IPC.OA_CHECK_LOGGED, cb),
  onLoginReady: (cb: (s: { loggedIn: boolean }) => void) => subscribe(IPC.OA_LOGIN_READY, cb),
  onLoginState: (cb: (s: { state: string }) => void) => subscribe(IPC.OA_LOGIN_STATE, cb),
  onLoginLanding: (cb: () => void) => subscribe(IPC.OA_LOGIN_LANDING, cb),

  fetchOA: (url: string): Promise<any> => ipcRenderer.invoke(IPC.OA_FETCH, url),
  // id 可选：带上它就订阅得到这次下载的进度（见 onDownloadProgress），用于链接上显示百分比
  downloadFile: (payload: { url: string; filename?: string; id?: string }): Promise<any> =>
    ipcRenderer.invoke(IPC.OA_FILE_DOWNLOAD, payload),
  // 流式下载进度：主进程边下边写，这里按块收到 { id, received, total }；结束/失败另有 done / error
  onDownloadProgress: (cb: (p: { id: string; received?: number; total?: number; done?: boolean; size?: number; error?: string }) => void) =>
    subscribe('mc-download-progress', cb),
  refreshOaSession: (): Promise<any> => ipcRenderer.invoke(IPC.OA_REFRESH_SESSION),
  startQrLogin: (forceQr?: boolean): Promise<any> => ipcRenderer.invoke(IPC.OA_QR_LOGIN_START, { forceQr: !!forceQr }),
  pollQrLogin: (payload: { qrToken: string; authChainCode: string; lck: string; entityId?: string }): Promise<any> =>
    ipcRenderer.invoke(IPC.OA_QR_LOGIN_POLL, payload),

  logError: (msg: string) => ipcRenderer.send(IPC.LOG_ERROR, msg),

  checkForUpdates: () => ipcRenderer.invoke(IPC.CHECK_UPDATE),
  startDownload: () => ipcRenderer.invoke(IPC.START_DOWNLOAD),
  onUpdateAvailable: (cb: (p: any) => void) => subscribe('update-available', cb),
  onUpdateDownloaded: (cb: (p: any) => void) => subscribe('update-downloaded', cb),
  onUpdateProgress: (cb: (p: { percent: number; transferred: number; total: number }) => void) =>
    subscribe('update-progress', cb),
  onUpdateNotAvailable: (cb: (p: any) => void) => subscribe('update-not-available', cb),
  onUpdateError: (cb: (p: any) => void) => subscribe('update-error', cb),
  installUpdate: () => ipcRenderer.invoke(IPC.INSTALL_UPDATE),
  // 托盘右键菜单「检查更新」：通知渲染层复用已有的 checkUpdate() 流程（含完整 UI 反馈）
  onTrayCheckUpdate: (cb: () => void) => subscribe('tray:check-update', cb),

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
  onTraySwitchView: (cb: (v: 'query' | 'ai') => void) => subscribe('tray:switch-view', cb),

  // 中国法定节假日安排：主进程联网拉取 + 落盘缓存（见 src/main/holidaySync.ts）。
  // 拿不到时返回 null，渲染层回退 @shared/holidays 的内置兜底表。
  getHolidays: (year: number): Promise<HolidayPlan | null> => ipcRenderer.invoke(IPC.HOLIDAY_GET, year),

  appVersion: (): string => ipcRenderer.sendSync(IPC.APP_VERSION),

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('mc-open-external', url),

  /**
   * 取拖拽/粘贴进来的 File 的本机绝对路径（1.0.43，附件用）。
   * Electron 32+ 移除了 File.path，官方推荐用 webUtils.getPathForFile；
   * 取不到时返回空串，调用方按「不支持的附件」处理。
   */
  getPathForFile: (file: File): string => {
    try { return webUtils.getPathForFile(file) } catch { return '' }
  },
  // 应用内打开内网地址（新窗口共用登录 partition，因此免登录）。
  // 不传 url = OA 工作台首页；传 url = 在应用内窗口打开该 streamax 内网地址（外部地址会退回系统浏览器）。
  // 系统浏览器不共享本应用登录态，所以内网链接一律走这里，绝不能交给 openExternal。
  openOaWindow: (url?: string): Promise<boolean> => ipcRenderer.invoke('mc-open-oa-window', url),
  // 鸿翼文件系统：按 fileGuid 弹「另存为」下载**原始文件**（AI 回复里的「下载」链接走这里）。
  // 与「预览」分开：预览用 openOaWindow 在应用内窗口看站点预览页，不触发下载。
  wjxtDownload: (payload: { fileGuid: string; name?: string; id?: string }): Promise<any> =>
    ipcRenderer.invoke('mc-wjxt-download', payload),
  // 打开「登录文件系统（账号密码）」窗口（H5 登录页）：会话缺失/失效时的备份登录方式，
  // 成功后窗口自动关闭并跳回文件系统首页；用户可在窗口内选择记住账号密码以便自动续登。
  wjxtLogin: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('mc-wjxt-login'),
  // 「一键自检」：体检「OA 物料查询 / IAM 会话 / 鸿翼 edoc2」三条线，返回一行结论 + 明细。
  // 结论与明细由主进程按**界面语言**生成，所以这里把当前语言带过去（同 showMessage 的做法）。
  wjxtDiagnose: (lang?: 'zh' | 'en'): Promise<{ ok: boolean; verdict: string; detail: string }> =>
    ipcRenderer.invoke('mc-wjxt-diagnose', lang ?? currentLang),
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
  // 记住本会话启用的技能（1.0.46）：按会话独立，但重启/切回旧会话要能恢复
  setConvSkills: (id: string, keys: string[]) => ipcRenderer.invoke(AI_IPC.SET_CONV_SKILLS, id, keys),
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
    // 技能（1.0.43）：列表 / 导入（zip 或文件夹）/ 删除
    // 勾选状态不落主进程：按会话存在渲染层，随消息用 enabledSkills 下发
    listSkills: (): Promise<any> => ipcRenderer.invoke(AI_IPC.SKILLS_LIST),
    importSkill: (kind: 'zip' | 'dir'): Promise<any> => ipcRenderer.invoke(AI_IPC.SKILL_IMPORT, kind),
    removeSkill: (id: string): Promise<any> => ipcRenderer.invoke(AI_IPC.SKILL_REMOVE, id),
    // 增强提示词：用当前供应商把草稿改写成更明确的提示词
    optimizePrompt: (input: { providerId: string; modelId?: string; text: string; lang?: string }): Promise<any> =>
      ipcRenderer.invoke(AI_IPC.OPTIMIZE_PROMPT, input),
    // ── MCP 服务（1.0.46）：登记 / 启停 / 测试连接 / 一键准备依赖 / 日志 ──
    mcpList: (): Promise<any> => ipcRenderer.invoke(AI_IPC.MCP_LIST),
    mcpSave: (input: any): Promise<any> => ipcRenderer.invoke(AI_IPC.MCP_SAVE, input),
    mcpDelete: (id: string): Promise<any> => ipcRenderer.invoke(AI_IPC.MCP_DELETE, id),
    mcpSetEnabled: (id: string, enabled: boolean): Promise<any> =>
      ipcRenderer.invoke(AI_IPC.MCP_SET_ENABLED, id, enabled),
    mcpImportJson: (text: string, skillKey?: string): Promise<any> =>
      ipcRenderer.invoke(AI_IPC.MCP_IMPORT_JSON, text, skillKey),
    mcpTest: (id: string): Promise<any> => ipcRenderer.invoke(AI_IPC.MCP_TEST, id),
    mcpDisconnect: (id: string): Promise<any> => ipcRenderer.invoke(AI_IPC.MCP_DISCONNECT, id),
    mcpStatus: (): Promise<any> => ipcRenderer.invoke(AI_IPC.MCP_STATUS),
    // 依赖安装：立即返回「已启动」，进度与结果经 onMcpEvent 推送（install-log / install-done）
    mcpPrepare: (id: string): Promise<any> => ipcRenderer.invoke(AI_IPC.MCP_PREPARE, id),
    mcpCancelPrepare: (id: string): Promise<any> => ipcRenderer.invoke(AI_IPC.MCP_PREPARE_CANCEL, id),
    mcpOpenLog: (id: string): Promise<any> => ipcRenderer.invoke(AI_IPC.MCP_OPEN_LOG, id),
    mcpSelectDir: (): Promise<any> => ipcRenderer.invoke(AI_IPC.MCP_SELECT_DIR),
  // 生成本机运行配置：剔除他人 Cookie、把写死的别人家路径改指本机，并回写登记里的配置环境变量
  mcpGenConfig: (id: string): Promise<any> => ipcRenderer.invoke(AI_IPC.MCP_GEN_CONFIG, id),
    onMcpEvent: (cb: (event: any) => void) => {
      const listener = (_e: any, event: any) => cb(event)
      ipcRenderer.on(AI_IPC.MCP_EVENT, listener)
      // cleanup 返回 void（EffectCallback 约束，见 onEvent 的注释）
      return () => { ipcRenderer.removeListener(AI_IPC.MCP_EVENT, listener) }
    },
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
