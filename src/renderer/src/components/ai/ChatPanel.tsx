import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import rehypeHighlight from 'rehype-highlight'
import type { AIAgentMode, AIConversation, AIMessage, AIProviderConfig, AIToolRun, SavedPrompt, AIProtocol } from '@shared/ai-types'
import { AI_PROTOCOL_LABELS } from '@shared/ai-types'
import { OA_ORIGIN } from '@shared/constants'
import { useStore } from '../../store'
import { Button, CodeBlock, Collapse, Icon, Tooltip } from 'animal-island-ui'
import { McSelect } from '../McSelect'

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

/** 库 <Select> 的协议选项（与 AIProtocol 一一对应，标签走共享常量） */
const PROTOCOL_OPTIONS = (['openai-compatible', 'anthropic'] as AIProtocol[]).map(p => ({
  key: p,
  label: AI_PROTOCOL_LABELS[p]
}))

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

  // ── 流式 delta 的「按帧合并」（1.0.42 性能优化）──
  // 原先每个 delta 都 setState 一次，而一次回复动辄几百上千个 delta：每来一个 token 都要
  // 重建 messages 数组、重渲染整条消息列表（并重新解析所有 Markdown）。现改为先把文本累积
  // 在 ref 里，等到下一帧再统一 flush —— 渲染次数从「每个 token 一次」降到「每帧一次」
  // （上限约 60 次/秒），且不会漏字。
  // 另外：非 delta 事件（done / error / tool-* / message-created）与切换会话前都必须先 flush，
  // 否则尾部文本会丢，或落到另一个会话的消息上。
  const pendingDeltaRef = useRef<{ id: string; text: string } | null>(null)
  const deltaRafRef = useRef<number | null>(null)
  const flushDeltas = useCallback(() => {
    if (deltaRafRef.current !== null) {
      cancelAnimationFrame(deltaRafRef.current)
      deltaRafRef.current = null
    }
    const pending = pendingDeltaRef.current
    if (!pending) return
    pendingDeltaRef.current = null
    setMessages(prev => prev.map(m => (m.id === pending.id ? { ...m, content: m.content + pending.text } : m)))
  }, [])
  const queueDelta = useCallback((id: string, text: string) => {
    const cur = pendingDeltaRef.current
    pendingDeltaRef.current = cur && cur.id === id ? { id, text: cur.text + text } : { id, text }
    if (deltaRafRef.current === null) deltaRafRef.current = requestAnimationFrame(flushDeltas)
  }, [flushDeltas])
  // 生成态的「镜像 ref」：滚动跟随的 effect 只依赖 messages，不想把生成态写进依赖
  // （否则生成结束会额外触发一次平滑滚动），又需要读到最新值 —— 用 ref 承接。
  const streamingIdsRef = useRef<string[]>([])
  const pendingNewStreamRef = useRef(false)
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
  // 生成态的镜像 ref（供滚动跟随的 effect 读取，理由见该 effect 的注释）
  streamingIdsRef.current = streamingIds
  pendingNewStreamRef.current = pendingNewStream
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
    // 切会话前先把按帧累积的正文落地：否则这几个字会被算到下一条消息上（见 queueDelta）
    flushDeltas()
    conversationIdRef.current = id
    setConversationId(id)
  }, [flushDeltas])
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

      // delta 走「按帧合并」（见 queueDelta）；其余事件一律先把待落地的文本 flush 掉，
      // 保证「正文尾段 → 工具卡片 / 完成态」的先后顺序不乱。
      if (event.type !== 'delta') flushDeltas()

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
        queueDelta(event.messageId!, event.content || '')
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
  }, [refreshConversations, refreshProviders, setActiveConversation, markStreaming, flushDeltas, queueDelta, t])

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
    const el = messagesRef.current
    if (pendingScrollRef.current.id && el) {
      const saved = scrollPositionsRef.current.get(pendingScrollRef.current.id)
      el.scrollTop = saved ?? 0
      pendingScrollRef.current.id = null
      return
    }
    // 1.0.42 性能优化：流式期间 messages 每帧都在变，此前每次都重新触发一次
    // scrollIntoView({ behavior:'smooth' })——滚动动画互相打断，观感上就是整页在抖，
    // 且每帧都要跑一遍布局。现改为：流式时直接设置 scrollTop（无动画），
    // 并且只在你本来就贴着底部时才自动跟随；上滚查看历史时不再被强行拉回底部。
    // 生成态从 ref 读取（而不是写进依赖）：依赖里加上它会让「生成结束」也额外触发一次
    // 平滑滚动，把正在上翻历史的用户拽回底部。
    if (el && (streamingIdsRef.current.length > 0 || pendingNewStreamRef.current)) {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      if (nearBottom) el.scrollTop = el.scrollHeight
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

  // 库 <Select> 不支持 <optgroup>：保持「内置在前、自定义在后」的顺序，
  // 末尾固定追加「添加自定义供应商」入口，语义与原生下拉一致。
  const providerOptions = useMemo(() => [
    ...providers.providers.filter(p => !p.isCustom).map(p => ({ key: p.id, label: p.name })),
    ...providers.providers.filter(p => p.isCustom).map(p => ({ key: p.id, label: p.name })),
    { key: '__add_custom__', label: `+ ${t('aiAddCustom')}` }
  ], [providers.providers, t])

  return (
    <div className={`ai-page${sideCollapsed ? ' side-collapsed' : ''}${isNarrow && drawerOpen ? ' side-open' : ''}`}>
      {isNarrow && drawerOpen && (
        <div className="ai-side-backdrop" onClick={closeDrawer} />
      )}
      <aside className="ai-sidebar">
        <div className="ai-sidebar-head">
          {/* 库无 chevron 图标：用 Play 三角旋转表达「收起/展开」，窄窗口用 Close 关闭抽屉 */}
          <button
            type="button"
            className="ai-side-toggle"
            title={isNarrow ? t('aiSideCollapse') : (sideCollapsed ? t('aiSideExpand') : t('aiSideCollapse'))}
            onClick={isNarrow ? closeDrawer : toggleSidebar}
          >
            {isNarrow
              ? <Icon name="Close" size={13} />
              : <Icon name="Play" size={12} className={sideCollapsed ? '' : 'ai-rot-180'} />}
          </button>
          {(!sideCollapsed || isNarrow) && <span>{t('viewAi')}</span>}
          {/* 新对话统一用 26px 图标按钮：文字按钮在英文（AI Assistant + New chat）下会把标题挤到截断 */}
          <button
            type="button"
            className="ai-side-new"
            title={t('aiNewChat')}
            onClick={() => { setActiveConversation(null); setMessages([]); if (isNarrow) setDrawerOpen(false) }}
          ><Icon name="Plus" size={16} /></button>
        </div>
        <div className="ai-history">
          {conversations.map(c => (
            <div key={c.id} className={`ai-history-item${c.id === conversationId ? ' active' : ''}`}>
              {/* 窄窗口下点会话后自动收起抽屉，避免浮层挡住对话区 */}
              <button className="ai-history-title" onClick={() => { void openConversation(c.id); setDrawerOpen(false) }}>{c.title}</button>
              <button className="ai-history-delete" title={t('delete')} onClick={() => removeConversation(c.id)}>
                <Icon name="Close" size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="ai-sidebar-foot">
          {/* 提示改用库 <Tooltip variant="default">（文档 #/tooltip 的 default 风格）：
              原生 title 的浏览器气泡延迟长、方头方脑，与全站视觉无关。
              Tooltip 会把触发器包进一层 inline-flex wrapper，宽度改由 .ai-md-editor-tip 撑满。 */}
          <Tooltip className="ai-md-editor-tip" variant="default" placement="top" title={t('aiMdEditorTip')}>
            <Button
              className="ai-md-editor-btn"
              onClick={() => window.mcApi.openExternal(MD_EDITOR_URL)}
            >
              {t('aiMdEditor')}
            </Button>
          </Tooltip>
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
          ><Icon name="Chat" size={16} /></button>
          {/* 自绘 .mc-select（原为库 <Select>）：面板与右侧模型下拉同一套纸感风格，
              触发器用 34px 紧凑变体，与相邻模型输入框同高 */}
          <McSelect
            ariaLabel={t('aiProvider')}
            className="mc-select--provider"
            triggerClassName="mc-select__trigger--sm"
            value={providerId}
            options={providerOptions}
            placeholder={t('aiProvider')}
            onChange={key => {
              // 末项是「添加自定义供应商」入口：不改当前选中，直接打开新增弹窗
              if (key === '__add_custom__') { openAddProvider(); return }
              setProviderId(key)
            }}
          />
          <div className="ai-model-combo">
            <input
              className="ai-model-input"
              value={modelId}
              placeholder={t('aiModel')}
              aria-label={t('aiModel')}
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
          <Button onClick={loadModels}>{t('aiFetchModels')}</Button>
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
          <Button type="primary" onClick={() => setShowSettings(v => !v)}>
            {showSettings ? t('aiCollapseSettings') : t('aiSettings')}
          </Button>
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
            <div className="ai-field">
              <span>{t('aiProtocol')}</span>
              {selectedProvider?.isCustom ? (
                <McSelect
                  ariaLabel={t('aiProtocol')}
                  className="mc-select--block"
                  triggerClassName="mc-select__trigger--sm"
                  value={providerProtocol}
                  options={PROTOCOL_OPTIONS}
                  onChange={key => setProviderProtocol(key as AIProtocol)}
                />
              ) : (
                <input value={AI_PROTOCOL_LABELS[selectedProvider?.protocol || 'openai-compatible']} disabled />
              )}
            </div>
            <div className="ai-settings-actions">
              <Button onClick={async () => {
                const res = await window.mcApi.ai.testProvider({ providerId, modelId })
                setNotice(res.ok ? res.message : res.error)
              }}>{t('aiTest')}</Button>
              <Button onClick={resetCurrentProvider} title={selectedProvider?.isCustom ? undefined : t('aiProviderBaseRequired')}>{t('aiResetDefault')}</Button>
              {selectedProvider?.isCustom && (
                <Button danger onClick={deleteCurrentProvider}>{t('aiDeleteProvider')}</Button>
              )}
              <Button type="primary" onClick={saveProvider}>{t('aiSave')}</Button>
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
                  ><Icon name="Close" size={11} /></button>
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
            ><Icon name="Plus" size={16} /></button>
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
                          <button type="button" className="ai-prompt-item-action" onClick={() => startEdit(p)}>{t('edit')}</button>
                          <button type="button" className="ai-prompt-item-action danger" onClick={() => removePrompt(p.id)}>{t('delete')}</button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <div className="ai-prompt-panel-foot">
                  <Button ghost onClick={openManager}>{t('aiPromptManager')}</Button>
                  {input.trim() && (
                    <Button ghost onClick={saveCurrentAsPrompt}>{t('aiPromptSaveCurrent')}</Button>
                  )}
                </div>
              </div>
            )}
            <textarea
              value={input}
              placeholder={disabled ? t('aiLoginRequired') : t('aiInputPh')}
              disabled={disabled}
              onChange={e => {
                // 输入延迟探针（仅开发模式）：只在「本次输入到下一帧」超过 30ms 时打印，
                // 用来判断打字卡顿是否还在、以及是否已经降到可忽略。
                // 打包后 import.meta.env.DEV 为 false，整段被摇掉。
                if ((import.meta as any).env?.DEV === true) {
                  const t0 = performance.now()
                  requestAnimationFrame(() => {
                    const dt = performance.now() - t0
                    if (dt > 30) console.log(`[perf] 输入到下一帧 ${dt.toFixed(1)}ms（>30ms）`)
                  })
                }
                setInput(e.target.value)
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
              }}
            />
          </div>
          <div className="ai-composer-actions">
            <span className="ai-title">{title}</span>
            {streaming
              ? <Button onClick={stopGenerating} disabled={stopping}>
                  {stopping ? t('aiStopping') : t('aiStop')}
                </Button>
              : <Button type="primary" onClick={submit} disabled={disabled || !input.trim()}>{t('aiSend')}</Button>}
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
                <McSelect
                  ariaLabel={t('aiProtocol')}
                  className="mc-select--block"
                  triggerClassName="mc-select__trigger--sm"
                  value={newProtocol}
                  options={PROTOCOL_OPTIONS}
                  onChange={key => setNewProtocol(key as AIProtocol)}
                />
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
                  <Button
                    type="primary"
                    onClick={submitAddProvider}
                    disabled={!newName.trim() || !newBaseUrl.trim()}
                  >{t('aiAddCustom')}</Button>
                  <Button ghost onClick={closeAddProvider}>{t('aiPromptClose')}</Button>
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
                  <Button type="primary" onClick={savePromptFromForm} disabled={!formText.trim()}>
                    {editingPrompt ? t('aiPromptSave') : t('aiPromptAdd')}
                  </Button>
                  <Button ghost onClick={() => { setEditingPrompt(null); setFormTitle(''); setFormText('') }}>{t('aiPromptReset')}</Button>
                  <Button ghost onClick={closeManager}>{t('aiPromptClose')}</Button>
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
                        <Button ghost onClick={() => startEdit(p)}>{t('edit')}</Button>
                        <Button ghost danger onClick={() => removePrompt(p.id)}>{t('delete')}</Button>
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

    // 内网地址（OA / IAM / MC 等）必须在应用内窗口打开：系统浏览器的 cookie 库与本应用的
    // partition 完全隔离，点过去只会被 302 到 IAM 登录页要求重新扫码。外部站点才交给系统浏览器。
    try {
      const h = new URL(url).hostname.toLowerCase()
      if (/(^|\.)streamax\.com$/.test(h)) {
        void window.mcApi.openOaWindow?.(url)
        return
      }
    } catch { /* 非法 URL：走下面的系统浏览器兜底 */ }
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

const MessageItem = memo(function MessageItem({ message, thinking }: { message: AIMessage; thinking?: boolean }) {
  const t = useStore(s => s.t)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | null>(null)

  // Markdown 解析（remark / rehype + 代码高亮）是这里最贵的一步：此前只要父组件重渲染
  // （每次 delta、每次切视图、每次改语言或主题）就会把**全部历史消息**重新解析一遍。
  // 按 content 记忆化后，内容未变的消息永远复用上一次的结果；叠加 memo，
  // 流式期间只有正在增长的那一条会重新解析。
  const rendered = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize, rehypeHighlight]}
        components={{ a: MarkdownLink }}
      >
        {message.content}
      </ReactMarkdown>
    ),
    [message.content]
  )

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
                {rendered}
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
            <Icon name={copied ? 'Check' : 'File'} size={13} />
            <span>{copied ? t('aiCopied') : t('aiCopy')}</span>
          </button>
        </div>
      </div>
    </div>
  )
})

