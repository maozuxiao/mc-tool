import { app, BrowserWindow, session } from 'electron'
import { appendFileSync } from 'fs'
import { join } from 'path'
import { PARTITION, downloadToDir, type DownloadToDirResult } from './fileDownload'
import type { AIExtraRoot } from '@shared/ai-types'

/**
 * 鸿翼文件系统（edoc2 企业内容库）查询与下载 —— 应用内置技能的执行层（1.0.43）。
 *
 * 请求通道（1.0.43 定稿，**必须走页面上下文**）：
 * 原技能包靠 `agent-browser`（外部 Chrome + CDP）打开 `wj.streamax.com:9443`、登录后在页面上下文
 * eval fetch。它本身不适合本应用（不该再让用户扫一次码、也不该为一个技能去分发 CLI），
 * 但它揭示了一个必须照做的关键点：**同一个登录态、同一个 WebCore 接口、同样的表单参数，
 * 主进程 `session.fetch` 只能拿到「HTTP 200 + FilesInfo 恒为空」，而页面上下文 fetch 直接命中真实数据**
 * （实测同一关键词：前者恒 0 条，后者 50 条，并能下载到原始文件）。差别在**请求的发起者** ——
 * 站点把 WebClient 模块的会话上下文绑在页面里（SPA 跑完 GetSystemInitStatus → GetCurrentUser 之后才成立），
 * 非浏览器上下文根本不参与这套绑定。
 * 因此这里用**应用自己的隐藏窗口**（见 ensureCtxWin）当页面宿主：先把它导航到站点首页、让站点自己的 JS
 * 完成握手，之后所有 WebCore 调用都用 `executeJavaScript` 在该页面的上下文里 `fetch(...)` ——
 * 等于「用站点自己的 JS 去问它自己的后端」。Cookie 依然只存在于 `persist:mc-query` 分区，不出主进程，
 * 与既有 file_download / mc_query 的鉴权哲学一致；页面上下文不可用时才降级到 `session.fetch`（见 mainFetch）。
 *
 * API 契约来自原技能包的 references/api_reference.md：
 * - 搜索：POST /WebCore（module=WebClient、fun=GetMapSearchResultList）
 * - 取下载地址：GET /Preview/GetPreviewPara（响应 data.fileUrl）
 * - DOC/DOCX 返回的是 GetConversionFile（转码预览件），改成 GetOriginFile 即得**原始文件**
 * - Referer 必须是 `.../preview.html`，否则服务端返回 `request invalid!`
 * - nResult=601 / HTTP 401 = 登录态失效
 * - **未登录时服务端不是返回 401，而是 302 到 SSO 登录页**（实测
 *   `Location: /https://wj.streamax.com:9443/sso/auth/goToLoginPage?returnUrl=%2FWebCore`）；
 *   1.0.43 修：此前跟随重定向后拿到一整页登录 HTML，JSON.parse 失败就笼统报
 *   `WJXT_BAD_RESPONSE`，把排查方向带偏成「服务端抖动」。现按「最终 URL + content-type」
 *   判定是否落到了登录页。
 *   注：`session.fetch` **不支持** `redirect: 'manual'` —— Chromium 会把 3xx 直接取消成
 *   请求错误（`Redirect was cancelled`），拿不到响应头，因此必须用默认的跟随重定向。
 */

export const WJXT_ORIGIN = 'https://wj.streamax.com:9443'
/**
 * 会话缺失时给用户登录的入口：应用内窗口打开，会话落在同一个 persist:mc-query 分区。
 * 用 `/index.html` 而不是根路径 —— 站点 SPA 的启动逻辑（GetCurrentUser）跑起来后，
 * 若未登录会**由站点自己**跳 `sso/auth/goToLoginPage`，走完它才算真正登录成功。
 */
export const WJXT_LOGIN_URL = `${WJXT_ORIGIN}/index.html`

/**
 * SSO 登录页直链。实测该页面（约 1.2KB 的 HTML）**不会自动完成登录** ——
 * 分区里即便有 SSO 票（LtpaToken / checkToken）也照样返回 ErrorCode4，
 * 也就是首次必须**人工在这个页面扫码一次**（工具无法代扫）。
 * 所以给用户开的窗口直接落在这里，让他一眼看到登录界面，而不是先看一屏空白/首页。
 */
export const WJXT_SSO_LOGIN_URL =
  `${WJXT_ORIGIN}/sso/auth/goToLoginPage?returnUrl=${encodeURIComponent('/index.html')}`
const WJXT_REFERER = `${WJXT_ORIGIN}/preview.html`
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const DEFAULT_TIMEOUT_MS = 30000
/** 单次搜索最多返回条数（服务端是 ES 分页，给太大没意义还慢） */
const MAX_SEARCH_SIZE = 50

/** 诊断日志：写 userData/wjxt.log（与 index.ts 的 debugLog 同一套路，便于事后取回） */
function wjxtLog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { appendFileSync(join(app.getPath('userData'), 'wjxt.log'), line) } catch { /* ignore */ }
  console.log('[wjxt] ' + msg)
}

/**
 * 「应用内开窗」能力由 index.ts 注入（见 setWjxtLoginOpener）。
 * 会话缺失/失效时用它弹一次登录窗口 —— 窗口与工具请求共用 persist:mc-query 分区，
 * 用户登录一次后工具侧立刻可用（系统浏览器与本应用不共享登录态，所以不能交出去）。
 */
let openLoginWindow: ((url: string) => void) | null = null
export function setWjxtLoginOpener(fn: ((url: string) => void) | null): void {
  openLoginWindow = fn
}

/**
 * 「隐藏窗口预热」能力由 index.ts 注入（见 setWjxtBootstrap）。
 * 该站点的 SSO 换票依赖 **SPA 自己的 JS 流程**：实测应用内窗口一加载就自动登录成功，
 * 而主进程裸 fetch（即便带上分区里的 SSO 票）换不到 edoc2 会话。
 * 因此这里用**不显示**的窗口把首页跑一遍 —— 成功则全程无弹窗，失败才弹可见的登录窗口。
 */
let bootstrapHiddenWindow: ((url: string, settleMs?: number) => Promise<boolean>) | null = null
export function setWjxtBootstrap(fn: ((url: string, settleMs?: number) => Promise<boolean>) | null): void {
  bootstrapHiddenWindow = fn
}

/** 关掉应用内登录窗口（登录成功后自动关）—— 同样由 index.ts 注入 */
let closeLoginWindow: ((url: string) => void) | null = null
export function setWjxtLoginCloser(fn: ((url: string) => void) | null): void {
  closeLoginWindow = fn
}

export interface WjxtFileInfo {
  /** ES 文档 id（DownLoadCheck 用） */
  id: string
  /** 文件 GUID（GetPreviewPara 用） */
  fileGuid: string
  name: string
  extName: string
  /** 原始文件字节数（下载后用于校验） */
  size: number
  parentFolderId?: string
  lastVerId?: string
  /** 目录路径（edoc2 用的是数字目录 id 串，如 "1\913\921\"） */
  path?: string
  /**
   * **真实目录路径名**（服务端返回的 relativePath，形如 `企业文档库/AD PLUS 2.0/版本发布`）。
   * 上游「增强搜索」脚本就是用它显示路径的；优先拿它做展示，`path` 只在它缺失时兜底。
   */
  relativePath?: string
  /** 修改时间：服务端给的是 `/Date(毫秒+时区)/`，对外统一转成可读时间 */
  modifyTime?: string
  createTime?: string
  creatorName?: string
  editorName?: string
  /** 版本号（如 "2.4.6"），判断「哪个版本最新」时比文件名可靠 */
  lastVerNumStr?: string
}

