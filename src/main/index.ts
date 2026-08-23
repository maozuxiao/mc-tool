import { app, BrowserWindow, session, ipcMain, shell, dialog, Menu, MenuItem } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'path'
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import http from 'http'
import https from 'https'
import zlib from 'zlib'
import { OA_LOGIN_URL, UPDATE_BASE_URL, OA_ORIGIN } from '@shared/constants'
import { IPC } from '@shared/types'
import { initAutoUpdater } from './updater'

let mainWindow: BrowserWindow | null = null
// 最近一次清除 cookie 的时间戳；退出登录后 IAM 需要短暂冷却才能正常走 SSO 跳转链，
// 否则 step1 会卡在 iam 第一次 302 后不继续（表现为 timeout）。这里用于退出后拉码前等待冷却。
let lastCookieClearAt = 0
// 使用持久化 partition，让 OA 登录 Cookie 自动写入磁盘并跨启动保留。
// 这是最可靠的方案：Electron 会为每个 persist:* partition 维护独立的
// Cookie/Storage 目录，进程退出后依然保留，无需手动文件备份。
const PARTITION = 'persist:mc-query'
const APP_ID = 'com.streamax.mcquery'

// 开发时从项目根目录 build/ 读取；打包后从 resources/ 读取（extraResources 配置）
function getIconPath() {
  const name = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  if (app.isPackaged) {
    return join(process.resourcesPath, name)
  }
  return join(__dirname, `../../build/${name}`)
}

// 调试日志文件
const LOG_PATH = join(app.getPath('userData'), 'debug-login.log')
function debugLog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    appendFileSync(LOG_PATH, line)
  } catch { /* ignore */ }
  console.log(line.trim())
}

// 登录后功能排查专用日志（查询请求 / 返回 / 登录态）
const QUERY_LOG_PATH = join(app.getPath('userData'), 'debug-query.log')
function queryLog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    appendFileSync(QUERY_LOG_PATH, line)
  } catch { /* ignore */ }
  console.log('[QUERY] ' + line.trim())
}

// OA 实际访问地址带 :8080 端口，登录态 Cookie 的 host 也包含该端口。
// OA 登录后设置的 cookie domain 通常为 .streamax.com（带点前缀，覆盖所有子域）。
// Electron 的 cookies.get({domain}) 做后缀匹配，需传不带前导点的 "streamax.com"。
const OA_COOKIE_DOMAIN = 'streamax.com'

// persist partition 已自动持久化 Cookie，这里仅做启动时诊断日志，
// 确认跨启动后 Cookie 是否仍在，便于排查。
async function dumpPersistedCookies() {
  try {
    const sess = session.fromPartition(PARTITION)
    // 获取全部 cookie，不限定 domain，便于完整诊断
    const all = await sess.cookies.get({})
    const streamax = all.filter(c => /streamax/.test(c.domain || ''))
    debugLog(`[startup] total cookies: ${all.length}, streamax: ${streamax.length}` +
      (streamax.length ? ` (${streamax.map(c => `${c.name}@${c.domain}${c.session ? '[session]' : ''}`).join(', ')})` : ''))
  } catch (e) {
    debugLog('[startup] dump cookies error: ' + String(e))
  }
}

// 一次性迁移：老版本用 cookies-backup.json 做的文件备份，且当时恢复时
// 用了错误的 host（无 :8080 端口），导致这些 cookie 对 OA 请求无效。
// 若 partition 内无有效 cookie 且旧备份文件存在，则将其按正确 host 迁移进 partition。
const LEGACY_BACKUP_PATH = join(app.getPath('userData'), 'cookies-backup.json')
async function migrateLegacyBackupIfNeeded() {
  try {
    const sess = session.fromPartition(PARTITION)
    const existing = await sess.cookies.get({ domain: OA_COOKIE_DOMAIN })
    if (existing.length > 0) {
      debugLog('[migrate] partition already has cookies, skip legacy migration')
      return
    }
    if (!existsSync(LEGACY_BACKUP_PATH)) {
      debugLog('[migrate] no legacy backup file, nothing to migrate')
      return
    }
    const raw = readFileSync(LEGACY_BACKUP_PATH, 'utf-8')
    const cookies: any[] = JSON.parse(raw)
    let migrated = 0
    for (const c of cookies) {
      try {
        const domain = (c.domain || '').replace(/^\./, '')
        const protocol = c.secure ? 'https' : 'http'
        const url = `${protocol}://${domain}:8080${c.path || '/'}`
        await sess.cookies.set({
          url,
          name: c.name,
          value: c.value,
          domain: domain,
          path: c.path || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          sameSite: c.sameSite || 'no_restriction',
          expirationDate: c.expirationDate || (Date.now() / 1000 + 30 * 24 * 3600)
        })
        migrated++
      } catch (err) {
        debugLog('[migrate] one failed: ' + String(err))
      }
    }
    debugLog(`[migrate] migrated ${migrated}/${cookies.length} legacy cookies`)
    // 迁移完成后删除旧备份，避免下次重复
    try { unlinkSync(LEGACY_BACKUP_PATH) } catch {}
  } catch (e) {
    debugLog('[migrate] error: ' + String(e))
  }
}

// OA 工具会话 cookie 文件备份/恢复。
// 根因：oa.streamax.com 的会话 cookie(route/SESSION)是 session 级(无 expiry)，
// Electron persist:* partition 对 session cookie 跨启动落盘不可靠（重开后 cookie=0），
// 导致“登录后重开需重新扫码”。这里额外把 OA 会话 cookie 落盘到文件，
// 启动时若 partition 内 OA 会话为空则从文件恢复，并强制补齐 expirationDate 使其持久。
const SESSION_BACKUP_PATH = join(app.getPath('userData'), 'oa-session-backup.json')

