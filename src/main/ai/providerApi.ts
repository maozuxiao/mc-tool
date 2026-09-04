import { net } from 'electron'
import type { AIModelInfo } from '@shared/ai-types'
import { getProvider } from './providerStore'

/**
 * OpenCode（Go / Zen，域名 opencode.ai）要求每个请求携带稳定的 x-opencode-session 头。
 * 官方通知：自 2026-09-06 起，缺失该头的请求将报错。
 * 有会话时用会话 ID（one stable ID per conversation）；拉模型 / 测试连接这类无会话的
 * 请求用本进程内稳定的应用级 ID，保证同一批次请求 ID 一致、便于服务端优化。
 */
let appSessionId = ''
function stableAppSessionId(): string {
  if (!appSessionId) appSessionId = `mc-tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return appSessionId
}
export function opencodeSessionHeaders(url?: string, conversationId?: string): Record<string, string> {
  if (!url || !/opencode\.ai/i.test(url)) return {}
  // header 值只允许 ASCII 安全字符，避免会话 ID 含特殊字符导致请求被拒
  const safe = (conversationId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128)
  return { 'x-opencode-session': safe || stableAppSessionId() }
}

async function requestJSON<T>(url: string, apiKey: string | undefined, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...opencodeSessionHeaders(url),
    ...(init.headers as Record<string, string> || {})
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const res = await net.fetch(url, { ...init, headers })
  const text = await res.text()
  let data: any
  try { data = text ? JSON.parse(text) : {} } catch { throw new Error(`接口响应不是 JSON（HTTP ${res.status}）`) }
  if (!res.ok) throw new Error(data?.error?.message || data?.message || `HTTP ${res.status}`)
  return data as T
}

export async function listModels(providerId: string): Promise<AIModelInfo[]> {
  const { config, apiKey } = getProvider(providerId)
  if (!apiKey && providerId !== 'ollama') throw new Error('请先配置 API Key')
  const data = await requestJSON<any>(`${config.baseUrl}/models`, apiKey)
  const models = Array.isArray(data?.data) ? data.data : []
  return models.map((m: any) => ({
    id: String(m.id || m.name || ''),
    name: String(m.name || m.id || ''),
    contextLength: m.context_length || m.contextLength || undefined,
    maxOutputTokens: m.max_output_tokens || m.maxOutputTokens || undefined
  })).filter((m: AIModelInfo) => m.id)
}

export async function testProvider(providerId: string, modelId?: string): Promise<{ ok: boolean; models: number; message: string }> {
  const { config, apiKey } = getProvider(providerId)
  if (!apiKey && providerId !== 'ollama') throw new Error('请先配置 API Key')
  const model = modelId || config.defaultModel || ''
  await requestJSON<any>(`${config.baseUrl}/chat/completions`, apiKey, {
    method: 'POST',
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false
    })
  })
  return { ok: true, models: 0, message: `连接成功：${model}` }
}