/** 把 edoc2 的 `/Date(1762566185319+0800)/` 转成可读的本地时间 `YYYY-MM-DD HH:mm` */
function parseEdoc2Date(v: any): string {
  if (v === undefined || v === null || v === '') return ''
  const raw = String(v)
  const m = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(raw)
  if (!m) return raw
  const ms = Number(m[1])
  if (!Number.isFinite(ms)) return raw
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 关键词匹配模式（对齐上游增强搜索脚本：word 分词 / contains 子串 / exact 整串） */
export type WjxtMatchMode = 'word' | 'contains' | 'exact'
/** 排序键（对齐上游增强搜索脚本：score / time / size / name） */
export type WjxtSort = 'score' | 'time' | 'size' | 'name'

interface WjxtResponse {
  status: number
  body: string
  /** 跟随重定向之后的最终 URL（落到登录页时会带 goToLoginPage / sso 路径） */
  finalUrl: string
  contentType: string
  /** 本次请求实际带上的分区 cookie 数（只记数量，不记内容） */
  cookieCount: number
}

/** 最终落点是不是 SSO 登录页（goToLoginPage / sso/auth / login） */
function isLoginUrl(u: string): boolean {
  return /goToLoginPage|\/sso\/|\/login\b/i.test(u)
}

/** 该 URL 在分区里的 cookie 名字清单（**只记名字、不记值**，仅用于日志定位） */
async function cookieNamesFor(url: string): Promise<{ count: number; names: string }> {
  try {
    const cookies = await session.fromPartition(PARTITION).cookies.get({ url })
    return { count: cookies.length, names: cookies.map(c => c.name).join(',') }
  } catch {
    return { count: 0, names: '' }
  }
}

// ── 页面上下文（隐藏窗口）─────────────────────────────────────────────────────────────
/**
 * 常驻的隐藏窗口：站点首页的宿主。所有 WebCore 请求都在它的页面上下文里发起。
 *
 * 生命周期：第一次用到时创建并导航到 `/index.html`（站点自己的 SPA 会跑
 * GetSystemInitStatus → GetCurrentUser 完成会话绑定），之后**一直复用**；
 * 窗口崩溃 / eval 报 `Failed to fetch` / 超时 → `destroyCtxWin()` 丢掉，下次自动重建。
 * 登录成功后由 `reloadCtxWin()` 重新导航一次，让页面把新会话重新绑定（原技能包对 404 的处置
 * 「重新导航一次首页」正是这个动作）。
 */
let ctxWin: BrowserWindow | null = null
let ctxLoading: Promise<void> | null = null

function destroyCtxWin(): void {
  const win = ctxWin
  ctxWin = null
  ctxLoading = null
  if (win && !win.isDestroyed()) {
    try { win.destroy() } catch { /* 已销毁则忽略 */ }
  }
}

// 退出时收掉隐藏窗口，别留下游离的渲染进程
app.on('will-quit', () => destroyCtxWin())

/** 创建（或复用）隐藏窗口，并等站点首页加载完成。返回 false = 页面上下文不可用。 */
async function ensureCtxWin(timeoutMs = 25000): Promise<boolean> {
  if (ctxWin && !ctxWin.isDestroyed()) return true
  if (!ctxLoading) {
    ctxLoading = (async () => {
      const win = new BrowserWindow({
        show: false,
        skipTaskbar: true,
        width: 1280,
        height: 800,
        webPreferences: {
          partition: PARTITION,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          // 关掉后台节流：窗口不可见时 Chromium 会降频定时器，站点的异步握手可能被拖慢
          backgroundThrottling: false
        }
      })
      ctxWin = win
      win.on('closed', () => { if (ctxWin === win) { ctxWin = null; ctxLoading = null } })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('load timeout')), timeoutMs)
        win.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve() })
        win.webContents.once('did-fail-load', (_e, code, desc) => {
          clearTimeout(timer)
          reject(new Error(`did-fail-load ${code} ${desc}`))
        })
        // 与可见登录窗口同一个入口：/index.html（未登录时站点自己会跳 SSO）
        void win.loadURL(WJXT_LOGIN_URL)
      })
      // 站点首页的握手（SystemManager/GetSystemInitStatus → WebClient/GetCurrentUser）是异步的，
      // 给页面一点时间把它跑完；随后由 readJson 按站点判据复核登录态，这里只求「别抢跑」。
      await new Promise(r => setTimeout(r, 1200))
      wjxtLog(`[page] hidden context ready url=${win.webContents.getURL().slice(0, 160)}`)
    })().catch((e: any) => {
      wjxtLog('[page] hidden context load failed: ' + String(e?.message || e))
      destroyCtxWin()
    }).finally(() => { ctxLoading = null })
  }
  await ctxLoading
  return !!ctxWin && !ctxWin.isDestroyed()
}

/** 重新导航隐藏窗口（登录成功 / 404 自愈时用：让页面用新会话重新绑定一次上下文） */
async function reloadCtxWin(): Promise<void> {
  const win = ctxWin
  if (!win || win.isDestroyed()) { await ensureCtxWin(); return }
  try {
    await win.webContents.reload()
    await new Promise(r => setTimeout(r, 1200))
    wjxtLog('[page] hidden context reloaded')
  } catch (e: any) {
    wjxtLog('[page] reload failed: ' + String(e?.message || e) + ' -> rebuild')
    destroyCtxWin()
    await ensureCtxWin()
  }
}

/**
 * 在页面上下文里发一次请求（唯一被验证能拿到数据的通道）。
 * 返回 null = 页面上下文不可用 / eval 失败 —— 调用方降级到 mainFetch，而不是把它当成业务结论。
 */
async function pageFetch(
  path: string,
  opts: { method?: string; form?: string; timeoutMs?: number } = {}
): Promise<WjxtResponse | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!(await ensureCtxWin(Math.min(timeoutMs, 25000)))) return null
  const win = ctxWin
  if (!win || win.isDestroyed()) return null

  const url = new URL(path, WJXT_ORIGIN).toString()
  const headers: Record<string, string> = {
    // 站点自己的 jQuery ajax（dataType: json，同源 XHR）带的就是这些
    'Accept': opts.form ? 'application/json, text/javascript, */*; q=0.01' : '*/*',
    'X-Requested-With': 'XMLHttpRequest'
  }
  if (opts.form) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'

  // 用页面里原生的 fetch（相对/绝对 URL 皆可，自动带分区 cookie、走 Chromium 网络栈，
  // 并参与站点自己的会话上下文）。整个脚本自带 try/catch，失败时把错误当数据回传，
  // 避免 executeJavaScript 直接 reject 而丢掉原因。
  const script = `(async () => {
  try {
    const opt = { method: ${JSON.stringify(opts.method || 'GET')}, credentials: 'include', headers: ${JSON.stringify(headers)} };
    ${opts.form ? `opt.body = ${JSON.stringify(opts.form)};` : ''}
    const r = await fetch(${JSON.stringify(url)}, opt);
    const t = await r.text();
    return JSON.stringify({ status: r.status, url: r.url, ct: r.headers.get('content-type') || '', body: t });
  } catch (e) {
    return JSON.stringify({ error: String((e && e.message) || e) });
  }
})()`

  let raw: any
  // 自有超时（页面上下文卡住时不能拖住整次工具调用）；结束务必清掉定时器，别让主进程留着游离计时器
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    raw = await Promise.race([
      win.webContents.executeJavaScript(script, true),
      new Promise((_res, rej) => { timer = setTimeout(() => rej(new Error('WJXT_PAGE_TIMEOUT')), timeoutMs) })
    ])
  } catch (e: any) {
    // 超时与「页面崩了」都按「上下文不可用」处理：丢掉窗口，下次重建；本次交给降级通道
    wjxtLog(`[page] executeJavaScript failed (${String(e?.message || e)}) -> drop hidden context`)
    destroyCtxWin()
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (raw === undefined || raw === null) {
    wjxtLog('[page] empty eval result -> drop hidden context')
    destroyCtxWin()
    return null
  }
  let parsed: any
  try { parsed = JSON.parse(String(raw)) } catch {
    wjxtLog('[page] eval result not JSON: ' + String(raw).slice(0, 200))
    destroyCtxWin()
    return null
  }
  if (parsed?.error) {
    const msg = String(parsed.error)
    wjxtLog(`[page] fetch ${path} failed: ${msg}`)
    // 上下文坏了（Failed to fetch / Load failed）→ 丢窗口重建；这类失败不是业务结论，交给降级通道
    if (/failed to fetch|networkerror|load failed|err_/i.test(msg)) { destroyCtxWin(); return null }
    return null
  }
  const { count, names } = await cookieNamesFor(url)
  wjxtLog(`[page] ${opts.method || 'GET'} ${url} status=${parsed.status} final=${String(parsed.url).slice(0, 200)} ct=${parsed.ct} len=${String(parsed.body).length} cookies=${count} names=${names}`)
  return {
    status: Number(parsed.status) || 0,
    body: String(parsed.body ?? ''),
    finalUrl: String(parsed.url || url),
    contentType: String(parsed.ct || ''),
    cookieCount: count
  }
}

