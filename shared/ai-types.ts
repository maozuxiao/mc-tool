export type AIProtocol = 'openai-compatible' | 'anthropic'

export interface AIProviderPreset {
  id: string
  name: string
  protocol: AIProtocol
  baseUrl: string
  defaultModel: string
  suggestedModels: string[]
}

export interface AIProviderConfig {
  id: string
  // 展示名（下拉框、设置面板标题用）。每条 config 都由 PROVIDER_PRESETS 派生，故必带。
  // 之前此类型缺 name，而 ChatPanel 直接读 provider.name，导致类型与实现不同步。
  name: string
  baseUrl: string
  defaultModel: string
  hasApiKey: boolean
  enabled: boolean
}

export interface AIModelInfo {
  id: string
  name: string
  contextLength?: number
  maxOutputTokens?: number
}

export interface AIConversation {
  id: string
  title: string
  providerId: string
  modelId: string
  createdAt: number
  updatedAt: number
}

export type AIMessageRole = 'user' | 'assistant' | 'tool'

export interface AIToolRun {
  id: string
  /** 工具类别，用于 UI 区分渲染：material（MC 物料）/ file（本地文件）等 */
  type?: string
  toolName: string
  input: unknown
  output?: unknown
  summary?: string
  status: 'running' | 'done' | 'error'
  durationMs?: number
}

export interface AIMessage {
  id: string
  conversationId: string
  role: AIMessageRole
  content: string
  reasoning?: string
  toolRuns?: AIToolRun[]
  providerId?: string
  modelId?: string
  inputTokens?: number
  outputTokens?: number
  createdAt: number
}

/**
 * 已授权目录（白名单）。alias 为空字符串表示主工作区（裸相对路径）；
 * 其余为额外目录的别名，模型用「别名/路径」引用。
 */
export interface AIExtraRoot {
  alias: string
  path: string
}

/**
 * 运行模式。决定下发哪些工具、用哪套系统提示语。
 * - ask：纯对话，不下发任何工具（模型不会去调不存在的工具而编造结果）
 * - mc：只下发 mc_query，查 OA 物料数据
 * - build：下发文件读写与命令工具，所有操作限制在 workspaceRoot 内
 */
export type AIAgentMode = 'ask' | 'mc' | 'build'

export interface AISendPayload {
  conversationId?: string
  // 渲染层为每次发送生成的 id。新会话在服务端落地前 conversationId 还是空的，
  // 用 requestId 才能立刻定位到这次请求并取消（否则「停止」点不动）。
  requestId?: string
  providerId: string
  modelId: string
  content: string
  mode?: AIAgentMode
  /**
   * @deprecated 由 mode 取代。仅当 mode 缺失时用于推导（兼容旧渲染层/已排队请求），
   * 渲染层不必再传。
   */
  useMcSkill?: boolean
  // Build 模式的工作区根目录：文件与命令操作都被限制在其中。
  // 由渲染层在用户选目录后传入，未选择时 Build 模式仍可用（模型可用 open_folder 打开目录）。
  workspaceRoot?: string
  // 会话级「额外可访问目录」白名单（工作区之外），由 UI 添加、跨启动持久化。
  // 模型用 alias 前缀引用其中的文件，如 shared/report.xlsx。
  extraRoots?: AIExtraRoot[]
  // 应用界面语言（zh / en），仅作为「提问语言无法判断时」的兜底
  lang?: string
}

/** 由 mode / 旧字段推导出实际模式，保证新旧渲染层都能正确工作 */
export function resolveMode(payload: Pick<AISendPayload, 'mode' | 'useMcSkill'>): AIAgentMode {
  if (payload.mode === 'ask' || payload.mode === 'mc' || payload.mode === 'build') return payload.mode
  return payload.useMcSkill ? 'mc' : 'ask'
}

/** 用户存储的自定义提示词（快捷调用） */
export interface SavedPrompt {
  id: string
  title: string
  text: string
  createdAt: number
}

export const AI_IPC = {
  GET_PROVIDERS: 'ai:get-providers',
  SAVE_PROVIDER: 'ai:save-provider',
  LIST_MODELS: 'ai:list-models',
  TEST_PROVIDER: 'ai:test-provider',
  LIST_CONVERSATIONS: 'ai:list-conversations',
  GET_CONVERSATION: 'ai:get-conversation',
  RENAME_CONVERSATION: 'ai:rename-conversation',
  DELETE_CONVERSATION: 'ai:delete-conversation',
  SEND_MESSAGE: 'ai:send-message',
  STOP_MESSAGE: 'ai:stop-message',
  // Build 模式的工作区根目录：由主进程弹系统目录选择框，避免渲染层直接操作 fs
  SELECT_WORKSPACE: 'ai:select-workspace',
  CLEAR_WORKSPACE: 'ai:clear-workspace',
  // 额外可访问目录（工作区之外）白名单：由主进程弹系统目录框选择，持久化到偏好
  ADD_EXTRA_ROOT: 'ai:add-extra-root',
  REMOVE_EXTRA_ROOT: 'ai:remove-extra-root',
  // 用户自定义提示词（快捷调用）：列表 / 保存 / 删除，持久化到 userData
  LIST_PROMPTS: 'ai:list-prompts',
  SAVE_PROMPT: 'ai:save-prompt',
  UPDATE_PROMPT: 'ai:update-prompt',
  DELETE_PROMPT: 'ai:delete-prompt',
  EVENT: 'ai:event'
} as const
