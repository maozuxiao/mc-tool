// AI 会话历史：JSON 文件持久化（userData/ai-history.json）。
//
// 原实现用 better-sqlite3，但它是原生模块，在本项目连续踩了三个坑：
//   1) rollup 打包主进程时，其内部对 .node 的动态 require 无法解析（须标 external）；
//   2) electron-builder 会自动跑 node-gyp 重建，本机无 VS 生成工具 → 打包直接失败；
//   3) 更致命：v13 要求 Node >= 22（NAPI 10），而 Electron 33 内置 Node 20；
//      降到 v12 虽支持 Node 20，但本机 Node 24 下 npm 装的是 Node 24 的 ABI 专版，
//      同样加载失败，且每次 npm install 都会把它装回去。
// 历史记录的操作都很简单（按会话取消息、追加、改名、删除），JSON 完全够用，
// 也与本项目其余持久化方式（cookie 备份、供应商配置、日志）保持一致。
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AIConversation, AIMessage, AIToolRun } from '@shared/ai-types'

interface ToolRunRecord extends AIToolRun {
  messageId: string
  createdAt: number
}

interface HistoryData {
  conversations: AIConversation[]
  messages: AIMessage[]
  toolRuns: ToolRunRecord[]
}

let cache: HistoryData | null = null

function historyFile(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'ai-history.json')
}

function load(): HistoryData {
  if (cache) return cache
  const empty: HistoryData = { conversations: [], messages: [], toolRuns: [] }
  try {
    if (!existsSync(historyFile())) {
      cache = empty
      return cache
    }
    const parsed = JSON.parse(readFileSync(historyFile(), 'utf-8')) as Partial<HistoryData>
    cache = {
      conversations: parsed.conversations ?? [],
      messages: parsed.messages ?? [],
      toolRuns: parsed.toolRuns ?? []
    }
  } catch {
    // 文件损坏时不要让整个 AI 助手不可用：退回空历史
    cache = empty
  }
  return cache
}

function persist(): void {
  if (!cache) return
  try {
    writeFileSync(historyFile(), JSON.stringify(cache), 'utf-8')
  } catch {
    // 写入失败不应阻塞正在进行的对话
  }
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function listConversations(): AIConversation[] {
  return load()
    .conversations.slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 200)
}

export function createConversation(providerId: string, modelId: string, title: string): AIConversation {
  const now = Date.now()
  const item: AIConversation = {
    id: newId('conv'),
    title,
    providerId,
    modelId,
    createdAt: now,
    updatedAt: now
  }
  load().conversations.push(item)
  persist()
  return item
}

export function getConversation(id: string): { conversation: AIConversation; messages: AIMessage[] } {
  const data = load()
  const found = data.conversations.find(c => c.id === id)
  if (!found) throw new Error('会话不存在')
  const messages = data.messages
    .filter(m => m.conversationId === id)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(m => ({ ...m }))
  for (const m of messages) {
    const runs = data.toolRuns
      .filter(r => r.messageId === m.id)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(r => ({ ...r }))
    if (runs.length) m.toolRuns = runs
  }
  return { conversation: { ...found }, messages }
}

export function appendMessage(input: {
  conversationId: string
  role: AIMessage['role']
  content: string
  reasoning?: string
  providerId?: string
  modelId?: string
  inputTokens?: number
  outputTokens?: number
}): AIMessage {
  const data = load()
  const now = Date.now()
  const msg: AIMessage = {
    id: newId('msg'),
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    reasoning: input.reasoning,
    providerId: input.providerId,
    modelId: input.modelId,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    createdAt: now
  }
  data.messages.push(msg)
  const conv = data.conversations.find(c => c.id === input.conversationId)
  if (conv) conv.updatedAt = now
  persist()
  return msg
}

export function updateMessage(id: string, patch: { content?: string; reasoning?: string; inputTokens?: number; outputTokens?: number; createdAt?: number }): void {
  const data = load()
  const m = data.messages.find(x => x.id === id)
  if (!m) return
  if (patch.content !== undefined) m.content = patch.content
  if (patch.reasoning !== undefined) m.reasoning = patch.reasoning
  if (patch.createdAt !== undefined) m.createdAt = patch.createdAt
  if (patch.inputTokens !== undefined) m.inputTokens = patch.inputTokens
  if (patch.outputTokens !== undefined) m.outputTokens = patch.outputTokens
  persist()
}

export function renameConversation(id: string, title: string): void {
  const data = load()
  const c = data.conversations.find(x => x.id === id)
  if (!c) return
  c.title = title
  c.updatedAt = Date.now()
  persist()
}

export function deleteConversation(id: string): void {
  const data = load()
  const msgIds = new Set(data.messages.filter(m => m.conversationId === id).map(m => m.id))
  data.toolRuns = data.toolRuns.filter(r => !msgIds.has(r.messageId))
  data.messages = data.messages.filter(m => m.conversationId !== id)
  data.conversations = data.conversations.filter(c => c.id !== id)
  persist()
}

export function appendToolRun(messageId: string, run: Omit<AIToolRun, 'id'>): AIToolRun {
  const full: ToolRunRecord = {
    ...run,
    id: newId('tool'),
    messageId,
    createdAt: Date.now()
  }
  load().toolRuns.push(full)
  persist()
  return full
}

export function completeToolRun(id: string, patch: { output?: unknown; summary?: string; status: AIToolRun['status']; durationMs?: number }): void {
  const data = load()
  const run = data.toolRuns.find(r => r.id === id)
  if (!run) return
  if (patch.output !== undefined) run.output = patch.output
  if (patch.summary !== undefined) run.summary = patch.summary
  run.status = patch.status
  if (patch.durationMs !== undefined) run.durationMs = patch.durationMs
  persist()
}