/**
 * 降级通道：主进程 `session.fetch`（**拿不到搜索结果**，仅保证仍能给出明确的登录态/HTTP 结论）。
 *
 * 保留它的意义：页面上下文起不来（隐藏窗口加载失败、内网抖动）时，用户至少能得到
 * 「要重新登录 / 服务端 404 / 超时」这类可执行结论，而不是一句「未知错误」。
 * 注意它带的是**显式拼的 Cookie 头**：`session.fetch` 是非浏览器上下文，对 SameSite=Strict/Lax
 * 的 cookie 不保证自动附加（与 index.ts 里 OA 窗口 ensureOaCookieInjector 同一套做法）。
 * `redirect: 'manual'` 不能用 —— Chromium 会把 3xx 直接取消成 `Redirect was cancelled`，
 * 因此跟随重定向，用 readJson 的「最终 URL + content-type」判据识别登录页。
 */
async function mainFetch(
  path: string,
  opts: { method?: string; form?: string; timeoutMs?: number } = {}
): Promise<WjxtResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const sess = session.fromPartition(PARTITION)
  const url = new URL(path, WJXT_ORIGIN).toString()
  const headers: Record<string, string> = {
    'User-Agent': UA,
    'Accept': opts.form ? 'application/json, text/javascript, */*; q=0.01' : '*/*',
    'Referer': WJXT_REFERER,
    'X-Requested-With': 'XMLHttpRequest'
  }
  if (opts.form) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
  const { count: cookieCount, names: cookieNames } = await cookieNamesFor(url)
  if (cookieCount) {
    const cookies = await sess.cookies.get({ url })
    headers['Cookie'] = cookies.map(c => `${c.name}=${c.value}`).join('; ')
  }

  const res = await sess.fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.form,
    // AbortSignal.timeout 在 Electron 33（Chromium 130）可用；超时即中断，不让工具卡死
    signal: AbortSignal.timeout(timeoutMs)
  } as any)
  const body = await res.text()
  const finalUrl = String(res.url || url)
  const contentType = String(res.headers.get('content-type') || '')
  wjxtLog(`[main] ${opts.method || 'GET'} ${url} status=${res.status} final=${finalUrl.slice(0, 200)} ct=${contentType} len=${body.length} cookies=${cookieCount} names=${cookieNames}`)
  return { status: res.status, body, finalUrl, contentType, cookieCount }
}

/**
 * 发一次 WebCore/Preview 请求：**优先页面上下文**，不可用时降级到主进程 fetch。
 * 两条通道的返回结构一致，readJson 的判读逻辑对二者通用。
 */
async function wjxtRequest(
  path: string,
  opts: { method?: string; form?: string; timeoutMs?: number } = {}
): Promise<WjxtResponse> {
  const viaPage = await pageFetch(path, opts)
  if (viaPage) return viaPage
  const viaMain = await mainFetch(path, opts)
  // 降级通道拿到空结果时特别标注一次：这正是「主进程 fetch 拿不到数据」的现场
  if (/GetMapSearchResultList/.test(opts.form || '')) {
    wjxtLog('[fallback] search went through main-process fetch —— 该通道实测恒为空结果，若返回 0 条属预期')
  }
  return viaMain
}

/** 进程内是否已做过一次会话预热 */
let warmedUp = false
/** 最近一次预热的登录结论（含时间），用于避免「同一次失败里重复跑一遍无打扰自愈」 */
let warmupVerdict: { at: number; loggedIn: boolean | null } = { at: 0, loggedIn: null }
/** 是否已经把「结果行的字段名」记过一次日志（进程内一次，用于确认 relativePath 存在） */
let loggedRowKeys = false

/** 分区里的 `token` cookie（站点会把它带给 GetCurrentUser，值只在内存里流转） */
async function getWjxtTokenCookie(): Promise<string> {
  try {
    const ck = await session.fromPartition(PARTITION).cookies.get({ url: WJXT_ORIGIN + '/', name: 'token' })
    return String(ck?.[0]?.value || '')
  } catch {
    return ''
  }
}

/**
 * 按站点自己的判据探测「当前用户」：true=已登录，false=未登录，null=探测失败。
 * 判据来自 `/scripts/app/main.js` 的 `$.ajaxSetup.dataFilter`：
 * 正文里出现 `errorCode`（ErrorCode4）或 `url` 指向登录页 → 未登录。
 */
async function probeLoggedIn(): Promise<boolean | null> {
  try {
    const token = await getWjxtTokenCookie()
    const params: Record<string, string> = { module: 'WebClient', fun: 'GetCurrentUser' }
    if (token) params.token = token
    const res = await wjxtRequest('/WebCore', {
      method: 'POST',
      form: new URLSearchParams(params).toString(),
      timeoutMs: 20000
    })
    const notLogged = /"errorCode"\s*:/.test(res.body) || /goToLoginPage/.test(res.body)
    return !notLogged
  } catch (e: any) {
    wjxtLog('[probe] GetCurrentUser failed: ' + String(e?.message || e))
    return null
  }
}

/**
 * 打开登录窗口后的轮询：**登录成功就自动关窗**（用户扫完码不用自己找关闭按钮），
 * 并把 warmedUp 复位，让下一次搜索重新预热（那时会直接确认「已登录」然后干活）。
 * 3 分钟没等到就停（不无限轮询）。
 */
let loginWatchTimer: ReturnType<typeof setInterval> | null = null
function watchLoginUntilDone(): void {
  if (loginWatchTimer) return
  let tries = 0
  loginWatchTimer = setInterval(() => {
    void (async () => {
      tries++
      const ok = await probeLoggedIn()
      if (ok === true) {
        if (loginWatchTimer) { clearInterval(loginWatchTimer); loginWatchTimer = null }
        wjxtLog(`[loginWatch] session established after ${tries} polls -> auto-close login window`)
        try { closeLoginWindow?.(WJXT_SSO_LOGIN_URL) } catch { /* ignore */ }
        warmedUp = false
        // 隐藏窗口里的页面还是「登录前」那份上下文：重新导航一次让它用新会话重新绑定
        void reloadCtxWin()
      } else if (tries >= 90) {
        if (loginWatchTimer) { clearInterval(loginWatchTimer); loginWatchTimer = null }
        wjxtLog('[loginWatch] give up after 3 minutes (still not logged in)')
      }
    })()
  }, 2000)
}

/**
 * 会话预热：按站点前端自己的启动序列走一遍（源码见 `https://wj.streamax.com:9443/scripts/app/main.js`）。
 *
 * 为什么需要：实测带分区 cookie 直接 POST `/WebCore` 业务接口会拿到 **404 + 空 body**，
 * 而**不是**登录态问题（没登录时是 302 到 SSO 登录页，两者形态完全不同）。站点前端的启动序列是：
 *   ① `POST WebCore {module:"SystemManager", fun:"GetSystemInitStatus"}`
 *   ② `POST WebCore {module:"WebClient",   fun:"GetCurrentUser"}`  ← 绑定 WebClient 模块的会话上下文
 *   ③ 之后才发业务请求（它的 `$.ajaxSetup` 里还专门把 404 静默掉：`statusCode:{404:function(){}}`）
 * 原技能包对这一形态的处置是「重新导航一次首页」（见 references/notes.md 排查清单第 5 条）——
 * 本质就是补上①②。因此这里先 GET 一次首页，再把这两个握手打一遍。
 *
 * 全链路 best-effort：任何一步失败都只记日志、不抛异常 —— 预热失败不等于查询失败，
 * 让真正的业务请求去报错，免得把「首页打不开」误报成「搜索失败」。
 */