// 登录偏好持久化：记录 token 最后刷新时间与上一次发起登录请求的本地自然日，
// 用于实现「强制走二维码登录」策略（当天首次登录 且 token 间隔 > 1 小时时跳过免密）。
const LOGIN_PREF_PATH = join(app.getPath('userData'), 'oa-login-pref.json')
interface LoginPref { lastTokenTs: number; lastLoginDay: string }
function getLoginPref(): LoginPref {
  try {
    if (existsSync(LOGIN_PREF_PATH)) {
      const raw = JSON.parse(readFileSync(LOGIN_PREF_PATH, 'utf-8'))
      return { lastTokenTs: raw.lastTokenTs || 0, lastLoginDay: raw.lastLoginDay || '' }
    }
  } catch {}
  return { lastTokenTs: 0, lastLoginDay: '' }
}
function setLoginPref(p: LoginPref) {
  try { writeFileSync(LOGIN_PREF_PATH, JSON.stringify(p)) } catch {}
}
// 本地自然日（设备系统时间），跨天以 00:00 为界
function todayStr(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

async function backupOaSession(sess: Electron.Session): Promise<void> {
  try {
    const all = await sess.cookies.get({})
    // 关键：OA 真实会话 cookie 分布在 oa.streamax.com 与 .streamax.com(LtpaToken) 两个域，
    // 漏掉任意一个都会导致恢复后仍是半登录态、查询被 901 踢回。
    const oa = all.filter(c => {
      const d = (c.domain || '').toLowerCase()
      return d.includes('oa.streamax.com') || d.endsWith('.streamax.com') || d === 'streamax.com'
    })
    if (oa.length === 0) return
    const exp = Date.now() / 1000 + 30 * 24 * 3600
    const data = oa.map(c => ({
      name: c.name,
      value: c.value,
      domain: (c.domain || '').replace(/^\./, ''),
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite || 'no_restriction',
      expirationDate: c.expirationDate || exp
    }))
    writeFileSync(SESSION_BACKUP_PATH, JSON.stringify(data, null, 2))
    debugLog(`[backup] saved ${data.length} OA session cookies to file`)
    // 同步记录 token 最后刷新时间，供「强制走二维码」策略判断间隔
    try { setLoginPref({ ...getLoginPref(), lastTokenTs: Date.now() }) } catch {}
  } catch (e: any) {
    debugLog('[backup] error: ' + e.message)
  }
}

async function restoreOaSession(sess: Electron.Session): Promise<boolean> {
  try {
    if (!existsSync(SESSION_BACKUP_PATH)) {
      debugLog('[restore] no backup file, nothing to restore')
      return false
    }
    // 注意：不能用“分区里是否已存在 oa.streamax.com cookie”判断是否需要恢复——
    // 启动时分区的 route@.oa.streamax.com / SESSION@.oa.streamax.com 只是 IAM 半登录态，
    // 会让 current.length>0 从而误判“已有会话”而跳过恢复。必须以真实探测为准。
    const alreadyValid = (await probeOaSession(sess)).ok
    if (alreadyValid) {
      debugLog('[restore] OA session already valid (probe ok), skip restore')
      return false
    }
    const raw = readFileSync(SESSION_BACKUP_PATH, 'utf-8')
    const cookies: any[] = JSON.parse(raw)
    let restored = 0
    for (const c of cookies) {
      try {
        const protocol = c.secure ? 'https' : 'http'
        // 还原原始 domain（含前导点），端口按域决定
        const host = c.domain
        const port = host.includes('oa.streamax.com') ? ':8080' : ''
        const url = `${protocol}://${host}${port}${c.path || '/'}`
        const exp = c.expirationDate || (Date.now() / 1000 + 30 * 24 * 3600)
        await sess.cookies.set({
          url,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          sameSite: c.sameSite || 'no_restriction',
          expirationDate: exp
        })
        restored++
      } catch (err) {
        debugLog('[restore] one failed: ' + String(err))
      }
    }
    debugLog(`[restore] restored ${restored}/${cookies.length} OA session cookies`)
    // 恢复后再次探测，确认真实会话可用
    const after = await probeOaSession(sess)
    debugLog(`[restore] after restore probe ok=${after.ok} reason=${after.reason}`)
    // 恢复成功后把当前(已验证可用)的会话重新落盘，防止备份文件比分区更旧，
    // 让下次启动的恢复链始终基于最新有效 cookie。
    if (after.ok) await backupOaSession(sess)
    return after.ok
  } catch (e: any) {
    debugLog('[restore] error: ' + e.message)
    return false
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    // 不限制最小尺寸：允许自由拖拽缩放宽度/高度，并支持 Windows 分屏（snap 半屏/四分之一）
    resizable: true,
    minWidth: 480,
    minHeight: 360,
    title: 'MC物料查询',
    backgroundColor: '#f8f8f0',
    icon: getIconPath(),
    // 隐藏默认菜单栏，任务栏右键只保留窗口基本项
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  })

  // 加载本地查询面板（默认页面）
  mainWindow.loadFile(join(__dirname, '../renderer/index.html'))

  // 启动后自动检测 OA 登录态；未登录则弹出登录层（由渲染进程控制）
  checkLoginAndNotify()

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  // 输入框/选中文本右键菜单（Electron 默认无右键菜单）
  mainWindow.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable && !params.selectionText) return
    const menu = new Menu()
    if (params.editFlags.canCut) menu.append(new MenuItem({ label: '剪切', role: 'cut' }))
    if (params.editFlags.canCopy) menu.append(new MenuItem({ label: '复制', role: 'copy' }))
    if (params.editFlags.canPaste) menu.append(new MenuItem({ label: '粘贴', role: 'paste' }))
    menu.append(new MenuItem({ type: 'separator' }))
    if (params.editFlags.canSelectAll) menu.append(new MenuItem({ label: '全选', role: 'selectAll' }))
    menu.popup({ window: mainWindow! })
  })

  // 页面缩放 IPC
  ipcMain.handle('mc-set-zoom', (_event, factor: number) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.setZoomFactor(Math.max(0.5, Math.min(2.0, factor)))
  })
  ipcMain.handle('mc-get-zoom', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return 1
    return mainWindow.webContents.getZoomFactor()
  })
  ipcMain.handle('mc-reset-zoom', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.setZoomFactor(1)
  })
  // 允许渲染进程让主进程打开系统默认浏览器
  ipcMain.handle('mc-open-external', (_event, url: string) => {
    if (typeof url === 'string' && url.startsWith('http')) shell.openExternal(url)
  })
}

// 判断 OA 是否已登录：
// 获取全部 cookie 后筛选 streamax 相关 cookie，避免 domain 后缀匹配的边界问题。
// 真实探测 OA 会话是否可用：发一次轻量 OA 接口请求，
// 返回 JSON（非 HTML / 非 302 reauth）才视为真正登录。
// 仅靠 cookie 名字判断不可靠——route/SESSION 可能是 IAM 半登录态，
// 带了它们 OA 接口仍会 302 到 IAM 重新认证。
// 探测结果需要区分失败原因：
//  - 'reauth'  : OA 明确 302 回跳 IAM(901)，会话已死，必须重新建立，不能"信任 cookie"
//  - 'network' : 超时/连接错误，无法判断会话状态，可以信任现有 cookie 避免误踢用户去扫码
//  - 'nocookie': 分区内没有任何 cookie
//  - 'invalid' : 有响应但不是 JSON（例如返回登录 HTML）
type ProbeReason = 'ok' | 'reauth' | 'network' | 'nocookie' | 'invalid'
interface ProbeResult { ok: boolean; reason: ProbeReason }

// 探测/预热共用的轻量 OA 查询地址（调用处追加时间戳防缓存）
const PROBE_URL_BASE =
  'http://oa.streamax.com:8080/ruiming/mc/materiel_ui/materielSearch.do?method=wuliao&q.ORGANIZATION_ID=102&q.ITEM_NUMBER=0000000000000&__seq='

async function probeOaSession(sess: Electron.Session): Promise<ProbeResult> {
  try {
    const cookies = await sess.cookies.get({})
    if (cookies.length === 0) return { ok: false, reason: 'nocookie' }
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')
    const probeUrl = PROBE_URL_BASE + Date.now()
    const result = await new Promise<{ status: number; headers: any; body: Buffer }>((resolve, reject) => {
      const u = new URL(probeUrl)
      const lib = u.protocol === 'https:' ? https : http
      const req = lib.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'Cookie': cookieStr,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*'
        }
      }, (res) => {
        const loc = res.headers.location
        const isReauth = loc && /iam\.streamax\.com/i.test(loc) && /(authCenter\/authenticate|state=IAM_OA_SSO|authnEngine|idp\/)/i.test(loc)
        if (isReauth) {
          resolve({ status: 901, headers: res.headers, body: Buffer.from('') })
          return
        }
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(Buffer.from(c)))
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }))
      })
      req.on('error', reject)
      // 探测超时从 15s 降到 6s：探测只是启动期健康检查的辅助，不应因网络抖动拖慢启动
      req.setTimeout(6000, () => { req.destroy(); reject(new Error('timeout')) })
      req.end()
    })
    const text = result.body.toString('utf8').trim()
    const returnsJson = text.length > 0 && !text.startsWith('<')
    const ok = result.status >= 200 && result.status < 400 && returnsJson && result.status !== 901
    const reason: ProbeReason = ok ? 'ok' : (result.status === 901 ? 'reauth' : 'invalid')
    debugLog(`[probeOaSession] status=${result.status} returnsJson=${returnsJson} -> ${ok} (${reason})`)
    return { ok, reason }
  } catch (e: any) {
    debugLog(`[probeOaSession] error: ${e?.message || e} (network)`)
    // 探测本身出错（网络超时 / ECONNRESET 等）无法判定会话是否失效，
    // 交由调用方按 reason='network' 做"信任 cookie"兜底，避免网络抖动强制扫码。
    return { ok: false, reason: 'network' }
  }
}

// 隐藏窗口走一次真实 OA 接口，触发 IAM OAuth 授权码回跳，让 OA 会话重新落地。
// 供 isOALoggedin(启动期) 与 OA_REFRESH_SESSION(查询期) 复用，避免逻辑重复。
async function tryAutoSsoRefresh(sess: Electron.Session): Promise<boolean> {
  debugLog('[autoSSO] start hidden-window OAuth refresh')
  let ssoWin: BrowserWindow | null = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: false }
  })
  try {
    await ssoWin.loadURL(PROBE_URL_BASE + Date.now())
    // 等待 OAuth 回跳 + 会话落地
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 1000))
      if ((await probeOaSession(sess)).ok) break
    }
  } catch (e: any) {
    debugLog('[autoSSO] trigger load error: ' + e.message)
  } finally {
    try { ssoWin?.close() } catch { /* ignore */ }
    ssoWin = null
  }
  const after = await probeOaSession(sess)
  debugLog(`[autoSSO] result ok=${after.ok} reason=${after.reason}`)
  if (after.ok) await backupOaSession(sess)
  return after.ok
}

