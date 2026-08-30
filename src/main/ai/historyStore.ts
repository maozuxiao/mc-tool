import Database from 'better-sqlite3'
import { app } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { AIConversation, AIMessage, AIToolRun } from '@shared/ai-types'

let db: Database.Database | null = null

function getDb(): Database.Database {
  if (db) return db
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  db = new Database(join(dir, 'ai-chat.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      reasoning TEXT,
      provider_id TEXT,
      model_id TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS tool_runs (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input_json TEXT NOT NULL,
      output_json TEXT,
      summary TEXT,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
    );
  `)
  return db
}

export function listConversations(): AIConversation[] {
  return getDb().prepare(
    `SELECT id, title, provider_id AS providerId, model_id AS modelId,
            created_at AS createdAt, updated_at AS updatedAt
     FROM conversations ORDER BY updated_at DESC LIMIT 200`
  ).all() as AIConversation[]
}

export function createConversation(providerId: string, modelId: string, title: string): AIConversation {
  const now = Date.now()
  const item = {
    id: `conv_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    title,
    providerId,
    modelId,
    createdAt: now,
    updatedAt: now
  }
  getDb().prepare(
    `INSERT INTO conversations (id, title, provider_id, model_id, created_at, updated_at)
     VALUES (@id, @title, @providerId, @modelId, @createdAt, @updatedAt)`
  ).run(item)
  return item
}

export function getConversation(id: string): { conversation: AIConversation; messages: AIMessage[] } {
  const conversation = getDb().prepare(
    `SELECT id, title, provider_id AS providerId, model_id AS modelId,
            created_at AS createdAt, updated_at AS updatedAt
     FROM conversations WHERE id = ?`
  ).get(id) as AIConversation | undefined
  if (!conversation) throw new Error('会话不存在')
  const messages = getDb().prepare(
    `SELECT id, conversation_id AS conversationId, role, content, reasoning,
            provider_id AS providerId, model_id AS modelId,
            input_tokens AS inputTokens, output_tokens AS outputTokens, created_at AS createdAt
     FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`
  ).all(id) as AIMessage[]
  const ids = messages.map(m => m.id)
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',')
    const runs = getDb().prepare(
      `SELECT id, message_id AS messageId, tool_name AS toolName, input_json AS inputJson,
              output_json AS outputJson, summary, status, duration_ms AS durationMs, created_at AS createdAt
       FROM tool_runs WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`
    ).all(...ids) as any[]
    for (const run of runs) {
      const msg = messages.find(m => m.id === run.messageId)
      if (!msg) continue
      msg.toolRuns = msg.toolRuns || []
      msg.toolRuns.push({
        id: run.id,
        toolName: run.toolName,
        input: JSON.parse(run.inputJson),
        output: run.outputJson ? JSON.parse(run.outputJson) : undefined,
        summary: run.summary,
        status: run.status,
        durationMs: run.durationMs
      } as AIToolRun)
    }
  }
  return { conversation, messages }
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
  const now = Date.now()
  const msg = {
    id: `msg_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
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
  getDb().prepare(
    `INSERT INTO messages (id, conversation_id, role, content, reasoning, provider_id, model_id, input_tokens, output_tokens, created_at)
     VALUES (@id, @conversationId, @role, @content, @reasoning, @providerId, @modelId, @inputTokens, @outputTokens, @createdAt)`
  ).run(msg)
  getDb().prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, input.conversationId)
  return msg as AIMessage
}

export function updateMessage(id: string, patch: { content?: string; reasoning?: string; inputTokens?: number; outputTokens?: number }): void {
  const sets: string[] = []
  const params: any = { id }
  if (patch.content !== undefined) { sets.push('content = @content'); params.content = patch.content }
  if (patch.reasoning !== undefined) { sets.push('reasoning = @reasoning'); params.reasoning = patch.reasoning }
  if (patch.inputTokens !== undefined) { sets.push('input_tokens = @inputTokens'); params.inputTokens = patch.inputTokens }
  if (patch.outputTokens !== undefined) { sets.push('output_tokens = @outputTokens'); params.outputTokens = patch.outputTokens }
  if (!sets.length) return
  getDb().prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = @id`).run(params)
}

export function renameConversation(id: string, title: string): void {
  getDb().prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), id)
}

export function deleteConversation(id: string): void {
  getDb().prepare('DELETE FROM conversations WHERE id = ?').run(id)
}

export function appendToolRun(messageId: string, run: Omit<AIToolRun, 'id'>): AIToolRun {
  const full = { ...run, id: `tool_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}` }
  getDb().prepare(
    `INSERT INTO tool_runs (id, message_id, tool_name, input_json, output_json, summary, status, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    full.id, messageId, full.toolName,
    JSON.stringify(full.input || {}),
    full.output === undefined ? null : JSON.stringify(full.output),
    full.summary || null, full.status, full.durationMs || null, Date.now()
  )
  return full
}

export function completeToolRun(id: string, patch: { output?: unknown; summary?: string; status: AIToolRun['status']; durationMs?: number }): void {
  getDb().prepare(
    `UPDATE tool_runs SET output_json = ?, summary = ?, status = ?, duration_ms = ? WHERE id = ?`
  ).run(
    patch.output === undefined ? null : JSON.stringify(patch.output),
    patch.summary || null, patch.status, patch.durationMs || null, id
  )
}
