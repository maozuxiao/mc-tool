import { useEffect, useRef, useState } from 'react'
import { useStore } from './store'
import { LoginOverlay } from './components/LoginOverlay'
import { QueryPanel } from './components/QueryPanel'
import { ChatPanel } from './components/ai/ChatPanel'
import { UpdateBar } from './components/UpdateBar'

type MainView = 'query' | 'ai'

export function App() {
  const t = useStore(s => s.t)
  const loggedIn = useStore(s => s.loggedIn)
  const loginState = useStore(s => s.loginState)
  const landing = useStore(s => s.landing)
  const setLoggedIn = useStore(s => s.setLoggedIn)
  const setChecking = useStore(s => s.setCheckingLogin)
  const setLoginState = useStore(s => s.setLoginState)
  const setLanding = useStore(s => s.setLanding)
  const setLoginError = useStore(s => s.setLoginError)
  const setQrRefetchSeq = useStore(s => s.setQrRefetchSeq)
  const setUpdateInfo = useStore(s => s.setUpdateInfo)
  const [view, setView] = useState<MainView>('query')
  // ChatPanel 一旦挂载就不再卸载：切到物料查询只是用 CSS 隐藏。
  // 否则来回切页面会丢失本地状态（当前会话 id、已加载的消息、流式进度）。
  const aiMountedRef = useRef(false)
  if (view === 'ai') aiMountedRef.current = true

  useEffect(() => {
    window.mcApi.onLoginChecked((s: { loggedIn: boolean; reason?: string }) => {
      setLanding(false)
      setLoggedIn(s.loggedIn)
      setChecking(false)
      if (s.loggedIn) {
        setLoginState('ok')
        setLoginError('')
      } else {
        const reason = s.reason
        setLoginError(
          reason === 'network'
            ? '网络异常，正在重新获取二维码...'
            : '登录未完成，正在重新获取二维码...'
        )
        setQrRefetchSeq(useStore.getState().qrRefetchSeq + 1)
      }
    })
    window.mcApi.onLoginReady((s: { loggedIn: boolean }) => {
      setLanding(false)
      setLoggedIn(s.loggedIn)
      setChecking(false)
      if (s.loggedIn) setLoginState('ok')
    })
    window.mcApi.onLoginState((s: { state: string }) => {
      const state = s.state as 'checking' | 'logging' | 'failed' | 'ok'
      setLoginState(state)
      if (state === 'checking') setChecking(true)
      else setChecking(false)
      if (state === 'ok') { setLanding(false); setLoggedIn(true) }
    })
    window.mcApi.onLoginLanding(() => setLanding(true))
    window.mcApi.reloadLogin()
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
      <div className={`view-pane${view === 'query' ? '' : ' is-hidden'}`}>
        <QueryPanel disabled={!loggedIn} />
      </div>
      {aiMountedRef.current && (
        <div className={`view-pane${view === 'ai' ? '' : ' is-hidden'}`}>
          <ChatPanel disabled={!loggedIn} />
        </div>
      )}
      {landing && (
        <div className="sso-loading-overlay">
          <div className="sso-loading-box">
            <div className="sso-loading-spinner" />
            <div className="sso-loading-text">正在进入工具…</div>
          </div>
        </div>
      )}
      <div className="view-switch">
        <button className={view === 'query' ? 'active' : ''} onClick={() => setView('query')}>{t('viewQuery')}</button>
        <button className={view === 'ai' ? 'active' : ''} onClick={() => setView('ai')}>{t('viewAi')}</button>
      </div>
    </div>
  )
}