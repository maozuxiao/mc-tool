'use strict'
// 路径沙箱：所有文件操作必须先过这里。
// AI 给出的路径不可信（可能来自被读取文件里的提示注入），
// 必须保证解析后的真实路径仍落在工作区根目录内。
const fs = require('fs')
const path = require('path')

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

/**
 * 把用户/模型给出的路径解析为「安全绝对路径」。
 * - 相对路径按 root 解析
 * - 解析符号链接后再校验，防止软链接把操作引出工作区
 * - 文件不存在时 realpathSync 会抛错，此时退回落款但依然做前缀校验
 * @param {string} root   工作区根目录（绝对路径）
 * @param {string} target 待校验路径（绝对或相对）
 * @param {{ mustExist?: boolean, allowMissing?: boolean }} opts
 * @returns {string} 安全的真实绝对路径
 */
function resolveSafe(root, target, opts = {}) {
  if (!root) throw new SandboxError('未指定工作区根目录（--root）')
  if (!target || typeof target !== 'string') throw new SandboxError('路径不能为空')
  // 拒绝 NUL 与控制字符，避免底层 fs 调用出现不可预期行为
  if (/[\u0000-\u001f]/.test(target)) throw new SandboxError('路径包含非法字符')

  const rootAbs = path.resolve(root)
  const abs = path.resolve(rootAbs, target)

  // 先按字面路径校验一次（目标不存在时也能提前拦住 ../ 逃逸）
  if (!isInside(rootAbs, abs)) {
    throw new SandboxError(`路径越界：${target} 不在工作区 ${rootAbs} 内`)
  }

  // 再解析符号链接做二次校验：软链接可能指向工作区之外
  let realRoot = rootAbs
  let realAbs = abs
  try { realRoot = fs.realpathSync(rootAbs) } catch { /* 根目录异常时保持字面值 */ }
  try { realAbs = fs.realpathSync(abs) } catch (e) {
    if (e && e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e
    // 目标不存在：可能是新建写入，允许，但要用其父目录的真实路径兜底
    let parent = path.dirname(abs)
    try {
      const realParent = fs.realpathSync(parent)
      if (!isInside(realRoot, realParent)) {
        throw new SandboxError(`路径越界：${target} 的父目录不在工作区内`)
      }
      realAbs = path.join(realParent, path.basename(abs))
    } catch (err) {
      if (err instanceof SandboxError) throw err
      throw new SandboxError(`路径不可访问：${target}`)
    }
  }

  if (!isInside(realRoot, realAbs)) {
    throw new SandboxError(`路径越界：${target} 解析后指向工作区之外`)
  }
  if (opts.mustExist && !fs.existsSync(realAbs)) {
    throw new SandboxError(`路径不存在：${target}`)
  }
  return realAbs
}

module.exports = { SandboxError, resolveSafe, isInside }
