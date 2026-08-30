import { BrowserWindow, net } from 'electron'
import { randomUUID } from 'crypto'
import type { AISendPayload } from '@shared/ai-types'
import { getProvider } from './providerStore'
import { MC_QUERY_TOOL_DEFINITION, mcSkillSystemPrompt, runMcQuery } from './mcSkill'
import {
  appendMessage, appendToolRun, completeToolRun, createConversation,
  getConversation, updateMessage
} from './historyStore'

export interface AIStreamEvent {
  type: 'conversation-created' | 'message-created' | 'delta' | 'tool-start' | 'tool-end' | 'done' | 'error'
  conversationId: string
  messageId?: string
  content?: string
  run?: any
  message?: string
}

const controllers = new Map<string, AbortController>()
const toolControllers = new Map<string, AbortController>()
const activeMessageIds = new Map<string, AbortController>()
// requestId -> conversationId。新会话在返回 conversation-created 之前，
// 渲染层手里只有 requestId，靠这张表才能把「停止」映射到正确的会话。
const requestToConversation = new Map<string, string>()
// 用户点停止时请求可能还没开始（IPC 竞态），先记下来，等请求注册时立刻取消
const pendingStops = new Set<string>()

function send(event: AIStreamEvent) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('ai:event', event)
  }
}

function createAbortController(conversationId: string): AbortController {
  const old = controllers.get(conversationId)
  old?.abort()
  // 同时清掉旧的工具取消器，防止 stop 时误杀后续会话
  const oldTool = toolControllers.get(conversationId)
  oldTool?.abort()
  toolControllers.delete(conversationId)

  const controller = new AbortController()
  controllers.set(conversationId, controller)
  return controller
}

export function stopMessage(id: string): void {
  // 允许传 requestId 或 conversationId
  const conversationId = requestToConversation.get(id) || id
  const controller = controllers.get(conversationId)
  if (controller) controller.abort()
  else pendingStops.add(id) // 请求尚未注册，等它注册时立即取消
  toolControllers.get(conversationId)?.abort()
  requestToConversation.delete(id)
}

// 将 Promise 与 AbortSignal / 超时绑定
function withAbort<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs?: number): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
      if (timer) clearTimeout(timer)
    }
    const onAbort = () => {
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort)
    let timer: NodeJS.Timeout | null = null
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        cleanup()
        reject(new Error(`请求超时（${timeoutMs / 1000}s），请重试或切换模型`))
      }, timeoutMs)
    }
    promise.then(
      (v) => { cleanup(); resolve(v) },
      (e) => { cleanup(); reject(e) }
    )
  })
}

function openAIToolMessages(messages: any[], toolsEnabled: boolean) {
  const payload: any[] = [{ role: 'system', content: mcSkillSystemPrompt('zh') }]
  for (const m of messages) {
    if (m.role === 'user') payload.push({ role: 'user', content: m.content })
    else if (m.role === 'assistant' && m.content) payload.push({ role: 'assistant', content: m.content })
  }
  return payload
}

function openAIToolResponse(toolCallId: string, content: unknown): any {
  return { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(content) }
}