async function isOALoggedin(): Promise<boolean> {
  try {
    const sess = session.fromPartition(PARTITION)
    const all = await sess.cookies.get({})
    const cookies = all.filter(c => /streamax/.test(c.domain || ''))
    debugLog(`[isOALoggedin] total cookies: ${all.length}, streamax: ${cookies.length}`)
    if (cookies.length === 0) return false
    const names = cookies.map(c => c.name)
    debugLog(`[isOALoggedin] names: ${names.join(', ')}`)
    // 注意：Electron cookie 的 domain 字段不含端口，oa.streamax.com:8080 的 cookie
    // 在 Electron 里 domain 记作 "oa.streamax.com"。因此按主机名匹配，而非带端口字符串。
    const OA_HOST = 'oa.streamax.com'
    // OA 会话 cookie 是“已登录”的可靠标志。根据抓包与实测，登录成功后分区里种下的是
    // route / SESSION（domain=.oa.streamax.com），且 OA 接口据此认定为已登录
    // （查询时若仅带这俩会被 302 到 IAM 做 SSO 握手，说明 cookie 有效）。
    const oaCookies = cookies.filter(c =>
      (c.domain || '').toLowerCase().includes(OA_HOST.toLowerCase()))
    const hasOaSession = oaCookies.some(c =>
      /^(JSESSIONID|SESSION|LTPATOKEN|ROUTE|TOKEN|OA_TOKEN|UID|USER|LOGIN|SSO)/i.test(c.name) ||
      c.name.toUpperCase().includes('SESSION') ||
      c.name.toUpperCase().includes('TOKEN'))
    debugLog(`[isOALoggedin] oa.host cookies(${oaCookies.length})=${oaCookies.map(c => c.name).join(', ')}; hasOaSession=${hasOaSession}`)
    queryLog(`[isOALoggedin] streamax cookies=${cookies.length}, oa.host cookies(${oaCookies.length})=[${oaCookies.map(c => `${c.domain}/${c.name}`).join(', ')}], hasOaSession=${hasOaSession}`)
    if (!hasOaSession) return false
    // 用真实探测确认 OA 会话真的可用（避免 IAM 半登录态被误判为已登录）。
    const probed = await probeOaSession(sess)
    queryLog(`[isOALoggedin] probeOaSession ok=${probed.ok} reason=${probed.reason}`)
    if (probed.ok) return true

    // 关键修复(1.0.5)：必须区分探测失败的原因，不能一律"信任 cookie"。
    // 旧逻辑对 901 也返回 true，导致会话已死却放行进主界面，
    // 表现为"免登录成功但搜索全部失败"。
    if (probed.reason === 'reauth' || probed.reason === 'invalid') {
      // OA 明确拒绝：先静默尝试一次 SSO 刷新，成功则无需打扰用户
      debugLog(`[isOALoggedin] OA session rejected (${probed.reason}) -> try silent SSO refresh`)
      const refreshed = await tryAutoSsoRefresh(sess)
      if (refreshed) {
        debugLog('[isOALoggedin] silent SSO refresh succeeded')
        return true
      }
      debugLog('[isOALoggedin] silent SSO refresh failed -> require QR login')
      return false
    }

    // network / nocookie：无法判定会话状态，信任已有 cookie，
    // 避免网络抖动导致每次启动都被迫扫码；真失效会在查询路径以 901 触发刷新。
    debugLog(`[isOALoggedin] probe inconclusive (${probed.reason}) -> trust cookie, skip forced QR login`)
    return true
  } catch {
    return false
  }
}

// 防重入：createWindow() 与渲染进程 OA_RELOAD 可能几乎同时触发登录检查，
// 导致启动期整条探测链（migrate/restore/probe）跑两遍、多发 6 次 OA 请求。
// 并发调用共享同一次 in-flight 检查。
let loginCheckInFlight: Promise<void> | null = null

function checkLoginAndNotify(): Promise<void> {
  if (loginCheckInFlight) {
    debugLog('[startup] login check already in flight, reuse')
    return loginCheckInFlight
  }
  loginCheckInFlight = doCheckLoginAndNotify().finally(() => {
    loginCheckInFlight = null
  })
  return loginCheckInFlight
}

async function doCheckLoginAndNotify() {
  if (!mainWindow) return

  // 强制走二维码登录判定：
  // 同时满足「当天首次登录」与「token 间隔 > 1 小时」时，跳过 token 免密恢复/探测，
  // 直接展示二维码登录，避免过期/失效 token 触发的自动重试与体验问题。
  //   - 当天首次：以设备本地自然日(00:00 切换)为准，lastLoginDay 与今天不同即为首次
  //   - token 间隔：本地系统时间 − 本地存储的 token 最后刷新时间 > 1h
  const pref = getLoginPref()
  const today = todayStr()
  const isFirstToday = pref.lastLoginDay !== today
  const tokenAgeMs = Date.now() - pref.lastTokenTs
  const TOKEN_MAX_AGE_MS = 60 * 60 * 1000
  const forceQr = isFirstToday && tokenAgeMs > TOKEN_MAX_AGE_MS
  // 记录“今天已发起过登录请求”，确保当天后续检查不再算首次
  if (isFirstToday) setLoginPref({ ...pref, lastLoginDay: today })

  if (forceQr) {
    debugLog(`[startup] force QR login: isFirstToday=${isFirstToday}, tokenAge=${Math.round(tokenAgeMs / 1000)}s (>1h=${tokenAgeMs > TOKEN_MAX_AGE_MS})`)
    // 不尝试免密恢复，直接让渲染进程显示二维码登录视图
    mainWindow.webContents.send(IPC.OA_LOGIN_STATE, { state: 'logging' })
    return
  }

  // 一次性迁移旧备份（若 partition 已空且有老文件）；之后信任 persist 持久化
  await migrateLegacyBackupIfNeeded()
  // 若 partition 内无 OA 会话，尝试从文件恢复（解决 session cookie 跨启动丢失）
  const restoredOk = await restoreOaSession(session.fromPartition(PARTITION))
  // 打印诊断，确认跨启动后 Cookie 是否仍在
  await dumpPersistedCookies()
  // 恢复后探测已通过则无需重复探测，直接放行（省一次 OA 请求）
  const ok = restoredOk ? true : await isOALoggedin()
  debugLog(`[startup] restoredOk=${restoredOk}, isOALoggedin = ${ok}`)
  if (ok) {
    // 有可用 cookie：直接进入工具页面，并确保主窗口显示在桌面前台
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
    mainWindow.webContents.send(IPC.OA_CHECK_LOGGED, { loggedIn: true })
  } else {
    // 无可用 cookie：通知渲染进程在主窗口内显示登录视图（webview），不弹独立窗口
    mainWindow.webContents.send(IPC.OA_LOGIN_STATE, { state: 'logging' })
  }
}

// 触发渲染进程在主窗口内显示 OA 登录视图（用于“重新登录”/首次无 cookie）
function requestLoginView() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.OA_LOGIN_STATE, { state: 'logging' })
  }
}

