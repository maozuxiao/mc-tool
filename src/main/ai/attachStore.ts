/**
 * 附件落盘与「最近一轮附件」记忆（1.0.71）
 *
 * 只解决一件事：把输入框里的截图（只有 dataUrl、没有本机路径）变成**真实存在、
 * 可被工具引用的本机文件**，并把路径写回附件对象。这样
 * `jira_add_comment` / `jira_create_ticket` 的 `attachments` 才有东西可传，
 * 模型不用再问用户「请提供图片的完整路径」。
 *
 * 目录：`userData/attachments/`（不是系统临时目录 —— 会话历史里存的是路径，
 * 重启后还要能读到；30 天前的旧文件按需清理，节流 10 分钟一次）。
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import type { AIAttachment } from '@shared/ai-types'
import { decodeDataUrl, sanitizeAttachFileName, type SavedAttachment } from './attachPaths'

const KEEP_MS = 30 * 24 * 60 * 60 * 1000

function attachDir(): string {
  return join(app.getPath('userData'), 'attachments')
}

let seq = 0

/** 清理 30 天前的旧附件；失败一律忽略（不能因为清理失败影响发消息） */
let lastCleanupAt = 0
function cleanupOld(maxAgeMs = KEEP_MS): void {
  if (Date.now() - lastCleanupAt < 10 * 60 * 1000) return
  lastCleanupAt = Date.now()
  try {
    const dir = attachDir()
    if (!existsSync(dir)) return
    const now = Date.now()
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      try {
        if (now - statSync(abs).mtimeMs > maxAgeMs) unlinkSync(abs)
      } catch { /* 单个文件失败不处理 */ }
    }
  } catch { /* 目录不可读就算了 */ }
}

/**
 * 把本轮附件整理成 [{name, path}]。
 * - 拖进来的本地文件本来就有 path：直接用（不复制，用户看到的就是原文件）；
 * - 图片（粘贴 / 拖图）只有 dataUrl：解码后落盘，并把 path **写回附件对象**——
 *   会话历史里因此带上路径，下一轮追问或重启后仍能引用。
 * 任何一步失败都静默降级（不影响发消息本身）。
 */
export function persistAttachments(atts?: AIAttachment[]): SavedAttachment[] {
  const list = (atts || []).filter(Boolean)
  if (!list.length) return []
  cleanupOld()
  const saved: SavedAttachment[] = []
  const seen = new Set<string>()
  const push = (name: string, abs: string): void => {
    const key = abs.toLowerCase()
    if (!abs || seen.has(key)) return
    seen.add(key)
    saved.push({ name: name || basename(abs), path: abs })
  }

  for (const a of list) {
    const own = String(a.path || '').trim()
    if (own) {
      try {
        if (statSync(own).isFile()) { push(a.name, own); continue }
      } catch { /* 路径失效：继续尝试 dataUrl 兜底 */ }
    }
    if (a.kind !== 'image' || !a.dataUrl) continue
    const dec = decodeDataUrl(a.dataUrl)
    if (!dec) continue
    try {
      const dir = attachDir()
      mkdirSync(dir, { recursive: true })
      const name = sanitizeAttachFileName(a.name, dec.mime)
      const abs = join(dir, `${Date.now()}-${++seq}-${name}`)
      writeFileSync(abs, dec.buf)
      a.path = abs
      push(name, abs)
    } catch { /* 落盘失败：识图不受影响，只是不能当附件传 */ }
  }
  return saved
}

/* 会话最近一轮附件：用户先贴图、下一轮只说「确认」时，模型仍需拿到路径。
   只放内存，1 小时过期，最多记 200 个会话。 */
const RECENT_TTL = 60 * 60 * 1000
const RECENT_MAX = 200
const recent = new Map<string, { at: number; files: SavedAttachment[] }>()

export function rememberAttachments(conversationId: string, files: SavedAttachment[]): void {
  if (!conversationId || !files.length) return
  recent.set(String(conversationId), { at: Date.now(), files })
  if (recent.size > RECENT_MAX) {
    const oldest = [...recent.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) recent.delete(oldest[0])
  }
}

export function recallAttachments(conversationId: string): SavedAttachment[] {
  const hit = recent.get(String(conversationId || ''))
  if (!hit) return []
  if (Date.now() - hit.at > RECENT_TTL) {
    recent.delete(String(conversationId))
    return []
  }
  return hit.files
}
