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
  debugLog('[autoSSO] start HTTP SSO refresh (follow OA login page redirects)')
  try {
    // 纯 HTTP 跟随 OA 登录页重定向链：若 partition 里 IAM 仍登录，OA 会静默完成
    // oa→iam?code→oa 落地并种下 OA 会话；若 IAM 已失效，则停在 IAM 登录页（OA 不落地）。
    try {
      const r = await httpJsonWithRedirect(OA_LOGIN_URL, sess, 6, 15000)
      debugLog(`[autoSSO] OA login page chain final=${r.finalUrl.split('?')[0]} status=${r.status}`)
    } catch (e: any) {
      debugLog('[autoSSO] OA login page chain error: ' + e.message)
    }
    // 等待落地（优化 A：间隔 400ms，上限 16 轮，覆盖 ~6s 最坏落地）
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 400))
      if ((await probeOaSession(sess)).ok) break
    }
  } catch (e: any) {
    debugLog('[autoSSO] trigger error: ' + e.message)
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
    const probed = await probeOaSession(sess)
    if (probed.ok) return true
    // 修复 1.0.13 回归：OA 明确拒绝登录时（probe=reauth，返回 901），即便 cookie 名存在
    // （SESSION@oa / LtpaToken@streamax）也**不能**信任——那是 OA 尚未认可的无效/旧 token，
    // 放行会导致查询被 OA 302 踢回 IAM、内部功能全废（见 2026-08-26 日志实证）。
    // 仅在探针因「网络级错误」(reason=network) 时才信任 cookie 兜底，避免网络抖动误踢真登录。
    // 注意：此处的 network 兜底是指「spa 已落地完成、SSO 刚结束」这类场景，调用方可结合 probe/落地结果决策。
    if (probed.reason === 'network') {
      queryLog(`[isOALoggedin] hasOaSession=true, probe reason=network -> trust cookie (network blip)`)
      return true
    }
    queryLog(`[isOALoggedin] hasOaSession=true but probe=reauth -> NOT logged in`)
    return false
  } catch {
    return false
  }
}

