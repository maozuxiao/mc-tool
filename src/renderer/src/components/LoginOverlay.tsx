import { useEffect, useRef, useState, useCallback } from 'react'
import { Button, Icon } from 'animal-island-ui'
import { useStore } from '../store'

interface Props {
  loginState: 'checking' | 'logging' | 'failed' | 'ok'
}

/** 二维码状态只保存「文案键」，渲染时才翻译：
 *  这样切换语言时状态区立即跟着变，不会残留上一次语言的文案。 */
type StatusKey =
  | 'qrPreparing'
  | 'qrFetching'
  | 'qrRetrying'
  | 'qrScanHint'
  | 'qrScanConfirm'
  | 'qrLoginOk'
  | 'qrExpired'
  | 'qrInvalid'
  | 'qrFail'

const MAX_POLL_MS = 3 * 60 * 1000 // 最多轮询 3 分钟

export function LoginOverlay({ loginState }: Props) {
  const lang = useStore(s => s.lang)
  const t = useStore(s => s.t)
  const appName = t(lang === 'en' ? 'qrAppEn' : 'qrAppZh')
  const loginError = useStore(s => s.loginError)
  const setLoginError = useStore(s => s.setLoginError)
  const qrRefetchSeq = useStore(s => s.qrRefetchSeq)

  const [qrSrc, setQrSrc] = useState('')
  const [qrToken, setQrToken] = useState('')
  const [authChainCode, setAuthChainCode] = useState('')
  const [lck, setLck] = useState('')
  const [status, setStatus] = useState<StatusKey>('qrPreparing')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [scanned, setScanned] = useState(false)
  const [expired, setExpired] = useState(false)

  const pollTimerRef = useRef<number | null>(null)
  const startedAtRef = useRef<number>(0)
  const pollingRef = useRef<boolean>(false)
  // 记录上一次 loginState，用于检测“重新登录”信号（退出后再进入 logging）
  const prevLoginStateRef = useRef<string>('')

  const buildQrSrc = useCallback((raw: string) => {
    if (!raw) return ''
    // 后端返回的 qrMsg 可能是完整 data URL，但 MIME 标错（png 实际是 jpeg）。
    // 先修正前缀：/9j/ 开头的一定是 JPEG。
    const pngPrefix = 'data:image/png;base64,'
    if (raw.startsWith(pngPrefix) && raw.slice(pngPrefix.length).startsWith('/9j/')) {
      return `data:image/jpeg;base64,${raw.slice(pngPrefix.length)}`
    }
    if (raw.startsWith('data:')) return raw
    const mime = raw.startsWith('/9j/') ? 'image/jpeg' : 'image/png'
    return `data:${mime};base64,${raw}`
  }, [])

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      window.clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  // 默认 forceQr=true：直接获取二维码，跳过主进程免登录校验（免登录由启动时的
  // checkLoginAndNotify 负责；这里只需拿到可用二维码）。退出登录/重开无 cookie 时
  // 直接拿码，避免走易 timeout 的自动校验路径。
  const fetchQr = useCallback(async (forceQr = true, retryLeft = 0) => {
    console.log('[QR] fetchQr called, loginState=', loginState, 'forceQr=', forceQr)
    stopPolling()
    setLoading(true)
    setError('')
    setLoginError('')
    setScanned(false)
    setQrSrc('')
    setQrToken('')
    setAuthChainCode('')
    setLck('')
    setExpired(false)
    setStatus('qrFetching')
    try {
      console.log('[QR] invoking startQrLogin...')
      // forceQr=true 表示用户手动点击刷新：跳过主进程自动认证判断，直接获取二维码
      const res = await window.mcApi.startQrLogin(forceQr)
      console.log('[QR] startQrLogin result=', res)
      if (!res.success) {
        // 可重试错误：自动退避重试，IAM 一恢复即出新码，无需用户手动刷新。
        //  - network  ：IAM 超时/不可达
        //  - retryable：IAM 冷启动未签发 lck 上下文（瞬态，重试可恢复）
        if ((res.reason === 'network' || res.reason === 'retryable') && retryLeft > 0) {
          setError(
            useStore.getState().t(res.reason === 'network' ? 'errLoginNetwork' : 'errLoginSvc')
          )
          setStatus('qrRetrying')
          setLoading(false)
          window.setTimeout(() => fetchQr(forceQr, retryLeft - 1), 5000)
          return
        }
        throw new Error(res.message || useStore.getState().t('errQrFetch'))
      }
      // OA 已登录态（SESSION 仍热，登录页直接 200 无 lck）：无需扫码，直接进工具
      if (res.alreadyLoggedIn) {
        console.log('[QR] alreadyLoggedIn=true, skip QR and enter tool')
        useStore.getState().setLoginState('ok')
        useStore.getState().setLoggedIn(true)
        useStore.getState().setLanding(false)
        setLoading(false)
        return
      }
      const token = res.qrToken || res.data?.qrToken
      const msg = res.qrMsg || res.data?.qrMessage || res.data?.qrMsg || res.data?.qrData
      if (!token || !msg) throw new Error(useStore.getState().t('errQrIncomplete'))
      setQrToken(token)
      setAuthChainCode(res.authChainCode || res.data?.authChainCode || '')
      setLck(res.lck || res.data?.lck || '')
      setQrSrc(buildQrSrc(msg))
      setStatus('qrScanHint')
      setLoading(false)
    } catch (e: any) {
      const msg = e.message || useStore.getState().t('errQrFetch')
      // 主进程正在并发获取二维码（互斥锁拒绝），稍候自动重试，不向用户报错
      if (/正在获取二维码/.test(msg)) {
        setStatus('qrFetching')
        window.setTimeout(() => fetchQr(forceQr, retryLeft), 800)
        return
      }
      setError(msg)
      setStatus('qrFail')
      setLoading(false)
    }
  }, [buildQrSrc, stopPolling])

  // 自动获取二维码。
  // 关键：退出登录后 loginState 从 'ok' 变回 'logging'，但组件未卸载，
  // 旧的 qrToken/lck 残留在 state 中，若仅按 "!qrToken" 判断就不会重新拉取，
  // 导致轮询沿用过期 token 一直 timeout。这里检测“重新进入 logging”信号，
  // 强制重置并重新获取二维码。
  useEffect(() => {
    const prev = prevLoginStateRef.current
    prevLoginStateRef.current = loginState
    if (loginState !== 'logging') return
    // 初次进入（无 token）或“重新登录”（上次不是 logging）→ 重新拉取
    if (!qrToken || prev !== 'logging') {
      setExpired(false)
      fetchQr(true, 6)
    }
  }, [loginState, qrToken, fetchQr])

  // 主进程 SSO 落地网络失败等场景：通过 qrRefetchSeq 自增触发自动重新拉取并显示新二维码，
  // 用户无需手动点击刷新（旧码已被扫过、重扫无效）。
  const lastRefetchSeqRef = useRef<number>(0)
  useEffect(() => {
    if (qrRefetchSeq === 0) return
    if (qrRefetchSeq === lastRefetchSeqRef.current) return
    lastRefetchSeqRef.current = qrRefetchSeq
    fetchQr(true, 6)
  }, [qrRefetchSeq, fetchQr])

  // 二维码拿到后开始长轮询（authExecute）
  // 注意：必须是单条请求串行等待，authExecute 会挂起 60s；用 setInterval 会导致多个请求并发互相覆盖。
  useEffect(() => {
    if (loginState !== 'logging' || !qrToken || !authChainCode || !lck) return
    console.log('[QR] start long-polling, token=', qrToken.slice(0, 8), 'chain=', authChainCode.slice(0, 8))
    startedAtRef.current = Date.now()
    pollingRef.current = true

    const schedule = (delay = 0) => {
      if (!pollingRef.current) return
      if (Date.now() - startedAtRef.current > MAX_POLL_MS) {
        pollingRef.current = false
        setExpired(true)
        setStatus('qrExpired')
        return
      }
      pollTimerRef.current = window.setTimeout(runPoll, delay)
    }

    const runPoll = async () => {
      if (!pollingRef.current) return
      try {
        const poll = await window.mcApi.pollQrLogin({ qrToken, authChainCode, lck, entityId: 'oa' })
        console.log('[QR] poll result=', poll)

        if (!pollingRef.current) return

        if (poll.loggedIn || poll.success) {
          pollingRef.current = false
          stopPolling()
          setScanned(true)
          setStatus('qrLoginOk')
          // 不立即 reloadLogin：主进程会在 SSO 落地 OA 会话后主动推送 OA_CHECK_LOGGED。
          // 若 8s 内未收到（SSO 失败），再主动检测一次，届时失败会回到二维码重试。
          window.setTimeout(() => {
            window.mcApi.reloadLogin()
          }, 8000)
          return
        }

        if (poll.data?.status === 'scanned' || poll.scanned) {
          setScanned(true)
          setStatus('qrScanConfirm')
          schedule(1000)
          return
        }

        // 4005 "二维码已失效"：之前由并发覆盖引起所以继续等待；但当前已改为串行轮询，
        // 若仍收到 4005 说明二维码确实失效（过期/被使用），标记过期并提示刷新。
        if (poll.code === 4005 || poll.code === '4005') {
          pollingRef.current = false
          setExpired(true)
          setError('')
          setStatus('qrInvalid')
          return
        }

        if (poll.error) {
          // timeout / 挂起返回：正常继续
          schedule(1000)
          return
        }

        if (!poll.success) {
          // 真正的业务失败
          pollingRef.current = false
          setError(poll.message || useStore.getState().t('qrPollFail'))
          return
        }

        schedule(1000)
      } catch (e: any) {
        console.error('[QR] poll exception', e)
        schedule(2000)
      }
    }

    schedule(0)
    return () => {
      pollingRef.current = false
      if (pollTimerRef.current) {
        window.clearTimeout(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }
  }, [loginState, qrToken, authChainCode, lck, stopPolling])

  // 登录成功后清理
  useEffect(() => {
    if (loginState === 'ok') stopPolling()
  }, [loginState, stopPolling])

  if (loginState === 'ok') return null

  return (
    <div className="login-overlay">
      <div className="login-card qr-login-card">
        <div className="qr-login-header">
          <div className="qr-login-badge">
            <Icon name="Lock" size={13} />
            {t('loginBadge')}
          </div>
          <h2 className="qr-login-title">{t('qrTitle')}</h2>
          <p className="qr-login-subtitle">{t('qrSubtitle', { app: appName })}</p>
        </div>

        <div className={`qr-frame ${loading ? 'qr-frame--loading' : ''} ${scanned ? 'qr-frame--scanned' : ''}`}>
          {qrSrc ? (
            <img src={qrSrc} alt={t('qrImageAlt')} className="qr-image" />
          ) : (
            <div className="qr-placeholder">
              {/* 恢复 1.0.38 的 📷 emoji：库 <Icon name="Camera"> 是深色描边线性图标，
                  放在这张奶油色卡片上又硬又小，和「二维码加载中」这句话不是一种气质。 */}
              <span className="qr-placeholder-icon">📷</span>
              <span>{t('qrLoading')}</span>
            </div>
          )}
          {scanned && <div className="qr-scanned-mask">{t('qrScanned')}</div>}
        </div>

        <div className={`qr-status-row ${expired ? 'qr-status-row--expired' : ''} ${scanned ? 'qr-status-row--scanned' : ''}`}>
          <span className={`qr-status-dot ${scanned ? 'qr-status-dot--scanned' : ''} ${expired ? 'qr-status-dot--expired' : ''}`} />
          <span>{t(status, { app: appName })}</span>
        </div>

        {error && <div className="qr-error">{error}</div>}
        {!error && loginError && <div className="qr-error">{loginError}</div>}

        <div className="qr-actions">
          {/* 原生 button + 自建立体样式 → 库 <Button type="primary">，主色跟随主题 */}
          <Button type="primary" onClick={() => fetchQr(true, 6)} disabled={loading}>
            {loading ? t('qrLoadingBtn') : t('qrRefresh')}
          </Button>
        </div>

        <p className="qr-hint">{t('qrHint')}</p>
      </div>
    </div>
  )
}