app.whenReady().then(() => {
  app.setAppUserModelId(APP_ID)
  app.setName('MC物料查询')
  createWindow()
  initAutoUpdater(mainWindow!, UPDATE_BASE_URL)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ── IPC ────────────────────────────────────────────────────
ipcMain.handle(IPC.OA_NAVIGATE, () => {
  requestLoginView()
})
// 渲染进程请求当前 OA 登录页地址（用于主窗口内嵌 webview 登录）
ipcMain.handle(IPC.OA_GET_LOGIN_URL, () => OA_LOGIN_URL)
ipcMain.handle(IPC.OA_RELOAD, () => {
  checkLoginAndNotify()
})

// 渲染进程上报崩溃日志
ipcMain.on(IPC.LOG_ERROR, (_e, msg: string) => {
  debugLog('[RENDER-CRASH] ' + msg)
})

// 同步返回应用版本号（供渲染进程展示软件说明/版本）
ipcMain.on(IPC.APP_VERSION, (e) => {
  e.returnValue = app.getVersion()
})

// 语义化版本比较：a > b 返回 1，a < b 返回 -1，相等返回 0（忽略构建号后缀）
function cmpVer(a: string, b: string): number {
  const na = (a || '').split('.').map(n => parseInt(n, 10) || 0)
  const nb = (b || '').split('.').map(n => parseInt(n, 10) || 0)
  const len = Math.max(na.length, nb.length)
  for (let i = 0; i < len; i++) {
    const x = na[i] || 0
    const y = nb[i] || 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

// 手动触发检查更新（Help -> Check for Update）
ipcMain.handle(IPC.CHECK_UPDATE, async () => {
  try {
    // autoDownload 已在 updater.ts 关闭，checkForUpdates 仅检测，不下载
    const result = await autoUpdater.checkForUpdates()

    const newVersion = result?.updateInfo?.version
    const current = app.getVersion()
    // 无更新信息 / 版本相同 / 服务器版本不高于本地 → 当前即为最新版本
    // （防止服务器 latest.yml 指向更低版本时误报“有更新/回退升级”）
    if (!newVersion || cmpVer(newVersion, current) <= 0) {
      return { ok: true, latest: true }
    }

    // 有更高版本：仅返回结果，由渲染端显示「下载」按钮，用户点击后再下载
    return { ok: true, hasUpdate: true, version: newVersion, downloading: false }
  } catch (e: any) {
    const msg = e?.message || String(e)
    debugLog('[CHECK_UPDATE] error: ' + msg)
    // 仅在“明确无更高版本”时视为最新；网络/解析失败则上报错误
    if (/update.*not available|no available update|is the latest|already up.to.date/i.test(msg)) {
      return { ok: true, latest: true }
    }
    return { ok: false, error: msg }
  }
})

// 用户点击「下载」后，由主进程真正开始下载
ipcMain.handle(IPC.START_DOWNLOAD, async () => {
  try {
    await autoUpdater.downloadUpdate()
    return { ok: true }
  } catch (e: any) {
    debugLog('[START_DOWNLOAD] error: ' + (e?.message || e))
    return { ok: false, error: e?.message || String(e) }
  }
})

// 主进程代理 HTTP 请求到 OA 接口，自动带上 partition 里的 Cookie
// 解决渲染进程 file:// 协议下跨域请求无法带 Cookie 的问题
// 自动跟随 302 重定向（如 IAM SSO 认证），最多跟 5 跳

async function setCookiesFromHeader(sess: Electron.Session, setCookieHeader: string | string[]) {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader]
  for (const h of headers) {
    const parts = h.split(';').map(s => s.trim())
    const [name, ...valueParts] = parts[0].split('=')
    const value = valueParts.join('=')
    if (!name) continue
    let domain = 'iam.streamax.com'
    let path = '/'
    let secure = true
    let httpOnly = false
    let sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict' = 'unspecified'
    for (const attr of parts.slice(1)) {
      const [k, v] = attr.split('=').map(s => s.trim().toLowerCase())
      if (k === 'domain' && v) domain = v
      if (k === 'path' && v) path = v
      if (k === 'secure') secure = true
      if (k === 'httponly') httpOnly = true
      if (k === 'samesite') {
        sameSite = v === 'none' ? 'no_restriction' : v === 'lax' ? 'lax' : v === 'strict' ? 'strict' : 'unspecified'
      }
    }
    const host = domain.replace(/^\./, '')
    // oa.streamax.com 的会话 cookie 实际绑定在 :8080 端口，写回时带上端口，
    // 保证 Electron 按正确 host 归类（虽然 domain 字段仍不含端口，但 URL host 需精确）。
    const portSuffix = /oa\.streamax\.com$/i.test(host) ? ':8080' : ''
    const url = `${secure ? 'https' : 'http'}://${host}${portSuffix}${path}`
    try {
      await sess.cookies.set({
        url,
        name: name.trim(),
        value,
        domain: domain.startsWith('.') ? domain : undefined,
        path,
        secure,
        httpOnly,
        sameSite
      })
      debugLog(`[COOKIE] set ${name.trim()} for ${host}${portSuffix}`)
    } catch (e: any) {
      // 端口版失败则回退到不带端口的 url 再试一次
      try {
        await sess.cookies.set({
          url: `${secure ? 'https' : 'http'}://${host}${path}`,
          name: name.trim(),
          value,
          domain: domain.startsWith('.') ? domain : undefined,
          path,
          secure,
          httpOnly,
          sameSite
        })
        debugLog(`[COOKIE] set ${name.trim()} for ${host} (fallback)`)
      } catch (e2: any) {
        debugLog(`[COOKIE] failed ${name.trim()}: ${e2.message}`)
      }
    }
  }
}

function httpJson({ url, method = 'GET', body, headers = {}, timeoutMs = 15000 }: {
  url: string
  method?: string
  body?: any
  headers?: Record<string, string>
  timeoutMs?: number
}) {
  return new Promise<{ status: number; headers: any; json: any }>((resolve, reject) => {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Content-Type': 'application/json',
        ...headers
      }
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(Buffer.from(c)))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        try {
          resolve({ status: res.statusCode || 0, headers: res.headers, json: text ? JSON.parse(text) : {} })
        } catch {
          resolve({ status: res.statusCode || 0, headers: res.headers, json: { raw: text } })
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')) })
    if (body !== undefined) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body))
    }
    req.end()
  })
}

// 跟随重定向 GET 页面，收集 cookie，返回最终文本
function httpJsonWithRedirect(startUrl: string, sess: Electron.Session, maxRedirects = 5, timeoutMs = 15000) {
  return new Promise<{ status: number; headers: any; text: string; finalUrl: string }>((resolve, reject) => {
    const doRequest = (url: string, redirectCount: number) => {
      if (redirectCount > maxRedirects) return reject(new Error('重定向次数过多'))
      const u = new URL(url)
      const mod = u.protocol === 'https:' ? https : http
      const req = mod.get({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Connection': 'keep-alive'
        }
      }, async (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = new URL(res.headers.location, url).toString()
          debugLog(`[QR-START] redirect ${res.statusCode} -> ${nextUrl}`)
          if (res.headers['set-cookie']) await setCookiesFromHeader(sess, res.headers['set-cookie'])
          // 必须排空/释放响应体，否则 keep-alive socket 被占用，后续请求会挂起导致 timeout
          res.resume()
          return doRequest(nextUrl, redirectCount + 1)
        }
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.from(c)))
        res.on('end', async () => {
          if (res.headers['set-cookie']) await setCookiesFromHeader(sess, res.headers['set-cookie'])
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode || 0, headers: res.headers, text, finalUrl: url })
        })
      })
      req.on('error', reject)
      req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')) })
    }
    doRequest(startUrl, 0)
  })
}

// 从 partition 读取 streamax 相关 cookie 并拼成 Cookie 字符串
async function getStreamaxCookieString(sess: Electron.Session): Promise<string> {
  try {
    const all = await sess.cookies.get({})
    const streamaxCookies = all.filter(c => /streamax/.test(c.domain || ''))
    return streamaxCookies.map(c => `${c.name}=${c.value}`).join('; ')
  } catch {
    return ''
  }
}

// 清除 IAM 的“半登录态” cookie（route / SESSION / usk / REQID 等），
// 这些只是 IAM SSO 中间态，不影响 oa.streamax.com 上的真正工具会话。
// 带着它们访问 OA 登录页会触发 oa<->iam 静默 SSO 重定向震荡，导致 QR-START step1 timeout。
async function clearIamHalfLoginCookies(sess: Electron.Session): Promise<void> {
  try {
    const all = await sess.cookies.get({ domain: 'iam.streamax.com' })
    for (const c of all) {
      if (/^(route|SESSION|usk|REQID|LTPATOKEN|JSESSIONID)$/i.test(c.name) || c.name.toUpperCase().includes('TOKEN')) {
        const url = `${c.secure ? 'https' : 'http'}://${c.domain?.replace(/^\./, '')}${c.path || '/'}`
        await sess.cookies.remove(url, c.name).catch(() => {})
      }
    }
    debugLog('[clearIam] cleared IAM half-login cookies')
  } catch (e: any) {
    debugLog('[clearIam] error: ' + e.message)
  }
}

