import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import rehypeHighlight from 'rehype-highlight'
import type { AIAgentMode, AIAttachment, AIConversation, AIMessage, AIProviderConfig, AISkillInfo, AIToolRun, SavedPrompt, AIProtocol } from '@shared/ai-types'
import { AI_PROTOCOL_LABELS, skillKey } from '@shared/ai-types'
import { OA_ORIGIN } from '@shared/constants'
import { useStore } from '../../store'
import { Button, CodeBlock, Collapse, Icon, Tooltip } from 'animal-island-ui'
// naive-icons（手绘 naive 风，MIT，1.1.0）：AI 面板里这几枚「操作类」图标改用它 ——
// 库内置图标是**固定 9 色填充**的手绘风，塞进主题色药丸/小按钮里会显得花。
// 封装见 components/NaiveIcon.tsx（按需引原始 SVG 资源 + 改色跟随主题，见该文件顶部说明）。
import { NaiveIcon } from '../NaiveIcon'
import { McSelect } from '../McSelect'
import { McpModal } from './McpModal'

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

/** 待发队列项（1.0.43）：排队时把附件一起快照下来，避免输入区被清空后丢附件 */
interface QueueItem {
  id: string
  text: string
  attachments?: AIAttachment[]
}

/**
 * 三种模式的图标与说明文案（1.0.43 改为 CodeBuddy 式下拉）。
 * 注意：名称文案仍沿用原来的 对话 / 物料 / Build，`setMode` 的语义与行为完全不变。
 */
const MODE_META: Record<AIAgentMode, { icon: string; labelKey: string; descKey: string }> = {
  ask: { icon: 'Chat', labelKey: 'aiModeAsk', descKey: 'aiModeAskDesc' },
  mc: { icon: 'Search', labelKey: 'aiModeMc', descKey: 'aiModeMcDesc' },
  build: { icon: 'Code', labelKey: 'aiModeBuild', descKey: 'aiModeBuildDesc' }
}

// ── 附件处理（1.0.43）──────────────────────────────────────────────

/** 图片内联上限：最长边缩到 1568px、dataURL 控制在 ~1.2MB（token 与请求体都要留余地） */
const IMG_MAX_EDGE = 1568
const IMG_MAX_BYTES = 1_200_000
/** 文本类附件内联上限（超出截断并在消息里标注） */
const TEXT_MAX_BYTES = 200_000
/** 按扩展名识别的文本类文件（拖进来的 File 常常没有 mime） */
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yml', 'yaml', 'xml', 'html', 'htm', 'log', 'ini', 'conf',
  'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'h', 'cpp', 'cs', 'go', 'rs', 'php', 'rb', 'sh', 'ps1', 'sql', 'bat', 'gradle', 'properties'
])

