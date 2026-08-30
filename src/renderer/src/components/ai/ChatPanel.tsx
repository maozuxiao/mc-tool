import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import rehypeHighlight from 'rehype-highlight'
import type { AIConversation, AIMessage, AIProviderConfig, AIToolRun } from '@shared/ai-types'

interface ProviderBundle {
  providers: AIProviderConfig[]
  suggestions: Record<string, string[]>
}

interface Props {
  disabled: boolean
}

export function ChatPanel({ disabled }: Props) {
  const [providers, setProviders] = useState<ProviderBundle>({ providers: [], suggestions: {} })
  const [providerId, setProviderId] = useState('')
  const [modelId, setModelId] = useState('')
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [apiKey, setApiKey] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [conversations, setConversations] = useState<AIConversation[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AIMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [useSkill, setUseSkill] = useState(true)
  const [notice, setNotice] = useState('')
  const bottomRef = useRef<HTMLDivElement | null>(null)

  const selectedProvider = providers.providers.find(p => p.id === providerId)

  const refreshConversations = useCallback(async () => {
    try { setConversations(await window.mcApi.ai.listConversations()) } catch {}
  }, [])

  const refreshProviders = useCallback(async () => {
    try {
      const data = await window.mcApi.ai.getProviders() as ProviderBundle
      setProviders(data)
      setProviderId(prev => prev || data.providers.find(p => p.hasApiKey)?.id || data.providers[0]?.id || '')
    } catch (e: any) { setNotice(e.message) }
  }, [])

  useEffect(() => {
    refreshProviders()
    refreshConversations()
    return window.mcApi.ai.onEvent(event => {
      if (event.type === 'conversation-created') {
        setConversationId(event.conversationId)
        refreshConversations()
      }
      if (event.type === 'message-created') {
        setMessages(prev => [...prev, {
          id: event.messageId!,
          conversationId: event.conversationId,
          role: 'assistant',
          content: '',
          createdAt: Date.now(),
          toolRuns: []
        }])
      }
      if (event.type === 'delta') {
        setMessages(prev => prev.map(m => m.id === event.messageId ? { ...m, content: m.content + (event.content || '') } : m))
      }
      if (event.type === 'tool-start') {
        setMessages(prev => prev.map(m => {
          if (m.id !== event.messageId) return m
          return { ...m, toolRuns: [...(m.toolRuns || []), event.run as AIToolRun] }
        }))
      }
      if (event.type === 'tool-end') {
        setMessages(prev => prev.map(m => {
          if (m.id !== event.messageId) return m
          return { ...m, toolRuns: (m.toolRuns || []).map(r => r.id === event.run.id ? { ...r, ...event.run } : r) }
        }))
      }
      if (event.type === 'error') setNotice(event.message || 'AI 请求失败')
      if (event.type === 'done') setStreaming(false)
    })
  }, [refreshConversations, refreshProviders])

  useEffect(() => {
    if (providerId && selectedProvider) {
      setModelId(selectedProvider.defaultModel)
      setModelOptions((providers.suggestions[providerId] || []).slice())
      setApiKey('')
    }
  }, [providerId])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  const openConversation = async (id: string) => {
    try {
      const data = await window.mcApi.ai.getConversation(id)
      setConversationId(id)
      setMessages(data.messages)
      setProviderId(data.conversation.providerId)
      setModelId(data.conversation.modelId)
    } catch (e: any) { setNotice(e.message) }
  }

  const saveProvider = async () => {
    if (!providerId) return
    try {
      await window.mcApi.ai.saveProvider({
        id: providerId,
        baseUrl: selectedProvider?.baseUrl,
        defaultModel: modelId,
        ...(apiKey ? { apiKey } : {})
      })
      setApiKey('')
      setNotice('AI 配置已保存')
      await refreshProviders()
    } catch (e: any) { setNotice(e.message) }
  }

  const loadModels = async () => {
    if (!providerId) return
    setNotice('正在获取模型列表...')
    const res = await window.mcApi.ai.listModels(providerId)
    if (res.ok) {
      setModelOptions(res.models.map((m: any) => m.id))
      setNotice(`已获取 ${res.models.length} 个模型`)
    } else {
      setModelOptions(res.suggestions || [])
      setNotice(`模型列表获取失败：${res.error}，已显示推荐模型`)
    }
  }

  const send = async () => {
    const content = input.trim()
    if (!content || streaming || disabled) return
    if (!selectedProvider?.hasApiKey && providerId !== 'ollama') {
      setShowSettings(true)
      setNotice('请先配置 API Key')
      return
    }
    setInput('')
    setStreaming(true)
    setNotice('')
    setMessages(prev => [...prev, {
      id: `local_user_${Date.now()}`,
      conversationId: conversationId || '',
      role: 'user',
      content,
      createdAt: Date.now()
    }])
    try {
      const res = await window.mcApi.ai.sendMessage({
        conversationId: conversationId || undefined,
        providerId,
        modelId,
        content,
        useMcSkill: useSkill
      })
      if (!res.ok) { setNotice(res.error); setStreaming(false) }
      await refreshConversations()
    } catch (e: any) {
      setNotice(e.message)
      setStreaming(false)
    }
  }

  const removeConversation = async (id: string) => {
    await window.mcApi.ai.deleteConversation(id)
    if (id === conversationId) {
      setConversationId(null)
      setMessages([])
    }
    refreshConversations()
  }

  const title = useMemo(() => conversations.find(c => c.id === conversationId)?.title || '新对话', [conversations, conversationId])

  return (
    <div className="ai-page">
      <aside className="ai-sidebar">
        <div className="ai-sidebar-head">
          <span>AI 助手</span>
          <button className="mq-btn" onClick={() => { setConversationId(null); setMessages([]) }}>+ 新对话</button>
        </div>
        <div className="ai-history">
          {conversations.map(c => (
            <div key={c.id} className={`ai-history-item${c.id === conversationId ? ' active' : ''}`}>
              <button className="ai-history-title" onClick={() => openConversation(c.id)}>{c.title}</button>
              <button className="ai-history-delete" onClick={() => removeConversation(c.id)}>×</button>
            </div>
          ))}
        </div>
      </aside>

      <section className="ai-main card">
        <div className="ai-toolbar">
          <select className="ai-select" value={providerId} onChange={e => setProviderId(e.target.value)}>
            {providers.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input className="ai-model-input" list="ai-model-list" value={modelId} onChange={e => setModelId(e.target.value)} />
          <datalist id="ai-model-list">{modelOptions.map(m => <option key={m} value={m} />)}</datalist>
          <button className="mq-btn" onClick={loadModels}>获取模型</button>
          <label className="ai-skill-toggle">
            <input type="checkbox" checked={useSkill} onChange={e => setUseSkill(e.target.checked)} />
            MC Skill
          </label>
          <button className="mq-btn accent" onClick={() => setShowSettings(v => !v)}>配置</button>
        </div>

        {showSettings && (
          <div className="ai-settings">
            <div className="ai-settings-title">API 配置 · {selectedProvider?.name}</div>
            <label className="ai-field">
              <span>Base URL</span>
              <input value={selectedProvider?.baseUrl || ''} onChange={e => {
                setProviders(prev => ({ ...prev, providers: prev.providers.map(p => p.id === providerId ? { ...p, baseUrl: e.target.value } : p) }))
              }} />
            </label>
            <label className="ai-field">
              <span>API Key</span>
              <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={selectedProvider?.hasApiKey ? '已配置，留空保持不变' : '请输入 API Key'} />
            </label>
            <div className="ai-settings-actions">
              <button className="mq-btn" onClick={async () => {
                const res = await window.mcApi.ai.testProvider({ providerId, modelId })
                setNotice(res.ok ? res.message : res.error)
              }}>测试连接</button>
              <button className="mq-btn accent" onClick={saveProvider}>保存配置</button>
            </div>
          </div>
        )}

        <div className="ai-messages">
          {messages.length === 0 && (
            <div className="ai-empty">
              <div className="ai-empty-icon">AI</div>
              <div>你可以直接提问，也可以让我查询物料、库存、BOM 或规格文件。</div>
            </div>
          )}
          {messages.map(m => <MessageItem key={m.id} message={m} />)}
          <div ref={bottomRef} />
        </div>

        <div className="ai-composer">
          {notice && <div className="ai-notice">{notice}</div>}
          <textarea
            value={input}
            placeholder={disabled ? '请先登录 OA 后使用 AI 助手' : '输入问题，Enter 发送，Shift+Enter 换行'}
            disabled={disabled || streaming}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
            }}
          />
          <div className="ai-composer-actions">
            <span className="ai-title">{title}</span>
            {streaming
              ? <button className="mq-btn" onClick={() => conversationId && window.mcApi.ai.stopMessage(conversationId)}>停止</button>
              : <button className="mq-btn accent" onClick={send} disabled={disabled || !input.trim()}>发送</button>}
          </div>
        </div>
      </section>
    </div>
  )
}

function MessageItem({ message }: { message: AIMessage }) {
  return (
    <div className={`ai-message ${message.role}`}>
      <div className="ai-avatar">{message.role === 'user' ? '我' : 'AI'}</div>
      <div className="ai-bubble">
        {(message.toolRuns || []).map(run => <ToolRunCard key={run.id} run={run} />)}
        {message.role === 'assistant'
          ? <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize, rehypeHighlight]}>{message.content}</ReactMarkdown>
          : <div className="ai-plain">{message.content}</div>}
      </div>
    </div>
  )
}

function ToolRunCard({ run }: { run: AIToolRun }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`ai-tool-run ${run.status}`}>
      <button onClick={() => setOpen(v => !v)}>
        <span>{run.status === 'running' ? '⏳' : run.status === 'error' ? '⚠️' : '✅'} {run.summary || run.toolName}</span>
        <span>{run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : ''}</span>
      </button>
      {open && <pre>{JSON.stringify(run.input, null, 2)}{'\n'}{run.output ? JSON.stringify(run.output, null, 2) : ''}</pre>}
    </div>
  )
}
