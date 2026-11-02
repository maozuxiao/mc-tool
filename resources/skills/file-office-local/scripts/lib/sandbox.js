'use strict'
// 路径沙箱：所有文件操作必须先过这里。
// AI 给出的路径不可信（可能来自被读取文件里的提示注入），
// 必须保证解析后的真实路径仍落在工作区根目录内。
const fs = require('fs')
const path = require('path')
const os = require('os')

class SandboxError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'SandboxError'
    this.code = code || 'PATH_OUTSIDE_ROOT'
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
  if (!target || typeof target !== 'string') throw new SandboxError('路径不能为空', 'INVALID_PATH')
  // 入口就清洗（1.0.69）：全角斜杠 / NBSP 会让 path.resolve 把整串当成**一个文件名**，
  // 得到一条被污染的绝对路径 —— 之后再怎么在 finalize 里救都救不回来。
  const targetStr = cleanPathString(String(target))
  if (/[\u0000-\u001f]/.test(targetStr)) throw new SandboxError('路径包含非法字符', 'INVALID_PATH')

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
    if (!isInside(rootAbs, real)) throw new SandboxError(
      `路径越界：${targetStr} 解析后指向工作区之外。如需写入桌面，请用 desktop/ 前缀（如 desktop/表格.xlsx）。`,
      'PATH_OUTSIDE_ROOT'
    )
    return finalize(real, targetStr, opts)
  }

  // 工作区外：仅「显式绝对路径」放行（Build 模式承诺可访问本机任意文件），且不得是受保护系统目录
  const isExplicitAbs = path.isAbsolute(targetStr) || /^[a-zA-Z]:[\\/]/.test(targetStr) || targetStr.startsWith('/')
  if (isExplicitAbs) {
    if (isProtectedDir(abs)) throw new SandboxError(`该目录受保护，不允许访问（系统目录）：${targetStr}`, 'DIR_BLOCKED')
    const real = resolveSymlink(abs)
    if (isProtectedDir(real)) throw new SandboxError(`该目录受保护，不允许访问（系统目录）：${targetStr}`, 'DIR_BLOCKED')
    return finalize(real, targetStr, opts)
  }

  // 其余（如 ../ 逃逸、相对路径解析到工作区外）一律拒绝
  throw new SandboxError(
    `路径越界：${targetStr} 不在已授权工作区 ${rootAbs} 内。` +
    `如需写入桌面，请用 desktop/ 前缀（如 desktop/表格.xlsx），不要自己猜绝对路径；` +
    `其他目录请用 open_folder 打开后用「别名/路径」引用，或直接使用绝对路径。`,
    'PATH_OUTSIDE_ROOT'
  )
}

// ── 路径容错（1.0.69）──────────────────────────────────────
/**
 * 清洗路径里的「看不见的字符」。
 *
 * 实测事故：用户报「路径读取 bug —— 明明存在的路径却说路径不存在」，
 * 报错路径 `E:\Program Files\mc-material-query\resources\skills\ceiba2-api-qa\references\api_reference.md`
 * 在磁盘上确实存在（手动核验通过），同一路径稍后又读取成功。
 * 这类「时好时坏、路径看着完全一样」的失败，绝大多数是模型从网页/文档里抄路径时
 * 混进了 NBSP(U+00A0)、零宽空格、全角斜杠/空格 —— 打印出来与正常路径一模一样。
 * Windows 的文件名本身不允许尾随空格与点，所以去掉它们是安全的。
 */
function cleanPathString(p) {
  let s = String(p || '')
  s = s.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')            // 零宽字符 / BOM / 软连字符
  s = s.replace(/[\u00A0\u2007\u202F\u3000]/g, ' ')            // NBSP / 全角空格 → 普通空格
  s = s.replace(/\uFF3C/g, '\\').replace(/\uFF0F/g, '/')       // 全角斜杠（只能当分隔符，不会出现在合法文件名里）
  s = s.replace(/[ \t]+$/, '')                                  // 尾随空白
  if (/^[a-zA-Z]:\\/.test(s)) s = s.replace(/\\{2,}/g, '\\')    // E:\\a → E:\a（不动 UNC 开头 \\\\）
  return s
}