/** 展开区 JSON 超过这个字符数就不再高亮。
 *  库 <CodeBlock> 是「按 token 切词再逐个拼 <span>」的实现，一份十万字符的工具返回
 *  会拼出上万个节点、把整个对话区拖卡。超过上限就退回纯文本 <pre>：
 *  高亮只是可读性优化，不值得为一次大响应牺牲面板的响应速度。
 *  （阈值按「正常工具返回都在几千字符内」留足余量，实际几乎不会触发。） */
const CODE_HIGHLIGHT_MAX = 20000

/** 展开区 JSON 真正写进 DOM 的硬上限（1.0.42 性能优化）。
 *
 *  库的 <Collapse> 把 answer **一直挂在 DOM 里**（靠 grid-template-rows 收起，见其源码），
 *  所以「折叠着」并不等于「没有成本」。而一次物料查询的 output 就可能是几百行 JSON
 *  （实测：197 条记录），十来张工具卡叠起来就是 MB 级文本常驻对话区 ——
 *  它同时解释了两个现象：
 *    · 在 AI 输入框里打字发卡：每个字符都要让浏览器重排这一大片 DOM；
 *    · 展开工具卡发卡：展开动画要对整块巨型文本重新布局。
 *  因此这里对**真正进 DOM 的那一份**做截断；完整内容仍可一键复制，信息不丢。
 *  注：JSON.stringify「完整内容」那一步仍然保留（复制要用），但只是内存里的字符串，
 *  不进 DOM，成本远低于让几 MB 文本参与布局。 */