async function wjxtWarmUp(force = false): Promise<void> {
  if (warmedUp && !force) return
  warmedUp = true

  // ① 页面上下文本身就是最好的预热：隐藏窗口加载站点首页时，SPA 自己就把启动序列跑完了
  //    （SystemManager/GetSystemInitStatus → WebClient/GetCurrentUser）。
  //    force=true（登录刚完成 / 遇到 404）时**重新导航一次**，让页面用新会话重新绑定上下文 ——
  //    原技能包对这一形态的处置「重新导航一次首页」正是这个动作。
  const ready = await ensureCtxWin(25000)
  wjxtLog(`[warmup] hidden page context ready=${ready}`)
  if (ready && force) await reloadCtxWin()
  if (!ready) {
    // 页面上下文起不来（窗口加载失败）：用降级通道至少把首页打一次，日志里留下证据
    try {
      const page = await mainFetch('/index.html', { timeoutMs: 20000 })
      wjxtLog(`[warmup] fallback GET /index.html status=${page.status} ct=${page.contentType} len=${page.body.length}`)
    } catch (e: any) {
      wjxtLog('[warmup] fallback GET /index.html failed: ' + String(e?.message || e))
    }
  }

  // 站点会从 URL query 或 `token` cookie 里取 token 传给 GetCurrentUser
  const token = await getWjxtTokenCookie()

  let loggedIn: boolean | null = null
  for (const [module, fun] of [['SystemManager', 'GetSystemInitStatus'], ['WebClient', 'GetCurrentUser']] as const) {
    try {
      const params: Record<string, string> = { module, fun }
      if (fun === 'GetCurrentUser' && token) params.token = token
      const res = await wjxtRequest('/WebCore', {
        method: 'POST',
        form: new URLSearchParams(params).toString(),
        timeoutMs: 20000
      })
      // 站点判据（main.js 的 dataFilter）：正文里出现 errorCode 或 url 指向登录页 = 未登录
      const notLogged = /"errorCode"\s*:/.test(res.body) || /goToLoginPage/.test(res.body)
      if (fun === 'GetCurrentUser') loggedIn = !notLogged
      wjxtLog(`[warmup] POST ${fun} status=${res.status} ct=${res.contentType} len=${res.body.length} loggedIn=${fun === 'GetCurrentUser' ? loggedIn : '-'} body=${JSON.stringify(res.body.slice(0, 140))}`)
    } catch (e: any) {
      wjxtLog(`[warmup] POST ${fun} failed: ${String(e?.message || e)}`)
    }
  }

  // 未登录时的**无打扰自愈**（都不弹窗，只有全部失败才由上层弹可见登录窗口）
  if (loggedIn === false) {
    const recheck = async (tag: string): Promise<boolean | null> => {
      const ok = await probeLoggedIn()
      wjxtLog(`[warmup] ${tag} loggedIn=${ok}`)
      return ok
    }

    // ① 静默 SSO：直接访问站点自己的登录入口并跟随重定向，
    //    分区里已有的 SSO 票（LtpaToken / checkToken）可能顺路换回 edoc2 会话
    try {
      const r = await wjxtRequest(`/sso/auth/goToLoginPage?returnUrl=${encodeURIComponent('/index.html')}`, { timeoutMs: 20000 })
      wjxtLog(`[warmup] silent sso status=${r.status} final=${r.finalUrl.slice(0, 180)} ct=${r.contentType} len=${r.body.length} cookies=${r.cookieCount}`)
    } catch (e: any) {
      wjxtLog('[warmup] silent sso failed: ' + String(e?.message || e))
    }
    loggedIn = await recheck('recheck#1')

    // ② 隐藏窗口预热：SSO 换票靠 SPA 自己的 JS 流程（可见窗口能成、裸 fetch 不成），
    //    所以再开一个**不显示**的窗口把首页跑一遍；成功则用户全程看不到窗口
    if (loggedIn === false && bootstrapHiddenWindow) {
      try {
        const ok = await bootstrapHiddenWindow(WJXT_LOGIN_URL, 2500)
        wjxtLog(`[warmup] hidden bootstrap ok=${ok}`)
      } catch (e: any) {
        wjxtLog('[warmup] hidden bootstrap failed: ' + String(e?.message || e))
      }
      loggedIn = await recheck('recheck#2')
    }

    if (loggedIn === false) {
      wjxtLog('[warmup] still not logged in after silent attempts -> 需要用户手动登录（搜索会报 WJXT_NO_SESSION）')
    }
  }
  warmupVerdict = { at: Date.now(), loggedIn }
}

/**
 * 把响应判读成 JSON；不可用时抛出**带语义的错误码**（供上层翻译成给用户/模型的提示）。
 * 重点是把「落到登录页/页面」与「服务端真异常」区分开 —— 二者处置完全不同。
 */
function readJson(res: WjxtResponse, what: string): any {
  if (res.status === 401 || res.status === 403) throw new Error('NEED_RELOGIN')
  if (/^\s*request invalid!/i.test(res.body)) {
    // 这条其实是 Referer 不对，但对我们来说同样是「不可用」
    throw new Error('WJXT_BAD_REQUEST')
  }
  const m = /"nResult"\s*:\s*(-?\d+)/.exec(res.body)
  if (m && m[1] === '601') throw new Error('NEED_RELOGIN')
  // 最终落点是 SSO 登录页 = 未登录 / 会话过期（服务端对未登录请求是 302 到登录页，不是 401）
  if (isLoginUrl(res.finalUrl)) {
    wjxtLog(`[${what}] redirected to login page: ${res.finalUrl.slice(0, 200)} cookies=${res.cookieCount}`)
    throw new Error(res.cookieCount === 0 ? 'WJXT_NO_SESSION' : 'NEED_RELOGIN')
  }
  const looksHtml = /text\/html/i.test(res.contentType) || /^\s*(<!doctype|<html|<\?xml)/i.test(res.body)
  if (looksHtml) {
    // 兜底：落点是 HTML 页面而不是接口（登录页 URL 形态变化时也能兜住）
    wjxtLog(`[${what}] got html page (not api): status=${res.status} ct=${res.contentType} final=${res.finalUrl.slice(0, 200)} cookies=${res.cookieCount}`)
    throw new Error(res.cookieCount === 0 ? 'WJXT_NO_SESSION' : 'NEED_RELOGIN')
  }
  if (res.status === 404) throw new Error('WJXT_HTTP_404')
  if (res.status >= 500) throw new Error('WJXT_HTTP_' + res.status)
  let json: any
  try {
    json = JSON.parse(res.body)
  } catch {
    throw new Error(`WJXT_BAD_RESPONSE: status=${res.status} ct=${res.contentType} final=${res.finalUrl.slice(0, 120)} body=${res.body.slice(0, 200)}`)
  }

  // ── 「未登录」是**合法 JSON + HTTP 200**，必须按站点自己的判据识别（/scripts/app/main.js 的 dataFilter）：
  //    {"url":"…/sso/auth/goToLoginPage","returnUrl":"/WebCore","defaultUrl":"/index.html","errorCode":"ErrorCode4"}
  // 光看状态码/结构会把它当成「搜索结果 0 条」——这正是之前一直「无报错但 0 条」的真因。
  if (json && typeof json === 'object') {
    const code = String((json as any).errorCode || '')
    const jump = String((json as any).url || '')
    if (code === 'ErrorCode4' || (jump && isLoginUrl(jump))) {
      wjxtLog(`[${what}] NOT LOGGED IN: errorCode=${code || '-'} url=${jump.slice(0, 140)} cookies=${res.cookieCount}`)
      throw new Error('WJXT_NO_SESSION')
    }
    if (code) {
      // 其它服务端错误码（站点用 edoc2ErrorCode 字典翻译）：原样上报，便于定位
      throw new Error(`WJXT_SERVER_ERROR: errorCode=${code} body=${res.body.slice(0, 160)}`)
    }
  }
  return json
}

/**
 * 关键词转义：**保留通配符与常见文件名字符**，只把会破坏 query_string 语法的字符反斜杠转义。
 *
 * 原来这里是把特殊字符一律替换成空格，会把 `ADPLUS*` 这类通配查询打坏（`*` 被吃掉）；
 * 原技能包 `search_edoc2.ps1` 实际只转义了单引号、其余原样送 —— 这里按它的思路放宽，
 * 但补上语法性转义（`()[]{}"^~:` 与 `&&`/`||`），避免模型给的关键词把查询打散。
 */
function esEscape(s: string): string {
  // 与上游「增强搜索」脚本的 esEscape 保持一致：Lucene 特殊字符一律反斜杠转义
  return String(s || '').replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, '\\$&')
}

/**
 * 常用大小写变体。ES 的 keyword 字段**通配符区分大小写**
 * （上游「增强搜索」脚本实测：`*RED*` 匹配不到 `Red.png`），
 * 所以通配查询必须把几种常见大小写形态用 OR 串起来。
 */
function caseVariants(t: string): string[] {
  const set = [t, t.toLowerCase(), t.toUpperCase()]
  if (t.length) set.push(t.charAt(0).toUpperCase() + t.slice(1).toLowerCase())
  return [...new Set(set)].filter(Boolean)
}