// 用隐藏 BrowserWindow 完成 IAM->OA 的 OAuth 授权码 SSO 流程。
// 真实链路（由 901 Location 反推）：
//   authnEngine(loginToken) → 302 →
//     iam .../authenticate?response_type=code&client_id=oa&redirect_uri=<OA接口>&state=IAM_OA_SSO
//   → IAM 对已登录用户自动 consent → 带着 code 回跳 redirect_uri(OA 接口)
//   → OA 校验 code 后种下真正的 OA 会话（JSESSIONID 等），此后接口返回 JSON。
// 关键点：
//   1. 必须用隐藏窗口跑握手，否则主窗口会被导航到 IAM/OA 页面，React UI 被卸载，
//      用户会看到 IAM/OA 页面内容（含断图占位符 @image:...）。
//   2. 不再傻等 authnEngine 的 JS 前端跳转，直接访问真实 OA 接口触发授权码回跳。
async function completeOaSso(_loginToken: string): Promise<boolean> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    debugLog('[SSO] mainWindow unavailable, skip SSO')
    return false
  }
  // 通知渲染进程立即显示全屏 Loading 覆盖层
  mainWindow.webContents.send(IPC.OA_LOGIN_LANDING)
  const sess = session.fromPartition(PARTITION)

  // 创建隐藏窗口专门跑 SSO（与主窗口共享 partition Cookie）
  let ssoWin: BrowserWindow | null = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  const oaTrigger = 'http://oa.streamax.com:8080/ruiming/mc/materiel_ui/materielSearch.do?method=wuliao&q.ORGANIZATION_ID=102&q.ITEM_NUMBER=0000000000000&__seq=' + Date.now()
  let ok = false
  try {
    // 最多等待约 12 轮，让 OAuth 回跳 + OA 会话落地完成。
    // 策略：每轮先探测，未落地则通过隐藏窗口触发一次 OA→IAM 握手，给会话落地机会。
    // 单次 loadURL 加 3s 硬性超时，避免网络抖动时单轮阻塞过长。
    for (let i = 0; i < 12; i++) {
      ok = (await probeOaSession(sess)).ok
      if (ok) {
        debugLog(`[SSO] OA session landed (probe ok) after ~${i}s`)
        break
      }
      try {
        await new Promise<void>((resolve) => {
          let done = false
          const finish = () => { if (!done) { done = true; resolve() } }
          const onFail = (_e: any, errMsg?: string) => {
            debugLog('[SSO] trigger OA load error: ' + (errMsg || 'fail'))
            finish()
          }
          const onStop = () => finish()
          ssoWin!.webContents.once('did-fail-load', onFail)
          ssoWin!.webContents.once('did-stop-loading', onStop)
          ssoWin!.loadURL(oaTrigger).catch((e: any) => {
            debugLog('[SSO] trigger OA load rejected: ' + (e?.message || e))
            finish()
          })
          // 硬性超时：最多等 3s，避免长时间阻塞 SSO 落地流程
          setTimeout(finish, 3000)
        })
        // 给 OAuth 回跳 + 会话落地一点时间
        await new Promise(r => setTimeout(r, 800))
      } catch (e: any) {
        debugLog('[SSO] trigger OA load error: ' + e.message)
      }
      await new Promise(r => setTimeout(r, 1000))
    }
  } finally {
    // 关闭隐藏 SSO 窗口，释放资源
    try { ssoWin?.close() } catch {}
    ssoWin = null
  }

  if (!ok) {
    debugLog('[SSO] OA session did NOT land within ~20s (IAM half-login only)')
    // 关键：SSO 失败时必须通知渲染进程取消 loading，否则用户会卡在"正在进入工具..."
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.OA_CHECK_LOGGED, { loggedIn: false })
    }
  }

  // SSO 落地成功：把 OA 会话 cookie 备份到文件，确保重开 app 可免登录
  if (ok) {
    await backupOaSession(sess)
  }
  return ok
}

ipcMain.handle(IPC.OA_QR_LOGIN_START, async () => {
  const sess = session.fromPartition(PARTITION)
  try {
    // 0) 清掉 IAM 半登录态 cookie，避免带着旧 route/SESSION/usk 访问 OA 登录页时
    //    触发 oa<->iam 静默 SSO 重定向震荡导致 step1 timeout。OA 工具会话不受影响。
    await clearIamHalfLoginCookies(sess)

    // 1) 先访问 OA 登录页，跟随重定向，提取一次性上下文 token (lck)
    //    lck 不在 HTML 里，而是在最终跳转 URL 的 query 参数中：/ac/#/index?lck=context_oauth2_xxx&entityId=oa
    debugLog(`[QR-START] step1: fetch login page ${OA_LOGIN_URL}`)

    // 退出登录后 IAM 需要短暂冷却才能正常走 SSO 跳转链，否则 step1 会卡在
    // iam 第一次 302 后不继续（表现为 timeout）。若距上次清除不足冷却期，先等待补足。
    const COOLDOWN_MS = 12000
    const sinceClear = Date.now() - lastCookieClearAt
    if (sinceClear < COOLDOWN_MS) {
      const wait = COOLDOWN_MS - sinceClear
      debugLog(`[QR-START] within IAM cooldown, waiting ${wait}ms before step1`)
      await new Promise(r => setTimeout(r, wait))
    }

    // 冷启动预热：长时间未成功登录（距上次 SSO 落地 > 30 分钟，典型如「每天首次」强制二维码），
    // IAM 后端处于冷态，第一次 302 跳转链常跑不完导致 step1 超时。先等待 IAM 预热再取登录页。
    const pref = getLoginPref()
    const sinceLastSso = Date.now() - (pref.lastTokenTs || 0)
    if (pref.lastTokenTs && sinceLastSso > 30 * 60 * 1000) {
      debugLog(`[QR-START] IAM cold start (idle ${(sinceLastSso / 60000) | 0}min), warm-up wait 8s before step1`)
      await new Promise(r => setTimeout(r, 8000))
    }

    let loginPage
    let lastErr
    // step1 单次超时 12s；最多重试 5 次，重试间隔随次数平滑递增（5s/8s/11s/14s），
    // 给 IAM 冷启动/解冻留出时间，确保跳转链在循环内跑通，不再把 timeout 抛给前端二次重试。
    // 只在首轮清一次 IAM 半登录态（反复清会重置 IAM 会话、延长解冻时间）。
    await clearIamHalfLoginCookies(sess)
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        loginPage = await httpJsonWithRedirect(OA_LOGIN_URL, sess, 5, 12000)
        lastErr = undefined
        break
      } catch (e: any) {
        lastErr = e
        debugLog(`[QR-START] step1 attempt ${attempt + 1} failed: ${e.message}`)
        if (attempt < 4) await new Promise(r => setTimeout(r, 5000 + attempt * 3000))
      }
    }
    if (lastErr) throw lastErr
    const page = loginPage!
    const pageText = page.text || ''
    const finalUrl = page.finalUrl || ''
    let lck = ''
    const urlLck = /[?&#]lck=(context_oauth2_[a-f0-9]+)/i.exec(finalUrl)
    if (urlLck) lck = urlLck[1]
    if (!lck) {
      const textLck = /(context_oauth2_[a-f0-9]+)/i.exec(pageText)
      if (textLck) lck = textLck[1]
    }
    debugLog(`[QR-START] loginPage finalUrl=${finalUrl.split('?')[0]}... status=${page.status}, lck=${lck.slice(0, 20) || '(empty)'}`)
    if (!lck) throw new Error('未能从登录页获取 lck 上下文参数')

    // 登录页会种下 IAM/SSO cookie，后续接口必须带上，否则 queryAuthMethods 返回空或报错
    const cookieStr = await getStreamaxCookieString(sess)
    debugLog(`[QR-START] cookies=${cookieStr ? cookieStr.split(';').length : 0} items`)

    // 2) 查询可用认证方式，获取扫码认证链 authChainCode（qr 模块的 chain）
    //    正确格式：POST + JSON（Content-Type: application/json;charset=UTF-8），body 含 lck 与 entityId
    debugLog('[QR-START] step2: queryAuthMethods')
    const methodsReq = await httpJson({
      url: 'https://iam.streamax.com/idp/authn/queryAuthMethods',
      method: 'POST',
      body: { lck, entityId: 'oa' },
      timeoutMs: 30_000,
      headers: {
        'Origin': 'https://iam.streamax.com',
        'Referer': 'https://iam.streamax.com/ac/',
        'Content-Type': 'application/json;charset=UTF-8',
        ...(cookieStr ? { 'Cookie': cookieStr } : {})
      }
    })
    if (methodsReq.headers['set-cookie']) await setCookiesFromHeader(sess, methodsReq.headers['set-cookie'])
    debugLog(`[QR-START] queryAuthMethods status=${methodsReq.status} body=${JSON.stringify(methodsReq.json).slice(0, 400)}`)

    let authChainCode = ''
    // 兼容多种可能的返回结构：data / data.list / data.authChains / result 等
    const respData = methodsReq.json?.data
    let chains: any[] = Array.isArray(respData) ? respData : []
    if (!chains.length && Array.isArray(respData?.list)) chains = respData.list
    if (!chains.length && Array.isArray(respData?.authChains)) chains = respData.authChains
    if (!chains.length && Array.isArray(respData?.chains)) chains = respData.chains
    if (!chains.length && Array.isArray(methodsReq.json?.result)) chains = methodsReq.json.result

    for (const c of chains) {
      const codes = [c.moduleCode, c.moduleCodes, c.authModuleCode, c.authModuleCodes].filter(Boolean).flat()
      if (codes.includes('qr') || c.authChainName?.includes('扫码') || c.moduleName?.includes('扫码')) {
        authChainCode = c.authChainCode
        break
      }
    }
    if (!authChainCode) {
      // 兜底：取第一个返回的链
      authChainCode = chains[0]?.authChainCode || ''
    }
    if (!authChainCode) {
      throw new Error(`未能获取扫码认证链 authChainCode，queryAuthMethods 返回：${JSON.stringify(methodsReq.json).slice(0, 200)}`)
    }

    // 3) 用 lck 请求二维码
    debugLog('[QR-START] step3: getAuthQr')
    const { status, headers, json } = await httpJson({
      url: 'https://iam.streamax.com/idp/authn/getAuthQr',
      method: 'POST',
      body: { entityId: 'oa', lck },
      timeoutMs: 30_000,
      headers: {
        'Origin': 'https://iam.streamax.com',
        'Referer': 'https://iam.streamax.com/ac/',
        ...(cookieStr ? { 'Cookie': cookieStr } : {})
      }
    })
    if (headers['set-cookie']) await setCookiesFromHeader(sess, headers['set-cookie'])
    debugLog(`[QR-START] getAuthQr status=${status} qrToken=${json?.data?.qrToken?.slice(0, 8)}... body=${JSON.stringify(json).slice(0, 200)}`)
    const ok = status >= 200 && status < 300 && (json?.code === '0' || json?.code === 0 || json?.code === '200' || json?.code === 200 || json?.status === 'success' || json?.success === true)
    if (!ok && json?.message) throw new Error(json.message)
    return {
      success: ok,
      qrToken: json?.data?.qrToken,
      qrMsg: json?.data?.qrMsg || json?.data?.qrMessage,
      authChainCode,
      lck,
      entityId: 'oa'
    }
  } catch (err: any) {
    debugLog('[QR-START] error: ' + err.message)
    return { success: false, message: err.message }
  }
})

