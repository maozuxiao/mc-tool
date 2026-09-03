import { app, BrowserWindow, session, ipcMain, shell, dialog, Menu, MenuItem } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join, dirname } from 'path'
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'fs'
import http from 'http'
import https from 'https'
import zlib from 'zlib'
import { OA_LOGIN_URL, OA_ORIGIN } from '@shared/constants'
import { IPC } from '@shared/types'
import { initAutoUpdater, isUpdateDownloaded, startUpdateDownload } from './updater'
import { registerAIIPC } from './ai/aiIpc'
// 使用持久化 partition，让 OA 登录 Cookie 自动写入磁盘并跨启动保留。
// 这是最可靠的方案：Electron 会为每个 persist:* partition 维护独立的
// Cookie/Storage 目录，进程退出后依然保留，无需手动文件备份。
// 定义收敛在 ai/fileDownload.ts（手动下载与 AI 下载共用同一份）。
import { downloadOaBuffer, PARTITION } from './ai/fileDownload'

let mainWindow: BrowserWindow | null = null
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

// 与技能脚本 mc_query.js 共享的 cookie jar：登录成功后导出全量 streamax cookie（含 IAM 票据 usk/REQID），
// 字段对齐 CDP Storage.getCookies（name/value/domain/path/secure/httpOnly/sameSite/expires），
// 使 Electron 登录一次、mc_query.js 直接复用，反之亦然。位置取 ~/.cache/ 与脚本约定一致。
const COOKIE_JAR_PATH = join(app.getPath('home'), '.cache', 'oa-mc-cookies.json')

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

// 与技能脚本 mc_query.js 互通：登录成功后把 partition 内全量 streamax cookie 导出到
// ~/.cache/oa-mc-cookies.json（字段对齐 CDP Storage.getCookies）。Electron 登录一次，脚本直接复用，反之亦然。
// 导出「全量」(含 IAM 票据 usk/REQID)，而非仅 OA cookie——脚本查询 OA 接口同样需要 IAM 票据完成 SSO。
async function exportCookiesToJar(sess: Electron.Session): Promise<void> {
  try {
    const all = await sess.cookies.get({})
    const jar = all
      .filter(c => /streamax\.com$/i.test(c.domain || ''))
      .map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain || '',
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        sameSite: c.sameSite || 'no_restriction',
        expires: c.expirationDate || (Date.now() / 1000 + 30 * 24 * 3600)
      }))
    if (jar.length === 0) return
    const dir = dirname(COOKIE_JAR_PATH)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(COOKIE_JAR_PATH, JSON.stringify(jar, null, 2))
    debugLog(`[jar] exported ${jar.length} streamax cookies to ${COOKIE_JAR_PATH}`)
  } catch (e: any) {
    debugLog('[jar] export error: ' + e.message)
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

  // 拦截窗口内导航：AI 消息里的 Markdown 链接点击后若未处理，会尝试在当前窗口加载 URL，
  // OA 下载/登录页可能让渲染进程白屏。外部链接交给系统浏览器，OA 链接直接阻止。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('http')) {
      event.preventDefault()
      if (!/oa\.streamax\.com|iam\.streamax\.com/i.test(url)) {
        shell.openExternal(url)
      }
    }
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
  registerAIIPC()
  initAutoUpdater(mainWindow!)

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