/**
 * 单个关键词 → query_string 片段。三种模式对齐上游「增强搜索」脚本的 wildExpr：
 * - `word`（默认）：分词匹配、大小写不敏感 —— 与上游 search_edoc2.ps1 实际跑通的写法一致
 * - `contains`：`*关键词*` 子串匹配（**通配符大小写敏感**，故 OR 出大小写变体）——
 *   适合查文件名片段，如 `M0010_V3_2.4.6`；比 word 慢，仅在需要时用
 * - `exact`：整串精确匹配，适合已知完整文件名
 */
function keywordClause(kw: string, mode: WjxtMatchMode): string {
  const t = String(kw || '').trim()
  if (!t) return 'filename:("")'
  if (mode === 'exact') {
    const e = '"' + esEscape(t) + '"'
    return `(filename:(${e}) OR filecontent:(${e}))`
  }
  if (mode === 'contains') {
    const expr = caseVariants(t).map(v => '*' + esEscape(v) + '*').join(' OR ')
    return `(filename:(${expr}) OR filecontent:(${expr}))`
  }
  const e = esEscape(t)
  return `(filename:(${e}) OR filecontent:(${e}))`
}

/**
 * 拆词 token（保留长度 >= 3 的，按长度降序取前 3 个）—— 用于「拆词兜底」策略。
 * 实测：完整长名 `HY_ADPLUS2.0_M0010_V3_2.4.6_RC26042090` 直接查常常 0 条，
 * 而拆出 `RC26042090` / `ADPLUS2` / `M0010` 这类片段查命中率高得多。
 */
function keywordTokens(kw: string): string[] {
  return String(kw || '')
    .split(/[^0-9A-Za-z\u4e00-\u9fa5]+/)
    .filter(t => t.length >= 3)
    .sort((a, b) => b.length - a.length)
    .slice(0, 3)
    .map(t => esEscape(t))
}

/**
 * 各「非 score」排序键是否被服务端支持（1.0.43 实测修正）。
 *
 * **实测结论**：本部署对 `sort:[{modifyTime:{order:'desc'}}]` 会**直接返回空结果集**
 * （HTTP 200、`result:0`、`FilesInfo` 为空、无任何报错），而同一查询用
 * `sort:[{_score:{order:'desc'}}]` 能命中 50 条。上游「增强搜索」脚本里正有一个
 * `sortTime` 能力探测（不支持就退回相关度），照搬 `sortClause` 时漏掉了这层。
 * 首次踩到 0 条即把该键记为 false，之后一律走「相关度查询 + 本地排序」。
 */
const serverSortOk: Record<string, boolean> = {}