// 严格版：供「刚完成扫码/SSO 落地」路径使用。此时会话本应已落地，
// 必须以真实探测 ok 为准，不对 network 做"信任 cookie"兜底——
// 否则弱网/服务端超时(-118)会把假登录骗进工具，首次查询即被 901 踢回扫码。
async function isOALoggedinStrict(sess: Electron.Session): Promise<boolean> {
  try {
    const cookies = (await sess.cookies.get({})).filter(c => /streamax/.test(c.domain || ''))
    if (cookies.length === 0) return false
    const OA_HOST = 'oa.streamax.com'
    const oaCookies = cookies.filter(c => (c.domain || '').toLowerCase().includes(OA_HOST.toLowerCase()))
    const hasOaSession = oaCookies.some(c =>
      /^(JSESSIONID|SESSION|LTPATOKEN|ROUTE|TOKEN|OA_TOKEN|UID|USER|LOGIN|SSO)/i.test(c.name) ||
      c.name.toUpperCase().includes('SESSION') || c.name.toUpperCase().includes('TOKEN'))
    if (!hasOaSession) return false
    const probed = await probeOaSession(sess)
    // 仅 probe.ok 才算登录；reauth/invalid/network 一律视为未生效
    debugLog(`[isOALoggedinStrict] probe ok=${probed.ok} reason=${probed.reason}`)
    return probed.ok
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
  // 恢复后仍需真实探测确认 OA 认可登录态：1.0.13 回归证明「cookie 已恢复≠OA 认可」，
  // 恢复成功但 OA 接口仍 901 reauth（IAM↔OA 信任链未打通）时，必须重新走 SSO 而非放行，
  // 否则进工具后所有查询被 OA 302 踢回 IAM、内部功能全废（见 2026-08-26 日志）。
  let ok = false
  if (restoredOk) {
    const probed = await probeOaSession(session.fromPartition(PARTITION))
    if (probed.ok) ok = true
    else if (probed.reason === 'network') ok = await isOALoggedin() // 网络级失败才兜底 cookie
    else debugLog(`[startup] restored cookies present but OA probe=reauth -> require re-SSO`)
  } else {
    ok = await isOALoggedin()
  }
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
    // Chromium 对 unspecified 的默认行为会按 Lax 处理，导致跨站（oa→iam）跳转时不发送
    // IAM cookie，从而 IAM 认为未登录、OA 会话无法落地。默认用 no_restriction 保证
    // IAM 的会话类 cookie（usk/SESSION/REQID）在 oa↔iam 的 302 链中始终被携带。
    let sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict' = 'no_restriction'
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
// stopAtLck: 当跳转链中出现 /ac/#/index?lck=... 时立即从 Location 解析 lck 并 resolve，
//   不再 GET 该冷场的 SPA 页面（登出后 IAM SPA 冷场会导致 step1 超时 40~50s）。lck 与 REQID
//   cookie 均在跳转响应头里已拿到，无需实际加载 SPA 内容。
// 快速落地：POST authnEngine 核销 loginToken，从返回 HTML 提取 oa/?code= 并手动跟随，
// 建立 OA 会话。参考 Streamax_oa_api_client 的 oa_client.js（纯 HTTP 路径），
// 彻底规避 BrowserWindow 在冷连接下的 -118 连接超时（round 1/2 各 ~21s，导致 ~73s 卡顿）。
// 保留 httpJsonWithRedirect（下方）用于 IAM→OA 的 OAuth 授权码 SSO 落地（QR-POLL 建立 IAM 票据、completeOaSso 用 BrowserWindow 完成 OA 会话）。
function httpJsonWithRedirect(startUrl: string, sess: Electron.Session, maxRedirects = 5, timeoutMs = 15000, stopAtLck = false) {
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
          // 命中 IAM SPA 入口（携带一次性 lck 上下文）：此时 lck 与 REQID cookie 均已就位，
          // 无需真正 GET 该 SPA 页面（登出后此处冷场会卡 40~50s）。提前 resolve，从 Location 拿 lck。
          if (stopAtLck && /[?&#]lck=(context_oauth2_[a-f0-9]+)/i.test(nextUrl)) {
            debugLog(`[QR-START] stopAtLck hit, resolve early (skip SPA load)`)
            return resolve({ status: res.statusCode || 0, headers: res.headers, text: '', finalUrl: nextUrl })
          }
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

// 用纯 HTTP 链（与 partition 共享 cookie jar）完成 IAM->OA 的 OAuth 授权码 SSO 落地。
// 这是 1.0.9 已验证可用的路径（日志实证：HTTP SSO chain landed OA session）。
// 真实链路：
//   authnEngine(loginToken) → 302 →
//     iam .../authenticate?response_type=code&client_id=oa&redirect_uri=<OA接口>&state=IAM_OA_SSO
//   → IAM 对已登录用户自动 consent → 带 code 回跳 redirect_uri(OA 接口)
//   → OA 校验 code 后通过 Set-Cookie 种下真正的 OA 会话（.oa.streamax.com 的 SESSION 等）。
// 关键点：
//   1. 必须用 httpJsonWithRedirect 跟随 302（落 OA cookie），而不是 BrowserWindow ——
//      隐藏窗口的 authnEngine 页面不会自动跳回 OA（实测停在 authnEngine），建不起 OA 会话。
//   2. loginToken 是一次性的；首轮跟随消费后即可，无需重复 load。
//   3. 跟随完成后 OA 会话可能处于「半建」(票据有了但未激活)，先 probe；若仍 901，
//      再 GET 一次 OA 登录页激活，然后再次 probe 即 200（与 1.0.9 的 warm-up 重试一致）。
// 复用隐藏 SSO 窗口，避免每次登录重建导致 webContents 冷连接
// （实测 iam 服务端对冷 CONNECTION 极易 21s 连接超时 -118，预热可规避）
let ssoWin: BrowserWindow | null = null
const IAM_SPA_LANDING = 'https://iam.streamax.com/ac/#/index'
function createSsoWin(): BrowserWindow {
  if (ssoWin && !ssoWin.isDestroyed()) return ssoWin
  ssoWin = new BrowserWindow({
    show: true, width: 1, height: 1, x: 0, y: 0,
    frame: false, skipTaskbar: true,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: false }
  })
  return ssoWin
}

async function completeOaSso(_loginToken: string, lck?: string): Promise<{ ok: boolean; reason: 'network' | 'reauth' }> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    debugLog('[SSO] mainWindow unavailable, skip SSO')
    return { ok: false, reason: 'reauth' }
  }
  // 通知渲染进程立即显示全屏 Loading 覆盖层
  mainWindow.webContents.send(IPC.OA_LOGIN_LANDING)
  const sess = session.fromPartition(PARTITION)

  let ok = false
  // 记录失败原因，用于给前端更明确的提示：
  //   'network' —— 网络抖动 / iam 不可达，可检查网络后重试
  //   'reauth'  —— OA 仍要求重新认证（半登录态 / loginToken 失效）
  let failReason: 'network' | 'reauth' = 'reauth'

  // ===== HTTP 落地已在 QR-POLL 阶段通过 landOaViaHttp 完成（authnEngine→oa/?code=→OA 会话）。
  // loginToken 是一次性的，不可在此重复核销，故 fastOk 交由 QR-POLL 先行处理；
  // 此处仅保持 fallback 结构：若 QR-POLL 的 HTTP 落地未生效，则走下方 BrowserWindow SPA 回跳（用 lck）。
  // 历史：曾在此重复 POST authnEngine 导致 token 复用失败；现已前移至 QR-POLL。
  let fastOk = false

  // 实测确定的落地方式（多次日志实证，而非猜测）：
  //   直接 load OA 业务接口页（OA_LOGIN_URL = http://oa.streamax.com:8080/）在清掉 OA cookie 后
  //   **会挂起**（did-start-loading 后无 did-stop/did-navigate，probe 永远 901），建不起 OA 会话。
  //   唯一能建立 OA 会话的路径是：**带 lck 访问 IAM SPA 落地页 ac/#/index?lck=...**，
  //   由该 SPA 的 JS 发起回跳 OA（will-navigate -> http://oa.streamax.com:8080/），
  //   OA 在回跳时种下真正的 OA 会话 cookie（SESSION@oa / LtpaToken@streamax）。
  //   所有成功日志都显示 fireOa load ac/#/index?lck= 后出现 will-navigate→oa 一轮落地；
  //   而 1.0.13 改成 load OA 业务页后，登出必败（12 轮全 901）——已证伪"OA 业务页能握手"的假设。
  //   故 oaTrigger 必须用带 lck 的 IAM SPA 落地页（与旧版一致，但配合下方优化避免慢）。
  //   注意：调用方（QR-POLL）必须先 HTTP 跟随 authnEngine 核销 loginToken，把 IAM 票据（usk 等）种好，
  //   否则 SPA 回跳 OA 时 OA 仍要求重新认证。
  if (!fastOk) {
  // ===== fallback：BrowserWindow SPA 回跳（仅当 HTTP 快路径失败时使用）=====
  const oaTrigger = (lck && lck.startsWith('context_oauth2_'))
    ? `${IAM_SPA_LANDING}?lck=${encodeURIComponent(lck)}&entityId=oa&theme=5b315b74bab14c5ba6e4072d8e9f3273`
    : OA_LOGIN_URL

  // 隐藏窗口跑握手（与主窗口共享 partition Cookie）。
  // 注意：屏幕外坐标(x:-2000)在部分环境会导致网络/GPU 初始化异常、SPA 加载静默卡死（-118）。
  // 改为 1×1 像素、skipTaskbar、不显示在任务栏，但保留可见性，避免渲染/网络被节流。
  // 复用模块级 ssoWin（若扫码阶段已预热，则直接进入热连接，避免首轮 -118）。
  const ssoWin = createSsoWin()

  // fireOa：用 ssoWin 加载 IAM SPA 落地页（ac/#/index?lck=）触发回跳 OA，建立 OA 会话。
  // 关键机制（HAR 实证，2026-08-25）：回跳 OA(?code=...) 由 SPA 的 JS 发出
  //   （SPA 先 XHR getLoginPageThirdAuth + authnEngine，再 window.location 回跳 OA），
  //   故**无法用纯 HTTP 跟随绕开 SPA**——必须让 Electron 真正加载并跑完 SPA。
  // 落地信号：will-navigate->oa.streamax.com（SPA 回跳 OA 建会话 cookie）；did-stop/finish 不 finish。
  // 重试策略（吸取 13:10 / 13:27 日志教训）：
  //   1) 每轮 load 前只在「上一轮未 settle（卡死）」时才 wc.stop()，避免打断正常冷场；
  //   2) 单轮兜底 35s：覆盖 SPA 冷场（实证约 16s）跑完回跳；若 35s 静默仍无回跳，判为卡死，
  //      下一轮 stop+重 load（不干等）；
  //   3) 连接级失败(-118 等) 标记 network 且下一轮重 load。
  // 仅对真正连接级错误（TIMED_OUT / ERR_CONNECTION / -118 等）标记 network；
  // ERR_ABORTED/-3 来自自身 stop，忽略。
  const OA_HOST_RE = /oa\.streamax\.com/i
  let pendingLoad = 0
  let loadedOnce = false
  let lastLoadSettled = false // 上一轮是否已完成（回跳或失败）；未 settle=卡死
  const isConnError = (s?: string) => !!s && /TIMED_OUT|ERR_CONNECTION|timeout|ERR_NAME|ERR_SSL|-118|-106|-7\b/i.test(s)
  const fireOa = (tag: string) => new Promise<void>((resolve) => {
    const myLoad = ++pendingLoad
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    const wc = ssoWin!.webContents
    const onFail = (_e: any, errMsg?: string) => {
      if (myLoad !== pendingLoad) return // 已被更新的 load 取代，忽略
      debugLog(`[SSO] fireOa(${tag}) did-fail-load: ${errMsg}`)
      lastLoadSettled = true
      if (isConnError(errMsg)) {
        failReason = 'network'
        loadedOnce = false // 连接级失败：下一轮允许重 load
      }
      finish()
    }
    const onStop = () => {
      if (myLoad !== pendingLoad) return
      debugLog(`[SSO] fireOa(${tag}) did-stop-loading -> ${wc.getURL().slice(0, 100)}`)
    }
    const onNav = () => {
      if (myLoad !== pendingLoad) return
      debugLog(`[SSO] fireOa(${tag}) did-navigate -> ${wc.getURL()}`)
    }
    const onStart = () => { if (myLoad === pendingLoad) debugLog(`[SSO] fireOa(${tag}) did-start-loading`) }
    const onWillNav = (_e: any, u: string) => {
      if (myLoad !== pendingLoad) return
      debugLog(`[SSO] fireOa(${tag}) will-navigate -> ${u?.slice(0, 100)}`)
      // 回跳 OA 宿主：这就是 SPA 落地信号，立即结束本轮，交主循环 probe 判定 OA 会话。
      if (OA_HOST_RE.test(u || '')) {
        lastLoadSettled = true
        loadedOnce = true
        finish()
      }
    }
    const onRedirect = (u: string) => { if (myLoad === pendingLoad) debugLog(`[SSO] fireOa(${tag}) redirect -> ${u?.slice(0, 100)}`) }
    const onFinish = () => { if (myLoad === pendingLoad) debugLog(`[SSO] fireOa(${tag}) did-finish-load -> ${wc.getURL()}`) }
    wc.once('did-fail-load', onFail)
    wc.once('did-stop-loading', onStop)
    wc.once('did-navigate', onNav)
    wc.once('did-start-loading', onStart)
    wc.once('will-navigate', onWillNav)
    wc.once('did-finish-load', onFinish)
    try { wc.once('did-get-redirect-request' as any, (_e: any, _o: string, n: string) => onRedirect(n)) } catch {}

    // 已 load 过且上一轮已 settle（回跳成功或失败）：不重复 load，只短暂等让主循环 probe。
    if (loadedOnce && lastLoadSettled) {
      debugLog(`[SSO] fireOa(${tag}) reuse existing SPA load (settled), wait for oa callback`)
      setTimeout(finish, 3000)
      return
    }
    // 上一轮卡死（未 settle）或连接失败：先 stop 清掉僵尸连接，再重 load。
    if (loadedOnce && !lastLoadSettled) {
      debugLog(`[SSO] fireOa(${tag}) previous load stalled, stop & reload`)
      try { wc.stop() } catch {}
    }
    const sep = oaTrigger.includes('?') ? '&' : '?'
    const url = oaTrigger + sep + '__seq=' + tag + '&__t=' + Date.now()
    loadedOnce = true
    lastLoadSettled = false
    debugLog(`[SSO] fireOa(${tag}) load ${url}`)
    wc.loadURL(url).catch((e: any) => {
      if (myLoad !== pendingLoad) return
      debugLog(`[SSO] fireOa(${tag}) loadURL error: ${e?.message}`)
      lastLoadSettled = true
      if (isConnError(e?.message || '')) { failReason = 'network'; loadedOnce = false }
      finish()
    })
    // 兜底超时：首轮(tag=0)用短兜底 8s，后续轮用 22s。
    // 根因（[13:54] 日志实证）：ssoWin webContents 首次 loadURL 时 partition cookie store 未热，
    //   首请求 hdrLen=96、cookie 完全未附（usk=false 且 route/SESSION 也未带），导致 SPA 认证必失败/卡死。
    //   第二轮 load 时 store 已热，cookie 正常附加，SPA 1s 内回跳成功。故首轮本质是「预热消耗」，
    //   无需等 22s，8s 即可判失败进入第二轮正式握手，把总耗时从 ~26s 降到 ~10s。
    //   后续轮（已带 cookie）仍需 22s 覆盖正常冷场峰值（约 16s）。
    const capMs = tag === '0' ? 8000 : 22000
    setTimeout(finish, capMs)
  })

  try {
    // 诊断：拦截 ssoWin 第一次发往 iam 的请求，确认实际 Cookie 头里是否含 usk。
    const onBeforeSend = (details: any) => {
      if (/iam\.streamax\.com/.test(details.url || '')) {
        const cookieHdr = (details.requestHeaders && (details.requestHeaders['Cookie'] || details.requestHeaders['cookie'])) || '(none)'
        debugLog(`[SSO-DIAG] request to iam: ${details.url?.slice(0, 90)} | Cookie contains usk = ${/usk=/.test(cookieHdr)} | hdrLen=${cookieHdr.length}`)
        try { sess.webRequest.onBeforeSendHeaders(null as any) } catch {}
      }
    }
    try { sess.webRequest.onBeforeSendHeaders({ urls: [] }, onBeforeSend) } catch {}

    // 诊断：打印 partition 里 iam/oa/streamax 所有 cookie 的完整属性
    try {
      const diagCookies = await sess.cookies.get({ domain: 'iam.streamax.com' })
      for (const c of diagCookies) {
        debugLog(`[SSO-DIAG] iam cookie: ${c.name} path=${c.path} domain=${c.domain} sameSite=${c.sameSite} secure=${c.secure}`)
      }
    } catch (e: any) { debugLog('[SSO-DIAG] get cookies error: ' + e.message) }

    // 关键修复(1.0.13)：OA 服务端（降级/异常态）对「带旧 OA 会话 cookie 的 Chromium 请求」
    // 会进入挂起态（请求已发出但既不 302 也不返回，did-start-loading 后永远无后续事件），
    // 导致 oa↔iam 静默 SSO 握手无法完成。而裸请求（不带旧 cookie）能正常 302。
    // 故在触发握手前，清除旧 OA/streamax 会话 cookie（保留 IAM 侧 usk/REQID 等票据，
    // usk 是 authnEngine 刚种好的，且 OA 首页加载时才需要 IAM 放行）。让 load OA 首页时
    // Chromium 不带旧 OA session，OA 干净 302→IAM→（认 usk）回跳 OA 建新会话。
    try {
      const domainsToClear = ['oa.streamax.com', '.streamax.com', 'streamax.com']
      let cleared = 0
      for (const d of domainsToClear) {
        const cs = await sess.cookies.get({ domain: d })
        for (const c of cs) {
          const urls = [`http://oa.streamax.com:8080`, `https://oa.streamax.com`, `https://streamax.com`]
          for (const u of urls) {
            try { await sess.cookies.remove(u, c.name) } catch {}
          }
          cleared++
        }
      }
      debugLog(`[SSO] cleared ${cleared} stale OA/streamax cookies before handshake`)
    } catch (e: any) { debugLog('[SSO] clear stale cookies error: ' + e.message) }

    // 进循环前先触发一次握手
    // 本地判定：partition 里是否出现了**真正的 OA 业务会话 cookie**。
    // 真 OA 会话 cookie 分布在 oa.streamax.com 宿主（SESSION/route/j_lang）与根域 .streamax.com
    // （LtpaToken 种在根域）。注意：IAM 的 SESSION/route 在 .iam.streamax.com，绝不能算 OA 会话，
    // 否则 landing 会把“只有 IAM 半登录态”误判为“OA 已登录”，导致假登录、重启又得扫码。
    const checkOaSessionCookie = async (): Promise<boolean> => {
      try {
        const all = await sess.cookies.get({})
        const oa = all.filter(c => {
          const d = (c.domain || '').toLowerCase()
          if (d.includes('iam.streamax.com')) return false // 排除 IAM 专有域
          // 真 OA 会话：oa.streamax.com 宿主，或根域 .streamax.com / streamax.com（LtpaToken）
          return d.includes('oa.streamax.com') ||
            d === '.streamax.com' || d === 'streamax.com'
        })
        const has = oa.some(c =>
          /^(JSESSIONID|SESSION|LTPATOKEN|ROUTE|TOKEN|OA_TOKEN|UID|USER|LOGIN|SSO)/i.test(c.name) ||
          c.name.toUpperCase().includes('SESSION') ||
          c.name.toUpperCase().includes('TOKEN'))
        debugLog(`[SSO] oa-session-cookie check: oaCookies=${oa.length} hasOaSession=${has} names=[${oa.map(c => c.name).join(',')}] domains=[${oa.map(c => c.domain).join(',')}]`)
        return has
      } catch { return false }
    }

    // 主循环：每轮先 probe 是否已落地，未落地则 load IAM SPA 落地页触发回跳 OA 建会话。
    // fireOa 以 will-navigate→oa 为落地信号（或 15s 兜底结束本轮），由主循环 probe/cookie 判定真正落地。
    // 最多 12 轮（最坏 ~12×(probe+15s)，但 IAM 正常时 1~2 轮即落地）。
    for (let i = 0; i < 12; i++) {
      const pr = await probeOaSession(sess)
      ok = pr.ok
      if (ok) {
        debugLog(`[SSO] OA session landed (probe ok) round=${i}`)
        break
      }
      // 落地判定：以真实探测(probe)为唯一权威。
      // 修复 1.0.13 回归：先前「只要 OA 会话 cookie 名出现就判落地」是错的——
      // cookie 被种下不代表 OA 认可登录（IAM↔OA 信任链未打通时 OA 接口仍 901 reauth）。
      // 故 cookie 仅作为「network 抖动时」的兜底证据，不能凌驾 reauth。
      if (pr.reason === 'network' && await checkOaSessionCookie()) {
        debugLog(`[SSO] OA session landed via cookie (probe=network blip) round=${i}`)
        ok = true
        break
      }
      if (pr.reason === 'reauth') {
        debugLog(`[SSO] OA probe=reauth (OA rejects session) round=${i}, keep retrying/handshake`)
      }
      if (pr.reason === 'network') failReason = 'network'
      try {
        // 加载 IAM SPA 落地页（ac/#/index?lck=）：SPA 的 JS 回跳 OA 种下 OA 会话 cookie。
        // fireOa 内部每轮 load 前 wc.stop() 干净上一轮，will-navigate→oa 即 finish 避免自相 ERR_ABORTED。
        await fireOa(String(i))
      } catch (e: any) {
        debugLog('[SSO] trigger OA load error: ' + e.message)
      }
    }
  } finally {
    // 保留 ssoWin 复用（已在扫码阶段预热），不关闭；下次登录直接复用热连接。
    // 仅在窗口已销毁时由 createSsoWin 触发重建。
  }
  } // end if (!fastOk) fallback

  if (!ok) {
    debugLog(`[SSO] OA session did NOT land within ~${(12 * 15)}s (failReason=${failReason})`)
  }

  // SSO 落地成功：把 OA 会话 cookie 备份到文件，确保重开 app 可免登录
  if (ok) {
    await backupOaSession(sess)
  }
  // 注意：不在此处发送 OA_CHECK_LOGGED，统一由 QR-POLL 外层根据返回值发送，
  // 避免「内部发一次 + 外层再发一次无 reason」导致 reason 被覆盖、前端重复 re-fetch。
  return { ok, reason: failReason }
}

ipcMain.handle(IPC.OA_QR_LOGIN_START, async () => {
  const sess = session.fromPartition(PARTITION)
  try {
    // 0) 不再主动清 IAM 半登录态：登出流程已保留 IAM 会话（COOKIE_CLEAR 只清 OA/streamax），
    //    故 IAM 通常是「热」的，保留可让 step1 第 1 次就 200、秒出二维码。
    //    首启冷启动 IAM 本就空，不清也无副作用。之前「震荡 timeout」实为循环前重复清 IAM 所致，已修。

    // 1) 先访问 OA 登录页，跟随重定向，提取一次性上下文 token (lck)
    //    lck 不在 HTML 里，而是在最终跳转 URL 的 query 参数中：/ac/#/index?lck=context_oauth2_xxx&entityId=oa
    debugLog(`[QR-START] step1: fetch login page ${OA_LOGIN_URL}`)

    // 冷启动预热：长时间未成功登录（距上次 SSO 落地 > 30 分钟，典型如「每天首次」强制二维码），
    // IAM 后端处于冷态，第一次 302 跳转链常跑不完导致 step1 超时。
    // 改为「自适应探测」：循环轻量探测 OA 入口是否可达（IAM 冷态恢复通常需要 20~35s），
    // 一旦可达立即 proceed 取登录页，而不是盲等固定 8s 后再一次性超时重试（那样反而会浪费时间）。
    const pref = getLoginPref()
    const sinceLastSso = Date.now() - (pref.lastTokenTs || 0)
    if (pref.lastTokenTs && sinceLastSso > 30 * 60 * 1000) {
      debugLog(`[QR-START] IAM cold start (idle ${(sinceLastSso / 60000) | 0}min), adaptive warm-up probing IAM...`)
      const probeDeadline = Date.now() + 40 * 1000
      let ready = false
      while (Date.now() < probeDeadline) {
        try {
          // 轻量探测：取 OA 登录页（跟随 302 到 IAM），短超时 4s；IAM 冷态恢复即命中
          await httpJsonWithRedirect(OA_LOGIN_URL, sess, 5, 4000)
          ready = true
          debugLog('[QR-START] IAM warm-up probe ok, proceed to step1')
          break
        } catch (e: any) {
          debugLog(`[QR-START] IAM warm-up probe retry: ${e.message}`)
          await new Promise(r => setTimeout(r, 2000))
        }
      }
      if (!ready) debugLog('[QR-START] IAM warm-up probe timed out (40s), fall through to step1 retry')
    }

    let loginPage
    let lastErr
    // step1：取 OA 登录页并跟随跳转链到 IAM 的 ac/#/index（拿到 lck）。
    // IAM 后端偶发卡顿（首次冷启动或网络抖动）时，跳转链会跑不完导致超时。
    // 优化（应对「偶尔卡 60s」）：单次超时收紧（首轮 5s、重试 4s），退避 [1.5,2,3,3,3]s，
    // 整体再套一层「硬上限 30s」——即便服务端持续抖动也给前端明确的 network 出口，不再盲等到 45s+。
    // 冷启动已由上面的自适应探测尽量覆盖，这里再做兜底；全部失败则抛 network 错误，
    // 前端提示「网络异常」而非无限转圈。
    // 注意：QR-START 开头已不再清 IAM 半登录态（保留热会话，登出后多数情况第 1 次就 200、秒出码）。
    const STEP1_HARD_CAP = 30_000
    const retryBackoff = [1500, 2000, 3000, 3000, 3000]
    const step1Started = Date.now()
    const step1WithCap = Promise.race([
      (async () => {
        for (let attempt = 0; attempt < 6; attempt++) {
          const elapsed = Date.now() - step1Started
          if (elapsed >= STEP1_HARD_CAP) throw new Error('step1 overall timeout')
          const budget = STEP1_HARD_CAP - elapsed
          try {
            loginPage = await httpJsonWithRedirect(OA_LOGIN_URL, sess, 5, attempt === 0 ? Math.min(5000, budget) : Math.min(4000, budget), true)
            lastErr = undefined
            return
          } catch (e: any) {
            lastErr = e
            debugLog(`[QR-START] step1 attempt ${attempt + 1} failed: ${e.message}${e.message === 'step1 overall timeout' ? ' (cap)' : ''}`)
            if (attempt < 5 && (Date.now() - step1Started) < STEP1_HARD_CAP) {
              await new Promise(r => setTimeout(r, retryBackoff[attempt] || 3000))
            }
          }
        }
      })(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('step1 overall timeout')), STEP1_HARD_CAP))
    ])
    try {
      await step1WithCap
    } catch (e: any) {
      lastErr = lastErr || e
    }
    if (lastErr) {
      // step1 全部失败：IAM/网络不可达，标记 network 让前端显示「网络异常」而非技术错误
      const isNet = /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ERR_CONNECTION|TIMED_OUT|ENOTFOUND|getaddrinfo/i.test(lastErr.message || '')
      lastErr.reason = isNet ? 'network' : 'server'
      lastErr.friendly = isNet ? '网络异常，请检查网络或稍后重试' : '登录服务暂不可用，请稍后重试'
      throw lastErr
    }
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

    // 预热隐藏窗口：趁用户扫码的几秒，让 BrowserWindow 的 webContents 与 iam/oa 建立「热连接」，
    // 消除 completeOaSso 握手时 round 1/2 的 -118 连接超时（实测各 ~21s，合计 ~42s 卡顿）。
    // 关键：预热用「不带 lck 的 OA_LOGIN_URL」（http://oa.streamax.com:8080/），由 iam 自动生成并消耗一个
    // **无关的** 新 lck，绝不会消耗本次登录的 lck（本次 lck 在 fireOa 阶段才用，仍有效）。
    // 之前 1.0.16 失败正是因为预热用了「本次 lck」导致 SPA 提前消费、后续 fireOa 不回跳。
    createSsoWin() // 复用模块级窗口；首次创建后，后续 fireOa 直接复用（连接保持热）
    if (ssoWin && !ssoWin.isDestroyed()) {
      ssoWin.webContents.loadURL('http://oa.streamax.com:8080/').catch(() => {})
      // 异步预热，不阻塞二维码返回；load 结果（302->iam->ac/#/index）会在 completeOaSso 前完成
    }

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
    // 区分网络类错误（step1 timeout / IAM 不可达）与业务逻辑错误，
    // 前端据此显示「网络异常」提示而非原始技术栈信息。
    const isNet = /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ERR_CONNECTION|TIMED_OUT|ENOTFOUND|getaddrinfo/i.test(err.message || '')
    const reason = err.reason || (isNet ? 'network' : 'server')
    const message = err.friendly || (isNet ? '网络异常，请检查网络或稍后重试' : (err.message || '获取二维码失败'))
    return { success: false, reason, message }
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
          debugLog('[QR-POLL] authExecute success, completing SSO (token=yes)')
          // 1.0.9 验证可用的两段式落地：
          //   第一步：HTTP 跟随 authnEngine 核销 loginToken，IAM 在其中种下 IAM 票据
          //          （usk/REQID/SESSION/LtpaToken）。authnEngine 页面本身不会跳回 OA，
          //          这一步只是「核销 + 种 IAM 票据」，不建立 OA 会话。
          const authUrl = `https://iam.streamax.com/idp/authCenter/authnEngine?locale=zh-CN&loginToken=${encodeURIComponent(String(loginToken))}`
          try {
            // 建立 IAM 票据（usk 等）：POST authnEngine 核销一次性 loginToken。
            // 注意：ian 返回 302 到 oa/?state=（非 ?code=），纯 HTTP 无法完成后续 OA code 交换（需浏览器 JS），
            // 故 OA 会话落地交给 completeOaSso 的 BrowserWindow（配合 QR-START 预热消除 -118 冷连接）。
            const fin = await httpJsonWithRedirect(authUrl, sess, 8, 20000)
            debugLog(`[QR-POLL] authnEngine HTTP chain final status=${fin.status} finalUrl=${fin.finalUrl?.split('?')[0]}`)
          } catch (  e: any) {
            debugLog('[QR-POLL] authnEngine chain error: ' + e.message)
          }
          //   第二步：交由 completeOaSso，用隐藏窗口反复 load OA 业务接口，
          //          带着刚种好的 IAM 票据触发 oa↔iam 静默 SSO，建立 OA 会话。
          const r = await completeOaSso(String(loginToken), lck)
          // 落地判定以「真实探测 OA 接口」为权威（修复 1.0.13 回归）：
          // 1.0.13 用「OA 会话 cookie 名出现」当落地信号是错的——cookie 种下≠OA 认可登录，
          // 信任链未打通时 OA 接口仍 901 reauth，放行后查询被 302 踢回 IAM（见 2026-08-26 日志）。
          // 故这里再 probe 一次作为最终判定：ok=true 才真正落地；reauth 必须要求重扫。
          // completeOaSso 的 reason 仅作诊断/前端提示，不决定是否放行。
          let landed = false
          let landReason: 'network' | 'reauth' = r.reason
          const finalProbe = await probeOaSession(sess)
          if (finalProbe.ok) {
            landed = true
          } else if (finalProbe.reason === 'network') {
            // 网络级失败才信任 cookie 兜底（避免网络抖动误踢真登录）
            landed = r.ok
            landReason = r.ok ? 'network' : landReason
          }
          const finalOk = landed
          debugLog(`[QR-POLL] completeOaSso.ok=${r.ok} finalProbe.ok=${finalProbe.ok} reason=${finalProbe.reason} -> landed=${landed}`)
          // 登录后预热 OA 会话：主动访问一次真实 OA 接口，强制完成 SSO 握手落地，
          // 避免用户首次查询时才被 OA 踢去 IAM 重新认证（901），消除“重新登录”体验。
          if (finalOk) {
            try {
              const warmed = await probeOaSession(sess)
              debugLog(`[QR-POLL] OA session warm-up ok=${warmed.ok} reason=${warmed.reason}`)
              if (!warmed.ok) {
                // 预热触发了 reauth（901）——注意 loginToken 一次性，绝不能再次调用 completeOaSso
                // （会重复消费 token → IAM 判定失效 → 重定向 authenticate，反而破坏会话）。
                // 改为仅重新探测：probe 访问 OA 业务接口本身会触发 SSO 握手激活。
                debugLog('[QR-POLL] warm-up hit reauth, re-probe only (no token reuse)')
                await probeOaSession(sess)
              }
            } catch (warmErr: any) {
              debugLog('[QR-POLL] warm-up warning: ' + warmErr.message)
            }
          }
          if (finalOk && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC.OA_CHECK_LOGGED, { loggedIn: true })
          } else if (mainWindow && !mainWindow.isDestroyed()) {
            // SSO 未真正落地：如实通知前端回到扫码界面重试（关闭"正在进入工具"loading），
            // 不再把假登录骗进工具后首次查询才被 901 踢出。带原因：network→网络异常提示。
            debugLog(`[QR-POLL] SSO did not truly land (reason=${landReason}), notify renderer to retry QR login`)
            mainWindow.webContents.send(IPC.OA_CHECK_LOGGED, { loggedIn: false, reason: landReason })
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
  // 登出只清「OA 工具会话」：oa.streamax.com 与 streamax.com 的会话 cookie。
  // 刻意【保留】iam.streamax.com 的 route/SESSION/usk/REQID —— 这些是 IAM SSO 会话，
  // 不清则登出后 IAM 仍是热的，下次刷新二维码 step1 第 1 次就能 200（约 2~5s 出码），
  // 不必重建会话（否则会连续 timeout、拉码耗时 60s+）。
  const all = await sess.cookies.get({})
  for (const c of all) {
    const domain = (c.domain || '').toLowerCase()
    // 只删 OA / streamax 主域；保留 iam.streamax.com IAM 会话
    if (domain.endsWith('oa.streamax.com') || domain.endsWith('streamax.com')) {
      try {
        const url = `${c.secure ? 'https' : 'http'}://${domain.replace(/^\./, '')}${c.path || '/'}`
        await sess.cookies.remove(url, c.name)
      } catch { /* ignore */ }
    }
  }
  // 清掉 OA 工具态相关的本地存储（避免旧页面态干扰），但保留 IAM 会话
  await sess.clearStorageData({
    storages: ['localstorage', 'indexdb', 'cachestorage', 'serviceworkers'],
  }).catch(() => {})
  debugLog('[COOKIE_CLEAR] cleared OA/streamax session cookies, kept IAM session')
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