async function streamOpenAICompatible(input: {
  payload: AISendPayload
  conversationId: string
  messages: any[]
  assistantMessageId: string
  controller: AbortController
}): Promise<void> {
  const { payload, conversationId, messages, assistantMessageId, controller } = input
  const { preset, config, apiKey } = getProvider(payload.providerId)
  if (!apiKey && payload.providerId !== 'ollama') throw new Error('请先配置 API Key')

  let conversation = [...messages]
  for (let round = 0; round < 5; round++) {
    const body: any = {
      model: payload.modelId,
      stream: true,
      messages: [
        { role: 'system', content: mcSkillSystemPrompt(payload.lang === 'en' ? 'en' : 'zh') },
        ...conversation.map(m => {
          if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content }
          if (m.tool_calls) return { role: 'assistant', content: m.content || '', tool_calls: m.tool_calls }
          return { role: m.role, content: m.content }
        })
      ]
    }
    if (payload.useMcSkill) body.tools = [MC_QUERY_TOOL_DEFINITION]

    // 本次请求独立取消器：用户 stop + 60s 超时都能中断
    const fetchController = new AbortController()
    const onParentAbort = () => fetchController.abort()
    controller.signal.addEventListener('abort', onParentAbort, { once: true })
    const fetchTimeout = setTimeout(() => fetchController.abort(), 60000)

    let res: Response
    try {
      res = await net.fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: fetchController.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify(body)
      })
    } finally {
      clearTimeout(fetchTimeout)
      controller.signal.removeEventListener('abort', onParentAbort)
    }

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '')
      let msg = `HTTP ${res.status}`
      try { msg = JSON.parse(errText)?.error?.message || msg } catch {}
      throw new Error(msg)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    let usage: any = null
    let toolCalls: any[] = []

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') continue
        let json: any
        try { json = JSON.parse(data) } catch { continue }
        // 某些上游会把错误包在 SSE data 里返回
        if (json.error) {
          throw new Error(json.error.message || JSON.stringify(json.error))
        }
        const delta = json.choices?.[0]?.delta || {}
        if (delta.content) {
          content += delta.content
          send({ type: 'delta', conversationId, messageId: assistantMessageId, content: delta.content })
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            toolCalls[idx] = toolCalls[idx] || { id: tc.id || `call_${randomUUID()}`, type: 'function', function: { name: '', arguments: '' } }
            if (tc.id) toolCalls[idx].id = tc.id
            if (tc.function?.name) toolCalls[idx].function.name += tc.function.name
            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments
          }
        }
        if (json.usage) usage = json.usage
      }
    }

    if (!toolCalls.length) {
      updateMessage(assistantMessageId, {
        content,
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens
      })
      return
    }

    const assistantToolMessage = { role: 'assistant', content, tool_calls: toolCalls }
    conversation.push(assistantToolMessage)
    const toolController = new AbortController()
    toolControllers.set(conversationId, toolController)
    try {
      for (const call of toolCalls) {
        let parsed: any
        try { parsed = JSON.parse(call.function.arguments || '{}') } catch { parsed = {} }
        const runningRun = appendToolRun(assistantMessageId, {
          toolName: call.function.name,
          input: parsed,
          status: 'running',
          summary: `正在调用 ${call.function.name}`
        })
        send({ type: 'tool-start', conversationId, messageId: assistantMessageId, run: runningRun })
        try {
          const result = call.function.name === 'mc_query'
            ? await runMcQuery(parsed, persistedRun => {
                // runMcQuery 会回调两次：开始时登记 running 态、结束时回传终态。
                // 首次回调不能落「完成」态，否则工具刚起跑 UI 就把转圈收掉了。
                if (persistedRun.status !== 'running') {
                  completeToolRun(runningRun.id, {
                    output: persistedRun.output,
                    summary: persistedRun.summary,
                    status: persistedRun.status,
                    durationMs: persistedRun.durationMs
                  })
                  send({ type: 'tool-end', conversationId, messageId: assistantMessageId, run: { ...runningRun, ...persistedRun, id: runningRun.id } })
                }
                // 本调用方已在外部用 appendToolRun 建好 run，故回传既有 id 即可。
                return { id: runningRun.id }
              }, toolController.signal)
            : { error: `不支持的工具：${call.function.name}` }
          conversation.push(openAIToolResponse(call.id, result))
        } catch (e: any) {
          if (e.name === 'AbortError' || /aborted/i.test(e.message)) {
            throw e
          }
          conversation.push(openAIToolResponse(call.id, { error: e.message }))
        }
      }
    } finally {
      toolControllers.delete(conversationId)
    }
    send({ type: 'delta', conversationId, messageId: assistantMessageId, content: '\n\n' })
  }
  throw new Error('AI 工具调用轮次过多')
}

export async function sendMessage(payload: AISendPayload): Promise<void> {
  if (!payload.content.trim()) throw new Error('消息不能为空')
  const provider = getProvider(payload.providerId)
  if (!provider.apiKey && payload.providerId !== 'ollama') throw new Error('请先配置 API Key')

  let conversationId = payload.conversationId
  if (!conversationId) {
    const title = payload.content.slice(0, 30).replace(/\s+/g, ' ') || '新对话'
    const conv = createConversation(payload.providerId, payload.modelId, title)
    conversationId = conv.id
    send({ type: 'conversation-created', conversationId, message: conv.id })
  }
  const existing = getConversation(conversationId)
  appendMessage({ conversationId, role: 'user', content: payload.content })
  const assistant = appendMessage({
    conversationId,
    role: 'assistant',
    content: '',
    providerId: payload.providerId,
    modelId: payload.modelId
  })
  const controller = createAbortController(conversationId)
  activeMessageIds.set(assistant.id, controller)
  if (payload.requestId) requestToConversation.set(payload.requestId, conversationId)
  // 竞态兜底：用户在请求注册前就点了停止
  if (payload.requestId && pendingStops.has(payload.requestId)) {
    pendingStops.delete(payload.requestId)
    controller.abort()
  }
  send({ type: 'message-created', conversationId, messageId: assistant.id, message: assistant.id })

  try {
    const messages = existing.messages
    if (provider.preset.protocol === 'openai-compatible') {
      await streamOpenAICompatible({
        payload, conversationId,
        messages: [...messages, { role: 'user', content: payload.content }],
        assistantMessageId: assistant.id,
        controller
      })
    } else {
      throw new Error('Anthropic adapter 将在后续版本启用，请先选择 OpenAI-compatible Provider')
    }
    send({ type: 'done', conversationId, messageId: assistant.id })
  } catch (e: any) {
    if (e.name === 'AbortError') {
      send({ type: 'done', conversationId, messageId: assistant.id, message: '已停止生成' })
      return
    }
    send({ type: 'error', conversationId, messageId: assistant.id, message: e.message })
  } finally {
    controllers.delete(conversationId)
    toolControllers.delete(conversationId)
    activeMessageIds.delete(assistant.id)
    if (payload.requestId) {
      requestToConversation.delete(payload.requestId)
      pendingStops.delete(payload.requestId)
    }
  }
}

export { openAIToolMessages }
