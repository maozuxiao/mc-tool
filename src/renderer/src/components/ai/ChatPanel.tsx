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
  // 全局偏好：上次使用的服务商 / 模型，跨会话、跨启动恢复
  preferences?: { lastProviderId?: string; lastModelId?: string }
}

const MD_EDITOR_URL = 'https://maozuxiao.github.io/Streamax/Tools/KattyBB_MD_Editor/'

interface Props {
  disabled: boolean
}

export function ChatPanel({ disabled }: Props) {
  const t = useStore(s => s.t)
  const lang = useStore(s => s.lang)
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
  // 正在生成的会话 id 列表：支持多个会话并发，各会话独立流式推进
  const [streamingIds, setStreamingIds] = useState<string[]>([])
  // 新会话在 conversation-created 回来之前还没有 id，单独记一个生成态
  const [pendingNewStream, setPendingNewStream] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [useSkill, setUseSkill] = useState(true)
  const [notice, setNotice] = useState('')
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const messagesRef = useRef<HTMLDivElement | null>(null)
  // 每次发送生成，新会话还没拿到 conversationId 时也能靠它取消
  const requestIdRef = useRef<string>('')
  // 是否已完成「按上次配置初始化」：AI 配置是全局的，只恢复一次，
  // 之后切换会话不再改动 provider / model。
  const initializedRef = useRef(false)
  // 刚恢复出来的 providerId：切换 provider 的副作用会重置模型，
  // 恢复出来的模型不能被它覆盖掉。
  const skipModelResetRef = useRef<string | null>(null)

  const selectedProvider = providers.providers.find(p => p.id === providerId)

  // 当前视图展示的会话。事件必须按会话过滤：别的会话在后台继续生成，
  // 不能把它们的增量内容塞进当前视图。
  const conversationIdRef = useRef<string | null>(null)
  const setActiveConversation = useCallback((id: string | null) => {
    conversationIdRef.current = id
    setConversationId(id)
  }, [])
  const markStreaming = useCallback((id: string, on: boolean) => {
    setStreamingIds(prev => (on
      ? (prev.includes(id) ? prev : [...prev, id])
      : prev.filter(x => x !== id)))
  }, [])
  // 只有「当前打开的会话」在生成时才锁输入；切到别的会话/新会话即可继续提问
  const streaming = pendingNewStream || (!!conversationId && streamingIds.includes(conversationId))

  const refreshConversations = useCallback(async () => {
    try { setConversations(await window.mcApi.ai.listConversations()) } catch {}
  }, [])

  const refreshProviders = useCallback(async () => {
    try {
      const data = await window.mcApi.ai.getProviders() as ProviderBundle
      setProviders(data)
      if (!initializedRef.current && data.providers.length) {
        const prefId = data.preferences?.lastProviderId
        // 上次使用的服务商必须仍然在预设列表里（预设可能被改名/移除）
        const restored = prefId ? data.providers.find(p => p.id === prefId) : undefined
        const fallback = data.providers.find(p => p.hasApiKey) || data.providers[0]
        const nextProviderId = restored?.id || fallback?.id || ''
        setProviderId(nextProviderId)
        const prefModel = data.preferences?.lastModelId
        setModelId(prefModel && restored ? prefModel : (restored?.defaultModel || fallback?.defaultModel || ''))
        skipModelResetRef.current = nextProviderId
        initializedRef.current = true
      }
    } catch (e: any) { setNotice(e.message) }
  }, [])

  useEffect(() => {
    refreshProviders()
    refreshConversations()
    return window.mcApi.ai.onEvent(event => {
      const activeId = conversationIdRef.current
      // 是否属于当前打开的会话。新会话首条消息时 activeId 还是 null，
      // 由 conversation-created 先补上 id，随后的事件就能对上号。
      const isActive = activeId !== null && event.conversationId === activeId

      if (event.type === 'conversation-created') {
        // 只有停留在「新对话」视图时才接管这个新会话；
        // 若用户已经切到别的会话，就让它在后台生成，不打断当前视图。
        if (activeId === null) {
          setActiveConversation(event.conversationId)
          setPendingNewStream(false)
          markStreaming(event.conversationId, true)
        }
        refreshConversations()
        return
      }

      if (event.type === 'message-created') {
        if (!isActive) return
        setMessages(prev => [...prev, {
          id: event.messageId!,
          conversationId: event.conversationId,
          role: 'assistant',
          content: '',
          createdAt: Date.now(),
          toolRuns: []
        }])
        return
      }

      if (event.type === 'delta') {
        if (!isActive) return
        setMessages(prev => prev.map(m => m.id === event.messageId ? { ...m, content: m.content + (event.content || '') } : m))
        return
      }

      if (event.type === 'tool-start') {
        if (!isActive) return
        setMessages(prev => prev.map(m => {
          if (m.id !== event.messageId) return m
          return { ...m, toolRuns: [...(m.toolRuns || []), event.run as AIToolRun] }
        }))
        return
      }

      if (event.type === 'tool-end') {
        if (!isActive) return
        setMessages(prev => prev.map(m => {
          if (m.id !== event.messageId) return m
          return { ...m, toolRuns: (m.toolRuns || []).map(r => r.id === event.run.id ? { ...r, ...event.run } : r) }
        }))
        return
      }

      if (event.type === 'error') {
        markStreaming(event.conversationId, false)
        if (isActive) {
          setNotice(event.message || t('aiRequestFailed'))
          setStopping(false)
        }
        refreshConversations()
        return
      }

      if (event.type === 'done') {
        markStreaming(event.conversationId, false)
        if (isActive) {
          setStopping(false)
          if (event.reason === 'timeout') setNotice(t('aiTimeout'))
          else if (event.reason === 'stopped') setNotice(t('aiStopped'))
        }
        refreshConversations()
      }
    })
  }, [refreshConversations, refreshProviders, setActiveConversation, markStreaming, t])

  useEffect(() => {
    if (!providerId) return
    // 初始化恢复出来的这一次，模型已按上次配置设好，不能再被默认模型覆盖
    if (skipModelResetRef.current === providerId) {
      skipModelResetRef.current = null
      setModelOptions((providers.suggestions[providerId] || []).slice())
      setApiKey('')
      return
    }
    if (selectedProvider) {
      setModelId(selectedProvider.defaultModel)
      setModelOptions((providers.suggestions[providerId] || []).slice())
      setApiKey('')
    }
  }, [providerId])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  // 切到物料查询时本页被 display:none 隐藏，浏览器的滚动位置会丢；
  // 重新显示时回到最新一条，避免用户每次切回来都停在会话开头。
  useEffect(() => {
    const el = messagesRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let wasVisible = el.offsetParent !== null
    const ro = new ResizeObserver(() => {
      const visible = el.offsetParent !== null
      if (visible && !wasVisible) el.scrollTop = el.scrollHeight
      wasVisible = visible
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const openConversation = async (id: string) => {
    try {
      const data = await window.mcApi.ai.getConversation(id)
      setActiveConversation(id)
      setMessages(data.messages)
      // 注意：AI 配置（服务商 / 模型）是全局的，不随会话切换而改变。
      // 历史会话仍然用它当时记录的服务商与模型，只有「当前工具栏选择」保持全局。
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
    // 只标记「当前会话」进入生成态：别的会话仍可继续提问（并发）
    if (conversationId) markStreaming(conversationId, true)
    else setPendingNewStream(true)
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
    // 结束/失败时统一清理本次生成态
    const clearStreaming = () => {
      if (conversationId) markStreaming(conversationId, false)
      else setPendingNewStream(false)
    }
    try {
      const res = await window.mcApi.ai.sendMessage({
        conversationId: conversationId || undefined,
        requestId,
        providerId,
        modelId,
        content,
        useMcSkill: useSkill,
        lang
      })
      // 请求在发出事件之前就失败（如 API Key 缺失），事件不会来，这里兜底清理
      if (!res.ok) { setNotice(res.error); clearStreaming() }
      await refreshConversations()
    } catch (e: any) {
      setNotice(e.message)
      clearStreaming()
    } finally {
      setStopping(false)
    }
  }

  const stopGenerating = async () => {
    // 当前会话已有 id 且在生成中，优先按 id 停；否则退回 requestId（新会话首条）
    const id = (conversationId && streamingIds.includes(conversationId))
      ? conversationId
      : requestIdRef.current
    if (!id) {
      // 兜底：实在拿不到 id 也要放开 UI，避免卡在「停止」状态
      if (conversationId) markStreaming(conversationId, false)
      else setPendingNewStream(false)
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
      setActiveConversation(null)
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
          <button className="mq-btn" onClick={() => { setActiveConversation(null); setMessages([]) }}>{t('aiNewChat')}</button>
        </div>
        <div className="ai-history">
          {conversations.map(c => (
            <div key={c.id} className={`ai-history-item${c.id === conversationId ? ' active' : ''}`}>
              <button className="ai-history-title" onClick={() => openConversation(c.id)}>{c.title}</button>
              <button className="ai-history-delete" onClick={() => removeConversation(c.id)}>×</button>
            </div>
          ))}
        </div>
        <div className="ai-sidebar-foot">
          <button
            className="mq-btn ai-md-editor-btn"
            title={t('aiMdEditorTip')}
            onClick={() => window.mcApi.openExternal(MD_EDITOR_URL)}
          >
            {t('aiMdEditor')}
          </button>
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
          <button className="mq-btn accent" onClick={() => setShowSettings(v => !v)}>
            {showSettings ? t('aiCollapseSettings') : t('aiSettings')}
          </button>
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

        <div className="ai-messages" ref={messagesRef}>
          {messages.length === 0 && (
            <div className="ai-empty">
              <div className="ai-empty-icon">AI</div>
              <div>{t('aiEmpty')}</div>
            </div>
          )}
          {messages.map((m, i) => (
            <MessageItem
              key={m.id}
              message={m}
              // 最后一条助手消息还没收到任何内容时，显示「思考中…」而不是一个空气泡
              thinking={streaming && i === messages.length - 1 && m.role === 'assistant' && !m.content}
            />
          ))}
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

// 复制优先用 Clipboard API；file:// 协议下它可能不可用，回退到 execCommand
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* 继续走回退方案 */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch { return false }
}

function MessageItem({ message, thinking }: { message: AIMessage; thinking?: boolean }) {
  const t = useStore(s => s.t)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | null>(null)

  useEffect(() => () => { if (copyTimer.current) window.clearTimeout(copyTimer.current) }, [])

  const handleCopy = async () => {
    const ok = await copyText(message.content || '')
    if (!ok) return
    setCopied(true)
    if (copyTimer.current) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className={`ai-message ${message.role}`}>
      <div className="ai-avatar">{message.role === 'user' ? t('aiRoleUser') : 'AI'}</div>
      <div className="ai-message-body">
        <div className="ai-bubble">
          {(message.toolRuns || []).map(run => <ToolRunCard key={run.id} run={run} />)}
          {message.role === 'assistant'
            ? (
              <>
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize, rehypeHighlight]} components={{ a: MarkdownLink }}>{message.content}</ReactMarkdown>
                {thinking && (
                  <div className="ai-thinking">
                    <span className="ai-thinking-dots"><i /><i /><i /></span>
                    {t('aiThinking')}
                  </div>
                )}
              </>
            )
            : <div className="ai-plain">{message.content}</div>}
        </div>
        <div className="ai-message-actions">
          <button className="ai-copy-btn" onClick={handleCopy} disabled={!message.content}>
            {copied ? `✓ ${t('aiCopied')}` : `⧉ ${t('aiCopy')}`}
          </button>
        </div>
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
