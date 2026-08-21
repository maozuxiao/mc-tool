// 物料记录（平铺对象，字段名与 OA 接口返回一致）
export type MaterialRow = Record<string, string | number>

// 单条查询结果（通用行）
export interface SearchResult {
  itemNo?: string
  itemNo2?: string
  [key: string]: string | number | undefined
}

// 登录状态
export interface LoginState {
  loggedIn: boolean
  // 登录成功后收割到的关键 cookie 摘要（仅用于展示，不做敏感存储）
  user?: string
}

// 自动更新信息
export interface UpdateInfo {
  hasUpdate: boolean
  version?: string
  releaseNotes?: string
  downloaded?: boolean
}

// 渲染进程 -> 主进程 的 IPC 通道名
export const IPC = {
  OA_LOGIN_READY: 'oa-login-ready',          // 渲染进程通知：已跳转到目标页且 cookie 就绪
  OA_CHECK_LOGGED: 'oa-check-logged',        // 主进程回：当前是否已登录
  OA_LOGIN_LANDING: 'oa-login-landing',      // 主进程回：扫码成功，正在 SSO 落地（渲染层显示 Loading 覆盖层）
  OA_LOGIN_STATE: 'oa-login-state',          // 主进程回：登录阶段状态（checking/logging/failed）
  OA_NAVIGATE: 'oa-navigate',                // 渲染进程请求主进程显示登录视图
  OA_GET_LOGIN_URL: 'oa-get-login-url',      // 渲染进程获取 OA 登录页地址（webview 用）
  APP_VERSION: 'app-version',                // 渲染进程同步获取应用版本号
  OA_RELOAD: 'oa-reload',
  OA_FETCH: 'oa-fetch',                      // 主进程代理 HTTP 请求（带 Cookie）
  OA_FILE_DOWNLOAD: 'oa-file-download',      // 主进程代理下载规格文件（带 Cookie，避免跳浏览器未登录）
  OA_REFRESH_SESSION: 'oa-refresh-session',  // 重新预热 OA 会话（SSO 握手落地），消除 901 重复登录
  OA_QR_LOGIN_START: 'oa-qr-login-start',    // 获取 IAM 二维码
  OA_QR_LOGIN_POLL: 'oa-qr-login-poll',      // 轮询 IAM 二维码登录状态
  LOG_ERROR: 'log-error',                     // 渲染进程上报崩溃日志
  COOKIE_GET: 'cookie-get',
  COOKIE_SET: 'cookie-set',
  COOKIE_CLEAR: 'cookie-clear',
  CHECK_UPDATE: 'check-update',
  START_DOWNLOAD: 'start-download',
  UPDATE_DOWNLOADED: 'update-downloaded',
  UPDATE_ERROR: 'update-error',
  INSTALL_UPDATE: 'install-update'
} as const
