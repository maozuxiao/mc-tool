import { app } from 'electron'
import { homedir } from 'os'
import { basename, existsSync, join, resolve } from 'path'

export interface AllowedRoot {
  /** 空字符串表示主工作区（裸相对路径）；其余为额外目录的别名 */
  alias: string
  /** 绝对路径 */
  path: string
}

// Windows 路径大小写不敏感，比较前统一小写；分隔符统一为正斜杠再比较前缀
export function isInside(root: string, target: string): boolean {
  const r = resolve(root).replace(/\\/g, '/').toLowerCase()
  const t = resolve(target).replace(/\\/g, '/').toLowerCase()
  return t === r || t.startsWith(r + '/')
}

// 受保护的系统目录：不允许作为 AI 可访问目录（防止把整台机器交给模型）
export function dirBlockReason(dir: string): string | null {
  const d = resolve(dir).replace(/\\/g, '/').toLowerCase()
  const sysDrive = resolve(process.env.SystemDrive || 'C:\\').replace(/\\/g, '/').toLowerCase()
  if (d === sysDrive || d.startsWith(sysDrive + '/windows')) return 'SYSTEM_WINDOWS'
  const resDir = (app.isPackaged ? process.resourcesPath : app.getAppPath()).replace(/\\/g, '/').toLowerCase()
  if (d.startsWith(resDir)) return 'APP_RESOURCES'
  const userData = app.getPath('userData').replace(/\\/g, '/').toLowerCase()
  if (d.startsWith(userData)) return 'APP_DATA'
  const home = homedir().replace(/\\/g, '/').toLowerCase()
  if (d === home) return 'HOME'
  return null
}

// 由目录名生成合法别名（只允许字母数字下划线连字符），冲突自动加 -2
export function makeAlias(dir: string, roots: AllowedRoot[]): string {
  let base = basename(dir).replace(/[^A-Za-z0-9_-]/g, '_').toLowerCase() || 'dir'
  const used = new Set(roots.map(r => r.alias))
  if (!used.has(base)) return base
  let i = 2
  while (used.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

// 预置系统特殊目录：当前仅「桌面」。用 app.getPath('desktop') 动态取真实桌面路径，
// 自动处理 Windows 桌面被 OneDrive 重定向（C:/Users/xxx/OneDrive/Desktop）的情况，
// 不写死路径。桌面是 HOME 子目录，dirBlockReason 不拦截，可安全预置为 Build 模式默认可写别名。
// 异常时回退到 homedir()/Desktop，再不行则返回空数组（不预置，不影响其他逻辑）。
export function systemRoots(): AllowedRoot[] {
  try {
    const desktop = app.getPath('desktop')
    if (desktop) return [{ alias: 'desktop', path: desktop }]
  } catch {
    // app.getPath 在极少数环境会抛错，走兜底
  }
  const fallback = join(homedir(), 'Desktop')
  return existsSync(fallback) ? [{ alias: 'desktop', path: fallback }] : []
}
