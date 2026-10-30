import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Background } from 'animal-island-ui'
import { useStore } from './store'
import { themeBackdrop } from './theme'
import { LoginOverlay } from './components/LoginOverlay'
import { QueryPanel } from './components/QueryPanel'
import { ChatPanel } from './components/ai/ChatPanel'
import { UpdateBar } from './components/UpdateBar'
import { SessionExpiredBar } from './components/SessionExpiredBar'

type MainView = 'query' | 'ai'

/**
 * 两个视图面板只在「登录态」这一个 prop 上变化，其余状态与它们无关，因此做 memo。
 *
 * 1.0.42 性能优化：切视图走的是 setView，而本组件同时订阅了语言、主题、登录态、
 * SSO 遮罩、更新进度等多路状态 —— 任一变化都会让整个 App 重新 render，进而把
 * 查询页与 AI 页两棵大树一起重渲染（表格是「结果集行数」量级、AI 页是「消息数 ×
 * Markdown 解析」量级），叠加切回时对显示侧的一次完整 layout，就是切视图卡顿的主因。
 * memo 之后切换只改类名，不再进入面板内部。
 */
const MemoQueryPanel = memo(QueryPanel)
const MemoChatPanel = memo(ChatPanel)

// 壁纸同理：它只依赖 theme 一个 prop，但 App 每次重渲染（切视图、登录态、更新进度事件
// 每秒多次）都会连带重渲染这块全屏组件。memo 之后只有换主题才会重建。
const MemoBackdrop = memo(Background)

