/**
 * 1.0.75 #3/#4 回归：登录同步限频与鸿翼子窗口判定。
 * 事故原型：从备份 cookie 恢复会话时 app 判「OA 已登录」，却没触发 edoc2 同步 → 鸿翼一直未登录。
 */
import { describe, expect, it } from 'vitest'
import {
  isWjPage, shouldThrottleLoginSync, isWjSsoIndexUrl,
  isAcLoginPageUrl, isWjSsoShimUrl, isWjIntermediateUrl,
  encodeWjxtCredentials, decodeWjxtCredentials,
  encodeWjxtStore, decodeWjxtStore, upsertWjxtAccount
} from '../wjxtSyncPolicy'

describe('shouldThrottleLoginSync · 三条已登录路径共用限频', () => {
  it('首次同步（last=0）总是允许', () => {
    expect(shouldThrottleLoginSync(1_000_000, 0, 30_000)).toBe(false)
  })
  it('窗口内跳过，边界上（恰好 30s）放行', () => {
    expect(shouldThrottleLoginSync(1_029_999, 1_000_000, 30_000)).toBe(true)
    expect(shouldThrottleLoginSync(1_030_000, 1_000_000, 30_000)).toBe(false)
    expect(shouldThrottleLoginSync(1_030_001, 1_000_000, 30_000)).toBe(false)
  })
  it('minInterval=0 时永不节流', () => {
    expect(shouldThrottleLoginSync(100, 100, 0)).toBe(false)
  })
  it('心跳 / 多个子窗口重复触发时只放第一次', () => {
    let last = 0
    let allowed = 0
    for (const now of [10_000, 10_500, 11_000, 40_001, 40_100, 70_001]) {
      if (!shouldThrottleLoginSync(now, last, 30_000)) { last = now; allowed++ }
    }
    expect(allowed).toBe(3)
  })
})

describe('isWjPage · 子窗口 Loading 兜底只对鸿翼网页版生效', () => {
  it('识别带端口的鸿翼站点', () => {
    expect(isWjPage('https://wj.streamax.com:9443/index.html')).toBe(true)
    expect(isWjPage('https://wj.streamax.com/')).toBe(true)
    expect(isWjPage('https://WJ.STREAMAX.COM:9443/sso/auth/callback?code=x')).toBe(true)
  })
  it('不误伤 IAM 登录页、OA 与明文 http', () => {
    expect(isWjPage('https://iam.streamax.com/ac/#/index?lck=abc&entityId=edoc2')).toBe(false)
    expect(isWjPage('http://oa.streamax.com:8080/ruiming/sso/service.jsp?method=showDocSSO')).toBe(false)
    expect(isWjPage('http://wj.streamax.com:9443/index.html')).toBe(false)
  })
  it('空值 / 形似但非法的域名都不匹配', () => {
    expect(isWjPage('')).toBe(false)
    expect(isWjPage('https://wj.streamax.com.evil.com/')).toBe(false)
    expect(isWjPage('https://evil.com/?next=https://wj.streamax.com/')).toBe(false)
  })
})

/** HAR 实测链：authenticate(200+ssoShim) → callback → jump.html → /index.html#doc/… */
describe('H5 · SSO 换票链各阶段的 URL 判据', () => {
  it('SPA 首页才算换票跑完（含 hash 路由与端口）', () => {
    expect(isWjSsoIndexUrl('https://wj.streamax.com:9443/index.html#doc/enterprise/1')).toBe(true)
    expect(isWjSsoIndexUrl('https://wj.streamax.com/index.html')).toBe(true)
    expect(isWjSsoIndexUrl('')).toBe(false)
  })
  it('jump.html / callback / IAM 都不能算已落回站点首页', () => {
    expect(isWjSsoIndexUrl('https://wj.streamax.com:9443/jump.html?token=abc')).toBe(false)
    expect(isWjSsoIndexUrl('https://wj.streamax.com:9443/sso/auth/callback?code=abc')).toBe(false)
    expect(isWjSsoIndexUrl('https://iam.streamax.com/idp/authCenter/authenticate?client_id=edoc2')).toBe(false)
  })
  it('AC 登录页 = IAM 会话过期，需要人扫码', () => {
    expect(isAcLoginPageUrl('https://iam.streamax.com/ac/#/index?lck=ctx&entityId=edoc2')).toBe(true)
    expect(isAcLoginPageUrl('https://iam.streamax.com/idp/authCenter/authenticate?client_id=edoc2')).toBe(false)
  })
  it('authenticate 是 200+ssoShim 中间态，不能被当作「未登录」重导航', () => {
    expect(isWjSsoShimUrl('https://iam.streamax.com/idp/authCenter/authenticate?client_id=edoc2&state=Q7u')).toBe(true)
    expect(isWjSsoShimUrl('https://wj.streamax.com:9443/index.html')).toBe(false)
  })
  it('站点内中间页（callback / jump.html）不能算会话已建立', () => {
    expect(isWjIntermediateUrl('https://wj.streamax.com:9443/sso/auth/callback?code=a00dd96f')).toBe(true)
    expect(isWjIntermediateUrl('https://wj.streamax.com:9443/jump.html?token=0032bba7')).toBe(true)
    expect(isWjIntermediateUrl('https://wj.streamax.com:9443/index.html#doc/enterprise/1')).toBe(false)
  })
})

