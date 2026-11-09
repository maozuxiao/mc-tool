/**
 * 1.0.75 · 文件系统（edoc2）账密的**本机加密存储**（支持多账号）。
 *
 * 用户明确要求：「我输入的账密可以保存，下次如果账密更新也要实时更新」，
 * 以及「如果有多个账号密码，应该存在一个下拉框供选择」。
 * 因此恢复 1.0.48 曾因「越权 + 页面结构脆弱」而移除的保存能力，但口径完全不同：
 *   - 只用 Electron `safeStorage`（Windows 上是 DPAPI，密文绑定当前 Windows 用户），
 *     **绝不写明文**；加密不可用时宁可不保存，也不降级成明文文件；
 *   - 只在**登录成功后** upsert 最后一次提交的值 —— 同账号改密码即覆盖，
 *     不同账号追加（最多 10 个）并设为当前；错误密码不会被记住；
 *   - 兼容 1.0.75 早期的单账号密文 `{username,password}`，自动升级成账号列表；
 *   - 账密不进任何日志、不上传、不随会话同步；文件名与旧的 `wjxt-login.json` 区分，
 *     避免被启动时的旧文件清理逻辑误删。
 */
import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  decodeWjxtStore, encodeWjxtStore, upsertWjxtAccount,
  type WjxtCredentials, type WjxtCredentialStore
} from './wjxtSyncPolicy'

function credentialPath(): string {
  return join(app.getPath('userData'), 'wjxt-credentials.bin')
}

export function loadWjxtStore(): WjxtCredentialStore | null {
  try {
    const p = credentialPath()
    if (!existsSync(p)) return null
    if (!safeStorage.isEncryptionAvailable()) return null
    return decodeWjxtStore(safeStorage.decryptString(readFileSync(p)))
  } catch {
    // 密文损坏 / 换过 Windows 账号 / 旧格式 —— 当作没有凭据，走手动登录
    return null
  }
}

/** 当前默认账号（自动填充用它） */
export function loadWjxtCredentials(): WjxtCredentials | null {
  const store = loadWjxtStore()
  if (!store) return null
  return store.accounts.find(a => a.username === store.current) || store.accounts[0] || null
}

/** 全部已保存账号（登录窗口的下拉框用它） */
export function loadWjxtAccounts(): WjxtCredentials[] {
  return loadWjxtStore()?.accounts || []
}

export function hasWjxtCredentials(): boolean {
  return loadWjxtCredentials() !== null
}

/** 登录成功后调用：同账号覆盖密码，不同账号追加并设为当前 */
export function saveWjxtCredentials(c: WjxtCredentials): boolean {
  const next = upsertWjxtAccount(loadWjxtStore(), c)
  const plain = next ? encodeWjxtStore(next) : null
  if (!plain) return false
  try {
    if (!safeStorage.isEncryptionAvailable()) return false
    const p = credentialPath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, safeStorage.encryptString(plain), { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

export function clearWjxtCredentials(): void {
  try {
    const p = credentialPath()
    if (existsSync(p)) unlinkSync(p)
  } catch { /* ignore */ }
}