export function App() {
  const t = useStore(s => s.t)
  const theme = useStore(s => s.theme)
  const loggedIn = useStore(s => s.loggedIn)
  const loginState = useStore(s => s.loginState)
  const landing = useStore(s => s.landing)
  const setLoggedIn = useStore(s => s.setLoggedIn)
  const setChecking = useStore(s => s.setCheckingLogin)
  const setLoginState = useStore(s => s.setLoginState)
  const setLanding = useStore(s => s.setLanding)
  const setLoginError = useStore(s => s.setLoginError)
  const setQrRefetchSeq = useStore(s => s.setQrRefetchSeq)
  const setSessionExpired = useStore(s => s.setSessionExpired)
  const setUpdateInfo = useStore(s => s.setUpdateInfo)
  // landing 是一层全屏遮罩，只要它不消失，整个界面都无法输入。
  // 主进程已保证每条路径都会给出结束事件，这里再加一道保险：
  // 万一有未覆盖的异常分支漏发，2 分钟后自动解除，不必重启应用。
  useEffect(() => {
    if (!landing) return
    const timer = window.setTimeout(() => setLanding(false), 120_000)
    return () => window.clearTimeout(timer)
  }, [landing, setLanding])

  const [view, setView] = useState<MainView>('query')
  // ChatPanel 一旦挂载就不再卸载：切到物料查询只是用 CSS 隐藏。
  // 否则来回切页面会丢失本地状态（当前会话 id、已加载的消息、流式进度）。
  const aiMountedRef = useRef(false)
  if (view === 'ai') aiMountedRef.current = true

  // ── 切换耗时自测（仅开发模式；未启用 vite/client 类型，故对 import.meta 做一次 any 收口）──
  // 把「点击 → 上屏」拆成三段，用来判断剩余的「不跟手」到底在 React 提交、布局还是绘制：
  //   react  = 点击到 DOM 更新完成
  //   layout = 强制读一次布局属性测出的同步布局耗时
  //   paint  = 再等两帧，得到「真正画上屏」的总耗时
  // 用法：npm run dev 下多点几次切换，看控制台 [perf] switch 行；控制台没有输出说明这段被摇掉了。
  const switchStartRef = useRef(0)
  const switchTo = useCallback((v: MainView) => {
    switchStartRef.current = performance.now()
    setView(v)
  }, [])
  useLayoutEffect(() => {
    if (!switchStartRef.current) return
    const t0 = switchStartRef.current
    switchStartRef.current = 0
    const tCommit = performance.now()
    void document.body.offsetHeight // 强制同步布局，这一步的耗时即 Layout
    const tLayout = performance.now()
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const tPaint = performance.now()
      if ((import.meta as any).env?.DEV === true) {
        console.log(
          `[perf] switch ${view}: react=${(tCommit - t0).toFixed(1)}ms ` +
          `layout=${(tLayout - tCommit).toFixed(1)}ms paint=${(tPaint - t0).toFixed(1)}ms`
        )
      }
    }))
  }, [view])

  useEffect(() => {
    // 监听统一收集「取消订阅」函数，卸载时清理。
    // 1.0.42：以前这些 on* 返回的是 IpcRenderer（不可调用），effect 没有 cleanup ——
    // StrictMode 的「挂载 → 卸载 → 再挂载」会注册两份监听，同一条事件被处理两次
    // （登录态与更新进度都会重复触发），顺带让启动阶段多出一批无用工作。
    const offs: Array<() => void> = []
    offs.push(window.mcApi.onLoginChecked((s: { loggedIn: boolean; reason?: string }) => {
      // 先取「更新前」的状态：下面 setLoggedIn 一执行，zustand 里就已是新值，
      // 而「是否刚刚从已登录掉下来」必须用旧值判断（1.0.53）。
      const wasLoggedIn = useStore.getState().loggedIn
      const wasLoginState = useStore.getState().loginState
      setLanding(false)
      setLoggedIn(s.loggedIn)
      setChecking(false)
      if (s.loggedIn) {
        setLoginState('ok')
        setLoginError('')
        // 登录成功：清除失效提示条
        setSessionExpired(false)
      } else {
        const reason = s.reason
        setLoginError(
          // 2026-10-26：主动登出不是失败，别用「登录未完成」这种口吻。
          reason === 'logout'
            ? t('qrLoggedOut')
            : reason === 'network'
              ? t('errLoginNetwork')
              : reason === 'expired'
                ? t('errLoginExpired')
                : t('errLoginIncomplete')
        )
        // 1.0.53：只在「刚刚从已登录掉下来」或「当前不在扫码态」时才请求重取二维码。
        // 主进程侧的触发源已增至三处（窗口 focus / 心跳兜底 / 原有路径），其中窗口 focus
        // 是高频事件 —— 若每次都自增，用户正要扫码就被反复刷掉。主进程已有幂等（
        // requestLoginView 的 loginViewShown），这里再加一道：即便消息仍重复到达
        // （例如登录层已经显示着时又来一条），也不会把正在展示的二维码重置。
        //
        // 2026-10-26：主动登出**不再额外自增**。登出时主进程同时下发
        // OA_LOGIN_STATE('logging')，登录层自身会因为 loginState 变化拉一次码；
        // 这里再 bump 就是两路并发拉码，后一路的 setQrSrc('') 会把前一路刚渲染的
        // 二维码擦掉（用户实测：退出登录后一屏空白，点「刷新二维码」才有）。
        if (reason !== 'logout' && (wasLoggedIn || wasLoginState !== 'logging')) {
          setQrRefetchSeq(useStore.getState().qrRefetchSeq + 1)
        }
      }
    }))
    offs.push(window.mcApi.onLoginReady((s: { loggedIn: boolean }) => {
      setLanding(false)
      setLoggedIn(s.loggedIn)
      setChecking(false)
      if (s.loggedIn) { setLoginState('ok'); setSessionExpired(false) }
    }))
    offs.push(window.mcApi.onLoginState((s: { state: string }) => {
      const state = s.state as 'checking' | 'logging' | 'failed' | 'ok'
      setLoginState(state)
      if (state === 'checking') setChecking(true)
      else setChecking(false)
      if (state === 'ok') { setLanding(false); setLoggedIn(true); setSessionExpired(false) }
    }))
    offs.push(window.mcApi.onLoginLanding(() => setLanding(true)))
    // 启动耗时优化：reloadLogin 会让主进程做一次会话探测（可能拉起隐藏窗口 / 发起网络请求），
    // 原先在 effect 里同步发出，等于和 React 首帧抢主线程。这里推迟到首帧渲染完成之后再发，
    // 监听已先注册好，登录事件不会丢。
    const reloadRaf = requestAnimationFrame(() => { void window.mcApi.reloadLogin() })
    offs.push(() => cancelAnimationFrame(reloadRaf))
    offs.push(window.mcApi.onUpdateAvailable((p: any) =>
      setUpdateInfo({ hasUpdate: true, version: p.version, notes: p.releaseNotes, checking: false })))
    offs.push(window.mcApi.onUpdateDownloaded(() =>
      setUpdateInfo({ hasUpdate: true, downloaded: true, progress: 100 })))
    offs.push(window.mcApi.onUpdateProgress((p: { percent: number; transferred: number; total: number }) =>
      setUpdateInfo({ hasUpdate: true, downloading: true, progress: Math.round(p.percent) })))
    offs.push(window.mcApi.onUpdateNotAvailable(() =>
      setUpdateInfo({ hasUpdate: false, checking: false })))
    offs.push(window.mcApi.onUpdateError((p: any) =>
      setUpdateInfo({ checking: false, error: p.message })))
    // 托盘右键菜单「物料查询 / AI 助手」→ 直接切视图（视图状态仍归本组件管）
    offs.push(window.mcApi.onTraySwitchView((v) => switchTo(v)))
    // 托盘右键菜单「检查更新」→ 复用渲染层 checkUpdate()（含完整 UI 反馈）
    offs.push(window.mcApi.onTrayCheckUpdate(() => { useStore.getState().checkUpdate() }))

    return () => { offs.forEach(off => off()) }
  }, [])

  // 报到：告诉主进程「当前渲染层是新实例」，让它复位 loginViewShown。
  // 没有这一步的话，dev 下整页重载后主进程仍认为登录层已展示，后续 requestLoginView
  // 全被 `skip (already shown)` 吞掉，新实例的登录层再也收不到消息
  // （2026-10-30 实测：reload 后出码 4 次、focus 检查 5 次全部 skip）。
  useEffect(() => {
    void window.mcApi.rendererReady()
  }, [])

  // 窗口失焦 / 最小化 / 切到后台时，暂停纯装饰性动画（选中 Tab 的小叶子、壁纸入场），
  // 避免应用退到后台仍持续占用合成器与 GPU（任务管理器里 GPU 进程 124 MB 的一部分）。
  // 具体暂停规则见 styles.css 的 .win-idle。
  useEffect(() => {
    const root = document.documentElement
    const sync = () => {
      if (document.hidden || !document.hasFocus()) root.classList.add('win-idle')
      else root.classList.remove('win-idle')
    }
    sync()
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
      document.removeEventListener('visibilitychange', sync)
      root.classList.remove('win-idle')
    }
  }, [])

  return (
    <div className="app-root">
      {/* 全局壁纸层：整窗最底层的一块「壁纸」，铺满视口、不占布局、不拦点击。
          放在这里（而不是各页面内部）才能让登录页、物料查询页、AI 助手页与顶部提示条
          共用同一张壁纸；切换主题只改这一个属性，不会触发两张表格重渲染。 */}
      <MemoBackdrop type={themeBackdrop(theme)} className="mc-backdrop" />
      <UpdateBar />
      <SessionExpiredBar />
      {!loggedIn && !landing && <LoginOverlay loginState={loginState} />}
      <div className={`view-pane${view === 'query' ? '' : ' is-hidden'}`}>
        <MemoQueryPanel disabled={!loggedIn} />
      </div>
      {aiMountedRef.current && (
        <div className={`view-pane${view === 'ai' ? '' : ' is-hidden'}`}>
          <MemoChatPanel disabled={!loggedIn} />
        </div>
      )}
      {landing && (
        <div className="sso-loading-overlay">
          <div className="sso-loading-box">
            <div className="sso-loading-spinner" />
            <div className="sso-loading-text">{t('ssoEntering')}</div>
          </div>
        </div>
      )}
      <div className="view-switch">
        <button type="button" className={view === 'query' ? 'active' : ''} onClick={() => switchTo('query')}>{t('viewQuery')}</button>
        <button type="button" className={view === 'ai' ? 'active' : ''} onClick={() => switchTo('ai')}>{t('viewAi')}</button>
      </div>
    </div>
  )
}