function humanSize(n?: number): string {
  const v = Number(n || 0)
  if (!v) return ''
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${(v / 1024 / 1024).toFixed(1)} MB`
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result || ''))
    r.onerror = () => reject(new Error('读取失败'))
    r.readAsDataURL(file)
  })
}

/**
 * 图片预处理：按最长边缩放再内联，避免把十几 MB 的原图直接塞进请求体。
 * 透明 PNG 保持 PNG（转 JPEG 会把透明区域填黑），其余统一 JPEG。
 */
async function shrinkImage(file: File): Promise<{ dataUrl: string; size: number }> {
  const src = await readAsDataUrl(file)
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('图片解析失败'))
    el.src = src
  })
  const scale = Math.min(1, IMG_MAX_EDGE / Math.max(img.width, img.height))
  if (scale === 1 && src.length <= IMG_MAX_BYTES) return { dataUrl: src, size: file.size }
  const w = Math.max(1, Math.round(img.width * scale))
  const h = Math.max(1, Math.round(img.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return { dataUrl: src, size: file.size }
  ctx.drawImage(img, 0, 0, w, h)
  const isPng = /image\/png/i.test(file.type)
  let out = canvas.toDataURL(isPng ? 'image/png' : 'image/jpeg', 0.85)
  if (!isPng && out.length > IMG_MAX_BYTES) out = canvas.toDataURL('image/jpeg', 0.6)
  return { dataUrl: out, size: Math.round(out.length * 0.75) }
}

/**
 * 把 File 列表转成附件：
 * - 图片 → 缩放后内联（视觉模型直接读）；
 * - 文本类 → 读成文本内联（超上限截断）；
 * - 其它（xlsx/docx/pdf…）→ 只记本机路径，Build 模式下由模型用 file_read 读取。
 */
async function filesToAttachments(files: File[]): Promise<{ list: AIAttachment[]; skipped: string[] }> {
  const list: AIAttachment[] = []
  const skipped: string[] = []
  let seq = 0
  for (const f of files) {
    const name = f.name || '未命名'
    const id = `att_${Date.now().toString(36)}_${seq++}`
    try {
      if (f.type.startsWith('image/')) {
        const { dataUrl, size } = await shrinkImage(f)
        list.push({ id, name, kind: 'image', mime: f.type, size, dataUrl })
        continue
      }
      const ext = extOf(name)
      if (f.type.startsWith('text/') || TEXT_EXT.has(ext)) {
        const raw = await f.text()
        const truncated = raw.length > TEXT_MAX_BYTES
        list.push({
          id, name, kind: 'text',
          mime: f.type || `text/${ext || 'plain'}`,
          size: f.size,
          text: truncated ? raw.slice(0, TEXT_MAX_BYTES) : raw,
          truncated
        })
        continue
      }
      const path = window.mcApi.getPathForFile?.(f) || ''
      if (!path) { skipped.push(name); continue }
      list.push({ id, name, kind: 'file', mime: f.type, size: f.size, path })
    } catch {
      skipped.push(name)
    }
  }
  return { list, skipped }
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
  const [queue, setQueue] = useState<QueueItem[]>([])

  // ── 模式下拉（1.0.43，参考 CodeBuddy：触发器显示当前模式，菜单里带图标/说明/勾选）──
  const [modePanelOpen, setModePanelOpen] = useState(false)
  const modePanelRef = useRef<HTMLDivElement | null>(null)
  // ── 技能面板（仅 build 模式出现）──
  const [skills, setSkills] = useState<AISkillInfo[]>([])
  const [skillPanelOpen, setSkillPanelOpen] = useState(false)
  const [skillBusy, setSkillBusy] = useState(false)
  // 「诊断」按钮的忙碌态：一键自检会真的探测三条会话线（几秒），期间禁用防连点
  const [diagBusy, setDiagBusy] = useState(false)
  // MCP 服务管理弹窗（1.0.46）：登记 stdio 服务并绑定技能，勾选技能后其工具才会下发
  const [mcpOpen, setMcpOpen] = useState(false)
  const skillPanelRef = useRef<HTMLDivElement | null>(null)
  // ── 附件（粘贴 / 拖拽 / 选择文件）──
  const [attachments, setAttachments] = useState<AIAttachment[]>([])
  const [attachBusy, setAttachBusy] = useState(false)
  // ── 待发队列的拖动排序状态（1.0.43）──
  const [queueDrag, setQueueDrag] = useState<number | null>(null)
  const [queueOver, setQueueOver] = useState<number | null>(null)
  // ── 增强提示词 ──
  const [enhancing, setEnhancing] = useState(false)
  // 增强前的原文，用于「撤销」；null 表示当前没有可撤销的增强结果
  const [enhanceBackup, setEnhanceBackup] = useState<string | null>(null)
  // 正在生成的会话 id 列表：支持多个会话并发，各会话独立流式推进
  const [streamingIds, setStreamingIds] = useState<string[]>([])
  // 「停止 / 超时」时模型一句都没输出 → 气泡会是空的。按 messageId 记下原因，
  // 让空气泡显示一句说明（用户反馈：空消息看起来像「AI 没反应」）。
  // 只影响渲染、不写进历史；历史里的空气泡退化为通用文案。
  const [emptyMsgHints, setEmptyMsgHints] = useState<Record<string, 'stopped' | 'timeout'>>({})
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
  // 技能列表（内置 + 导入）：启动读一次，导入/启停后由对应操作回写
  // 这里直接调 IPC 而不再经过 refreshSkills：那个 useCallback 定义在下方，
  // 写进依赖数组会触发「使用先于声明」的类型错误（TDZ）
  useEffect(() => {
    window.mcApi.ai.listSkills().then((r: AISkillInfo[]) => setSkills(r || [])).catch(() => { /* 读不到就当没有技能 */ })
  }, [])
  // 模式下拉与技能面板：点击面板外收起（与提示词面板同一套交互）
  useEffect(() => {
    if (!modePanelOpen && !skillPanelOpen) return
    const onDocClick = (e: MouseEvent) => {
      const t2 = e.target as Node
      if (modePanelRef.current && !modePanelRef.current.contains(t2)) setModePanelOpen(false)
      if (skillPanelRef.current && !skillPanelRef.current.contains(t2)) setSkillPanelOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [modePanelOpen, skillPanelOpen])
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

  // 1.0.43：AI 输出时若已滚离底部，输入区上沿浮出「回到最新输出」按钮（参考 CodeBuddy）。
  // atBottom 用 state 驱动按钮显隐；阈值与下面的滚动跟随保持一致（80px），
  // 否则会出现「刚跟随到底部、按钮却还亮着」的抖动。
  const [atBottom, setAtBottom] = useState(true)
  /** 用户主动发送时置 true：这一帧强制跟随到底部（哪怕他正翻着历史） */
  const forceFollowRef = useRef(false)
  const syncAtBottom = useCallback(() => {
    const el = messagesRef.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }, [])
  const jumpToLatest = useCallback(() => {
    const el = messagesRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setAtBottom(true)
  }, [])
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
          // 记下「这次是被停止/超时结束的」：该消息若最终没有内容，气泡里给一句说明
          if (event.messageId && (event.reason === 'stopped' || event.reason === 'timeout')) {
            const reason: 'stopped' | 'timeout' = event.reason
            setEmptyMsgHints(prev => ({ ...prev, [event.messageId as string]: reason }))
          }
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
      syncAtBottom()
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
      // 主动发送（forceFollow）时无条件跟随；纯流式增量只在你本来就贴底时跟随，
      // 这样上翻历史不会被强行拽回底部，改为由「回到最新输出」按钮兜住。
      if (nearBottom || forceFollowRef.current) {
        el.scrollTop = el.scrollHeight
        forceFollowRef.current = false
        setAtBottom(true)
      } else {
        setAtBottom(false)
      }
      return
    }
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    forceFollowRef.current = false
    setAtBottom(true)
  }, [messages, syncAtBottom])

  // 切到物料查询时本页被 display:none 隐藏，浏览器的滚动位置会丢；
  // 重新显示时回到最新一条，避免用户每次切回来都停在会话开头。
  useEffect(() => {
    const el = messagesRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let wasVisible = el.offsetParent !== null
    const ro = new ResizeObserver(() => {
      const visible = el.offsetParent !== null
      if (visible && !wasVisible) {
        el.scrollTop = el.scrollHeight
        setAtBottom(true)
      }
      wasVisible = visible
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 本轮回复结束后，依次把排队的问题发出去（连带该条排队项的附件快照）
  useEffect(() => {
    if (!streaming && !disabled && queue.length > 0) {
      const [next, ...rest] = queue
      setQueue(rest)
      void send(next.text, next.attachments)
    }
    // eslint-disable-line react-hooks/exhaustive-deps
  }, [streaming, disabled, queue])

  const openConversation = async (id: string) => {
    try {
      // 切走前保存当前会话的滚动位置
      if (conversationIdRef.current && messagesRef.current) {
        scrollPositionsRef.current.set(conversationIdRef.current, messagesRef.current.scrollTop)
      }
      const data: any = await window.mcApi.ai.getConversation(id)
      setActiveConversation(id)
      setMessages(data.messages)
      // 恢复该会话上次的勾选（1.0.47）：只在内存里还没有这条会话的记录时用库里的值 ——
      // 同一进程内用户刚改过的勾选以内存为准，不能被旧值覆盖回去。
      const saved = data?.conversation?.enabledSkills
      if (Array.isArray(saved)) {
        setSkillSel(prev => (prev[id] ? prev : { ...prev, [id]: saved.map(String) }))
      }
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

  const send = async (override?: string, overrideAtts?: AIAttachment[]) => {
    const content = (override ?? input).trim()
    if (!content || streaming || disabled) return
    // 主动发送：无论此刻滚到哪儿都跟着新消息回到底部（按钮兜住的是「被动流式」那段）
    forceFollowRef.current = true
    if (!selectedProvider?.hasApiKey && providerId !== 'ollama') {
      setShowSettings(true)
      setNotice(t('aiNeedApiKey'))
      return
    }
    // 附件：排队项自带的优先（overrideAtts），否则用输入区当前的
    const atts = (overrideAtts && overrideAtts.length ? overrideAtts : attachments)
    const sendAtts = atts.length ? atts : undefined
    // 「本机文件路径」这类附件只有 Build 模式能读，其它模式先提示（图片/文本仍照常发送）
    if (mode !== 'build' && sendAtts?.some(a => a.kind === 'file')) {
      setNotice(t('aiAttachFileNeedsBuild'))
    }
    if (override === undefined) { setInput(''); setAttachments([]); setEnhanceBackup(null) }
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
      attachments: sendAtts,
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
        lang,
        attachments: sendAtts,
        // 技能只在 build 模式生效（Skills 面板也只在 build 模式出现）
        enabledSkills: mode === 'build' ? enabledSkills : undefined
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

  // 提交：回复中按 Enter 时把问题排队（连带附件一起快照），空闲时直接发送
  const submit = () => {
    const content = input.trim()
    if (!content || disabled) return
    if (streaming) {
      setQueue(q => [...q, {
        id: `q_${Date.now().toString(36)}_${q.length}`,
        text: content,
        attachments: attachments.length ? attachments : undefined
      }])
      setInput('')
      setAttachments([])
      setEnhanceBackup(null)
    } else {
      void send()
    }
  }

  // 「继续」按钮（1.0.46）：模型偶尔只回一句计划宣告就结束回合（实测「DS100 规格书」那轮：
  // 33 字、0 个工具调用，用户只能手打「请继续」）。一键等效：空闲直接 send('继续')，生成中排队。
  // 用 ref 包一层保持回调身份稳定 —— MessageItem 是 memo 组件，不能让每次渲染都把它打穿。
  const continueRef = useRef<() => void>(() => {})
  continueRef.current = () => {
    const text = t('aiContinueText')
    if (streaming) {
      setQueue(q => [...q, { id: `q_${Date.now().toString(36)}_${q.length}`, text }])
    } else if (!disabled) {
      void send(text)
    }
  }
  const onContinue = useCallback(() => continueRef.current(), [])

  // ── 附件 ──────────────────────────────────────────────────────
  const attachFromFiles = useCallback(async (files: FileList | File[] | null) => {
    const arr = files ? Array.from(files as File[]) : []
    if (!arr.length) return
    setAttachBusy(true)
    try {
      const { list, skipped } = await filesToAttachments(arr)
      if (list.length) setAttachments(prev => [...prev, ...list])
      if (skipped.length) setNotice(t('aiAttachSkipped', { names: skipped.join('、') }))
    } finally {
      setAttachBusy(false)
    }
  }, [t])

  const pickFiles = () => {
    const el = document.createElement('input')
    el.type = 'file'
    el.multiple = true
    el.onchange = () => { void attachFromFiles(el.files) }
    el.click()
  }

  // ── 待发队列操作（1.0.43）：拖动排序 / 立即发送 / 载回输入框编辑 ──
  const moveQueueItem = (from: number | null, to: number) => {
    if (from === null || from === to) return
    setQueue(prev => {
      const next = prev.slice()
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return next
    })
  }
  const sendQueueItemNow = (id: string) => {
    const item = queue.find(q => q.id === id)
    if (!item) return
    if (streaming) {
      // 正在生成：插到队首（本轮结束后第一个发出）
      setQueue(prev => [item, ...prev.filter(q => q.id !== id)])
      setNotice(t('aiQueueMovedFirst'))
      return
    }
    setQueue(prev => prev.filter(q => q.id !== id))
    void send(item.text, item.attachments)
  }
  const editQueueItem = (id: string) => {
    const item = queue.find(q => q.id === id)
    if (!item) return
    setQueue(prev => prev.filter(q => q.id !== id))
    setInput(item.text)
    if (item.attachments?.length) setAttachments(item.attachments)
  }

  // ── 增强提示词 ────────────────────────────────────────────────
  const enhancePrompt = async () => {
    const text = input.trim()
    if (!text || enhancing || !providerId) return
    setEnhancing(true)
    setNotice('')
    try {
      const res = await window.mcApi.ai.optimizePrompt({ providerId, modelId, text, lang })
      if (!res?.ok) { setNotice(res?.message || t('aiEnhanceFailed')); return }
      setEnhanceBackup(text)
      setInput(String(res.text || ''))
    } catch (e: any) {
      setNotice(e.message)
    } finally {
      setEnhancing(false)
    }
  }
  const undoEnhance = () => {
    if (enhanceBackup === null) return
    setInput(enhanceBackup)
    setEnhanceBackup(null)
  }

  // ── 技能（仅 build 模式）──────────────────────────────────────
  // 勾选**按会话独立**（1.0.43 修复）：键是会话 id，未落库的新会话用 '__new__'。
  // 早先勾选是全局持久化的，于是「上一个会话勾了，新建会话照样勾着」。
  // 现在：新建会话从零开始；切回旧会话仍是原样；进程重启后全部不勾选。
  const [skillSel, setSkillSel] = useState<Record<string, string[]>>({})
  const convKey = conversationId ?? '__new__'
  const selectedSkillKeys = skillSel[convKey] || []
  const refreshSkills = useCallback(async () => {
    try { setSkills(await window.mcApi.ai.listSkills() as AISkillInfo[]) } catch { /* 读不到就当没有技能 */ }
  }, [])
  const enabledSkillInfos = useMemo(
    () => skills.filter(s => selectedSkillKeys.includes(skillKey(s))),
    [skills, selectedSkillKeys]
  )
  // 下发给主进程的是「来源:id」（内置与导入同名时靠它区分注入哪一份）
  const enabledSkills = useMemo(() => enabledSkillInfos.map(s => skillKey(s)), [enabledSkillInfos])
  // 勾选落库（1.0.47）：按会话持久化，重启/切回旧会话能恢复。'__new__' 还没有会话 id，跳过，
  // 等会话创建后由下面的迁移 effect 补落。落库失败不影响本次勾选。
  const persistSkillSel = useCallback((convId: string | null, keys: string[]) => {
    if (!convId || convId === '__new__') return
    try { void window.mcApi.ai.setConvSkills(convId, keys) } catch { /* 落库失败不阻塞 */ }
  }, [])
  const toggleSkill = (key: string, enabled: boolean) => {
    const cur = new Set(selectedSkillKeys)
    if (enabled) cur.add(key)
    else cur.delete(key)
    const next = [...cur]
    setSkillSel(prev => ({ ...prev, [convKey]: next }))
    // 落库放在 setState 外面：state updater 必须是纯函数（StrictMode 下会被调用两次）
    persistSkillSel(conversationId, next)
  }
  // 新会话第一次拿到 id 时，把 '__new__' 槽的勾选迁到这条会话上（否则发送后技能会被悄悄丢掉），
  // 并清空 '__new__' —— 这样「下一条新会话」又是从零开始，正是本次要修的行为
  const skillSelRef = useRef(skillSel)
  skillSelRef.current = skillSel
  const prevConvIdRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevConvIdRef.current
    prevConvIdRef.current = conversationId
    if (prev || !conversationId) return
    const pending = skillSelRef.current['__new__'] || []
    if (!pending.length) return
    setSkillSel(s => (s[conversationId] ? s : { ...s, [conversationId]: pending, __new__: [] }))
    // 迁移的同时落库：会话刚创建，把新会话的勾选写进它的记录，重启/切回才能恢复
    persistSkillSel(conversationId, pending)
  }, [conversationId, persistSkillSel])
  // 「诊断」：一键体检三条会话线（OA / IAM / 鸿翼 edoc2），结论弹窗、明细同时写进 wjxt.log。
  // 用途：用户报「搜不到文件 / 让登录」时，让 TA 点一下就能拿到「到底是哪一条线断了」。
  const runDiag = async () => {
    setDiagBusy(true)
    try {
      const r: any = await window.mcApi.wjxtDiagnose?.()
      if (!r?.ok) { void window.mcApi.showMessage({ type: 'warning', message: t('aiDiagFailed') }); return }
      void window.mcApi.showMessage({ type: 'info', title: t('aiDiagTitle'), message: `${r.verdict}\n\n${r.detail}` })
    } catch (e: any) {
      void window.mcApi.showMessage({ type: 'error', message: `${t('aiDiagFailed')}：${e?.message || String(e)}` })
    } finally {
      setDiagBusy(false)
    }
  }

  const importSkill = async (kind: 'zip' | 'dir') => {
    setSkillBusy(true)
    try {
      const res = await window.mcApi.ai.importSkill(kind) as any
      if (res?.canceled) return
      if (!res?.ok) { setNotice(res?.message || t('aiSkillImportFailed')); return }
      setSkills(res.skills as AISkillInfo[])
      // 导入是明确动作 → 直接把刚导入的（user 来源那份，与内置同名也不冲突）勾到当前会话上
      if (res.id) toggleSkill(skillKey({ source: 'user', id: String(res.id) }), true)
      setNotice(t(res.overwritten ? 'aiSkillUpdated' : 'aiSkillImported', { name: res.name || res.id || '' }))
    } finally {
      setSkillBusy(false)
    }
  }
  const removeSkillById = async (id: string) => {
    setSkillBusy(true)
    try {
      const res = await window.mcApi.ai.removeSkill(id) as any
      if (!res?.ok) { setNotice(res?.message || t('aiSkillImportFailed')); return }
      setSkills(res.skills as AISkillInfo[])
      // 同步把各会话里对它的勾选清掉，避免留下悬空键（只可能删掉 user 来源那份）
      const dead = skillKey({ source: 'user', id })
      setSkillSel(prev => {
        const next: Record<string, string[]> = {}
        for (const [k, v] of Object.entries(prev)) next[k] = v.filter(x => x !== dead)
        return next
      })
    } finally {
      setSkillBusy(false)
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
              {/* 该会话正在生成时给个标记：并发生成时才能一眼看出哪条在跑（1.0.43） */}
              {streamingIds.includes(c.id) && (
                <span className="ai-history-running" title={t('aiStreamingBadge')}>
                  <span className="ai-history-running__dot" />
                </span>
              )}
              <button className="ai-history-delete" title={t('delete')} onClick={() => removeConversation(c.id)} data-cursor="pointer">
                <NaiveIcon name="close" size={13} />
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
          {/* 模式选择（1.0.43 参考 CodeBuddy）：触发器展示当前模式，菜单项带图标 / 名称 / 说明 / 勾选。
              名称与行为完全不变——仍是 对话 / 物料 / Build 三种模式，setMode 语义不变。 */}
          <div className="ai-mode-picker" ref={modePanelRef}>
            <button
              type="button"
              className={`ai-mode-trigger${modePanelOpen ? ' open' : ''}`}
              aria-haspopup="listbox"
              aria-expanded={modePanelOpen}
              aria-label={t('aiMode')}
              title={mode === 'build' ? t('aiWorkspaceTip') : t('aiMode')}
              onClick={() => setModePanelOpen(v => !v)}
            >
              <Icon name={MODE_META[mode].icon as any} size={14} />
              <span className="ai-mode-trigger__text">{t(MODE_META[mode].labelKey)}</span>
              <span className="ai-mode-caret"><Icon name="Play" size={10} /></span>
            </button>
            {modePanelOpen && (
              <div className="ai-mode-panel" role="listbox" aria-label={t('aiMode')}>
                {(['ask', 'mc', 'build'] as AIAgentMode[]).map(m => (
                  <button
                    key={m}
                    type="button"
                    role="option"
                    aria-selected={mode === m}
                    className={`ai-mode-option${mode === m ? ' on' : ''}`}
                    onClick={() => { setMode(m); setModePanelOpen(false) }}
                  >
                    <span className="ai-mode-option__icon"><Icon name={MODE_META[m].icon as any} size={16} /></span>
                    <span className="ai-mode-option__body">
                      <span className="ai-mode-option__name">{t(MODE_META[m].labelKey)}</span>
                      <span className="ai-mode-option__desc">{t(MODE_META[m].descKey)}</span>
                    </span>
                    {mode === m && <span className="ai-mode-option__check"><Icon name="Check" size={14} /></span>}
                  </button>
                ))}
              </div>
            )}
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

        <div className="ai-messages" ref={messagesRef} onScroll={syncAtBottom}>
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
              emptyHint={emptyMsgHints[m.id]}
              onContinue={onContinue}
            />
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="ai-composer">
          {/* 滚离底部时浮出「回到最新输出」（1.0.43，参考 CodeBuddy）：
              点击平滑回到底部；生成中额外带一个呼吸点，提示「上面还有新内容」 */}
          {!atBottom && (
            <button
              type="button"
              className={`ai-jump-btn${streaming ? ' is-live' : ''}`}
              title={t('aiJumpLatest')}
              aria-label={t('aiJumpLatest')}
              onClick={jumpToLatest}
            ><Icon name="Play" size={14} /></button>
          )}
          {notice && <div className="ai-notice">{notice}</div>}
          {/* 增强提示词后给一次「撤销」机会：把原文还回来，避免误点后要重新敲 */}
          {enhanceBackup !== null && (
            <div className="ai-notice ai-notice--ok">
              <span>{t('aiEnhanced')}</span>
              <button type="button" className="ai-notice-action" onClick={undoEnhance}>{t('aiUndo')}</button>
            </div>
          )}
          {queue.length > 0 && (
            <div className="ai-queue">
              <span className="ai-queue-label">{t('aiQueued', { n: queue.length })}</span>
              <div className="ai-queue-list">
                {queue.map((q, i) => (
                  <div
                    key={q.id}
                    className={`ai-queue-item${queueOver === i && queueDrag !== null && queueDrag !== i ? ' dragover' : ''}`}
                    draggable
                    onDragStart={() => { setQueueDrag(i); setQueueOver(null) }}
                    onDragOver={e => { e.preventDefault(); if (queueDrag !== null && queueDrag !== i) setQueueOver(i) }}
                    onDragLeave={() => setQueueOver(v => (v === i ? null : v))}
                    onDrop={e => { e.preventDefault(); moveQueueItem(queueDrag, i); setQueueDrag(null); setQueueOver(null) }}
                    onDragEnd={() => { setQueueDrag(null); setQueueOver(null) }}
                    title={q.text}
                  >
                    <span className="ai-queue-item__text">{q.text.length > 40 ? q.text.slice(0, 40) + '…' : q.text}</span>
                    {q.attachments?.length ? (
                      <span className="ai-queue-item__att" title={t('aiAttachCount', { n: q.attachments.length })}>
                        <Icon name="File" size={11} />{q.attachments.length}
                      </span>
                    ) : null}
                    <span className="ai-queue-item__ops">
                      <button type="button" className="ai-queue-op" title={t('aiQueueSendNow')}
                        onClick={() => sendQueueItemNow(q.id)}><NaiveIcon name="play" size={11} /></button>
                      <button type="button" className="ai-queue-op" title={t('aiQueueEdit')}
                        onClick={() => editQueueItem(q.id)}><NaiveIcon name="pencil" size={11} /></button>
                      <button type="button" className="ai-queue-op danger" title={t('aiQueueRemove')}
                        onClick={() => setQueue(prev => prev.filter(x => x.id !== q.id))}><NaiveIcon name="close" size={11} /></button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* 已启用技能的 chip（1.0.43，参考 CodeBuddy：选中的技能在输入框上方成一行 chip）：
              点 chip 打开 Skills 面板继续管理，点 × 直接停用该技能 */}
          {mode === 'build' && enabledSkillInfos.length > 0 && (
            <div className="ai-skill-chip-list">
              {enabledSkillInfos.map(s => (
                <span key={skillKey(s)} className="ai-skill-chip" title={s.description || s.id}>
                  <button type="button" className="ai-skill-chip__main" onClick={() => setSkillPanelOpen(true)}>
                    <NaiveIcon name="rocket" size={12} />
                    <span className="ai-skill-chip__name">{s.name}</span>
                  </button>
                  <button
                    type="button"
                    className="ai-skill-chip__remove"
                    title={t('aiSkillDisable')}
                    onClick={() => toggleSkill(skillKey(s), false)}
                  ><NaiveIcon name="close" size={11} /></button>
                </span>
              ))}
            </div>
          )}
          {/* 附件 chips：粘贴截图 / 拖拽文件 / 选择文件都会落到这里，发送时随消息一起带走 */}
          {attachments.length > 0 && (
            <div className="ai-attach-list">
              {attachments.map(a => (
                <AttachChip
                  key={a.id}
                  a={a}
                  onRemove={id => setAttachments(prev => prev.filter(x => x.id !== id))}
                />
              ))}
              <button type="button" className="ai-attach-clear" onClick={() => setAttachments([])}>{t('aiAttachClear')}</button>
            </div>
          )}
          <div
            className="ai-composer-drop"
            onDragOver={e => { e.preventDefault() }}
            onDrop={e => { e.preventDefault(); void attachFromFiles(e.dataTransfer?.files || null) }}
          >
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
              // 粘贴：剪贴板里的截图，以及从资源管理器复制的文件，都直接变成附件
              onPaste={e => {
                const files = e.clipboardData?.files
                if (files && files.length) { e.preventDefault(); void attachFromFiles(files) }
              }}
            />
          </div>
          </div>
          <div className="ai-composer-actions">
            <span className="ai-title">{title}</span>
            <div className="ai-composer-tools">
              {/* 增强提示词：调用当前供应商把草稿改写成更明确的提示词（不自动发送，可撤销） */}
              <Button
                onClick={enhancePrompt}
                disabled={disabled || !input.trim() || enhancing}
                title={t('aiEnhanceTip')}
              >
                <Icon name="Star" size={13} />
                <span>{enhancing ? t('aiEnhancing') : t('aiEnhance')}</span>
              </Button>
              {/* 附件：图片 / 文本 / 其他文件（其他格式在 Build 模式下交给 file_read） */}
              <Button onClick={pickFiles} disabled={disabled || attachBusy} title={t('aiAttachTip')}>
                <Icon name="File" size={13} />
                <span>{attachBusy ? t('aiAttachBusy') : t('aiAttach')}</span>
              </Button>
              {/* 技能：仅 Build 模式（Skills 面板 + 导入） */}
              {mode === 'build' && (
                <div className="ai-skill-picker" ref={skillPanelRef}>
                  <Button
                    onClick={() => setSkillPanelOpen(v => !v)}
                    disabled={disabled}
                    title={t('aiSkillsTip')}
                  >
                    <NaiveIcon name="rocket" size={13} />
                    <span>{t('aiSkills')}{enabledSkills.length ? ` (${enabledSkills.length})` : ''}</span>
                  </Button>
                  {skillPanelOpen && (
                    <div className="ai-skill-panel">
                      <div className="ai-skill-panel__head">{t('aiSkillsTitle')}</div>
                      {/* 技能默认全部不勾选（含内置技能），且勾选只对当前会话生效：给一句明示 */}
                      {skills.length > 0 && selectedSkillKeys.length === 0 && (
                        <div className="ai-skill-none">{t('aiSkillNoneOn')}</div>
                      )}
                      {skills.length === 0 && <div className="ai-skill-empty">{t('aiSkillEmpty')}</div>}
                      {/* 列表单独滚动、头/底栏固定：英文下底部那三个按钮更宽更高，
                          以前整块面板一起滚，列表被挤成一小条、按钮还得滚动才看得见 */}
                      <div className="ai-skill-list">
                      {skills.map(s => {
                        const on = selectedSkillKeys.includes(skillKey(s))
                        return (
                        <div key={skillKey(s)} className={`ai-skill-item${on ? ' on' : ''}`}>
                          <button
                            type="button"
                            className="ai-skill-item__main"
                            title={s.description}
                            onClick={() => toggleSkill(skillKey(s), !on)}
                          >
                            {/* 勾选框：启用=实心主题色方块 + 白色对勾；停用=只有描边的空框。
                                此前写成「永远渲染对勾、只把颜色调淡」，取消勾选后看起来没有任何变化 */}
                            <span className={`ai-skill-item__check${on ? ' on' : ''}`}>
                              {on && <Icon name="Check" size={11} />}
                            </span>
                            <span className="ai-skill-item__text">
                              <span className="ai-skill-item__name">
                                {s.name}
                                {/* 来源标签：同 id 时导入版会遮蔽内置版，标出来才知道当前生效的是哪一份 */}
                                <span className={`ai-skill-item__tag${s.source === 'user' ? ' is-user' : ''}`}>
                                  {s.source === 'user' ? t('aiSkillUser') : t('aiSkillBuiltin')}
                                </span>
                                {/* 「需 MCP」徽标（1.0.46）：SKILL.md 声明了 MCP 工具但还没绑定服务 ——
                                    勾了也用不了，点它直达 MCP 服务登记，避免再次踩「勾了但用不了」 */}
                                {s.needsMcp && !s.mcpBound && (
                                  <button
                                    type="button"
                                    className="ai-skill-item__badge"
                                    title={t('mcpNeedsTip')}
                                    onClick={() => { setSkillPanelOpen(false); setMcpOpen(true) }}
                                  >{t('mcpNeedsBadge')}</button>
                                )}
                              </span>
                              <span className="ai-skill-item__desc">{s.description || s.id}</span>
                            </span>
                          </button>
                          {s.source === 'user' && (
                            <button
                              type="button"
                              className="ai-skill-item__del"
                              title={t('delete')}
                              onClick={() => void removeSkillById(s.id)}
                            ><NaiveIcon name="trash" size={12} /></button>
                          )}
                        </div>
                        )
                      })}
                      </div>
                      {/* 底栏按钮统一 size="small"：英文 Import zip / Import folder / Diagnose 用默认尺寸时
                          又宽又高，三个就把面板占满、纵向还吃掉一大块 —— 这正是「英文下面板显小」的根因 */}
                      <div className="ai-skill-panel__foot">
                        {/* 图标走 Button 的 icon 插槽（inline-flex + gap，间距由库负责），
                            emoji 纯装饰故 aria-hidden；文案仍走 i18n，中英各一份 */}
                        <Button
                          size="small"
                          ghost
                          icon={<span className="ai-skill-btn-ico" aria-hidden="true">🗃️</span>}
                          onClick={() => void importSkill('zip')}
                          disabled={skillBusy}
                        >{t('aiSkillImportZip')}</Button>
                        <Button
                          size="small"
                          ghost
                          icon={<span className="ai-skill-btn-ico" aria-hidden="true">📂</span>}
                          onClick={() => void importSkill('dir')}
                          disabled={skillBusy}
                        >{t('aiSkillImportDir')}</Button>
                        {/* 一键自检：三条会话线（OA / IAM / 鸿翼 edoc2）一次问清，结论直接弹窗 */}
                        <Button
                          size="small"
                          ghost
                          icon={<span className="ai-skill-btn-ico" aria-hidden="true">🩺</span>}
                          onClick={() => void runDiag()}
                          disabled={diagBusy}
                        >{diagBusy ? t('aiDiagRunning') : t('aiDiagBtn')}</Button>
                        {/* MCP 服务管理（1.0.46）：登记 stdio 服务并绑定技能，勾选技能后其工具才下发 */}
                        <Button
                          size="small"
                          ghost
                          icon={<span className="ai-skill-btn-ico" aria-hidden="true">🔌</span>}
                          onClick={() => setMcpOpen(true)}
                        >{t('mcpTitle')}</Button>
                      </div>
                      <div className="ai-skill-panel__hint">{t('aiSkillHint')}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
            {streaming
              ? <Button onClick={stopGenerating} disabled={stopping}>
                  {stopping ? t('aiStopping') : t('aiStop')}
                </Button>
              : <Button type="primary" onClick={submit} disabled={disabled || !input.trim()}>{t('aiSend')}</Button>}
          </div>
        </div>
      </section>
      {/* MCP 服务管理弹窗（Skills 面板底栏「🔌 MCP」打开） */}
      <McpModal open={mcpOpen} onClose={() => setMcpOpen(false)} skills={skills} />
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

/**
 * 附件 chip（输入区待发列表与消息气泡回显共用，1.0.43）。
 *
 * 图片类型**鼠标悬停（或键盘聚焦）时在 chip 上方浮出原图预览** ——
 * 此前只有一个 20px 缩略图，两张截图放一起根本分不清哪张是哪张；
 * 发送之后的回显同样可以悬停查看。
 * 预览层 `pointer-events: none`：鼠标移上去不会被它抢走 hover 导致闪烁。
 */
function AttachChip({ a, onRemove }: { a: AIAttachment; onRemove?: (id: string) => void }) {
  const t = useStore(s => s.t)
  const isImg = a.kind === 'image' && !!a.dataUrl
  return (
    <span className={`ai-attach-chip ${a.kind}`} title={a.path || a.name}>
      {isImg
        ? <img className="ai-attach-chip__thumb" src={a.dataUrl} alt="" />
        : <Icon name={a.kind === 'text' ? 'Pencil' : 'File'} size={12} />}
      <span className="ai-attach-chip__name">{a.name}</span>
      {a.size ? <span className="ai-attach-chip__size">{humanSize(a.size)}</span> : null}
      {a.truncated ? <span className="ai-attach-chip__warn">…</span> : null}
      {onRemove && (
        <button
          type="button"
          className="ai-attach-chip__remove"
          title={t('delete')}
          onClick={() => onRemove(a.id)}
        ><Icon name="Close" size={11} /></button>
      )}
      {isImg && (
        <span className="ai-attach-preview">
          <img src={a.dataUrl} alt={a.name} />
          <span className="ai-attach-preview__meta">
            <span className="ai-attach-preview__name">{a.name}</span>
            {a.size ? <span className="ai-attach-preview__size">{humanSize(a.size)}</span> : null}
          </span>
        </span>
      )}
    </span>
  )
}

/**
 * 解析鸿翼文件系统（wjxt 技能）产出的链接，把「预览」与「下载」分开：
 * - 预览：`…/preview.html?fileid=<guid>`（技能返回的 previewUrl，文件名列也用这个）
 * - 下载：同一地址 + `mcdl=1&name=<原始文件名>`（技能返回的 downloadUrl）
 * 返回 null = 不是这类链接（限定 streamax 域 + preview.html + fileid，避免误伤其它内网地址）。
 *
 * 为什么必须单独解析：下面「规格文件下载」的旧判据 `/[?&]fileId=/i` 是**大小写不敏感**的，
 * 会把 `fileid=` 认成 `fileId=` —— 于是点「预览」直接弹保存框，文件名还用了链接文案（「下载」），
 * 保存类型变成「所有文件」，得到一个没有后缀的文件（1.0.43 报的 bug）。
 */
function parseWjxtLink(raw: string): { fileGuid: string; download: boolean; name: string } | null {
  try {
    const u = new URL(raw)
    if (!/(^|\.)streamax\.com$/i.test(u.hostname)) return null
    if (!/\/preview\.html$/i.test(u.pathname)) return null
    const gid = u.searchParams.get('fileid') || u.searchParams.get('fileId') || ''
    if (!gid) return null
    // searchParams 已经解过码，不要再 decode 一次（否则名字里带 % 的会被二次解码弄坏）
    return { fileGuid: gid, download: u.searchParams.get('mcdl') === '1', name: u.searchParams.get('name') || '' }
  } catch {
    return null
  }
}

function MarkdownLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const t = useStore(s => s.t)
  const display = typeof children === 'string' ? children : ''
  const [downloading, setDownloading] = useState(false)
  // 流式下载进度（主进程边下边写时按块推过来）：链接文案显示「下载中 42%」，
  // 让「选完保存位置后文件慢慢长大」这件事在界面上看得见
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null)
  const dlIdRef = useRef('')

  useEffect(() => {
    const off = window.mcApi.onDownloadProgress?.(p => {
      if (!p || p.id !== dlIdRef.current) return
      if (p.error || p.done) { setProgress(null); return }
      setProgress({ received: Number(p.received || 0), total: Number(p.total || 0) })
    })
    return () => { off?.() }
  }, [])

  /** 每次点击生成一个下载 id：进度事件靠它认领自己那一条（同一页可能同时有多个下载链接） */
  const beginDownload = (): string => {
    const id = `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    dlIdRef.current = id
    setProgress(null)
    return id
  }

  const handleClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (!href || downloading) return

    // 把相对路径补成 OA 绝对地址
    let url = href
    if (url.startsWith('/')) url = OA_ORIGIN + url
    if (!/^https?:\/\//i.test(url)) return

    // 鸿翼文件系统（wjxt 技能）的链接单独分流，必须排在「规格文件下载」判据之前（见 parseWjxtLink 注释）
    const wjxt = parseWjxtLink(url)
    if (wjxt) {
      if (!wjxt.download) {
        // 预览 = 在应用内窗口打开站点预览页：同一登录分区免登录，**不触发下载**
        void window.mcApi.openOaWindow?.(url)
        return
      }
      // 下载 = 弹「另存为」：主进程先按 fileGuid 换出原始文件直链，再**流式**落盘到用户选的路径
      const id = beginDownload()
      setDownloading(true)
      try {
        const res: any = await window.mcApi.wjxtDownload({ fileGuid: wjxt.fileGuid, name: wjxt.name, id })
        if (!res?.ok && !res?.canceled) {
          void window.mcApi.showMessage({
            type: 'error',
            message: res?.error === 'NEED_RELOGIN'
              ? t('fileNeedLogin')
              : res?.error === 'WJXT_NO_FILE_URL'
                ? t('aiFileNoUrl')
                : t('aiFileDownloadFail', { m: res?.error || 'unknown' })
          })
        }
      } catch (err: any) {
        void window.mcApi.showMessage({ type: 'error', message: t('fileDownloadFail', { m: err?.message || String(err) }) })
      } finally {
        setDownloading(false)
      }
      return
    }

    // 判断是不是规格文件下载链接（OA / MC 规格文件：`fileId=` **大小写敏感**，
    // 别再写成 /i —— 那会把上面已拦下的 `fileid=` 预览链接又拉回下载分支）
    const isSpec = /\/specificationFileDownload\b/i.test(url) ||
      /[?&]fileId=/.test(url) ||
      /[?&]fileName=/i.test(url)

    if (isSpec) {
      const u = new URL(url)
      let filename = u.searchParams.get('fileName') || display || 'spec-file'
      try { filename = decodeURIComponent(filename) } catch { /* 保持原样 */ }
      // 下载/保存都不弹提示框：链接文案本身会变成「下载中…」，
      // 只有真正出错（登录失效、网络失败）才提示，避免打扰用户。
      const id = beginDownload()
      setDownloading(true)
      try {
        const res: any = await window.mcApi.downloadFile({ url, filename, id })
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
      /* 用 aria-busy 而不是 aria-disabled：项目的自定义光标（cursor.css 引 animal-island-ui 规则）
         对 [aria-disabled='true'] 会强制 `cursor: not-allowed`，下载中光标会变成「圆圈禁行」，
         看起来像卡住/转圈（用户反馈过）。busy 态本身已用 .busy 的 pointer-events:none 防重复点击。 */
      aria-busy={downloading}
    >
      {downloading
        ? (progress?.total
          ? t('downloadingPercent', { p: Math.min(99, Math.round((progress.received / progress.total) * 100)) })
          : t('downloading'))
        : children}
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

const MessageItem = memo(function MessageItem({ message, thinking, emptyHint, onContinue }: { message: AIMessage; thinking?: boolean; emptyHint?: 'stopped' | 'timeout'; onContinue?: () => void }) {
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
        {/* 附件回显（1.0.43）：历史里也保留，追问时能对上「你说的是哪张图/哪个文件」 */}
        {!!message.attachments?.length && (
          <div className="ai-msg-attach-list">
            {message.attachments.map(a => <AttachChip key={a.id} a={a} />)}
          </div>
        )}
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
                {/* 停止 / 超时后模型一句都没输出时，气泡是空的 —— 补一句说明，
                    否则看起来像「AI 没反应」。历史里（没有 in-memory 原因）退化为通用文案。 */}
                {!thinking && !message.content && (
                  <div className="ai-msg-empty">
                    {emptyHint === 'timeout'
                      ? t('aiMsgEmptyTimeout')
                      : emptyHint === 'stopped'
                        ? t('aiMsgEmptyStopped')
                        : t('aiMsgEmptyGeneric')}
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
          {/* 「继续」：模型只回了句计划就停时，一键让它接着干（免手打「请继续」）。
              只给助手消息、且思考占位态不显示（那时本来就在生成中）。 */}
          {message.role === 'assistant' && !thinking && onContinue && (
            <button type="button" className="ai-copy-btn" onClick={onContinue} title={t('aiContinueTip')}>
              <Icon name="Play" size={13} />
              <span>{t('aiContinueBtn')}</span>
            </button>
          )}
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
