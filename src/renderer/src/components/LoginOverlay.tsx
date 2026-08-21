import { useEffect, useRef, useState, useCallback } from 'react'

interface Props {
  loginState: 'checking' | 'logging' | 'failed' | 'ok'
}

const MAX_POLL_MS = 3 * 60 * 1000 // 最多轮询 3 分钟

export function LoginOverlay({ loginState }: Props) {
  const [qrSrc, setQrSrc] = useState('')
  const [qrToken, setQrToken] = useState('')
  const [authChainCode, setAuthChainCode] = useState('')
  const [lck, setLck] = useState('')
  const [status, setStatus] = useState('准备二维码...')
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
  const fetchQr = useCallback(async (forceQr = true) => {
    console.log('[QR] fetchQr called, loginState=', loginState, 'forceQr=', forceQr)
    stopPolling()
    setLoading(true)
    setError('')
    setScanned(false)
    setQrSrc('')
    setQrToken('')
    setAuthChainCode('')
    setLck('')
    setExpired(false)
    setStatus('正在获取二维码...')
    try {
      console.log('[QR] invoking startQrLogin...')
      // forceQr=true 表示用户手动点击刷新：跳过主进程自动认证判断，直接获取二维码
      const res = await window.mcApi.startQrLogin(forceQr)
      console.log('[QR] startQrLogin result=', res)
      if (!res.success) throw new Error(res.message || '获取二维码失败')
      const token = res.qrToken || res.data?.qrToken
      const msg = res.qrMsg || res.data?.qrMessage || res.data?.qrMsg || res.data?.qrData
      if (!token || !msg) throw new Error('二维码数据不完整')
      setQrToken(token)
      setAuthChainCode(res.authChainCode || res.data?.authChainCode || '')
      setLck(res.lck || res.data?.lck || '')
      setQrSrc(buildQrSrc(msg))
      setStatus('请使用 OA 手机 App 扫码登录')
      setLoading(false)
    } catch (e: any) {
      const msg = e.message || '获取二维码失败'
      // 主进程正在并发获取二维码（互斥锁拒绝），稍候自动重试，不向用户报错
      if (/正在获取二维码/.test(msg)) {
        setStatus('正在获取二维码...')
        window.setTimeout(() => fetchQr(forceQr), 800)
        return
      }
      setError(msg)
      setStatus('获取二维码失败')
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
      fetchQr()
    }
  }, [loginState, qrToken, fetchQr])

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
        setStatus('二维码已过期，请点击刷新重试')
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
          setStatus('登录成功，正在进入工具...')
          // 不立即 reloadLogin：主进程会在 SSO 落地 OA 会话后主动推送 OA_CHECK_LOGGED。
          // 若 8s 内未收到（SSO 失败），再主动检测一次，届时失败会回到二维码重试。
          window.setTimeout(() => {
            window.mcApi.reloadLogin()
          }, 8000)
          return
        }

        if (poll.data?.status === 'scanned' || poll.scanned) {
          setScanned(true)
          setStatus('已扫码，请在手机上确认登录')
          schedule(1000)
          return
        }

        // 4005 "二维码已失效"：之前由并发覆盖引起所以继续等待；但当前已改为串行轮询，
        // 若仍收到 4005 说明二维码确实失效（过期/被使用），标记过期并提示刷新。
        if (poll.code === 4005 || poll.code === '4005') {
          pollingRef.current = false
          setExpired(true)
          setError('')
          setStatus('二维码已失效，请点击刷新重试')
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
          setError(poll.message || '轮询失败')
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
    <div className="login-overlay show">
      <div className="login-card qr-login-card">
        <div className="qr-login-header">
          <div className="qr-login-badge">OA 登录</div>
          <h2 className="qr-login-title">扫码登录</h2>
          <p className="qr-login-subtitle">请使用 OA 手机 App 扫描二维码</p>
        </div>

        <div className={`qr-frame ${loading ? 'qr-frame--loading' : ''} ${scanned ? 'qr-frame--scanned' : ''}`}>
          {qrSrc ? (
            <img src={qrSrc} alt="OA 登录二维码" className="qr-image" />
          ) : (
            <div className="qr-placeholder">
              <span className="qr-placeholder-icon">📷</span>
              <span>二维码加载中</span>
            </div>
          )}
          {scanned && <div className="qr-scanned-mask">已扫码</div>}
        </div>

        <div className={`qr-status-row ${expired ? 'qr-status-row--expired' : ''} ${scanned ? 'qr-status-row--scanned' : ''}`}>
          <span className={`qr-status-dot ${scanned ? 'qr-status-dot--scanned' : ''} ${expired ? 'qr-status-dot--expired' : ''}`} />
          <span className="qr-status-text">{status}</span>
        </div>

        {error && <div className="qr-error">{error}</div>}

        <div className="qr-actions">
          <button
            className="animal-btn animal-btn--primary"
            onClick={() => fetchQr(true)}
            disabled={loading}
          >
            {loading ? '加载中...' : '刷新二维码'}
          </button>
        </div>

        <p className="qr-hint">如果长时间未跳转，请确保手机已完成确认登录</p>
      </div>
    </div>
  )
}