const TOOL_JSON_MAX_CHARS = 3000
const TOOL_JSON_MAX_LINES = 50

/** 按行数与字符数双重上限截断，返回截断后的文本与是否发生了截断 */
function clampJson(text: string): { shown: string; truncated: boolean } {
  let shown = text
  let truncated = false
  const lines = shown.split('\n')
  if (lines.length > TOOL_JSON_MAX_LINES) {
    shown = lines.slice(0, TOOL_JSON_MAX_LINES).join('\n')
    truncated = true
  }
  if (shown.length > TOOL_JSON_MAX_CHARS) {
    shown = shown.slice(0, TOOL_JSON_MAX_CHARS)
    truncated = true
  }
  return { shown, truncated }
}

/** 把库 <CodeBlock> 压进聊天气泡的尺寸。
 *
 *  库默认是 20px 24px 内边距 / 14px 字号 / 20px 圆角，那是按文档页的留白定的，
 *  塞进气泡会明显偏大。这里沿用原先 .ai-tool-run__pre 的度量（10px 内边距、
 *  11.5px 字号、280px 限高、8px 圆角），只保留库自己的深色代码底与复制按钮。
 *  深色底 / 边框 / 等宽字体 / overflow 都来自库，不必在这里重复声明。
 *
 *  paddingRight 必须显式给：库只在「没传 padding / paddingRight」时才会自动补 96px
 *  右内边距来给复制按钮让位（见其实现里的 padding===undefined 判断），
 *  我们传了 padding，自动补位就失效了，不给就会被按钮压住第一行代码。 */