// 真正的扫码等待接口：authExecute 是「长轮询」，请求挂起直到手机确认后返回登录结果。
ipcMain.handle(IPC.OA_QR_LOGIN_POLL, async (_e, payload: {
  qrToken: string
  authChainCode: string
  lck: string
  entityId?: string
}) => {
  const sess = session.fromPartition(PARTITION)
  const { qrToken, authChainCode, lck, entityId = 'oa' } = payload
  const pollUrl = 'https://iam.streamax.com/idp/authn/authExecute'
  try {
    const allCookies = await sess.cookies.get({})
    const streamaxCookies = allCookies.filter(c => /streamax/.test(c.domain || ''))
    const cookieStr = streamaxCookies.map(c => `${c.name}=${c.value}`).join('; ')
    const body = {
      authModuleCode: 'qr',
      authChainCode,
      entityId,
      authPara: { qrToken },
      lck,
      requestType: 'chain_type'
    }
    debugLog(`[QR-POLL] url=${pollUrl} qrToken=${qrToken.slice(0, 8)} chain=${authChainCode.slice(0, 8)} cookies=${streamaxCookies.length}`)

    // 长轮询：给较长超时，服务端会在扫码/确认后返回。
    const { status, headers, json } = await httpJson({
      url: pollUrl,
      method: 'POST',
      body,
      timeoutMs: 60_000,
      headers: {
        'Origin': 'https://iam.streamax.com',
        'Referer': 'https://iam.streamax.com/ac/',
        'Content-Type': 'application/json;charset=UTF-8',
        ...(cookieStr ? { 'Cookie': cookieStr } : {})
      }
    })
    if (headers['set-cookie']) await setCookiesFromHeader(sess, headers['set-cookie'])
    debugLog(`[QR-POLL] status=${status} data=${JSON.stringify(json).slice(0, 200)}`)

    // 解析登录结果：成功条件灵活匹配（兼容 code:200 / loggedIn:true / status:success 等）
    const code = json?.code
    const success = status >= 200 && status < 300 &&
      (code === '200' || code === 200 || json?.loggedIn === true || json?.message?.includes('成功') ||
       json?.status === 'success' || json?.success === true)

    if (success) {
      // authExecute 仅表示 IAM 侧认证通过，还需完成 IAM->OA 的 SSO 跳转，
      // 种下 oa.streamax.com:8080 的 SESSION/LtpaToken 等登录态 cookie。
      // 根据抓包证据，真实浏览器跳转链为：
      //   authExecute(成功) → /idp/authCenter/authnEngine?loginToken=xxx
      //     → JS 自动跳转 → http://oa.streamax.com:8080/sys/portal/page.jsp?state=IAM_OA_SSO
      try {
        const loginToken =
          json?.data?.loginToken ||
          json?.loginToken ||
          (json?.data && (json.data as any)?.loginToken) ||
          (json?.data && (json.data as any)?.token)
        if (loginToken) {
          debugLog('[QR-POLL] authExecute success, completing SSO via authnEngine (token=yes)')
          // 先用 HTTP 跟随 authnEngine：若它返回 HTTP 302 到 page.jsp，则能直接落 cookie；
          // 若它返回 200+JS 跳转（HTTP 链拿不到后续），再 fallback 到主窗口执行 JS 跳转。
          const authUrl = `https://iam.streamax.com/idp/authCenter/authnEngine?locale=zh-CN&loginToken=${encodeURIComponent(String(loginToken))}`
          const fin = await httpJsonWithRedirect(authUrl, sess, 8)
          debugLog(`[QR-POLL] SSO chain final status=${fin.status} finalUrl=${fin.finalUrl}`)
          const after = await sess.cookies.get({})
          const hasOaSession = (cs: any[]) => cs.some(c =>
            (c.domain || '').toLowerCase().includes('oa.streamax.com') &&
            (/^(JSESSIONID|SESSION|LTPATOKEN|ROUTE|TOKEN|OA_TOKEN|UID|USER|LOGIN|SSO)/i.test(c.name) ||
             c.name.toUpperCase().includes('SESSION') || c.name.toUpperCase().includes('TOKEN')))
          debugLog(`[QR-POLL] after HTTP SSO: oa cookies = ${after.filter(c => (c.domain||'').toLowerCase().includes('oa.streamax.com')).map(c => c.name).join(', ') || '(none)'}`)
          let landed = hasOaSession(after)
          if (!landed) {
            // HTTP 链没拿到 OA 会话，用主窗口跑完整 SSO 跳转链（含主动导航 portal 兜底）
            debugLog('[QR-POLL] HTTP SSO chain did not land OA session, falling back to main-window navigation')
            landed = await completeOaSso(String(loginToken))
          } else {
            debugLog('[QR-POLL] HTTP SSO chain landed OA session, skipping main-window nav')
          }
          // SSO 完成后主动检测登录态并通知渲染进程进入工具；若主窗口导航返回成功也直接推送
          const finalOk = landed || await isOALoggedin()
          debugLog(`[QR-POLL] final isOALoggedin = ${finalOk}`)
          // 登录后预热 OA 会话：主动访问一次真实 OA 接口，强制完成 SSO 握手落地，
          // 避免用户首次查询时才被 OA 踢去 IAM 重新认证（901），消除“重新登录”体验。
          if (finalOk) {
            try {
              const warmed = await probeOaSession(sess)
              debugLog(`[QR-POLL] OA session warm-up ok=${warmed.ok} reason=${warmed.reason}`)
              if (!warmed.ok) {
                // 预热触发了 reauth（901）——再给一次机会通过主窗口导航 portal 完成握手
                debugLog('[QR-POLL] warm-up hit reauth, retry via completeOaSso')
                await completeOaSso(String(loginToken))
                await probeOaSession(sess)
              }
            } catch (warmErr: any) {
              debugLog('[QR-POLL] warm-up warning: ' + warmErr.message)
            }
          }
          if (finalOk && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC.OA_CHECK_LOGGED, { loggedIn: true })
          }
        } else {
          debugLog('[QR-POLL] authExecute success but no loginToken found, cannot complete SSO')
        }
      } catch (finishErr: any) {
        debugLog('[QR-POLL] SSO finish warning: ' + finishErr.message)
      }
    }

    return {
      success,
      loggedIn: success,
      code,
      status: json?.status,
      message: json?.message,
      data: json?.data ?? {}
    }
  } catch (err: any) {
    // 长轮询超时（timeout）属正常，标记 error 让前端继续下一轮等待，不报错
    const isTimeout = /timeout/i.test(err.message)
    debugLog(`[QR-POLL] error: ${err.message}${isTimeout ? ' (long-poll timeout, continue)' : ''}`)
    return { success: false, loggedIn: false, error: isTimeout ? 'timeout' : err.message, message: isTimeout ? '' : err.message }
  }
})