/** 服务端不支持某排序键时，在本地按该键排序（数据里已带 modifyTime / size / name） */
function sortFilesLocally(files: WjxtFileInfo[], sort: WjxtSort): WjxtFileInfo[] {
  const arr = [...files]
  const ms = (v?: string) => {
    const m = /\/Date\((-?\d+)/.exec(String(v || ''))
    return m ? Number(m[1]) : 0
  }
  if (sort === 'time') arr.sort((a, b) => ms(b.modifyTime) - ms(a.modifyTime))
  else if (sort === 'size') arr.sort((a, b) => (b.size || 0) - (a.size || 0))
  else if (sort === 'name') arr.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'))
  return arr
}

/** 排序键的中文说法（提示语里用） */
const SORT_LABEL: Record<string, string> = { score: '相关度', time: '修改时间', size: '大小', name: '文件名' }

/** 排序：对齐上游「增强搜索」脚本的 sortClause（score / time / size / name） */
function sortClause(sort?: WjxtSort): Array<Record<string, any>> {
  switch (sort) {
    case 'time': return [{ modifyTime: { order: 'desc' } }]
    case 'size': return [{ size: { order: 'desc' } }]
    case 'name': return [{ filename: { order: 'asc' } }]
    default: return [{ _score: { order: 'desc' } }]
  }
}

/**
 * 搜索文件（返回编号清单供用户确认）。
 * query 可传完整 ES 查询串（高级用法），不传则按「文件名或内容包含关键词」构造。
 */
export async function wjxtSearch(
  keyword: string,
  opts: { size?: number; query?: string; mode?: WjxtMatchMode; sort?: WjxtSort; from?: number } = {}
): Promise<{ total: number; files: WjxtFileInfo[]; strategy?: string; sortMode?: string }> {
  const size = Math.min(Math.max(Math.round(opts.size ?? 10), 1), MAX_SEARCH_SIZE)
  const from = Math.max(0, Math.round(Number(opts.from) || 0))
  const mode: WjxtMatchMode = opts.mode === 'contains' || opts.mode === 'exact' ? opts.mode : 'word'
  const sortKey: WjxtSort = opts.sort === 'time' || opts.sort === 'size' || opts.sort === 'name' ? opts.sort : 'score'
  // 服务端支持该排序键时才用它；已记为不支持（serverSortOk=false）则一开始就走相关度 + 本地排序
  let wantServerSort = sortKey !== 'score' && serverSortOk[sortKey] !== false
  let activeSorts = sortClause(wantServerSort ? sortKey : 'score')
  const base = keywordClause(keyword, mode)
  // 查询构造以原技能包**实际跑通**的 search_edoc2.ps1 为准（2026-09-22 用 agent-browser
  // 在本机完整跑通验证过）：
  //   (filename:(kw) OR filecontent:(kw))                      ← 无范围前缀，实测能命中
  // api_reference.md / prepare_urls.py 里那条
  //   (filepath:(1) OR masterfilepath:(1)) AND (filename:(kw) OR filecontent:(kw))
  // 在本部署下会把结果集筛成空 —— 表现为「HTTP 200、无报错、0 条」（同一关键词实测对比：
  // 无前缀命中 50 条，有前缀 0 条）。
  // 因此：首选无前缀查询；只有 0 条时才退回去试带前缀那条（换环境可能反过来）。
  // ── 策略链（1.0.43 效率优化）────────────────────────────────────────
  // 一次调用内部自己把「换个写法再试」做完。实测把这件事留给模型时，
  // 它会为一个文件发 88 次搜索（74 次空结果），回复周期极长。
  // 顺序按实测命中率排：原模式 → contains（通配子串）→ 拆词 OR → 带范围前缀（换环境可能只有它有效）。
  const strategies: Array<{ name: string; query: string }> = []
  if (opts.query) {
    strategies.push({ name: 'custom', query: opts.query.trim() })
  } else {
    strategies.push({ name: mode, query: base })
    if (mode !== 'contains') strategies.push({ name: 'contains', query: keywordClause(keyword, 'contains') })
    const toks = keywordTokens(keyword)
    if (toks.length) {
      const expr = toks.join(' OR ')
      strategies.push({ name: 'tokens', query: `(filename:(${expr}) OR filecontent:(${expr}))` })
    }
    strategies.push({ name: 'prefixed', query: `(filepath:(1) OR masterfilepath:(1)) AND ${base}` })
  }

  const buildForm = (query: string) => {
    const searchXml = JSON.stringify({
      from,
      size,
      _source: { excludes: ['filecontent'] },
      sort: activeSorts,
      query: { query_string: { query, default_operator: 'AND' } }
    })
    const argsXml = `<GetListArgs><PageNum>0</PageNum><PageSize>${size}</PageSize></GetListArgs>`
    return new URLSearchParams({
      module: 'WebClient',
      fun: 'GetMapSearchResultList',
      searchXml,
      mnId: '0',
      docViewId: '0',
      argsXml,
      startNum: '0',
      metaDataSearch: 'false',
      searchType: 'MixFile',
      searchLocation: 'enterprise'
    }).toString()
  }
  const searchOnce = (query: string) =>
    wjxtRequest('/WebCore', { method: 'POST', form: buildForm(query), timeoutMs: 45000 })

  /** 解析响应：结果数组路径做多重兜底（见下方注释），并把「该响应的原始体」一起带回来留痕 */
  const parseFiles = (json: any) => {
    const docList = json?.docListInfo || json?.data?.docListInfo || json?.data?.result || json?.data || {}
    const raw: any[] = docList?.FilesInfo || docList?.filesInfo || json?.FilesInfo || []
    const files: WjxtFileInfo[] = raw.map((f: any) => ({
      id: String(f?.id ?? ''),
      fileGuid: String(f?.fileGuid ?? ''),
      name: String(f?.name ?? ''),
      extName: String(f?.extName ?? ''),
      // 原技能包取的是这些字段（search_edoc2.ps1 的 -Fields 默认值）：
      // 「哪个版本最新」这类问题必须靠 mtime / path / ver，只给文件名答不了
      path: f?.path !== undefined ? String(f.path) : undefined,
      // 真实路径名（优先）—— 上游脚本用的就是它；字段名在个别版本里可能不同，做几种兜底
      relativePath: (() => {
        const v = f?.relativePath ?? f?.absolutePath ?? f?.folderPath ?? f?.pathName
        return v !== undefined && v !== null && String(v).trim() ? String(v).trim() : undefined
      })(),
      modifyTime: f?.modifyTime !== undefined ? String(f.modifyTime) : undefined,
      createTime: f?.createTime !== undefined ? String(f.createTime) : undefined,
      creatorName: f?.creatorName !== undefined ? String(f.creatorName) : undefined,
      editorName: f?.editorName !== undefined ? String(f.editorName) : undefined,
      lastVerNumStr: f?.lastVerNumStr !== undefined ? String(f.lastVerNumStr) : undefined,
      size: Number(f?.size ?? 0) || 0,
      parentFolderId: f?.parentFolderId !== undefined ? String(f.parentFolderId) : undefined,
      lastVerId: f?.lastVerId !== undefined ? String(f.lastVerId) : undefined
    })).filter(f => f.fileGuid)
    const total = Number(docList?.TotalCount ?? docList?.totalCount ?? files.length) || files.length
    return { files, total, docList }
  }

  // 首次搜索前先按站点前端的启动序列预热会话（见 wjxtWarmUp 的长注释）
  await wjxtWarmUp()

  /**
   * 发一次搜索，并在两类可自愈的失败上重试一次：
   * - 404（WebCore 的已知形态）→ 强制重做预热；
   * - 会话缺失/失效 → 先做一次「无打扰自愈」（静默 SSO + 隐藏窗口换票），成功则照常返回结果、
   *   **完全不弹窗**；仍然不行才把错误抛给上层（那里才会弹可见登录窗口）。
   * 刚跑过预热且结论是「未登录」时不重复跑，避免同一次失败里连开两次隐藏窗口。
   */
  let loginRetried = false
  const attempt = async (query: string): Promise<{ res: WjxtResponse; json: any }> => {
    const run = async () => {
      const r = await searchOnce(query)
      return { res: r, json: readJson(r, 'search') }
    }
    try {
      return await run()
    } catch (e: any) {
      const code = toUserError(e)
      if (code === 'WJXT_HTTP_404') {
        wjxtLog('[search] got 404, redo warm up then retry once')
        await wjxtWarmUp(true)
        return await run()
      }
      const verdictFresh = Date.now() - warmupVerdict.at < 60000 && warmupVerdict.loggedIn === false
      if ((code === 'WJXT_NO_SESSION' || code === 'NEED_RELOGIN') && !loginRetried && !verdictFresh) {
        loginRetried = true
        wjxtLog('[search] session missing -> silent re-login (silent SSO + hidden window), then retry once')
        await wjxtWarmUp(true)
        return await run()
      }
      throw e
    }
  }

  // 逐个策略尝试，命中即停（每次调用最多多花 0.3~1s，却能省掉模型一轮 5~20s 的往返）
  let usedStrategy = strategies[0].name
  let usedServerSort = wantServerSort
  let res: WjxtResponse | null = null
  let json: any = null
  let parsed: { files: WjxtFileInfo[]; total: number; docList: any } = { files: [], total: 0, docList: {} }
  for (const s of strategies) {
    wjxtLog(`[search] try strategy=${s.name} query=${s.query} sort=${usedServerSort ? sortKey : 'score'}`)
    const r = await attempt(s.query)
    usedStrategy = s.name
    res = r.res
    json = r.json
    parsed = parseFiles(r.json)

    // 服务端排序返回 0 条 → 立刻用**相关度排序重跑同一查询**。
    // 本部署对 modifyTime 排序会静默返回空集（见 serverSortOk 注释），这不是「没有这个文件」，
    // 之前就是这里把「有 26 条命中」的关键词判成了 0 条。
    if (!parsed.files.length && usedServerSort) {
      wjxtLog(`[search] sort=${sortKey} returned 0 -> retry same query with score sort`)
      activeSorts = sortClause('score')
      usedServerSort = false
      const r2 = await attempt(s.query)
      const p2 = parseFiles(r2.json)
      if (p2.files.length) {
        serverSortOk[sortKey] = false
        res = r2.res
        json = r2.json
        parsed = p2
        wjxtLog(`[search] score sort hit ${p2.files.length}/${p2.total} -> 改本地按 ${sortKey} 排序（该部署不支持服务端 ${sortKey} 排序）`)
      }
    }

    if (parsed.files.length) {
      wjxtLog(`[search] strategy=${s.name} hit ${parsed.files.length}/${parsed.total}`)
      // 一次性把结果行的字段名记下来：确认 relativePath（真实路径名）在本部署里确实存在
      // （上游脚本用过它，但不同版本字段名可能不同，留个可回查的证据）
      if (!loggedRowKeys) {
        loggedRowKeys = true
        try {
          const raw = parsed.docList?.FilesInfo?.[0] || parsed.docList?.filesInfo?.[0] || {}
          wjxtLog('[search] row0 keys=' + Object.keys(raw).join(',')
            + ' relativePath=' + JSON.stringify(String(raw.relativePath ?? '')))
        } catch { /* 诊断失败不影响搜索 */ }
      }
      break
    }
  }
  // 走的是「相关度查询 + 本地排序」：按请求的键把这一页排好（页大小内排序，
  // 「哪份/哪个版本最新」这种问题够用；跨页的全局时间序需要翻页时再说）
  if (!usedServerSort && sortKey !== 'score' && parsed.files.length) {
    parsed = { ...parsed, files: sortFilesLocally(parsed.files, sortKey) }
  }
  const sortMode = sortKey === 'score' ? 'score' : (usedServerSort ? `server:${sortKey}` : `local:${sortKey}`)

  if (!parsed.files.length && res) {
    // 空结果必须留痕：可能是查询条件/权限问题（响应本身是合法 JSON、TotalCount=0），
    // 也可能是响应结构变了导致我们把结果取空了 —— 两者处置完全不同，靠这条日志区分。
    // 只记结构性信息 + 响应前 600 字符（不含任何凭证）。
    wjxtLog('[search] EMPTY(all strategies): ' + JSON.stringify({
      keyword, size, sortMode,
      strategies: strategies.map(s => s.name),
      result: json?.result, errorCode: json?.errorCode, islogin: json?.islogin,
      topKeys: Object.keys(json || {}),
      docListKeys: Object.keys(parsed.docList || {}),
      head: res.body.slice(0, 600)
    }))
  }
  return { total: parsed.total, files: parsed.files, strategy: usedStrategy, sortMode }
}

/**
 * 由 fileGuid 拿到「原始文件」的下载直链。
 * GetPreviewPara 返回的 fileUrl 对 DOC/DOCX 指向 GetConversionFile（转码件），
 * 按契约把 pathname 换成 GetOriginFile、x 只保留前三段、去掉 r 参数，即得原始文件。
 */
export async function wjxtResolveOriginUrl(fileGuid: string): Promise<string> {
  const gid = String(fileGuid || '').trim()
  if (!gid) throw new Error('MISSING_ARG')
  const qs = new URLSearchParams({
    t: String(Date.now()),
    fileId: gid,
    byid: 'true',
    clientTypeName: 'pc',
    deviceTypeName: 'pc',
    browserPlatform: '1'
  }).toString()
  const json = readJson(await wjxtRequest(`/Preview/GetPreviewPara?${qs}`), 'preview')
  const raw = String(json?.data?.fileUrl || '')
  if (!raw) throw new Error('WJXT_NO_FILE_URL')

  let url: URL
  try { url = new URL(raw, WJXT_ORIGIN) } catch { throw new Error('WJXT_BAD_FILE_URL') }
  if (url.pathname.includes('GetConversionFile')) {
    url.pathname = url.pathname.replace('GetConversionFile', 'GetOriginFile')
    const x = url.searchParams.get('x') || ''
    url.searchParams.set('x', x.split(',').slice(0, 3).join(','))
    url.searchParams.delete('r')
  }
  return url.toString()
}

/** 把内部错误翻译成给模型/用户看的稳定错误码 */
function toUserError(e: any): string {
  const msg = String(e?.message || e)
  if (msg === 'NEED_RELOGIN') return 'NEED_RELOGIN'
  if (msg === 'WJXT_NO_SESSION') return 'WJXT_NO_SESSION'
  if (msg === 'WJXT_BAD_REQUEST') return 'WJXT_BAD_REQUEST'
  if (msg === 'WJXT_HTTP_404') return 'WJXT_HTTP_404'
  if (/^WJXT_HTTP_5\d\d$/.test(msg)) return 'WJXT_HTTP_5XX'
  if (/^WJXT_SERVER_ERROR/.test(msg)) return 'WJXT_SERVER_ERROR'
  if (e?.name === 'TimeoutError' || /timeout/i.test(msg)) return 'WJXT_TIMEOUT'
  return msg
}

/**
 * 需要登录时的统一处置：弹一次应用内登录窗口 + 给出可执行提示。
 * 窗口与工具请求共用 persist:mc-query 分区 —— 用户登录一次，工具侧立刻就有会话。
 */
function reloginResult(code: 'NEED_RELOGIN' | 'WJXT_NO_SESSION'): any {
  // 直接开 SSO 登录页：实测该页面不会自动登录（分区里有 SSO 票也照样 ErrorCode4），
  // 首次必须人工扫码一次 —— 让用户一开窗就看到登录界面，别先看一屏空白
  try { openLoginWindow?.(WJXT_SSO_LOGIN_URL) } catch { /* 开窗失败不影响给模型的结论 */ }
  watchLoginUntilDone()
  wjxtLog(`need login (${code}) -> open in-app SSO login window ${WJXT_SSO_LOGIN_URL}`)
  return {
    ok: false,
    error: code,
    needLogin: true,
    loginUrl: WJXT_SSO_LOGIN_URL,
    message: code === 'WJXT_NO_SESSION'
      ? '应用内还没有鸿翼文件系统（edoc2）的登录态 —— 服务端对请求返回了未登录信封'
        + '（errorCode=ErrorCode4，url 指向 sso/auth/goToLoginPage）。'
        + '已为你打开应用内登录窗口：**首次需要在那个窗口里扫码登录一次（这一步工具无法代扫）**。'
        + '登录成功后窗口会自动关闭，届时让我重试同一个查询即可 —— 会话会保留下来，之后不会再打扰你。'
        + '**不要**把这个地址复制到系统浏览器：系统浏览器与应用不共享登录态。'
      : '鸿翼文件系统的登录态已失效：已重新打开应用内登录窗口（首次需扫码一次，成功后窗口会自动关闭），'
        + '登录完让我重试同一个查询。'
  }
}

// ── 下发给模型的工具定义 ─────────────────────────────────────────────

export const WJXT_SEARCH_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'wjxt_search',
    description: '在鸿翼文件系统（Streamax 企业内容库）里搜索文件，返回编号清单（编号 / 文件名 / 大小 / 扩展名 / ' +
      '修改时间 / 版本号 / 目录路径 / fileGuid / 原始字节数）。' +
      '检索范围是文件名与文件正文内容。默认返回前 10 条，可用 size 调整（上限 50）；' +
      '高级用法可传 query 直接给 ES 查询串（字段 filename / filecontent，支持 * 通配）。' +
      '判断「哪份/哪个版本最新」要用返回里的 modifyTime 与 lastVerNumStr，不要只看文件名推断。' +
      '本工具**一次调用内部会自动换写法**（原模式 → 子串 → 拆词 → 范围前缀）直到命中：' +
      '返回里的 strategy 是命中的那条、note 会说明「原查询没命中、已自动改用 X 命中 N 条」——' +
      '看到 note 就直接用结果，**不要自己再换关键词重试**；' +
      '每个结果都带 folderPath（**真实目录路径名**，如 企业文档库/AD PLUS 2.0/版本发布）、' +
      'folderUrl（点开可在应用内浏览该目录）与 previewUrl（点开可在应用内预览/下载该文件）：' +
      '表格里的「目录」列请把 **folderPath 作为链接文字**、folderUrl 作为 href，' +
      '文件名用 previewUrl 做链接 —— 不要把 path（数字 id 串）或「浏览该目录」当显示文字。' +
      '**本工具只检索服务器上的文件系统**：不要用本地文件工具（file_search / list_dir / file_read）去「补充检索」' +
      '同一个文件，也不要提议「把本地目录发我」这类绕开文件系统的方案；结论只能来自本工具的返回值。' +
      '登录态由应用提供，无需任何扫码或口令。用户要「找文件/查资料/下载某个文档」时先用本工具列出候选，' +
      '让用户按编号确认后再调用 wjxt_download。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '关键词（文件名或内容里出现的词）' },
        size: { type: 'number', description: '返回条数，默认 10，上限 50' },
        mode: {
          type: 'string',
          enum: ['word', 'contains', 'exact'],
          description: '关键词匹配方式（默认 word）。word=分词匹配、大小写不敏感；' +
            'contains=文件名/正文子串匹配（`*关键词*`，适合查片段如 M0010_V3_2.4.6，比 word 慢）；' +
            'exact=整串精确匹配（已知完整文件名时最准）'
        },
        sort: {
          type: 'string',
          enum: ['score', 'time', 'size', 'name'],
          description: '排序（默认 score 相关度）。要「最新的在前」用 time（按修改时间倒序），' +
            '另有 size 从大到小、name 按文件名升序。该部署的服务端排序**已做自动兜底**：' +
            '服务端不支持时会自动改用「相关度查询 + 本地排序」，返回里的 note 会说明 —— 直接看结果即可，不要自己再排'
        },
        from: { type: 'number', description: '分页起始偏移（默认 0）。total 大于返回条数时用它翻页' },
        query: {
          type: 'string',
          description: '可选：完整 ES 查询串（给了 keyword 时以 query 为准）。可用字段 ' +
            'filename / filecontent / extName / creatorName / modifyTime / filepath；' +
            '支持通配 *（大小写敏感）与区间，例如 filename:(HY_ADPLUS2.0) AND filename:(Train OR 火车)、' +
            'modifyTime:[2026-01-01 TO 2026-12-31]'
        }
      },
      required: ['keyword']
    }
  }
}

