/**
 * file_read / file_read_batch 的图片路径兜底判定（纯函数层）。
 *
 * 背景：用户粘贴 / 工具下载的图片已经作为 image_url 发给模型看了，但附件路径提示或历史上下文
 * 偶尔会让模型再调 file_read 去「读」图片路径，而 file-office-local 只处理文本 / Office / PDF，
 * 读图片必然返回 UNSUPPORTED_FORMAT，产生一次无意义的工具错误卡片。
 * 这里把判定与拦截结果构造抽成纯函数，方便单测；toolRegistry 在启动子进程前调用。
 */
import { isImageName, mimeFromName } from './attachmentMedia'

export const IMAGE_READ_HINT =
  '图片已作为图片消息提供，请直接看图作答，不要用 file_read / file_read_batch 读取图片（本工具只支持文本 / Office / PDF）'

/**
 * 路径是否指向图片（大小写不敏感，先去掉 querystring / hash 再取文件名）。
 * 复用 attachmentMedia 维护的图片扩展名集合，不重复造表。
 */
export function isImageReadPath(p: string): boolean {
  const s = String(p || '').trim().split(/[?#]/)[0]
  if (!s) return false
  const name = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1)
  return isImageName(name, mimeFromName(name))
}

/** file_read 命中图片的拦截结果（不启动 file-office-local 子进程） */
export function imageReadBlockedResult(p: string): any {
  return { ok: false, code: 'IMAGE_USE_VISION', error: IMAGE_READ_HINT, path: p }
}

/** file_read_batch 拆分：图片走视觉通道，其余才交给脚本 */
export function splitImagePaths(paths: string[]): { images: string[]; others: string[] } {
  const images: string[] = []
  const others: string[] = []
  for (const raw of (Array.isArray(paths) ? paths : [])) {
    const p = String(raw)
    ;(isImageReadPath(p) ? images : others).push(p)
  }
  return { images, others }
}

/** file_read_batch 全为图片时的拦截结果 */
export function imageBatchBlockedResult(images: string[]): any {
  return { ok: false, code: 'IMAGE_USE_VISION', error: IMAGE_READ_HINT, skippedImages: images }
}

/** 批量结果里追加 skippedImages 与 note（保留脚本原有字段） */
export function withSkippedImages(result: any, images: string[]): any {
  if (!images.length) return result
  return {
    ...result,
    skippedImages: images,
    note: (result?.note ? result.note + '\n' : '') +
      `已跳过 ${images.length} 张图片（${images.join('、')}）：${IMAGE_READ_HINT}`
  }
}