// ============ OA_REFRESH_SESSION：主进程重新预热 OA 会话（消除 901） ============
ipcMain.handle(IPC.OA_REFRESH_SESSION, async () => {
  try {
    const sess = session.fromPartition(PARTITION)
    // 先探测，若命中 reauth(901) 则在隐藏窗口里走一次真实 OA 接口，
    // 触发 IAM OAuth 授权码回跳，完成 OA 会话落地；避免主窗口被导航到 OA 页面。
    const probed = await probeOaSession(sess)
    if (!probed.ok) {
      debugLog(`[OA_REFRESH_SESSION] probe failed (${probed.reason}), trigger OAuth callback in hidden window`)
      const retried = await tryAutoSsoRefresh(sess)
      queryLog(`[OA_REFRESH_SESSION] after warm-up probed=${retried}`)
      // 自动刷新仍失败：会话确已失效，通知渲染进程拉起扫码登录
      if (!retried) {
        queryLog('[OA_REFRESH_SESSION] auto refresh failed -> request QR login')
        requestLoginView()
      }
      return { ok: retried, needRelogin: !retried }
    }
    queryLog('[OA_REFRESH_SESSION] session already valid=true')
    return { ok: true }
  } catch (e: any) {
    debugLog('[OA_REFRESH_SESSION] error: ' + (e?.message || e))
    return { ok: false, error: e?.message || String(e) }
  }
})

ipcMain.handle(IPC.OA_FETCH, async (_e, url: string): Promise<any> => {
  const sess = session.fromPartition(PARTITION)

  // 排查日志：记录入口请求与当前分区登录态 cookie（含 domain，用于判断 OA 是否认可）
  const allCookies0 = await sess.cookies.get({})
  const cookieNames0 = allCookies0.map(c => c.name)
  queryLog(`[OA_FETCH] REQ url=${url}`)
  queryLog(`[OA_FETCH] partition cookie count=${allCookies0.length} names=[${cookieNames0.join(', ')}]`)
  for (const c of allCookies0) {
    queryLog(`[OA_FETCH]   cookie domain=${c.domain} name=${c.name} path=${c.path} secure=${c.secure} httpOnly=${c.httpOnly}`)
  }

  // 内部函数：执行一次 HTTP 请求
  const doRequest = (targetUrl: string, cookieStr: string, maxRedirect = 0): Promise<{ status: number; headers: any; body: Buffer; cookieStr: string }> => {
    return new Promise((resolve, reject) => {
      const reqUrl = new URL(targetUrl)
      const useHttps = reqUrl.protocol === 'https:'
      const lib = useHttps ? https : http
      const options: any = {
        hostname: reqUrl.hostname,
        port: reqUrl.port || (useHttps ? 443 : 80),
        path: reqUrl.pathname + reqUrl.search,
        method: 'GET',
        headers: {
          'Cookie': cookieStr,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Encoding': 'gzip, deflate',
          'Referer': OA_ORIGIN
        }
      }
      const req = lib.request(options, res => {
        // 收集 set-cookie，合并到后续请求的 cookie 字符串
        const setCookies = res.headers['set-cookie']
        let updatedCookie = cookieStr
        if (Array.isArray(setCookies) && setCookies.length) {
          for (const sc of setCookies) {
            const nameVal = sc.split(';')[0].trim()
            if (nameVal && nameVal.includes('=')) {
              const name = nameVal.split('=')[0].trim()
              // 移除同名旧 cookie，追加新的
              updatedCookie = updatedCookie
                .split(';')
                .filter(c => !c.trim().startsWith(name + '='))
                .concat([nameVal])
                .join('; ')
            }
          }
        }

        // 处理重定向
        if ([301, 302, 303, 307, 308].includes(res.statusCode || 0) && res.headers.location && maxRedirect < 5) {
          let loc = res.headers.location
          if (!loc.startsWith('http')) {
            // 相对路径 → 拼接为绝对 URL
            const base = `${reqUrl.protocol}//${reqUrl.hostname}${reqUrl.port ? ':' + reqUrl.port : ''}`
            loc = new URL(loc, base).href
          }
          // 关键：OA 接口(materielSearch.do 等)在 cookie 触发 SSO 重新握手时，
          // 会 302 到 iam.streamax.com 认证地址（state=IAM_OA_SSO）。
          // 这是“需要重新登录”的信号，不是数据重定向——禁止跟随，否则会一路
          // 跟到 IAM 登录页 HTML，被误判为服务器错误。
          const isReauthRedirect = /iam\.streamax\.com/i.test(loc) &&
            /(authCenter\/authenticate|state=IAM_OA_SSO|authnEngine|idp\/)/i.test(loc)
          if (isReauthRedirect) {
            debugLog(`[OA_FETCH] reauth redirect ${res.statusCode} → ${loc} (stop following)`)
            queryLog(`[OA_FETCH] 901 REAUTH LOCATION=${loc}`)
            resolve({ status: 901, headers: res.headers, body: Buffer.from(''), cookieStr: updatedCookie })
            return
          }
          debugLog(`[OA_FETCH] redirect ${res.statusCode} → ${loc} (${maxRedirect + 1}/5)`)
          doRequest(loc, updatedCookie, maxRedirect + 1).then(resolve).catch(reject)
          return
        }

        // 非重定向：收集 body
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks), cookieStr: updatedCookie })
        })
      })
      req.on('error', reject)
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')) })
      req.end()
    })
  }

  // 获取 partition 下所有 cookie（包括 iam.streamax.com 等跨域 SSO cookie）
  const cookies = await sess.cookies.get({})
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')

  try {
    const { status, headers, body } = await doRequest(url, cookieStr)
    const encoding = (headers['content-encoding'] || '').toLowerCase()

    queryLog(`[OA_FETCH] RES status=${status} | reqCookieCount=${cookies.length} | encoding=${encoding} | byteLen=${body.length}`)

    // 按 content-encoding 解压
    const decode = (raw: Buffer): string => {
      try {
        if (encoding === 'gzip') return zlib.gunzipSync(raw).toString('utf8')
        if (encoding === 'deflate') return zlib.inflateSync(raw).toString('utf8')
      } catch (e) {
        queryLog('[OA_FETCH] decompress failed: ' + String(e))
      }
      return raw.toString('utf8')
    }
    const text = decode(body).trim()

    if (status >= 400) {
      queryLog(`[OA_FETCH] HTTP ERROR ${status} bodyHead=${text.slice(0, 200)}`)
      throw new Error(`HTTP ${status}: ${text.slice(0, 200)}`)
    } else if (status === 901) {
      // OA 接口要求重新走 SSO 认证（cookie 触发了 302 reauth 到 IAM）
      queryLog(`[OA_FETCH] NEED RE-LOGIN (OA redirected to IAM auth)`)
      throw new Error('NEED_RELOGIN')
    } else if (body.length === 0) {
      queryLog('[OA_FETCH] empty body, returning {}')
      return {}
    } else if (text.startsWith('<')) {
      // 未登录 / Cookie 失效的典型表现：OA 返回登录页 HTML
      queryLog(`[OA_FETCH] RETURNED HTML (likely NOT logged-in / cookie invalid), status=${status}, htmlHead=${text.slice(0, 160).replace(/\s+/g, ' ')}`)
      throw new Error(`OA 返回 HTML（可能未登录或 Cookie 失效），status: ${status}`)
    } else {
      try {
        const json = JSON.parse(text)
        const rowCount = Array.isArray(json?.datas) ? json.datas.length : (json ? Object.keys(json).length : 0)
        queryLog(`[OA_FETCH] OK JSON parsed, topKeys=[${Object.keys(json).join(', ')}] datasRows=${rowCount}`)
        return json
      } catch (e) {
        queryLog('[OA_FETCH] JSON.parse failed, raw head: ' + text.slice(0, 120))
        return text
      }
    }
  } catch (err: any) {
    queryLog(`[OA_FETCH] THROW: ${err?.message || String(err)}`)
    throw err
  }
})

