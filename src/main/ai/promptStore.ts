import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import type { SavedPrompt } from '@shared/ai-types'

const FILE = join(app.getPath('userData'), 'promptStore.json')

let cache: SavedPrompt[] | null = null

function load(): SavedPrompt[] {
  if (cache) return cache
  try {
    if (existsSync(FILE)) cache = JSON.parse(readFileSync(FILE, 'utf8'))
    else cache = []
  } catch {
    cache = []
  }
  return cache
}

function persist(list: SavedPrompt[]): SavedPrompt[] {
  cache = list
  try {
    const dir = join(app.getPath('userData'))
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf8')
  } catch {
    /* 持久化失败不阻断主流程，仅本次运行内存态有效 */
  }
  return list
}

export function listPrompts(): SavedPrompt[] {
  return load().slice()
}

export function savePrompt(text: string, title?: string): SavedPrompt[] {
  const trimmed = (text || '').trim()
  if (!trimmed) return load().slice()
  const item: SavedPrompt = {
    id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: (title || trimmed).slice(0, 30),
    text: trimmed,
    createdAt: Date.now()
  }
  const next = [item, ...load()]
  return persist(next)
}

export function updatePrompt(id: string, text: string, title?: string): SavedPrompt[] {
  const list = load()
  const idx = list.findIndex(p => p.id === id)
  if (idx === -1) return list.slice()
  const trimmed = (text || '').trim()
  if (!trimmed) return list.slice()
  list[idx] = {
    ...list[idx],
    title: (title || trimmed).slice(0, 30),
    text: trimmed
  }
  return persist(list)
}

export function deletePrompt(id: string): SavedPrompt[] {
  return persist(load().filter(p => p.id !== id))
}