// 用户点击「下载」后，由主进程真正开始下载。
// 重入保护收敛在 updater.ts 的 startUpdateDownload()：electron-updater 的
// downloadUpdate() 被重复调用会整包重新下载（「进度条满了以后又重新跑一遍」），
// 顶栏「下载」按钮与帮助菜单「立即下载」两条路径都从这里走，重复调用直接短路。
ipcMain.handle(IPC.START_DOWNLOAD, async () => {
  try {
    const alreadyDownloaded = isUpdateDownloaded()
    if (!alreadyDownloaded) await startUpdateDownload()
    return { ok: true, alreadyDownloaded }
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
    const setOne = async (useUrl: string, usePath: string) => {
      try {
        await sess.cookies.set({
          url: useUrl,
          name: name.trim(),
          value,
          domain: domain.startsWith('.') ? domain : undefined,
          path: usePath,
          secure,
          httpOnly,
          sameSite
        })
        return true
      } catch (e: any) {
        return false
      }
    }
    let okSet = await setOne(url, path)
    if (!okSet) okSet = await setOne(`${secure ? 'https' : 'http'}://${host}${path}`, path)
    if (okSet) {
      debugLog(`[COOKIE] set ${name.trim()} for ${host}${portSuffix} path=${path}`)
      // 关键修复(1.0.13 实证 + 日志印证)：IAM 票据(usk/REQID 等)多为 path=/idp，
      // 而 SPA 落地页在 /ac/#/index，浏览器 path 规则下 /ac/ 请求不携带 /idp 的 cookie
      // → SPA 首请求 Cookie contains usk = false → IAM 不认 → OA 弹回 reauth 死循环。
      // 故对 IAM 票据类 cookie，在 set 成功后直接补一份 path='/' 副本（value 取自完整 Set-Cookie 头，
      // 绕开 cookies.get 对 httpOnly cookie 返回空 value 的限制）。仅 IAM 域、仅票据类。
      const isIamTicket = /iam\.streamax\.com$/i.test(domain || '') &&
        /^(usk|REQID|route|SESSION|LTPATOKEN|JSESSIONID)$/i.test(name.trim())
      if (isIamTicket && (path || '/') !== '/') {
        // 用同 host、path=/ 的 url 再 set 一份（value 同源完整），使 /ac/ 等任意路径请求都能带上票据。
        const rootOk = await setOne(`${secure ? 'https' : 'http'}://${host}/`, '/')
        debugLog(`[COOKIE] replicate ${name.trim()} path=${path} -> / ${rootOk ? 'ok' : 'FAIL'}`)
      }
    } else {
      debugLog(`[COOKIE] failed ${name.trim()}: all attempts`)
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
// 主进程 net 模块对 streamax 请求完全正常（QR-START 的 302 链完美），故 SSO 落地全程用纯 HTTP
// （httpPostFollow / httpJsonWithRedirect）完整跟随重定向链，彻底规避 BrowserWindow 渲染进程挂起问题。
function httpJsonWithRedirect(startUrl: string, sess: Electron.Session, maxRedirects = 5, timeoutMs = 15000, stopAtLck = false) {
  return new Promise<{ status: number; headers: any; text: string; finalUrl: string }>((resolve, reject) => {
    const doRequest = async (url: string, redirectCount: number) => {
      if (redirectCount > maxRedirects) return reject(new Error('重定向次数过多'))
      const u = new URL(url)
      const mod = u.protocol === 'https:' ? https : http
      // 关键修复(2026-08-27)：每次重定向跟随都必须带上 partition 内已有的 streamax cookie
      // （尤其 IAM 票据 usk/REQID），否则 IAM 认为未登录 → authnEngine 返回重新认证而非种票据+回跳 OA →
      // OA 全程 reauth。getStreamaxCookieString 从 sess 实时读取（含上一跳 set-cookie 写入的新票据）。
      const cookieStr = await getStreamaxCookieString(sess)
      const req = mod.get({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Connection': 'keep-alive',
          ...(cookieStr ? { 'Cookie': cookieStr } : {})
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

// POST 带 body 并跟随 3xx 重定向（用于 authnEngine 的「确认」调用，SPA 即 POST 此接口 302 回 OA）。
function httpPostFollow(startUrl: string, body: string, sess: Electron.Session, maxRedirects = 5, timeoutMs = 15000) {
  return new Promise<{ status: number; headers: any; text: string; finalUrl: string }>((resolve, reject) => {
    const doRequest = async (url: string, b: string, redirectCount: number) => {
      if (redirectCount > maxRedirects) return reject(new Error('重定向次数过多'))
      const u = new URL(url)
      const mod = u.protocol === 'https:' ? https : http
      const cookieStr = await getStreamaxCookieString(sess)
      const req = mod.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: b ? 'POST' : 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Connection': 'keep-alive',
          ...(cookieStr ? { 'Cookie': cookieStr } : {}),
          ...(b ? { 'Content-Length': Buffer.byteLength(b) } : {})
        }
      }, async (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = new URL(res.headers.location, url).toString()
          debugLog(`[QR-POLL] authnEngine POST redirect ${res.statusCode} -> ${nextUrl}`)
          if (res.headers['set-cookie']) await setCookiesFromHeader(sess, res.headers['set-cookie'])
          res.resume()
          return doRequest(nextUrl, '', redirectCount + 1)
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
      if (b) req.write(b)
      req.end()
    }
    doRequest(startUrl, body, 0)
  })
}

// 纯 HTTP 完成 IAM->OA 的 OAuth 落地（彻底弃用 BrowserWindow：渲染进程在该环境加载 streamax 页面
// 会静默挂起，dom-ready 永不触发，SPA 不执行 JS；而主进程 net 模块对同域请求完全正常）。
// 真实浏览器扫码后落地链（抓包实证）：
//   authExecute(成功, loginToken) → POST authnEngine?loginToken= → 302 → oa/?code=...&state=IAM_OA_SSO
//     → 302 → oa/?state=IAM_OA_SSO → 302 → iam/authenticate?...&redirect_uri=oa&state=IAM_OA_SSO
//     → 302 → iam/ac/#/index?lck=新 → (浏览器加载 SPA → SPA 用新 lck 完成 OAuth 授权 → 回跳 oa/?code=新)
// 关键：IAM 在 authnEngine 302 之后，OA 回跳 iam/authenticate 时若 OAuth state 机完整，IAM 会再 302 回 OA
// 并种下 OA 会话；但若落在 iam/ac/#/index 说明需要 SPA 二次确认。本函数完整跟随 POST authnEngine 的
// 所有 302（cookie 透传已保证 state 机上下文连续），落点稳定在 oa.streamax.com 即成功。
async function landOaViaHttp(sess: Electron.Session, loginToken: string): Promise<{ ok: boolean; finalUrl: string; reason: string }> {
  try {
    // 关键修正(2026-08-28)：先清掉【失效的 OA 业务会话 cookie】，否则 OA 带着隔天残留的
    // 陈旧 SESSION/LtpaToken 既不认（probe 901 reauth）又不肯发新会话，导致 OAuth 落地死循环。
    // 只清 OA 业务域(.oa.streamax.com 的 SESSION/route/j_lang、根域 .streamax.com 的 LtpaToken)，
    // 绝不碰 IAM 域(.iam.streamax.com 的 usk/SESSION/REQID/route)——那是刚扫码建立的 IAM 票据，必须保留。
    const before = await sess.cookies.get({})
    const staleOa = before.filter(c => {
      const d = (c.domain || '').toLowerCase()
      if (d.includes('iam.streamax.com')) return false
      const name = (c.name || '').toUpperCase()
      return (d.includes('oa.streamax.com') || d === '.streamax.com' || d === 'streamax.com') &&
        /SESSION|ROUTE|J_LANG|LTPATOKEN|TOKEN|UID|USER|LOGIN|SSO|OA_/.test(name)
    })
    for (const c of staleOa) {
      // Electron 的 Cookie.domain 是 string | undefined，取值时需要兜底
      try { await sess.cookies.remove(`https://${(c.domain || '').replace(/^\./, '')}${c.path || '/'}`, c.name) } catch {}
    }
    debugLog(`[HTTP-LAND] cleared ${staleOa.length} stale OA session cookies (kept IAM): [${staleOa.map(c => c.name + '@' + c.domain).join(',')}]`)

    const authnUrl = `https://iam.streamax.com/idp/authCenter/authnEngine?loginToken=${encodeURIComponent(loginToken)}&locale=zh-CN`
    debugLog(`[HTTP-LAND] POST authnEngine (loginToken) -> read response body`)
    const r = await httpPostFollow(authnUrl, '', sess, 12, 20000)
    debugLog(`[HTTP-LAND] authnEngine status=${r.status} finalUrl=${r.finalUrl}`)
    debugLog(`[HTTP-LAND] authnEngine bodyHead=${r.text.slice(0, 400).replace(/\s+/g, ' ')}`)

    // authnEngine 是 SPA 内部 XHR：它【不会 302】，而是返回 200 + 响应体，由 SPA 的 JS 解析后
    // 客户端跳转 oa/?code=...&state=...（之前误以为会 302，是错的）。故此处必须自己解析响应体里的 code。
    // 响应体形式（抓包实证）：含 `location = "oa/?code=<授权码>&state=IAM_OA_SSO"` 的 JS，或 JSON 含 code 字段。
    const extractCode = (txt: string): { code?: string; state?: string } => {
      // 优先匹配 JS 跳转里的 oa/?code=...&state=...
      const m1 = txt.match(/oa\?code=([^"'\s&]+)&state=([^"'\s&]+)/i)
      if (m1) return { code: decodeURIComponent(m1[1]), state: decodeURIComponent(m1[2]) }
      const m2 = txt.match(/code=([^"'\s&]+)/i)
      const m3 = txt.match(/state=([^"'\s&]+)/i)
      if (m2) return { code: decodeURIComponent(m2[1]), state: m3 ? decodeURIComponent(m3[1]) : 'IAM_OA_SSO' }
      return {}
    }
    const { code, state } = extractCode(r.text)
    if (!code) {
      debugLog(`[HTTP-LAND] no code found in authnEngine response (IAM did not issue OAuth code) -> fail`)
      return { ok: false, finalUrl: r.finalUrl, reason: 'no-code' }
    }
    debugLog(`[HTTP-LAND] extracted code=${code.slice(0, 12)}... state=${state}`)

    // 用手动 GET oa/?code=&state= 完成 OAuth 落地（这一步才消费 code、由 OA 建会话）。
    // 与浏览器 SPA 执行的 window.location="oa/?code=..." 等价；用 httpJsonWithRedirect 完整跟随 302 链。
    const oaLandingUrl = `http://oa.streamax.com:8080/?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state || 'IAM_OA_SSO')}`
    debugLog(`[HTTP-LAND] GET oa landing ${oaLandingUrl.slice(0, 90)}... -> follow redirects`)
    const r2 = await httpJsonWithRedirect(oaLandingUrl, sess, 12, 20000)
    debugLog(`[HTTP-LAND] oa landing final status=${r2.status} finalUrl=${r2.finalUrl}`)
    if (/^https?:\/\/oa\.streamax\.com/i.test(r2.finalUrl) && r2.status >= 200 && r2.status < 400) {
      return { ok: true, finalUrl: r2.finalUrl, reason: 'landed-oa' }
    }
    // 落点仍在 iam（ac/#/index 或 authenticate）：取 lck 再 GET ac/#/index 触发 SPA 二次 OAuth 授权回跳。
    const mLck = r2.finalUrl.match(/[?&#]lck=(context_oauth2_[a-f0-9]+)/i)
    if (mLck) {
      const newLck = mLck[1]
      debugLog(`[HTTP-LAND] oa-landing bounced to iam lck=${newLck}, GET ac/#/index to finish OAuth`)
      const r3 = await httpJsonWithRedirect(`https://iam.streamax.com/ac/#/index?lck=${newLck}&entityId=oa`, sess, 12, 20000)
      debugLog(`[HTTP-LAND] retry3 final status=${r3.status} finalUrl=${r3.finalUrl}`)
      if (/^https?:\/\/oa\.streamax\.com/i.test(r3.finalUrl) && r3.status >= 200 && r3.status < 400) {
        return { ok: true, finalUrl: r3.finalUrl, reason: 'landed-oa-retry' }
      }
      return { ok: false, finalUrl: r3.finalUrl, reason: 'stuck-iam' }
    }
    return { ok: false, finalUrl: r2.finalUrl, reason: 'stuck-unknown' }
  } catch (e: any) {
    debugLog(`[HTTP-LAND] error: ${e.message}`)
    return { ok: false, finalUrl: '', reason: 'error:' + e.message }
  }
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
    const removed: string[] = []
    for (const c of all) {
      if (/^(route|SESSION|usk|REQID|LTPATOKEN|JSESSIONID)$/i.test(c.name) || c.name.toUpperCase().includes('TOKEN')) {
        const url = `${c.secure ? 'https' : 'http'}://${c.domain?.replace(/^\./, '')}${c.path || '/'}`
        await sess.cookies.remove(url, c.name).catch(() => {})
        removed.push(c.name)
      }
    }
    // 打印实际清除数量与名单：验证时可直接确认「陈旧 IAM 会话是否真的被清掉」。
    // 注意只作用于 iam.streamax.com 域，OA 的 LtpaToken@.streamax.com 不受影响。
    debugLog(`[clearIam] cleared ${removed.length}/${all.length} IAM half-login cookies${removed.length ? ': ' + removed.join(', ') : ''}`)
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
//   1. 必须用 httpPostFollow/httpJsonWithRedirect 跟随 302（落 OA cookie）；
//      BrowserWindow 在该环境加载 streamax 页面会静默挂起（dom-ready 不触发），故全程纯 HTTP。
//   2. loginToken 是一次性的；首轮跟随消费后即可，无需重复 load。
//   3. 跟随完成后 OA 会话可能处于「半建」(票据有了但未激活)，先 probe；若仍 901，
//      再 GET 一次 OA 登录页激活，然后再次 probe 即 200（与 1.0.9 的 warm-up 重试一致）。
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

  // ===== 纯 HTTP 落地（landOaViaHttp）：POST authnEngine 核销 loginToken → 完整跟随 302 链
  // → OA/?code= → OA 消费 code 建会话。loginToken 一次性，仅在此核销一次。无需 BrowserWindow。
  let fastOk = false

  // ===== 纯 HTTP 完成 IAM->OA OAuth 落地（彻底弃用 BrowserWindow，详见 landOaViaHttp 注释）=====
  // 实证(2026-08-27)：ssoWin(BrowserWindow) 在该环境加载 streamax 页面后 dom-ready 永不触发、
  // SPA 文档静默 pending、JS 不执行、零回跳（连 9 轮均卡在 fireOa load 后无 302）。而主进程 net 模块
  // 对同域请求完全正常（QR-START 的 302 链完美）。故改为纯 HTTP 完整跟随 authnEngine 的 302 链完成落地。
  if (!fastOk) {
    try {
      const land = await landOaViaHttp(sess, String(_loginToken))
      debugLog(`[SSO] landOaViaHttp ok=${land.ok} reason=${land.reason} finalUrl=${land.finalUrl}`)
      // 落地判定以「真实探测 OA 接口」为权威（修复 1.0.13 回归：cookie 名出现≠OA 认可登录）。
      const pr = await probeOaSession(sess)
      if (pr.ok) ok = true
      else if (land.ok && pr.reason === 'network') ok = true // 网络抖动时信任 HTTP 落地结果
      else if (land.ok) {
        // HTTP 落地成功但 probe 仍 reauth：再尝一次完整跟随（state 机偶发需二次确认）
        debugLog(`[SSO] HTTP-land ok but probe reauth, retry once`)
        const land2 = await landOaViaHttp(sess, String(_loginToken))
        const pr2 = await probeOaSession(sess)
        ok = pr2.ok || (land2.ok && pr2.reason === 'network')
      }
      if (!ok) failReason = pr.reason === 'network' ? 'network' : 'reauth'
    } catch (e: any) {
      debugLog(`[SSO] landOaViaHttp threw: ${e.message}`)
      failReason = 'reauth'
    }
  } // end if (!fastOk)
  if (!ok) {
    debugLog(`[SSO] OA session did NOT land (failReason=${failReason})`)
  }

  // SSO 落地成功：把 OA 会话 cookie 备份到文件，确保重开 app 可免登录
  if (ok) {
    await backupOaSession(sess)
    // jar 互通：登录成功后导出全量 streamax cookie，供 mc_query.js 技能脚本复用（反之亦然）。
    await exportCookiesToJar(sess)
  }
  // 注意：不在此处发送 OA_CHECK_LOGGED，统一由 QR-POLL 外层根据返回值发送，
  // 避免「内部发一次 + 外层再发一次无 reason」导致 reason 被覆盖、前端重复 re-fetch。
  return { ok, reason: failReason }
}

// 重入锁：避免前端「自动重拉」与「refetchSeq 触发」并发调用导致双开 QR（两个 step1 / 两个 fireOa 争抢同一个 ssoWin，
// 实测会出现并行 QR-START、登录流程互相干扰、OA 握手彻底失败）。并发时第二个 invoke 直接复用第一个进行中的结果。
let qrLoginInFlight: Promise<any> | null = null
ipcMain.handle(IPC.OA_QR_LOGIN_START, () => {
  if (qrLoginInFlight) return qrLoginInFlight
  qrLoginInFlight = (async () => {
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
      // 1.0.22：冷态恢复实测偶需 >40s（次日首登 5 次探针全 timeout），上限延长到 70s 以覆盖更冷的 IAM。
      const probeDeadline = Date.now() + 70 * 1000
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
    if (!lck) {
      // OA 已登录态：访问登录页直接 200、不再 302 去 IAM 要 lck（SESSION cookie 仍热）。
      // 此时不应报错退出，而是用真实探测判定是否真的已登录：已登录则短路返回，让前端直接进工具。
      const onOaHost = /:\/\/oa\.streamax\.com/i.test(finalUrl)
      if (onOaHost && page.status >= 200 && page.status < 400) {
        const probe = await probeOaSession(sess)
        debugLog(`[QR-START] lck empty but landed on OA host, probe ok=${probe.ok} reason=${probe.reason}`)
        if (probe.ok) {
          debugLog('[QR-START] OA already logged in (no lck needed), short-circuit to tool')
          return { success: true, alreadyLoggedIn: true, entityId: 'oa' }
        }
        // probe=reauth：OA 不认可（会话失效），落到下方原错误逻辑，由前端重扫/重登录
      }
      // 卡在 IAM 宿主（onOaHost=false）：诊断日志显示此时 oa.host cookies=0、
      // 而 iam 域仍残留 8 个陈旧 cookie（idle 数小时），属「IAM 半登录态」——
      // 静默 SSO 已被 OA 拒绝（901 reauth），IAM 又不肯发起新授权流程签发 lck，
      // 于是稳定返回 200。这是**确定性**失败：每次重发同样这批陈旧 cookie，
      // IAM 响应必然相同，单纯重试无效（实测 7 次结果完全一致，间隔 5s）。
      // 故先清掉陈旧 IAM 会话，让 IAM 视我们为新客户端；配合 retryable，
      // 下一次重试即以干净会话取码。仅在失败点清理，不动「热 IAM」的正常快路径。
      await clearIamHalfLoginCookies(sess)
      // friendly 是重试耗尽后的终态文案（重试中的提示由前端按 reason 自行渲染），
      // 故此处写终态语气，不再写「正在重试」。
      const lckErr: any = new Error('未能从登录页获取 lck 上下文参数（IAM 半登录态，已清理陈旧会话待重试）')
      lckErr.reason = 'retryable'
      lckErr.friendly = '登录服务未就绪，请稍后重试'
      throw lckErr
    }

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
    // 区分网络类错误（step1 timeout / IAM 不可达）与业务逻辑错误，
    // 前端据此显示「网络异常」提示而非原始技术栈信息。
    const isNet = /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ERR_CONNECTION|TIMED_OUT|ENOTFOUND|getaddrinfo/i.test(err.message || '')
    const reason = err.reason || (isNet ? 'network' : 'server')
    const message = err.friendly || (isNet ? '网络异常，请检查网络或稍后重试' : (err.message || '获取二维码失败'))
    return { success: false, reason, message }
  } finally {
    qrLoginInFlight = null
  }
  })()
  return qrLoginInFlight
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
          // 关键修正(18:19 实证)：loginToken 是一次性的，authnEngine 一旦消费就失效。
          // 若 QR-POLL 先手动 authnEngine?loginToken= 种 usk，则下游 SPA 再用同一 loginToken 调
          // authnEngine 时令牌已失效 → SPA 零 XHR、不回跳（18:19 实证）。
          // 正确路径(15:46 成功实证)：【主进程不消费 loginToken】，把完整 loginToken 交给 SPA；
          // SPA 加载 ac/#/index?lck=&loginToken= 时，其 JS 自行调 authnEngine 完成「确认」，
          // 此时 IAM 在响应里 Set-Cookie 下发 usk，并回跳 OA(?code=) 建会话。usk 由 SPA 自己种，无需主进程前置。
          debugLog('[QR-POLL] hand loginToken to SPA (no premature authnEngine consume)')
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
          // 没有 loginToken 就无法完成 SSO，如实告知前端回到扫码重试，
          // 否则前端会一直停在「等待扫码」的半途状态。
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC.OA_CHECK_LOGGED, { loggedIn: false, reason: 'reauth' })
          }
        }
      } catch (finishErr: any) {
        debugLog('[QR-POLL] SSO finish warning: ' + finishErr.message)
        // 兜底（关键）：completeOaSso 一进来就会发 OA_LOGIN_LANDING，
        // 渲染层随即盖一层全屏「正在进入工具…」遮罩。这里若吞掉异常而不发结束事件，
        // 遮罩就永远不消失——整个界面无法输入，只能重启应用。
        // 这正是偶发「全局不能输入」的根因（例如 finalProbe 抛异常时）。
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.OA_CHECK_LOGGED, { loggedIn: false, reason: 'reauth' })
        }
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
  try {
    // 复用与 AI file_download 相同的下载核心：自动带 OA 登录态、识别会话失效、跟随重定向
    const buf: Buffer = await downloadOaBuffer(url)

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

// 渲染层提示框统一走这里，不要用 window.alert / window.confirm：
// 那两个是同步阻塞渲染进程的，弹窗若被主窗口挡住（或用户没留意到），
// 整个界面会表现为「全局无法输入」，只能重启应用才恢复。
// showMessageBox 由主进程弹出、正确挂在 mainWindow 上，且不阻塞渲染进程。
// 按钮 / 标题随界面语言：渲染层启动与切换语言时经 setUiLang 同步过来；
// 未同步前按系统语言兜底（中文系统给中文按钮，其余给英文）。
let uiLang: '' | 'zh' | 'en' = ''
ipcMain.on('dialog:setLang', (_e, lang: string) => {
  uiLang = lang === 'en' ? 'en' : 'zh'
})
function dialogLang(): { title: string; ok: string; cancel: string } {
  const lang = uiLang
    || (app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en')
  return lang === 'en'
    ? { title: 'MC Material Query', ok: 'OK', cancel: 'Cancel' }
    : { title: 'MC物料查询', ok: '确定', cancel: '取消' }
}
ipcMain.handle('dialog:message', async (_e, opts: {
  message?: string
  title?: string
  type?: 'none' | 'info' | 'error' | 'warning' | 'question'
}) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const L = dialogLang()
  await dialog.showMessageBox(mainWindow, {
    type: opts?.type || 'info',
    title: opts?.title || L.title,
    message: String(opts?.message ?? ''),
    buttons: [L.ok],
    defaultId: 0,
    cancelId: 0
  })
})

ipcMain.handle('dialog:confirm', async (_e, opts: { message?: string; title?: string }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const L = dialogLang()
  const res = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: opts?.title || L.title,
    message: String(opts?.message ?? ''),
    buttons: [L.cancel, L.ok],
    defaultId: 1,
    cancelId: 0
  })
  return res.response === 1
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
