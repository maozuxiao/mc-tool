import { net } from 'electron'
import type { AIModelInfo } from '@shared/ai-types'
import { getProvider } from './providerStore'

async function requestJSON<T>(url: string, apiKey: string | undefined, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
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
