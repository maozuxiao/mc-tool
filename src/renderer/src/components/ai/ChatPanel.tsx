import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import rehypeHighlight from 'rehype-highlight'
import type { AIAgentMode, AIConversation, AIMessage, AIProviderConfig, AIToolRun, SavedPrompt, AIProtocol } from '@shared/ai-types'
import { AI_PROTOCOL_LABELS } from '@shared/ai-types'
import { OA_ORIGIN } from '@shared/constants'
import { useStore } from '../../store'

interface ProviderBundle {
  providers: AIProviderConfig[]
  suggestions: Record<string, string[]>
  // 全局偏好：上次使用的服务商 / 模型 / 工作区目录 / 额外目录，跨会话、跨启动恢复
  preferences?: {
    lastProviderId?: string
    lastModelId?: string
    workspaceRoot?: string
    extraRoots?: { alias: string; path: string }[]
  }
}

const MD_EDITOR_URL = 'https://maozuxiao.github.io/Streamax/Tools/KattyBB_MD_Editor/'

// 与 CSS 的断点保持一致：窄窗口下会话栏改为「抽屉」浮层，宽窗口下沿用 44px 竖条收起
const NARROW_QUERY = '(max-width: 760px)'
function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => {
    try { return window.matchMedia(NARROW_QUERY).matches } catch { return false }
  })
  useEffect(() => {
    try {
      const mq = window.matchMedia(NARROW_QUERY)
      const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    } catch { /* 不支持 matchMedia 时退化为非窄窗 */ }
  }, [])
  return narrow
}

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
  // 自定义供应商编辑态：协议可改（仅自定义）；内置预设的协议为只读
  const [providerProtocol, setProviderProtocol] = useState<AIProtocol>('openai-compatible')
  // 新增自定义供应商弹窗与表单
  const [addProviderOpen, setAddProviderOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newProtocol, setNewProtocol] = useState<AIProtocol>('openai-compatible')
  const [newBaseUrl, setNewBaseUrl] = useState('')
  const [newModel, setNewModel] = useState('')
  const [newApiKey, setNewApiKey] = useState('')
  const [modelOpen, setModelOpen] = useState(false)
  const [conversations, setConversations] = useState<AIConversation[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AIMessage[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  // 每会话独立的输入框草稿：键为会话 id（新会话视图用 '__new__'），切换会话互不串扰
  const draftKey = conversationId ?? '__new__'
  const input = drafts[draftKey] ?? ''
  const setInput = useCallback((v: string) => {
    setDrafts(prev => ({ ...prev, [draftKey]: v }))
  }, [draftKey])
  // 回复中用户继续提问时，把问题排队，待本轮结束后依次发送（序列式追问）
  const [queue, setQueue] = useState<string[]>([])
  // 正在生成的会话 id 列表：支持多个会话并发，各会话独立流式推进
  const [streamingIds, setStreamingIds] = useState<string[]>([])
  // 新会话在 conversation-created 回来之前还没有 id，单独记一个生成态
  const [pendingNewStream, setPendingNewStream] = useState(false)
  const [stopping, setStopping] = useState(false)
  // 运行模式：ask 纯对话 / mc 物料查询 / build 文件读写与命令。
  // 刻意不做持久化：Build 是高风险模式，每次启动都回到 mc，由用户主动切换。
  const [mode, setMode] = useState<AIAgentMode>('mc')
  const [notice, setNotice] = useState('')
  // 会话历史栏收起/展开：记住用户偏好，跨启动保留
  const [sideCollapsed, setSideCollapsed] = useState(() => {
    try { return localStorage.getItem('ai.sidebarCollapsed') === '1' } catch { return false }
  })
  const toggleSidebar = () => {
    setSideCollapsed(v => {
      const next = !v
      try { localStorage.setItem('ai.sidebarCollapsed', next ? '1' : '0') } catch { /* 忽略 */ }
      return next
    })
  }
  // 窄窗口：会话栏改为抽屉浮层（不占布局高度），由工具栏 ☰/遮罩/关闭按钮控制显隐
  const isNarrow = useIsNarrow()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const closeDrawer = useCallback(() => setDrawerOpen(false), [])
  // 用户存储的自定义提示词（快捷调用）：点击填入输入框，用户修改后自行发送
  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([])
  const [promptPanelOpen, setPromptPanelOpen] = useState(false)
  const [managerOpen, setManagerOpen] = useState(false)
  const [editingPrompt, setEditingPrompt] = useState<SavedPrompt | null>(null)
  const [formTitle, setFormTitle] = useState('')
  const [formText, setFormText] = useState('')
  const promptPanelRef = useRef<HTMLDivElement | null>(null)
  const promptToggleRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    window.mcApi.ai.listPrompts().then((r: SavedPrompt[]) => setSavedPrompts(r || [])).catch(() => {})
  }, [])
  useEffect(() => {
    if (!promptPanelOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (!promptPanelRef.current || !promptToggleRef.current) return
      if (!promptPanelRef.current.contains(e.target as Node) && !promptToggleRef.current.contains(e.target as Node)) {
        setPromptPanelOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [promptPanelOpen])
  const refreshPrompts = async () => {
    try {
      const list = await window.mcApi.ai.listPrompts()
      setSavedPrompts(list || [])
    } catch { /* 忽略 */ }
  }
  const applyPrompt = (p: SavedPrompt) => { setInput(p.text); setPromptPanelOpen(false) }
  const saveCurrentAsPrompt = async () => {
    const text = input.trim()
    if (!text) return
    try {
      await window.mcApi.ai.savePrompt({ text })
      await refreshPrompts()
      setPromptPanelOpen(false)
    } catch { /* 忽略 */ }
  }
  const removePrompt = async (id: string) => {
    try {
      await window.mcApi.ai.deletePrompt(id)
      await refreshPrompts()
    } catch { /* 忽略 */ }
  }
  const openManager = () => {
    setPromptPanelOpen(false)
    setManagerOpen(true)
    setEditingPrompt(null)
    setFormTitle('')
    setFormText('')
  }
  const closeManager = () => {
    setManagerOpen(false)
    setEditingPrompt(null)
    setFormTitle('')
    setFormText('')
  }
  const startEdit = (p: SavedPrompt) => {
    setEditingPrompt(p)
    setFormTitle(p.title)
    setFormText(p.text)
    setManagerOpen(true)
    setPromptPanelOpen(false)
  }
  const savePromptFromForm = async () => {
    const text = formText.trim()
    if (!text) return
    try {
      if (editingPrompt) {
        await window.mcApi.ai.updatePrompt({ id: editingPrompt.id, text, title: formTitle || text })
      } else {
        await window.mcApi.ai.savePrompt({ text, title: formTitle || text })
      }
      await refreshPrompts()
      setEditingPrompt(null)
      setFormTitle('')
      setFormText('')
    } catch { /* 忽略 */ }
  }
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const messagesRef = useRef<HTMLDivElement | null>(null)
  // 每次发送生成，新会话还没拿到 conversationId 时也能靠它取消
  const requestIdRef = useRef<string>('')
  // 切换会话时保存/恢复滚动位置，避免每次切回来都强制滚到最底部
  const scrollPositionsRef = useRef<Map<string, number>>(new Map())
  const pendingScrollRef = useRef<{ id: string | null }>({ id: null })
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

  const refreshProviders = useCallback(async (): Promise<ProviderBundle | undefined> => {
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
      return data
    } catch (e: any) { setNotice(e.message); return undefined }
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
          // 把 AI 回复的时间戳更新为「回复完成」时刻，而不是请求发起时刻
          setMessages(prev => prev.map(m => m.id === event.messageId ? { ...m, createdAt: Date.now() } : m))
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
      setProviderProtocol(selectedProvider?.protocol || 'openai-compatible')
      return
    }
    if (selectedProvider) {
      setModelId(selectedProvider.defaultModel)
      setModelOptions((providers.suggestions[providerId] || []).slice())
      setApiKey('')
      setProviderProtocol(selectedProvider.protocol || 'openai-compatible')
    }
  }, [providerId])  // eslint-disable-line react-hooks/exhaustive-deps

  // 消息变化时：
  // - 切换会话后第一次渲染：恢复该会话上次保存的滚动位置，没有则保持在顶部
  //   （避免每次切回来都自动滚到最底部）。
  // - 普通流式 / 发送消息：自动滚到最底部。
  useEffect(() => {
    if (pendingScrollRef.current.id && messagesRef.current) {
      const saved = scrollPositionsRef.current.get(pendingScrollRef.current.id)
      messagesRef.current.scrollTop = saved ?? 0
      pendingScrollRef.current.id = null
      return
    }
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

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

  // 本轮回复结束后，依次把排队的问题发出去
  useEffect(() => {
    if (!streaming && !disabled && queue.length > 0) {
      const [next, ...rest] = queue
      setQueue(rest)
      void send(next)
    }
    // eslint-disable-line react-hooks/exhaustive-deps
  }, [streaming, disabled, queue])

  const openConversation = async (id: string) => {
    try {
      // 切走前保存当前会话的滚动位置
      if (conversationIdRef.current && messagesRef.current) {
        scrollPositionsRef.current.set(conversationIdRef.current, messagesRef.current.scrollTop)
      }
      const data = await window.mcApi.ai.getConversation(id)
      setActiveConversation(id)
      setMessages(data.messages)
      pendingScrollRef.current = { id }
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
        // 自定义供应商允许改协议；内置预设忽略（服务端回落到预设）
        ...(selectedProvider?.isCustom ? { protocol: providerProtocol } : {}),
        ...(apiKey ? { apiKey } : {})
      })
      setApiKey('')
      setNotice(t('aiSaved'))
      await refreshProviders()
    } catch (e: any) { setNotice(e.message) }
  }

  // 重置为默认：内置供应商恢复默认 Base URL / 模型并清空 API Key；自定义仅清空 Key
  const resetCurrentProvider = async () => {
    if (!providerId) return
    try {
      const config = await window.mcApi.ai.resetProvider(providerId) as AIProviderConfig
      setApiKey('')
      setProviderProtocol(config.protocol || 'openai-compatible')
      setNotice(t('aiProviderReset'))
      await refreshProviders()
    } catch (e: any) { setNotice(e.message) }
  }

  // 删除自定义供应商（内置预设不可删），删除后回退到第一个内置供应商
  const deleteCurrentProvider = async () => {
    if (!providerId || !selectedProvider?.isCustom) return
    try {
      const name = selectedProvider.name
      await window.mcApi.ai.deleteCustomProvider(providerId)
      const data = await refreshProviders()
      const fallback = data?.providers.find(p => !p.isCustom) || data?.providers[0]
      setProviderId(fallback?.id || '')
      setModelId(fallback?.defaultModel || '')
      setApiKey('')
      setNotice(t('aiProviderDeleted', { name }))
    } catch (e: any) { setNotice(e.message) }
  }

  const openAddProvider = () => {
    setNewName('')
    setNewProtocol('openai-compatible')
    setNewBaseUrl('')
    setNewModel('')
    setNewApiKey('')
    setAddProviderOpen(true)
  }
  const closeAddProvider = () => setAddProviderOpen(false)
  const submitAddProvider = async () => {
    if (!newName.trim()) { setNotice(t('aiProviderNameRequired')); return }
    if (!newBaseUrl.trim()) { setNotice(t('aiProviderBaseRequired')); return }
    try {
      const config = await window.mcApi.ai.addCustomProvider({
        name: newName.trim(),
        protocol: newProtocol,
        baseUrl: newBaseUrl.trim(),
        defaultModel: newModel.trim(),
        ...(newApiKey.trim() ? { apiKey: newApiKey.trim() } : {})
      }) as AIProviderConfig
      setAddProviderOpen(false)
      setProviderId(config.id)
      setModelId(config.defaultModel || '')
      setApiKey('')
      setNotice(t('aiProviderAdded', { name: config.name }))
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

  const send = async (override?: string) => {
    const content = (override ?? input).trim()
    if (!content || streaming || disabled) return
    if (!selectedProvider?.hasApiKey && providerId !== 'ollama') {
      setShowSettings(true)
      setNotice(t('aiNeedApiKey'))
      return
    }
    if (override === undefined) setInput('')
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
        mode,
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

  // 提交：回复中按 Enter 时把问题排队，空闲时直接发送
  const submit = () => {
    const content = input.trim()
    if (!content || disabled) return
    if (streaming) {
      setQueue(q => [...q, content])
      setInput('')
    } else {
      void send()
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
    // 清掉该会话的草稿，避免内存里残留无主草稿
    setDrafts(prev => { const n = { ...prev }; delete n[id]; return n })
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
    <div className={`ai-page${sideCollapsed ? ' side-collapsed' : ''}${isNarrow && drawerOpen ? ' side-open' : ''}`}>
      {isNarrow && drawerOpen && (
        <div className="ai-side-backdrop" onClick={closeDrawer} />
      )}
      <aside className="ai-sidebar">
        <div className="ai-sidebar-head">
          {/* 宽窗口：« 收起为竖条 / » 展开；窄窗口：× 关闭抽屉 */}
          <button
            type="button"
            className="ai-side-toggle"
            title={isNarrow ? t('aiSideCollapse') : (sideCollapsed ? t('aiSideExpand') : t('aiSideCollapse'))}
            onClick={isNarrow ? closeDrawer : toggleSidebar}
          >{isNarrow ? '×' : (sideCollapsed ? '»' : '«')}</button>
          {(!sideCollapsed || isNarrow) && <span>{t('viewAi')}</span>}
          {/* 新对话统一用 26px 图标按钮：文字按钮在英文（AI Assistant + New chat）下会把标题挤到截断 */}
          <button
            type="button"
            className="ai-side-new"
            title={t('aiNewChat')}
            onClick={() => { setActiveConversation(null); setMessages([]); if (isNarrow) setDrawerOpen(false) }}
          >+</button>
        </div>
        <div className="ai-history">
          {conversations.map(c => (
            <div key={c.id} className={`ai-history-item${c.id === conversationId ? ' active' : ''}`}>
              {/* 窄窗口下点会话后自动收起抽屉，避免浮层挡住对话区 */}
              <button className="ai-history-title" onClick={() => { void openConversation(c.id); setDrawerOpen(false) }}>{c.title}</button>
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
          {/* 窄窗口专用：唤起会话抽屉（宽窗口由 CSS 隐藏） */}
          <button
            type="button"
            className="ai-side-menu-btn"
            title={t('aiSideExpand')}
            onClick={() => setDrawerOpen(true)}
          >☰</button>
          <select
            className="ai-select"
            value={providerId}
            onChange={e => {
              // 下拉末项是「添加自定义供应商」入口：不改当前选中，直接打开新增弹窗
              if (e.target.value === '__add_custom__') { openAddProvider(); return }
              setProviderId(e.target.value)
            }}
          >
            <optgroup label={t('aiBuiltinProvider')}>
              {providers.providers.filter(p => !p.isCustom).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </optgroup>
            {providers.providers.some(p => p.isCustom) && (
              <optgroup label={t('aiCustomProvider')}>
                {providers.providers.filter(p => p.isCustom).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </optgroup>
            )}
            <option value="__add_custom__">+ {t('aiAddCustom')}</option>
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
          <div className="ai-mode-switch" role="group" aria-label={t('aiMode')}>
            {(['ask', 'mc', 'build'] as AIAgentMode[]).map(m => (
              <button
                key={m}
                type="button"
                className={`ai-mode-btn${mode === m ? ' active' : ''}`}
                onClick={() => setMode(m)}
                title={m === 'build' ? t('aiWorkspaceTip') : undefined}
              >
                {m === 'ask' ? t('aiModeAsk') : m === 'mc' ? t('aiModeMc') : t('aiModeBuild')}
              </button>
            ))}
          </div>
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
            <label className="ai-field">
              <span>{t('aiProtocol')}</span>
              {selectedProvider?.isCustom ? (
                <select
                  className="ai-select"
                  value={providerProtocol}
                  onChange={e => setProviderProtocol(e.target.value as AIProtocol)}
                >
                  {(['openai-compatible', 'anthropic'] as AIProtocol[]).map(p => (
                    <option key={p} value={p}>{AI_PROTOCOL_LABELS[p]}</option>
                  ))}
                </select>
              ) : (
                <input value={AI_PROTOCOL_LABELS[selectedProvider?.protocol || 'openai-compatible']} disabled />
              )}
            </label>
            <div className="ai-settings-actions">
              <button className="mq-btn" onClick={async () => {
                const res = await window.mcApi.ai.testProvider({ providerId, modelId })
                setNotice(res.ok ? res.message : res.error)
              }}>{t('aiTest')}</button>
              <button className="mq-btn" onClick={resetCurrentProvider} title={selectedProvider?.isCustom ? undefined : t('aiProviderBaseRequired')}>{t('aiResetDefault')}</button>
              {selectedProvider?.isCustom && (
                <button className="mq-btn danger" onClick={deleteCurrentProvider}>{t('aiDeleteProvider')}</button>
              )}
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
              thinking={streaming && i === messages.length - 1 && m.role === 'assistant'}
            />
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="ai-composer">
          {notice && <div className="ai-notice">{notice}</div>}
          {queue.length > 0 && (
            <div className="ai-queue">
              <span className="ai-queue-label">{t('aiQueued', { n: queue.length })}</span>
              {queue.map((q, i) => (
                <span key={i} className="ai-queue-item" title={q}>
                  {q.length > 24 ? q.slice(0, 24) + '…' : q}
                  <button
                    type="button"
                    className="ai-queue-remove"
                    title={t('aiQueueRemove')}
                    onClick={() => setQueue(prev => prev.filter((_, j) => j !== i))}
                  >×</button>
                </span>
              ))}
            </div>
          )}
          <div className="ai-composer-input-wrap">
            <button
              type="button"
              ref={promptToggleRef}
              className={`ai-prompt-toggle${promptPanelOpen ? ' open' : ''}`}
              title={t('aiPromptQuick')}
              onClick={() => setPromptPanelOpen(v => !v)}
            >+</button>
            {promptPanelOpen && (
              <div ref={promptPanelRef} className="ai-prompt-panel">
                <div className="ai-prompt-list">
                  {savedPrompts.length === 0 ? (
                    <div className="ai-prompt-empty">{t('aiPromptEmpty')}</div>
                  ) : (
                    savedPrompts.map(p => (
                      <div key={p.id} className="ai-prompt-item">
                        <button
                          type="button"
                          className="ai-prompt-item-title"
                          title={p.text}
                          onClick={() => applyPrompt(p)}
                        >{p.title || p.text.slice(0, 20)}</button>
                        <div className="ai-prompt-item-actions">
                          <button type="button" className="ai-prompt-item-action" onClick={() => startEdit(p)}>编辑</button>
                          <button type="button" className="ai-prompt-item-action danger" onClick={() => removePrompt(p.id)}>删除</button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <div className="ai-prompt-panel-foot">
                  <button type="button" className="mq-btn ghost" onClick={openManager}>{t('aiPromptManager')}</button>
                  {input.trim() && (
                    <button type="button" className="mq-btn ghost" onClick={saveCurrentAsPrompt}>{t('aiPromptSaveCurrent')}</button>
                  )}
                </div>
              </div>
            )}
            <textarea
              value={input}
              placeholder={disabled ? t('aiLoginRequired') : t('aiInputPh')}
              disabled={disabled}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
              }}
            />
          </div>
          <div className="ai-composer-actions">
            <span className="ai-title">{title}</span>
            {streaming
              ? <button className="mq-btn" onClick={stopGenerating} disabled={stopping}>
                  {stopping ? t('aiStopping') : t('aiStop')}
                </button>
              : <button className="mq-btn accent" onClick={submit} disabled={disabled || !input.trim()}>{t('aiSend')}</button>}
          </div>
        </div>
      </section>
      {addProviderOpen && (
        <div className="ai-prompt-modal-overlay" onClick={closeAddProvider}>
          <div className="ai-prompt-modal" onClick={e => e.stopPropagation()}>
            <div className="ai-prompt-modal-head">{t('aiAddCustom')}</div>
            <div className="ai-prompt-modal-body">
              <div className="ai-prompt-form">
                <input
                  className="ai-prompt-form-title"
                  placeholder={t('aiCustomName')}
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                />
                <select
                  className="ai-select"
                  value={newProtocol}
                  onChange={e => setNewProtocol(e.target.value as AIProtocol)}
                >
                  {(['openai-compatible', 'anthropic'] as AIProtocol[]).map(p => (
                    <option key={p} value={p}>{AI_PROTOCOL_LABELS[p]}</option>
                  ))}
                </select>
                <input
                  placeholder={t('aiBaseUrl')}
                  value={newBaseUrl}
                  onChange={e => setNewBaseUrl(e.target.value)}
                />
                <input
                  placeholder={t('aiModel')}
                  value={newModel}
                  onChange={e => setNewModel(e.target.value)}
                />
                <input
                  type="password"
                  placeholder={t('aiApiKey')}
                  value={newApiKey}
                  onChange={e => setNewApiKey(e.target.value)}
                />
                <div className="ai-prompt-form-actions">
                  <button
                    type="button"
                    className="mq-btn accent"
                    onClick={submitAddProvider}
                    disabled={!newName.trim() || !newBaseUrl.trim()}
                  >{t('aiAddCustom')}</button>
                  <button type="button" className="mq-btn ghost" onClick={closeAddProvider}>{t('aiPromptClose')}</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {managerOpen && (
        <div className="ai-prompt-modal-overlay" onClick={closeManager}>
          <div className="ai-prompt-modal" onClick={e => e.stopPropagation()}>
            <div className="ai-prompt-modal-head">{t('aiPromptManager')}</div>
            <div className="ai-prompt-modal-body">
              <div className="ai-prompt-form">
                <input
                  className="ai-prompt-form-title"
                  placeholder={t('aiPromptTitlePh')}
                  value={formTitle}
                  onChange={e => setFormTitle(e.target.value)}
                />
                <textarea
                  className="ai-prompt-form-text"
                  placeholder={t('aiPromptTextPh')}
                  value={formText}
                  onChange={e => setFormText(e.target.value)}
                  rows={6}
                />
                <div className="ai-prompt-form-actions">
                  <button type="button" className="mq-btn accent" onClick={savePromptFromForm} disabled={!formText.trim()}>
                    {editingPrompt ? t('aiPromptSave') : t('aiPromptAdd')}
                  </button>
                  <button type="button" className="mq-btn ghost" onClick={() => { setEditingPrompt(null); setFormTitle(''); setFormText('') }}>{t('aiPromptReset')}</button>
                  <button type="button" className="mq-btn ghost" onClick={closeManager}>{t('aiPromptClose')}</button>
                </div>
              </div>
              {savedPrompts.length > 0 && (
                <div className="ai-prompt-manager-list">
                  {savedPrompts.map(p => (
                    <div key={p.id} className="ai-prompt-manager-item">
                      <div className="ai-prompt-manager-info">
                        <div className="ai-prompt-manager-title">{p.title || p.text.slice(0, 20)}</div>
                        <div className="ai-prompt-manager-text" title={p.text}>{p.text}</div>
                      </div>
                      <div className="ai-prompt-manager-actions">
                        <button type="button" className="mq-btn ghost" onClick={() => startEdit(p)}>编辑</button>
                        <button type="button" className="mq-btn ghost danger" onClick={() => removePrompt(p.id)}>删除</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function MarkdownLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const t = useStore(s => s.t)
  const display = typeof children === 'string' ? children : ''
  const [downloading, setDownloading] = useState(false)
  const handleClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (!href || downloading) return

    // 把相对路径补成 OA 绝对地址
    let url = href
    if (url.startsWith('/')) url = OA_ORIGIN + url
    if (!/^https?:\/\//i.test(url)) return

    // 判断是不是规格文件下载链接
    const isSpec = /\/specificationFileDownload\b/i.test(url) ||
      /[?&]fileId=/i.test(url) ||
      /[?&]fileName=/i.test(url)

    if (isSpec) {
      const u = new URL(url)
      let filename = u.searchParams.get('fileName') || display || 'spec-file'
      try { filename = decodeURIComponent(filename) } catch { /* 保持原样 */ }
      // 下载/保存都不弹提示框：链接文案本身会变成「下载中…」，
      // 只有真正出错（登录失效、网络失败）才提示，避免打扰用户。
      setDownloading(true)
      try {
        const res: any = await window.mcApi.downloadFile({ url, filename })
        if (!res?.ok && !res?.canceled) {
          void window.mcApi.showMessage({
            type: 'error',
            message: res?.error === 'NEED_RELOGIN'
              ? t('fileNeedLogin')
              : t('fileDownloadFail', { m: res?.error || 'unknown' })
          })
        }
      } catch (err: any) {
        void window.mcApi.showMessage({ type: 'error', message: t('fileDownloadFail', { m: err?.message || String(err) }) })
      } finally {
        setDownloading(false)
      }
      return
    }

    // 普通外部链接用系统默认浏览器打开，避免在当前窗口导航导致白屏
    window.mcApi.openExternal?.(url)
  }

  return (
    <a
      href={href}
      className={`ai-md-link${downloading ? ' busy' : ''}`}
      onClick={handleClick}
      aria-disabled={downloading}
    >
      {downloading ? t('downloading') : children}
    </a>
  )
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

// 把消息时间戳格式化为 YYYY/MM/DD HH:MM:SS（按本机时区，年份补全为 4 位；日期用斜杠、时间用冒号）
function fmtDate(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  const yyyy = String(d.getFullYear())
  return `${yyyy}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
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
          <span className="ai-msg-time">{fmtDate(message.createdAt)}</span>
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