const CODE_BLOCK_STYLE: React.CSSProperties = {
  margin: 0,
  padding: '10px',
  paddingRight: 88,
  fontSize: 11.5,
  maxHeight: 280,
  borderRadius: 8
}

/**
 * 工具调用折叠卡。
 *
 * 原先自绘「button + 条件渲染 <pre>」，现改用库 <Collapse>（文档 #/collapse）：
 * 展开/收起、+/− 徽标与高度过渡都由库负责，用法与物料查询页的「批量查询料号」一致。
 * 库的 answer 始终在 DOM 里（靠 grid-template-rows 收起），所以详情不再随展开挂载/卸载。
 * 问答卡本身是按 FAQ 区尺度设计的（见 ai-chat.css 的 .ai-tool-run-collapse 说明），
 * 这里只通过结构选择器把它压到聊天气泡内的尺寸，不命中库的哈希类名。
 *
 * 展开区是 input / output 两份 JSON。原先直接用裸 <pre> 输出，长描述里全是转义的
 * 双引号和 | 分隔符，几乎读不出结构。库里唯一做代码着色的是 <CodeBlock>
 * （rehype-highlight 只作用于 markdown 正文里的围栏代码，这里不是 markdown），
 * 它的分词器覆盖「字符串 / 数字 / true·false·null / 括号冒号」——正好是 JSON 的全部词法，
 * 所以直接拿来用，不需要额外的高亮库。
 */
