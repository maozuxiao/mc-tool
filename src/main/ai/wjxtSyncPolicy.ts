/**
 * 1.0.75 · 鸿翼登录同步策略（纯函数，不依赖 electron，便于 vitest 直接单测）
 *
 * 场景：OA 判定「已登录」有三条路径（扫码成功 / 备份 cookie 恢复 / 心跳静默自愈），
 * 三条都要顺手把 edoc2 会话建起来；但心跳与多个子窗口会重复触发，所以要有统一限频。
 */

/** 距上次同步不足 minIntervalMs 时跳过；首次（last=0）总是允许 */
export function shouldThrottleLoginSync(now: number, last: number, minIntervalMs: number): boolean {
  // last<=0 表示从未同步过，必须放行（真实时钟下 Date.now() 远大于 30s，但小时间戳单测会暴露边界）
  if (last <= 0) return false
  return now - last < minIntervalMs
}

/** 是否鸿翼网页版页面（OA「文件管理」子窗口 Loading 兜底只对它生效） */
export function isWjPage(url: string): boolean {
  return /^https:\/\/wj\.streamax\.com(:\d+)?\//i.test(String(url || ''))
}

/**
 * 1.0.75 H5：SSO 换票链跑完的落点 —— 站点 SPA 首页。
 * HAR 实测终点 `https://wj.streamax.com:9443/index.html#doc/enterprise/1`。
 */
export function isWjSsoIndexUrl(url: string): boolean {
  return /^https:\/\/wj\.streamax\.com(:\d+)?\/index\.html/i.test(String(url || ''))
}

/** IAM 的 AC 登录页：会话已过期，需要人扫码，别再空等换票 */
export function isAcLoginPageUrl(url: string): boolean {
  return /iam\.streamax\.com\/ac\/#\/index\?lck=/i.test(String(url || ''))
}

/** IAM authenticate：200 + ssoShim 自动提交脚本的**中间态**，不是「未登录」 */
export function isWjSsoShimUrl(url: string): boolean {
  return /iam\.streamax\.com\/idp\/authCenter\/authenticate/i.test(String(url || ''))
}

/** 站点内换票中间页（callback / jump.html），命中不等于会话已建立 */
export function isWjIntermediateUrl(url: string): boolean {
  const s = String(url || '')
  return /\/sso\/auth\//i.test(s) || /\/jump\.html/i.test(s)
}

// ── 文件系统账密（1.0.75，用户明确要求保存并自动更新）────────────────────
// 这里只放纯序列化逻辑，密文落盘由 wjxtCredentials.ts 用 safeStorage 完成，
// 这样加解密边界可单测，且任何明文都不会经过日志。
export interface WjxtCredentials {
  username: string
  password: string
}

export function encodeWjxtCredentials(c: WjxtCredentials): string | null {
  const u = String(c?.username || '').trim()
  const p = String(c?.password || '')
  if (!u || !p) return null
  return JSON.stringify({ username: u, password: p })
}

export function decodeWjxtCredentials(raw: string): WjxtCredentials | null {
  try {
    const o = JSON.parse(String(raw || ''))
    if (o && typeof o.username === 'string' && typeof o.password === 'string'
      && o.username.trim() && o.password) {
      return { username: o.username, password: o.password }
    }
  } catch { /* 密文损坏 / 旧格式 → 当作没有凭据 */ }
  return null
}

// ── 多账号（1.0.75：用户要求「多个账号密码应该有下拉框供选择」）──────────────
export interface WjxtCredentialStore {
  /** 当前默认账号（username），必须是 accounts 里某一个 */
  current: string
  accounts: WjxtCredentials[]
}

export function encodeWjxtStore(store: WjxtCredentialStore): string | null {
  try {
    const accounts = (store?.accounts || []).filter(
      a => a && String(a.username || '').trim() && String(a.password || '')
    )
    if (!accounts.length) return null
    const current = accounts.some(a => a.username === store.current)
      ? store.current
      : accounts[0].username
    return JSON.stringify({ current, accounts })
  } catch { return null }
}

/** 兼容 1.0.75 早期的单账号密文 `{username,password}` */
export function decodeWjxtStore(raw: string): WjxtCredentialStore | null {
  try {
    const o = JSON.parse(String(raw || ''))
    if (!o || typeof o !== 'object') return null
    if (Array.isArray(o.accounts)) {
      const accounts = o.accounts.filter(
        (a: any) => a && typeof a.username === 'string' && typeof a.password === 'string'
          && a.username.trim() && a.password
      )
      if (!accounts.length) return null
      const current = accounts.some((a: WjxtCredentials) => a.username === o.current)
        ? o.current : accounts[0].username
      return { current, accounts }
    }
    const one = decodeWjxtCredentials(raw)
    return one ? { current: one.username, accounts: [one] } : null
  } catch { return null }
}

/** 登录成功后 upsert：同账号覆盖密码并设为当前，不同账号追加（最多 10 个） */
export function upsertWjxtAccount(
  store: WjxtCredentialStore | null, c: WjxtCredentials
): WjxtCredentialStore | null {
  const u = String(c?.username || '').trim()
  const p = String(c?.password || '')
  if (!u || !p) return null
  const rest = (store?.accounts || []).filter(a => a.username !== u)
  return { current: u, accounts: [{ username: u, password: p }, ...rest].slice(0, 10) }
}
