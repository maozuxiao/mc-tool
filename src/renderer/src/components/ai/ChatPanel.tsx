import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import rehypeHighlight from 'rehype-highlight'
import type { AIConversation, AIMessage, AIProviderConfig, AIToolRun } from '@shared/ai-types'
import { OA_ORIGIN } from '@shared/constants'
import { useStore } from '../../store'

interface ProviderBundle {
  providers: AIProviderConfig[]
  suggestions: Record<string, string[]>
}

interface Props {
  disabled: boolean
}

export function ChatPanel({ disabled }: Props) {
  const t = useStore(s => s.t)
  const [providers, setProviders] = useState<ProviderBundle>({ providers: [], suggestions: {} })
  const [providerId, setProviderId] = useState('')
  const [modelId, setModelId] = useState('')
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [apiKey, setApiKey] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [conversations, setConversations] = useState<AIConversation[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AIMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [useSkill, setUseSkill] = useState(true)
  const [notice, setNotice] = useState('')
  const bottomRef = useRef<HTMLDivElement | null>(null)
  // 每次发送生成，新会话还没拿到 conversationId 时也能靠它取消
  const requestIdRef = useRef<string>('')

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
      if (event.type === 'error') { setNotice(event.message || t('aiRequestFailed')); setStreaming(false); setStopping(false) }
      if (event.type === 'done') { setStreaming(false); setStopping(false) }
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
      setNotice(t('aiSaved'))
      await refreshProviders()
    } catch (e: any) { setNotice(e.message) }
  }

  const loadModels = async () => {
    if (!providerId) return
    setNotice(t('aiFetchingModels'))
    const res = await window.mcApi.ai.listModels(providerId)
    if (res.ok) {
      setModelOptions(res.models.map((m: any) => m.id))
      setNotice(t('aiModelsFetched', { n: res.models.length }))
    } else {
      setModelOptions(res.suggestions || [])
      setNotice(t('aiModelsFailed', { m: res.error }))
    }
  }

  const send = async () => {
    const content = input.trim()
    if (!content || streaming || disabled) return
    if (!selectedProvider?.hasApiKey && providerId !== 'ollama') {
      setShowSettings(true)
      setNotice(t('aiNeedApiKey'))
      return
    }
    setInput('')
    setStreaming(true)
    setStopping(false)
    setNotice('')
    setMessages(prev => [...prev, {
      id: `local_user_${Date.now()}`,
      conversationId: conversationId || '',
      role: 'user',
      content,
      createdAt: Date.now()
    }])
    // 生成 requestId：新会话落地前 conversationId 还是 null，
    // 只有 requestId 能立刻把这次请求停掉。
    const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    requestIdRef.current = requestId
    try {
      const res = await window.mcApi.ai.sendMessage({
        conversationId: conversationId || undefined,
        requestId,
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
    } finally {
      setStopping(false)
    }
  }

  const stopGenerating = async () => {
    const id = requestIdRef.current || conversationId
    if (!id) {
      // 兜底：实在拿不到 id 也要放开 UI，避免卡在「停止」状态
      setStreaming(false)
      setStopping(false)
      return
    }
    setStopping(true)
    setNotice('')
    try {
      await window.mcApi.ai.stopMessage(id)
    } catch (e: any) {
      setNotice(e.message)
    } finally {
      setStopping(false)
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

  const title = useMemo(() => conversations.find(c => c.id === conversationId)?.title || t('aiNewChatTitle'), [conversations, conversationId, t])
  // 原生 <datalist> 的下拉弹层由浏览器绘制，CSS 无法控制其高度，模型一多就没有滚动条。
  // 改为自绘下拉，沿用应用内 .lifecycle-panel 的规格（max-height + overflow-y: auto）。
  const modelSuggestions = useMemo(() => {
    const kw = modelId.trim().toLowerCase()
    return kw ? modelOptions.filter(m => m.toLowerCase().includes(kw)) : modelOptions
  }, [modelOptions, modelId])

  return (
    <div className="ai-page">
      <aside className="ai-sidebar">
        <div className="ai-sidebar-head">
          <span>{t('viewAi')}</span>
          <button className="mq-btn" onClick={() => { setConversationId(null); setMessages([]) }}>{t('aiNewChat')}</button>
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
          <div className="ai-model-combo">
            <input
              className="ai-model-input"
              value={modelId}
              placeholder={t('aiModel')}
              onChange={e => { setModelId(e.target.value); setModelOpen(true) }}
              onFocus={() => setModelOpen(true)}
              onBlur={() => window.setTimeout(() => setModelOpen(false), 150)}
            />
            {modelOpen && modelSuggestions.length > 0 && (
              <div className="ai-model-panel">
                {modelSuggestions.map(m => (
                  <div
                    key={m}
                    className={`ai-model-option${m === modelId ? ' active' : ''}`}
                    onMouseDown={e => { e.preventDefault(); setModelId(m); setModelOpen(false) }}
                  >
                    {m}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button className="mq-btn" onClick={loadModels}>{t('aiFetchModels')}</button>
          <label className="ai-skill-toggle">
            <input type="checkbox" checked={useSkill} onChange={e => setUseSkill(e.target.checked)} />
            MC Skill
          </label>
          <button className="mq-btn accent" onClick={() => setShowSettings(v => !v)}>{t('aiSettings')}</button>
        </div>

        {showSettings && (
          <div className="ai-settings">
            <div className="ai-settings-title">{t('aiApiConfig', { name: selectedProvider?.name || '' })}</div>
            <label className="ai-field">
              <span>{t('aiBaseUrl')}</span>
              <input value={selectedProvider?.baseUrl || ''} onChange={e => {
                setProviders(prev => ({ ...prev, providers: prev.providers.map(p => p.id === providerId ? { ...p, baseUrl: e.target.value } : p) }))
              }} />
            </label>
            <label className="ai-field">
              <span>{t('aiApiKey')}</span>
              <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={selectedProvider?.hasApiKey ? t('aiKeyConfigured') : t('aiKeyPlaceholder')} />
            </label>
            <div className="ai-settings-actions">
              <button className="mq-btn" onClick={async () => {
                const res = await window.mcApi.ai.testProvider({ providerId, modelId })
                setNotice(res.ok ? res.message : res.error)
              }}>{t('aiTest')}</button>
              <button className="mq-btn accent" onClick={saveProvider}>{t('aiSave')}</button>
            </div>
          </div>
        )}

        <div className="ai-messages">
          {messages.length === 0 && (
            <div className="ai-empty">
              <div className="ai-empty-icon">AI</div>
              <div>{t('aiEmpty')}</div>
            </div>
          )}
          {messages.map(m => <MessageItem key={m.id} message={m} />)}
          <div ref={bottomRef} />
        </div>

        <div className="ai-composer">
          {notice && <div className="ai-notice">{notice}</div>}
          <textarea
            value={input}
            placeholder={disabled ? t('aiLoginRequired') : t('aiInputPh')}
            disabled={disabled || streaming}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
            }}
          />
          <div className="ai-composer-actions">
            <span className="ai-title">{title}</span>
            {streaming
              ? <button className="mq-btn" onClick={stopGenerating} disabled={stopping}>
                  {stopping ? t('aiStopping') : t('aiStop')}
                </button>
              : <button className="mq-btn accent" onClick={send} disabled={disabled || !input.trim()}>{t('aiSend')}</button>}
          </div>
        </div>
      </section>
    </div>
  )
}

function MarkdownLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const display = typeof children === 'string' ? children : ''
  const handleClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (!href) return

    // 把相对路径补成 OA 绝对地址
    let url = href
    if (url.startsWith('/')) url = OA_ORIGIN + url
    if (!/^https?:\/\//i.test(url)) return

    // 判断是不是规格文件下载链接
    const isSpec = /\/specificationFileDownload\b/i.test(url) ||
      /[?&]fileId=/i.test(url) ||
      /[?&]fileName=/i.test(url)

    if (isSpec) {
      try {
        const u = new URL(url)
        let filename = u.searchParams.get('fileName') || display || 'spec-file'
        try { filename = decodeURIComponent(filename) } catch { /* 保持原样 */ }
        const res: any = await window.mcApi.downloadFile({ url, filename })
        if (!res?.ok && !res?.canceled) {
          alert(res?.error === 'NEED_RELOGIN'
            ? 'OA 登录已失效，请重新登录后再下载规格文件'
            : `规格文件下载失败：${res?.error || 'unknown'}`)
        }
      } catch (err: any) {
        alert(`规格文件下载失败：${err?.message || String(err)}`)
      }
      return
    }

    // 普通外部链接用系统默认浏览器打开，避免在当前窗口导航导致白屏
    window.mcApi.openExternal?.(url)
  }

  return <a href={href} onClick={handleClick}>{children}</a>
}

function MessageItem({ message }: { message: AIMessage }) {
  const t = useStore(s => s.t)
  return (
    <div className={`ai-message ${message.role}`}>
      <div className="ai-avatar">{message.role === 'user' ? t('aiRoleUser') : 'AI'}</div>
      <div className="ai-bubble">
        {(message.toolRuns || []).map(run => <ToolRunCard key={run.id} run={run} />)}
        {message.role === 'assistant'
          ? <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize, rehypeHighlight]} components={{ a: MarkdownLink }}>{message.content}</ReactMarkdown>
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