export const WJXT_DOWNLOAD_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'wjxt_download',
    description: '把鸿翼文件系统里的**原始文件**下载到指定目录（不转码、不改格式，字节数与服务器一致）。' +
      'fileGuids 取自 wjxt_search 的返回（可一次传多个批量下载）；dir 必须是已授权工作区内的目录' +
      '（绝对路径或「别名/路径」，如 desktop/下载 或 工作区子目录），目录不存在会自动创建；' +
      '同名文件会自动重命名为「名称(1).ext」而不会覆盖。' +
      '批量下载超过 10 个文件时建议先与用户确认，避免一次拉太多。',
    parameters: {
      type: 'object',
      properties: {
        fileGuids: {
          type: 'array',
          items: { type: 'string' },
          description: '要下载的文件 GUID 列表（wjxt_search 返回的 fileGuid）；也可只传一个'
        },
        fileGuid: { type: 'string', description: '单个文件 GUID（与 fileGuids 二选一）' },
        dir: { type: 'string', description: '目标目录（绝对路径或「别名/路径」），必须在已授权工作区内' },
        names: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：与 fileGuids 一一对应的文件名（用于覆盖服务器文件名）'
        },
        sizes: {
          type: 'array',
          items: { type: 'number' },
          description: '可选：与 fileGuids 一一对应的期望字节数（用 wjxt_search 结果里的 size）。' +
            '给了就做精确比对，返回里会带 sizeMatched；强烈建议带上，能立刻发现下载不完整'
        }
      },
      required: ['dir']
    }
  }
}

export interface WjxtDownloadItem {
  fileGuid: string
  name?: string
  expectedSize?: number
  ok: boolean
  savedPath?: string
  relative?: string
  name2?: string
  size?: number
  /** 文件头识别出的类型（DOCX/XLSX(PK)、PDF、DOC/XLS(OLE2)…） */
  kind?: string
  /** 给了 sizes 时：实际字节数与期望是否一致 */
  sizeMatched?: boolean
  error?: string
  message?: string
}