// 在 app 内下载规格文件：复用 partition 已登录的 OA 会话 Cookie，避免跳浏览器
// 后浏览器未登录 OA 无法下载的问题。返回 { ok, savedPath } 或 { ok:false, error }。
ipcMain.handle(IPC.OA_FILE_DOWNLOAD, async (_e, payload: { url: string; filename?: string }): Promise<any> => {
  const { url, filename } = payload || {}
  if (!url) return { ok: false, error: 'empty url' }
  const sess = session.fromPartition(PARTITION)
  const cookies = await sess.cookies.get({})
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')

  try {
    const buf: Buffer = await new Promise((resolve, reject) => {
      const reqUrl = new URL(url)
      const useHttps = reqUrl.protocol === 'https:'
      const lib = useHttps ? https : http
      const req = lib.request({
        hostname: reqUrl.hostname,
        port: reqUrl.port || (useHttps ? 443 : 80),
        path: reqUrl.pathname + reqUrl.search,
        method: 'GET',
        headers: {
          'Cookie': cookieStr,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept': '*/*',
          'Referer': OA_ORIGIN
        }
      }, (res) => {
        // 若 OA 要求重新登录（302 到 IAM 认证），说明会话已失效，无法下载
        const loc = res.headers.location
        const isReauth = loc && /iam\.streamax\.com/i.test(loc) && /(authCenter\/authenticate|state=IAM_OA_SSO|authnEngine|idp\/)/i.test(loc)
        if (isReauth) {
          reject(new Error('NEED_RELOGIN'))
          return
        }
        if ((res.statusCode || 0) >= 400) {
          reject(new Error('HTTP ' + res.statusCode))
          return
        }
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(Buffer.from(c)))
        res.on('end', () => resolve(Buffer.concat(chunks)))
      })
      req.on('error', reject)
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('download timeout')) })
      req.end()
    })

    // 让用户选择保存位置；默认文件名优先用链接里的 fileName=，其次 payload.filename
    let defaultName = filename || 'specification-file'
    const fnMatch = url.match(/fileName=([^&]+)/i)
    if (fnMatch) {
      try { defaultName = decodeURIComponent(fnMatch[1]) } catch { /* ignore */ }
    }
    if (!mainWindow) return { ok: false, error: 'no main window' }
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName,
      title: '保存规格文件'
    })
    if (canceled || !filePath) return { ok: true, canceled: true }
    writeFileSync(filePath, buf)
    queryLog(`[OA_FILE_DOWNLOAD] saved ${buf.length} bytes -> ${filePath}`)
    return { ok: true, savedPath: filePath }
  } catch (e: any) {
    const msg = e?.message || String(e)
    queryLog(`[OA_FILE_DOWNLOAD] error: ${msg}`)
    if (msg === 'NEED_RELOGIN') return { ok: false, error: 'NEED_RELOGIN' }
    return { ok: false, error: msg }
  }
})

ipcMain.handle(IPC.COOKIE_CLEAR, async () => {
  const sess = session.fromPartition(PARTITION)
  // 记录清除时间，供 QR-START step1 冷却等待（退出后 IAM 需短暂复位）
  lastCookieClearAt = Date.now()
  // 彻底清空 partition 下所有持久化数据（Cookie / Storage / Cache），
  // 覆盖 oa.streamax.com 与 iam.streamax.com 等 SSO 域
  await sess.clearStorageData()
  await sess.cookies.remove('http://oa.streamax.com:8080', '').catch(() => {})
  // 也尝试按域清理（cookies.remove 需要 name，这里用 cookies.get+clear 兜底）
  const all = await sess.cookies.get({})
  for (const c of all) {
    try {
      const url = `${c.secure ? 'https' : 'http'}://${c.domain?.replace(/^\./, '')}${c.path || '/'}`
      await sess.cookies.remove(url, c.name)
    } catch { /* ignore */ }
  }
  debugLog('[COOKIE_CLEAR] cleared all partition cookies/storage')
  // 同时删除 OA 会话文件备份，避免退出登录后重开又自动恢复登录态
  try { if (existsSync(SESSION_BACKUP_PATH)) unlinkSync(SESSION_BACKUP_PATH) } catch {}
  checkLoginAndNotify()
})
ipcMain.handle(IPC.INSTALL_UPDATE, () => {
  const fs = require('fs')
  const { spawn } = require('child_process')
  // 直接取 electron-updater 已下载的安装包路径，避免 quitAndInstall 在 Windows 上偶发不退出 app
  const installerPath = (autoUpdater as any).downloadedUpdateHelper?.file
  debugLog(`[INSTALL_UPDATE] installerPath=${installerPath}, exists=${installerPath ? fs.existsSync(installerPath) : false}`)

  if (installerPath && fs.existsSync(installerPath)) {
    // 非静默安装：不加 /S，显示完整 NSIS 安装向导；--force-run 确保安装完成后自动启动 app
    const args = ['--updated', '--force-run']
    debugLog(`[INSTALL_UPDATE] spawn: ${installerPath} ${args.join(' ')}`)
    try {
      const child = spawn(installerPath, args, { detached: true, stdio: 'ignore' })
      child.unref()
      debugLog(`[INSTALL_UPDATE] spawn pid=${child.pid}`)
    } catch (e: any) {
      debugLog(`[INSTALL_UPDATE] spawn error: ${e?.message || e}`)
      // fallback：让 electron-updater 自己处理
      autoUpdater.quitAndInstall(false, true)
      return
    }
    // 当前 app 必须退出，才能让安装向导覆盖/写入文件
    setTimeout(() => {
      debugLog('[INSTALL_UPDATE] app.exit(0)')
      app.exit(0)
    }, 300)
  } else {
    // 未找到已下载安装包时兜底
    debugLog('[INSTALL_UPDATE] fallback quitAndInstall(false, true)')
    autoUpdater.quitAndInstall(false, true)
  }
})

ipcMain.handle('dialog:saveCsv', async (_e, content: string, defaultName: string) => {
  if (!mainWindow) return null
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  })
  if (canceled || !filePath) return null
  const fs = require('fs')
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
})
