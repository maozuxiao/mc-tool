import { useEffect } from 'react'
import { useStore } from './store'
import { LoginOverlay } from './components/LoginOverlay'
import { QueryPanel } from './components/QueryPanel'
import { UpdateBar } from './components/UpdateBar'

declare global {
  interface Window {
    mcApi: {
      openOALogin: () => Promise<void>
      reloadLogin: () => Promise<void>
      getLoginUrl: () => Promise<string>
      clearLogin: () => Promise<void>
      onLoginChecked: (cb: (s: { loggedIn: boolean }) => void) => () => void
      onLoginReady: (cb: (s: { loggedIn: boolean }) => void) => () => void
      onLoginState: (cb: (s: { state: string }) => void) => () => void
      onLoginLanding: (cb: () => void) => () => void
      fetchOA: (url: string) => Promise<any>
      startQrLogin: () => Promise<any>
      pollQrLogin: (qrToken: string) => Promise<any>
      logError: (msg: string) => void
      checkForUpdates: () => Promise<{ ok: boolean; version?: string; error?: string }>
      startDownload: () => Promise<{ ok: boolean; error?: string }>
      onUpdateAvailable: (cb: (p: any) => void) => () => void
      onUpdateDownloaded: (cb: (p: any) => void) => () => void
      onUpdateNotAvailable: (cb: (p: any) => void) => () => void
      onUpdateProgress: (cb: (p: { percent: number; transferred: number; total: number }) => void) => () => void
      onUpdateError: (cb: (p: any) => void) => () => void
      installUpdate: () => Promise<void>
      saveCsv: (content: string, defaultName: string) => Promise<string | undefined>
      appVersion: () => string
    }
  }
}

export function App() {
  const loggedIn = useStore(s => s.loggedIn)
  const checking = useStore(s => s.checkingLogin)
  const loginState = useStore(s => s.loginState)
  const landing = useStore(s => s.landing)
  const setLoggedIn = useStore(s => s.setLoggedIn)
  const setChecking = useStore(s => s.setCheckingLogin)
  const setLoginState = useStore(s => s.setLoginState)
  const setLanding = useStore(s => s.setLanding)
  const setUpdateInfo = useStore(s => s.setUpdateInfo)

  useEffect(() => {
    // 监听主进程回传的登录态检测结果
    window.mcApi.onLoginChecked((s: { loggedIn: boolean }) => {
      setLanding(false)
      setLoggedIn(s.loggedIn)
      setChecking(false)
      if (s.loggedIn) setLoginState('ok')
    })
    window.mcApi.onLoginReady((s: { loggedIn: boolean }) => {
      setLanding(false)
      setLoggedIn(s.loggedIn)
      setChecking(false)
      if (s.loggedIn) setLoginState('ok')
    })
    // 监听登录阶段状态：checking / logging / failed / ok
    window.mcApi.onLoginState((s: { state: string }) => {
      const state = s.state as 'checking' | 'logging' | 'failed' | 'ok'
      setLoginState(state)
      if (state === 'checking') setChecking(true)
      else setChecking(false)
      if (state === 'ok') { setLanding(false); setLoggedIn(true) }
    })
    // 扫码成功、SSO 落地中：显示全屏 Loading 覆盖层，用户不会看到 OA 页面
    window.mcApi.onLoginLanding(() => setLanding(true))
    // 挂载时主动询问一次当前登录态，作为事件丢失的兜底
    window.mcApi.reloadLogin()
    // 自动更新事件
    window.mcApi.onUpdateAvailable((p: any) =>
      setUpdateInfo({ hasUpdate: true, version: p.version, notes: p.releaseNotes, checking: false }))
    window.mcApi.onUpdateDownloaded(() =>
      setUpdateInfo({ hasUpdate: true, downloaded: true, progress: 100 }))
    window.mcApi.onUpdateProgress((p: { percent: number; transferred: number; total: number }) =>
      setUpdateInfo({ hasUpdate: true, downloading: true, progress: Math.round(p.percent) }))
    window.mcApi.onUpdateNotAvailable(() =>
      setUpdateInfo({ hasUpdate: false, checking: false }))
    window.mcApi.onUpdateError((p: any) =>
      setUpdateInfo({ checking: false, error: p.message }))
  }, [])

  return (
    <div className="app-root">
      <UpdateBar />
      {!loggedIn && !landing && <LoginOverlay loginState={loginState} />}
      <QueryPanel disabled={!loggedIn} />
      {/* SSO 落地中：全屏 Loading 覆盖层，遮住底层内容，用户不会看到 OA 页面 */}
      {landing && (
        <div className="sso-loading-overlay">
          <div className="sso-loading-box">
            <div className="sso-loading-spinner" />
            <div className="sso-loading-text">正在进入工具…</div>
          </div>
        </div>
      )}
    </div>
  )
}
