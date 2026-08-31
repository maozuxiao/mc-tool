'use strict'
// 路径沙箱：所有文件操作必须先过这里。
// AI 给出的路径不可信（可能来自被读取文件里的提示注入），
// 必须保证解析后的真实路径仍落在工作区根目录内。
const fs = require('fs')
const path = require('path')
const os = require('os')

class SandboxError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SandboxError'
    this.code = 'PATH_OUTSIDE_ROOT'
  }
}

// Windows 路径大小写不敏感，比较前统一小写；分隔符统一为正斜杠再比较前缀
function normalizeForCompare(p) {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase()
}

function isInside(root, target) {
  const r = normalizeForCompare(root)
  const t = normalizeForCompare(target)
  return t === r || t.startsWith(r + '/')
}

// 受保护的系统目录：即便显式给出绝对路径也不允许读写，避免写坏系统
function isProtectedDir(abs) {
  const d = normalizeForCompare(abs)
  const sysDrive = normalizeForCompare(process.env.SystemDrive || 'C:\\')
  if (d === sysDrive) return true
  if (d.startsWith(sysDrive + '/windows')) return true
  return false
}

// 生成候选绝对路径，兼顾「相对 root 解析 / 误加的 root 目录名前缀 / 显式绝对路径 / 用户主目录」
function buildCandidates(rootAbs, target) {
  const cands = []
  if (rootAbs) {
    cands.push(path.resolve(rootAbs, target)) // 标准：相对 root 解析
    const segs = String(target).split(/[\\/]/).filter(Boolean)
    // 模型可能把「绝对路径」错拼成「<root目录名>/子路径」（如 root=Desktop 时给 desktop/foo）
    if (segs.length && segs[0].toLowerCase() === path.basename(rootAbs).toLowerCase()) {
      cands.push(path.resolve(rootAbs, segs.slice(1).join('/')))
    }
  } else {
    cands.push(path.resolve(String(target))) // OpenCode：绝对路径或相对 cwd
    const home = os.homedir()
    cands.push(path.join(home, String(target))) // 尝试用户主目录下（Desktop/下载 等）
    const segs = String(target).split(/[\\/]/).filter(Boolean)
    if (segs.length > 1) cands.push(path.join(home, segs.slice(1).join('/')))
  }
  // 显式绝对路径（无论是否设 root）都给一次机会，支持访问工作区之外的文件
  if (/^[a-zA-Z]:[\\/]/.test(String(target)) || String(target).startsWith('/')) {
    cands.push(path.resolve(String(target)))
  }
  return cands
}

// 优先取存在的候选；都不存在时返回标准解析结果（便于新建写入落到预期位置）
function pickCandidate(cands, target) {
  const hit = cands.find(c => fs.existsSync(c))
  if (hit) return hit
  return cands[0]
}

function resolveSymlink(abs) {
  try { return fs.realpathSync(abs) } catch (e) {
    if (e && e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e
    return abs
  }
}

/**
 * 把用户/模型给出的路径解析为「安全绝对路径」。
 * - 相对路径按 root 解析（工作区默认根）
 * - 解析符号链接后再校验，防止软链接把操作引出工作区
 * - Build 模式承诺可访问本机任意文件：模型给的「显式绝对路径」一律放行，
 *   仅拦截受保护的系统目录（C:\Windows 等）；目录名前缀被误加时自动纠正。
 * @param {string} root   工作区根目录（绝对路径）；空字符串表示 OpenCode 全文件系统模式
 * @param {string} target 待校验路径（绝对或相对）
 * @param {{ mustExist?: boolean }} opts
 * @returns {string} 安全的真实绝对路径
 */
function resolveSafe(root, target, opts = {}) {
  if (!target || typeof target !== 'string') throw new SandboxError('路径不能为空')
  if (/[\u0000-\u001f]/.test(target)) throw new SandboxError('路径包含非法字符')

  const targetStr = String(target)

  // OpenCode 模式：不限制工作区，允许本机任意文件/目录
  if (!root) {
    const abs = pickCandidate(buildCandidates('', targetStr), targetStr)
    return finalize(abs, targetStr, opts)
  }

  const rootAbs = path.resolve(root)
  const abs = pickCandidate(buildCandidates(rootAbs, targetStr), targetStr)

  // 落在工作区内：解析软链接后再做一次越界校验即可放行
  if (isInside(rootAbs, abs)) {
    const real = resolveSymlink(abs)
    if (!isInside(rootAbs, real)) throw new SandboxError(`路径越界：${targetStr} 解析后指向工作区之外`)
    return finalize(real, targetStr, opts)
  }

  // 工作区外：仅「显式绝对路径」放行（Build 模式承诺可访问本机任意文件），且不得是受保护系统目录
  const isExplicitAbs = path.isAbsolute(targetStr) || /^[a-zA-Z]:[\\/]/.test(targetStr) || targetStr.startsWith('/')
  if (isExplicitAbs) {
    if (isProtectedDir(abs)) throw new SandboxError(`该目录受保护，不允许访问（系统目录）：${targetStr}`)
    const real = resolveSymlink(abs)
    if (isProtectedDir(real)) throw new SandboxError(`该目录受保护，不允许访问（系统目录）：${targetStr}`)
    return finalize(real, targetStr, opts)
  }

  // 其余（如 ../ 逃逸、相对路径解析到工作区外）一律拒绝
  throw new SandboxError(`路径越界：${targetStr} 不在工作区 ${rootAbs} 内`)
}

// 必须存在校验，统一收尾
function finalize(abs, targetStr, opts) {
  if (opts.mustExist && !fs.existsSync(abs)) {
    throw new SandboxError(`路径不存在：${targetStr}`)
  }
  return abs
}

module.exports = { SandboxError, resolveSafe, isInside }