/** 下载一个或多个文件（逐个串行，失败不中断其余） */
export async function runWjxtDownload(
  input: { fileGuid?: string; fileGuids?: string[]; dir: string; names?: string[]; sizes?: Array<number | string> },
  roots: AIExtraRoot[] = []
): Promise<{
  ok: boolean
  dir?: string
  items: WjxtDownloadItem[]
  error?: string
  message?: string
  needLogin?: boolean
  loginUrl?: string
}> {
  const dir = String(input?.dir || '').trim()
  if (!dir) return { ok: false, items: [], error: 'MISSING_ARG', message: '缺少 dir 参数' }

  const guids = (input?.fileGuids?.length ? input.fileGuids : (input?.fileGuid ? [input.fileGuid] : []))
    .map(g => String(g || '').trim())
    .filter(Boolean)
  if (!guids.length) return { ok: false, items: [], error: 'MISSING_ARG', message: '缺少 fileGuid / fileGuids' }
  if (guids.length > 50) return { ok: false, items: [], error: 'TOO_MANY', message: '单次最多下载 50 个文件' }

  const items: WjxtDownloadItem[] = []
  let needReloginCode: 'NEED_RELOGIN' | 'WJXT_NO_SESSION' | '' = ''
  for (let i = 0; i < guids.length; i++) {
    const gid = guids[i]
    try {
      const url = await wjxtResolveOriginUrl(gid)
      const res: DownloadToDirResult = await downloadToDir({
        url,
        dir,
        name: input?.names?.[i],
        roots,
        referer: WJXT_REFERER,
        useSession: true,
        // 与原技能包 download.ps1 一致：校验文件头 + 精确字节数
        validateFileHeader: true,
        expectedSize: Number(input?.sizes?.[i]) || undefined
      })
      // 下载侧也可能撞上登录页（tokenized URL 过期时服务端同样 302 到 SSO），
      // downloadToDir 会把这类判成 NEED_RELOGIN —— 统一收口到登录处置
      if (!res.ok && (res.error === 'NEED_RELOGIN')) {
        needReloginCode = 'NEED_RELOGIN'
        items.push({ fileGuid: gid, ok: false, error: res.error, message: res.message })
        continue
      }
      items.push({
        fileGuid: gid,
        ok: !!res.ok,
        savedPath: res.savedPath,
        relative: res.relative,
        size: res.size,
        kind: res.kind,
        expectedSize: Number(input?.sizes?.[i]) || undefined,
        sizeMatched: res.sizeMatched,
        error: res.error,
        message: res.message
      })
    } catch (e: any) {
      const code = toUserError(e)
      if (code === 'NEED_RELOGIN' || code === 'WJXT_NO_SESSION') {
        needReloginCode = code as 'NEED_RELOGIN' | 'WJXT_NO_SESSION'
        items.push({ fileGuid: gid, ok: false, error: code, message: '鸿翼文件系统的登录态不可用' })
      } else {
        items.push({ fileGuid: gid, ok: false, error: code, message: String(e?.message || e) })
      }
    }
  }
  wjxtLog(`[download] dir=${dir} items=${items.length} ok=${items.filter(i => i.ok).length} needRelogin=${needReloginCode || '-'}`)
  if (needReloginCode) {
    const r = reloginResult(needReloginCode)
    return { ok: false, dir, items, error: r.error, message: r.message, needLogin: true, loginUrl: r.loginUrl }
  }
  const ok = items.every(it => it.ok)
  return {
    ok,
    dir,
    items,
    ...(ok ? {} : { message: '部分或全部文件下载失败，详见 items' })
  }
}

/** 搜索工具的执行入口：错误统一转成结构化结果，让模型知道下一步怎么做 */
export async function runWjxtSearch(input: {
  keyword?: string
  size?: number
  query?: string
  mode?: WjxtMatchMode
  sort?: WjxtSort
  from?: number
}): Promise<any> {
  const keyword = String(input?.keyword || '').trim()
  if (!keyword && !input?.query) return { ok: false, error: 'MISSING_ARG', message: '缺少 keyword 参数' }
  const from = Math.max(0, Math.round(Number(input?.from) || 0))
  wjxtLog(`[search] keyword=${keyword} size=${input?.size ?? '-'} mode=${input?.mode || 'word'} sort=${input?.sort || 'score'} from=${from} query=${input?.query ? 'yes' : 'no'}`)
  try {
    const { total, files, strategy, sortMode } = await wjxtSearch(keyword, {
      size: input?.size,
      query: input?.query,
      mode: input?.mode,
      sort: input?.sort,
      from: input?.from
    })
    const asked = input?.query ? 'custom' : (input?.mode || 'word')
    const notes: string[] = []
    // 工具内部自己换过写法：明确告诉模型「结果是用哪条命中的」，
    // 免得它再自己一轮轮换词试（实测那样会烧掉几十次调用）
    if (files.length && strategy && strategy !== asked) {
      notes.push(`原 ${asked} 查询没命中，已自动改用「${strategy}」查询并命中 ${files.length} 条（无需再换词重试）`)
    }
    // 服务端不支持该排序键时工具已改本地排序：说清楚，免得模型以为排序没生效又去折腾
    if (files.length && sortMode?.startsWith('local:')) {
      const k = sortMode.slice('local:'.length)
      const label = SORT_LABEL[k] || k
      notes.push(`该部署不支持服务端按${label}排序（会静默返回空结果集），工具已改用「相关度查询 + 本地按${label}排序」，结果已排好、不必自己再排`)
    }
    return {
      ok: true,
      total,
      count: files.length,
      from,
      hasMore: files.length > 0 && from + files.length < total,
      strategy,
      sortMode,
      ...(notes.length ? { note: notes.join('；') } : {}),
      // 字段对齐原技能包 search_edoc2.ps1 的默认输出（name/path/mtime/ext/size/guid/id/pid + ver）：
      // 「哪个版本最新」「这份文件在哪」这类问题必须靠 mtime / ver / path 回答，只有文件名不够。
      files: files.map((f, i) => ({
        no: i + 1,
        name: f.name,
        extName: f.extName,
        size: f.size,
        fileGuid: f.fileGuid,
        id: f.id,
        parentFolderId: f.parentFolderId,
        modifyTime: parseEdoc2Date(f.modifyTime),
        createTime: parseEdoc2Date(f.createTime),
        path: f.path,
        // **真实目录路径名**（服务端 relativePath，如 `企业文档库/AD PLUS 2.0/版本发布`）：
        // 表格里的「目录」列请用它当链接文字 —— 别拿 `path`（那是 1\913\921\… 的数字 id 串，用户看不懂）
        folderPath: f.relativePath || f.path,
        lastVerNumStr: f.lastVerNumStr,
        creatorName: f.creatorName,
        editorName: f.editorName,
        // 目录直链：站点 SPA 路由形如 index.html#doc/enterprise/<folderId>
        //（上游「增强搜索」脚本的 navigateToFolder 也是这个写法）。
        // 应用已把 AI 回复里的 *.streamax.com 链接改成「应用内窗口打开」，点开即可浏览该目录。
        folderUrl: f.parentFolderId
          ? `${WJXT_ORIGIN}/index.html#doc/enterprise/${f.parentFolderId}`
          : undefined,
        // 文件预览页（站点原生预览，可再下载）：文件名做成这个链接，点开就能看/下
        previewUrl: `${WJXT_ORIGIN}/preview.html?fileid=${encodeURIComponent(f.fileGuid)}`
      }))
    }
  } catch (e: any) {
    const code = toUserError(e)
    wjxtLog(`[search] failed code=${code} msg=${String(e?.message || e).slice(0, 300)}`)
    if (code === 'NEED_RELOGIN' || code === 'WJXT_NO_SESSION') return reloginResult(code as any)
    if (code === 'WJXT_BAD_REQUEST') {
      return { ok: false, error: code, message: '鸿翼服务端拒绝了请求（Referer/会话异常），请重新登录后重试' }
    }
    if (code === 'WJXT_HTTP_404') {
      return {
        ok: false,
        error: code,
        message: '鸿翼搜索接口返回 404，自动重试一次仍失败（服务端未就绪或网关抖动），请稍后再试。'
      }
    }
    if (code === 'WJXT_HTTP_5XX') {
      return { ok: false, error: code, message: '鸿翼服务端返回 5xx（服务端异常），请稍后再试。' }
    }
    if (code === 'WJXT_TIMEOUT') {
      return { ok: false, error: code, message: '请求超时（内网抖动或服务端慢），可以再试一次。' }
    }
    if (code === 'WJXT_SERVER_ERROR') {
      return { ok: false, error: code, message: '鸿翼服务端返回了业务错误码：' + String(e?.message || e) }
    }
    return { ok: false, error: 'SEARCH_FAILED', message: String(e?.message || e) }
  }
}