const ToolRunCard = memo(function ToolRunCard({ run }: { run: AIToolRun }) {
  const t = useStore(s => s.t)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | null>(null)
  useEffect(() => () => { if (copyTimer.current) window.clearTimeout(copyTimer.current) }, [])

  // 完整 JSON：只用于「复制完整内容」，不进 DOM（见 TOOL_JSON_MAX_CHARS 的说明）
  const full = useMemo(() => {
    const head = JSON.stringify(run.input, null, 2)
    return run.output ? `${head}\n${JSON.stringify(run.output, null, 2)}` : head
  }, [run.input, run.output])
  // 真正写进 DOM 的那一份：已截断
  const { shown, truncated } = useMemo(() => clampJson(full), [full])

  const handleCopyFull = async () => {
    const ok = await copyText(full)
    if (!ok) return
    setCopied(true)
    if (copyTimer.current) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Collapse
      className={`mc-collapse ai-tool-run-collapse ${run.status}`}
      question={
        <span className="ai-tool-run__q">
          {/* 运行中=Clock / 失败=Close / 完成=Check（库无 warning 图标，失败用叉号表达） */}
          <Icon name={run.status === 'running' ? 'Clock' : run.status === 'error' ? 'Close' : 'Check'} size={13} />
          <span className="ai-tool-run__name">{run.summary || run.toolName}</span>
          <span className="ai-tool-run__time">{run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : ''}</span>
        </span>
      }
      answer={
        <>
          {/* 被截断（= 本来就是个超大返回）时直接走纯文本兜底：
              一是与上面 CODE_HIGHLIGHT_MAX 的既定策略一致（大返回不做高亮），
              二是避免库 <CodeBlock> 把这几千字符再切成上千个 <span>，
              三是它的内置复制按钮只能复制「这一段」，容易让人以为复制到了完整内容 ——
              完整内容由下面这行的按钮负责。 */}
          {truncated || shown.length > CODE_HIGHLIGHT_MAX
            ? <pre className="ai-tool-run__pre">{shown}</pre>
            : <CodeBlock code={shown} style={CODE_BLOCK_STYLE} />}
          {/* 被截断时才出现这一行：完整内容仍可一键复制，信息不会丢 */}
          {truncated && (
            <div className="ai-tool-run__more">
              <span className="ai-tool-run__more-hint">{t('aiJsonTruncated', { n: full.length })}</span>
              <button type="button" className="ai-copy-btn" onClick={handleCopyFull}>
                <Icon name={copied ? 'Check' : 'File'} size={13} />
                <span>{copied ? t('aiCopied') : t('aiCopyFull')}</span>
              </button>
            </div>
          )}
        </>
      }
    />
  )
})