/** 1.0.75：账密序列化边界（密文落盘由 wjxtCredentials.ts 用 safeStorage 完成） */
describe('WJXT 账密序列化', () => {
  it('正常往返，用户名去掉首尾空白，密码原样保留', () => {
    const raw = encodeWjxtCredentials({ username: '  sean  ', password: 'p@ss"word\\x' })
    expect(raw).not.toBeNull()
    expect(decodeWjxtCredentials(raw!)).toEqual({ username: 'sean', password: 'p@ss"word\\x' })
  })
  it('中文与特殊字符不丢', () => {
    const raw = encodeWjxtCredentials({ username: '毛祖潇', password: '中 文!@#$%^&*()' })
    expect(decodeWjxtCredentials(raw!)).toEqual({ username: '毛祖潇', password: '中 文!@#$%^&*()' })
  })
  it('空用户名 / 空密码一律不生成凭据（避免把错误密码存下来）', () => {
    expect(encodeWjxtCredentials({ username: '', password: 'x' })).toBeNull()
    expect(encodeWjxtCredentials({ username: 'sean', password: '' })).toBeNull()
  })
  it('损坏密文 / 缺字段 / 旧格式都当作没有凭据', () => {
    expect(decodeWjxtCredentials('not-json')).toBeNull()
    expect(decodeWjxtCredentials('{"username":"sean"}')).toBeNull()
    expect(decodeWjxtCredentials('{"username":"","password":"x"}')).toBeNull()
    expect(decodeWjxtCredentials('')).toBeNull()
  })
  it('密码更新后再编码会覆盖旧值（登录成功时保存最后一次提交 → 实时更新）', () => {
    const before = encodeWjxtCredentials({ username: 'sean', password: 'old-pass' })
    const after = encodeWjxtCredentials({ username: 'sean', password: 'new-pass' })
    expect(before).not.toBe(after)
    expect(decodeWjxtCredentials(after!)?.password).toBe('new-pass')
  })
})

/** 1.0.75：多账号下拉所需的 store 序列化兼容与 upsert */
describe('WJXT 多账号存储', () => {
  it('多账号 store 正常往返', () => {
    const raw = encodeWjxtStore({
      current: 'b@streamax.com',
      accounts: [
        { username: 'a@streamax.com', password: 'p1' },
        { username: 'b@streamax.com', password: 'p2' }
      ]
    })
    const store = decodeWjxtStore(raw!)
    expect(store?.current).toBe('b@streamax.com')
    expect(store?.accounts).toHaveLength(2)
  })
  it('兼容 1.0.75 早期的单账号密文', () => {
    const legacy = encodeWjxtCredentials({ username: 'sean', password: 'pw' })
    const store = decodeWjxtStore(legacy!)
    expect(store).toEqual({ current: 'sean', accounts: [{ username: 'sean', password: 'pw' }] })
  })
  it('current 不在列表里时回落第一个账号', () => {
    const raw = encodeWjxtStore({ current: 'ghost', accounts: [{ username: 'real', password: 'p' }] })
    expect(decodeWjxtStore(raw!)?.current).toBe('real')
  })
  it('同账号改密码 → 覆盖并设为当前；不同账号 → 追加（下拉框就有多个）', () => {
    const s1 = upsertWjxtAccount(null, { username: 'a', password: 'old' })
    const s2 = upsertWjxtAccount(s1, { username: 'b', password: 'pwB' })
    expect(s2?.accounts.map(a => a.username)).toEqual(['b', 'a'])
    expect(s2?.current).toBe('b')
    const s3 = upsertWjxtAccount(s2, { username: 'a', password: 'new' })
    expect(s3?.accounts.find(a => a.username === 'a')?.password).toBe('new')
    expect(s3?.current).toBe('a')
    expect(s3?.accounts).toHaveLength(2)
  })
  it('最多保留 10 个账号，空账密不写入', () => {
    let s: any = null
    for (let i = 0; i < 14; i++) s = upsertWjxtAccount(s, { username: `u${i}`, password: 'p' })
    expect(s.accounts).toHaveLength(10)
    expect(upsertWjxtAccount(s, { username: '', password: 'x' })).toBeNull()
    expect(encodeWjxtStore({ current: '', accounts: [] })).toBeNull()
  })
  it('损坏密文返回 null，不抛异常', () => {
    expect(decodeWjxtStore('{oops')).toBeNull()
    expect(decodeWjxtStore('{"accounts":[]}')).toBeNull()
  })
})
