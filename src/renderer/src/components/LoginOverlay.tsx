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
  // 2026-10-26：请求序号。任何一次 fetchQr 只有「仍是最新一次」时才允许写 UI ——
  // 退出登录时可能同时有「登录层自动拉码」与「qrRefetchSeq 触发的重拉」，两路并发后
  // 主进程的互斥锁会让后一路复用前一路的结果；若无序号守卫，后一路的副作用（清空二维码、
  // 置成失败态）会覆盖前一路已经渲染好的二维码，界面表现为「有框没码 + 正在重新获取」。
  const fetchSeqRef = useRef(0)
  const lastFetchAtRef = useRef(0)
  /** 二维码「刚拿到就失效」的连续自动重拉计数（正常过期不计数，见 4005 分支） */
  const autoRefreshRef = useRef(0)

  const fetchQr = useCallback(async (forceQr = true, retryLeft = 0) => {
    const seq = ++fetchSeqRef.current
    const alive = () => seq === fetchSeqRef.current
    lastFetchAtRef.current = Date.now()
    console.log('[QR] fetchQr called, loginState=', loginState, 'forceQr=', forceQr, 'seq=', seq)
    stopPolling()
    setLoading(true)
    setError('')
    setLoginError('')
    setScanned(false)
    // 关键：**不清 qrSrc**。旧行为一进来就 setQrSrc('')，于是「重拉码」的瞬间界面上
    // 二维码直接消失（用户截图那种「有框没码 + 登录未完成，正在重新获取二维码…」）。
    // 旧码先留着，新码到了再替换，视觉上不出现空窗。
    setQrToken('')
    setAuthChainCode('')
    setLck('')
    setExpired(false)
    setStatus('qrFetching')
    try {
      console.log('[QR] invoking startQrLogin...')
      // forceQr=true 表示用户手动点击刷新：跳过主进程自动认证判断，直接获取二维码
      const res = await window.mcApi.startQrLogin(forceQr)
      if (!alive()) {
        console.log('[QR] stale response dropped (seq=', seq, ')')
        return
      }
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
          window.setTimeout(() => {
            if (alive()) fetchQr(forceQr, retryLeft - 1)
          }, 5000)
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
      // 过期请求的失败不该污染界面（可能已经有新码在展示）
      if (!alive()) {
        console.log('[QR] stale error dropped:', e?.message)
        return
      }
      const msg = e.message || useStore.getState().t('errQrFetch')
      // 主进程正在并发获取二维码（互斥锁拒绝），稍候自动重试，不向用户报错
      if (/正在获取二维码/.test(msg)) {
        setStatus('qrFetching')
        window.setTimeout(() => {
          if (alive()) fetchQr(forceQr, retryLeft)
        }, 800)
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
      // 800ms 内已经拉过一次就不再重复拉：退出登录会同时触发「本 effect」与
      // 「qrRefetchSeq effect」，两路并发只会让主进程重复跑 QR-START（互斥锁下白等）
      if (Date.now() - lastFetchAtRef.current < 800) return
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
    // 同上：主进程刚下发 logging 让登录层拉过码时，不再叠加第二次 QR-START
    if (Date.now() - lastFetchAtRef.current < 800) return
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
          // 2026-10-27：不再「静默挂死在过期码上」。实测用户没及时扫，60s×3 后收到 4005，
          // 之后界面就一直是这张死码（2026-10-26 13:54 / 22:58 两次，各自挂了数小时无动作）。
          // 这里自动重拉一张新码：正常的「3 分钟自然过期」不计数；只有新码刚拿到就立刻失效
          // （服务端异常）才累计，封顶 5 次，避免 1.2s 一次地空转。
          if (Date.now() - lastFetchAtRef.current > 10_000) autoRefreshRef.current = 0
          if (autoRefreshRef.current < 5) {
            autoRefreshRef.current++
            console.log('[QR] expired(4005) -> auto refresh #', autoRefreshRef.current)
            window.setTimeout(() => {
              if (useStore.getState().loginState !== 'logging') return
              fetchQr(true, 3)
            }, 1200)
          }
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