/**
 * 激进清洗：把全角字母/数字/括号等一并转成半角。
 * **只能用在「原样路径确实找不到」之后的救援阶段** —— 中文文件名大量使用全角括号
 * （`报告（终版）.xlsx`），入口就无脑转换会把本来正确的路径改坏。
 */
function cleanPathFull(p) {
  let s = cleanPathString(p)
  s = s.replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  s = s.replace(/[ \t]+$/, '')
  if (/^[a-zA-Z]:\\/.test(s)) s = s.replace(/\\{2,}/g, '\\')
  return s
}

/**
 * 存在性「救援」：直接 existsSync 失败后，再用清洗版 + 逐段大小写/空白模糊匹配找一次。
 * 只在 mustExist 判定失败时调用，命中则返回磁盘上真实存在的路径（调用方后续读取用它）。
 * 安全性：只在原路径的祖先目录内做归一化匹配，不会跑出原路径所在目录树。
 */
function rescueExisting(abs) {
  // 先用「激进清洗」版本试一次：全角括号/字母/数字被写成半角（或反之）都在这里救回
  const clean = cleanPathFull(abs)
  if (clean && clean !== abs && fs.existsSync(clean)) return clean

  // 归一化：忽略大小写、空白、下划线/连字符（模型常把 `api_reference` 写成 `api reference`），
  // 两侧都做全角→半角，保证「全角括号」与「半角括号」互相可匹配
  const norm = (s) => cleanPathFull(String(s)).toLowerCase().replace(/[\s_\-]/g, '')
  const m = /^([a-zA-Z]:)([\\/][\s\S]*)$/.exec(clean || abs)
  if (!m) return ''
  const segs = m[2].split(/[\\/]+/).filter(Boolean)
  let cur = m[1] + '\\'
  for (const seg of segs) {
    const direct = path.join(cur, seg)
    if (fs.existsSync(direct)) { cur = direct; continue }
    let hit = ''
    try {
      const entries = fs.readdirSync(cur)
      const key = norm(seg)
      const same = entries.filter(e => norm(e) === key)
      if (same.length === 1) hit = same[0]
      else if (!same.length) {
        // 前后缀包含（容忍多/少一个字符）：同样只在**唯一命中**时采纳，绝不猜
        const cands = entries.filter(e => norm(e).startsWith(key) || key.startsWith(norm(e)))
        if (cands.length === 1) hit = cands[0]
      }
    } catch { return '' }
    if (!hit) return ''
    cur = path.join(cur, hit)
  }
  return fs.existsSync(cur) ? cur : ''
}

/** 找不到时的诊断：说清「实际解析成了什么」「最近哪个上级目录存在」「里面有啥」 */
function missingHint(abs, targetStr) {
  const clean = cleanPathString(abs)
  const parts = []
  if (clean !== abs) parts.push('路径里含不可见字符（NBSP / 零宽 / 全角），已清洗后仍未找到')
  let dir = path.dirname(clean || abs)
  for (let i = 0; i < 8; i++) {
    const parent = path.dirname(dir)
    if (!parent || parent === dir) break
    if (fs.existsSync(dir)) {
      let names = []
      try { names = fs.readdirSync(dir).slice(0, 12) } catch { /* 无权限列举 */ }
      parts.push(`最近存在的上级目录：${dir}`)
      if (names.length) parts.push(`该目录下有：${names.join('、')}`)
      else parts.push('（该目录为空或无权限列举）')
      break
    }
    dir = parent
  }
  if (!parts.length) parts.push(`无法定位任何存在的上级目录，请确认盘符 ${clean.slice(0, 2)} 是否可用`)
  return '。诊断：' + parts.join('；')
}

// 必须存在校验，统一收尾
function finalize(abs, targetStr, opts) {
  if (opts.mustExist && !fs.existsSync(abs)) {
    const rescued = rescueExisting(abs)
    if (rescued) return rescued
    const shown = abs !== targetStr ? `（实际解析为 ${abs}）` : ''
    throw new SandboxError(`路径不存在：${targetStr}${shown}${missingHint(abs, targetStr)}`, 'PATH_NOT_FOUND')
  }
  return abs
}

module.exports = { SandboxError, resolveSafe, isInside, cleanPathString, rescueExisting }
