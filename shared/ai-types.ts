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
  // 接口协议。内置预设与自定义供应商都带，chatService / providerApi 据此选择调用方式。
  // 当前仅 openai-compatible 已实现，anthropic 先占字段、后续再实现，避免本次过度膨胀。
  protocol: AIProtocol
  // 自定义供应商标记：true 表示用户新增（可删除）；内置预设为 false / 缺省。
  isCustom?: boolean
  hasApiKey: boolean
  enabled: boolean
  // 自定义供应商才有的推荐模型（内置供应商建议模型来自 preset，不在此字段）
  suggestedModels?: string[]
}

/** 调用方选择的协议标签展示用 */
export const AI_PROTOCOL_LABELS: Record<AIProtocol, string> = {
  'openai-compatible': 'OpenAI 兼容',
  anthropic: 'Anthropic'
}

/** 新增自定义供应商入参 */
export interface AddCustomProviderInput {
  name: string
  protocol: AIProtocol
  baseUrl: string
  defaultModel: string
  apiKey?: string
}

/** 重置返回值：返回重置后的配置，便于渲染层直接回写 */
export interface ResetProviderResult {
  config: AIProviderConfig
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
  /** 随消息发出的附件（1.0.43）：历史里保留下 payload，便于后续追问仍能引用 */
  attachments?: AIAttachment[]
  providerId?: string
  modelId?: string
  inputTokens?: number
  outputTokens?: number
  createdAt: number
}

/**
 * 随消息发出的附件（1.0.43）。
 *
 * 三类处理方式不同：
 * - image：内联成 dataUrl，作为视觉消息发给模型（要求所选模型支持图片）；
 * - text ：读成文本内联进用户消息（限大小，超出会被截断）；
 * - file ：只带本机路径，交给模型用 file_read 工具读取（仅 Build 模式可用）。
 */
export interface AIAttachment {
  id: string
  name: string
  kind: 'image' | 'text' | 'file'
  mime?: string
  /** 原始字节数 */
  size?: number
  /** kind=image：data:image/...;base64,... */
  dataUrl?: string
  /** kind=text：文件文本内容（可能被截断） */
  text?: string
  /** kind=file：本机绝对路径 */
  path?: string
  /** 文本附件是否被截断（UI 提示用） */
  truncated?: boolean
}

/**
 * 技能（内置 + 导入），供 Skills 面板展示与勾选。
 *
 * 注意：**启用状态不在这里** —— 技能是**按会话独立**选择的（1.0.43 调整：早先是全局持久化，
 * 结果新会话会继承上一个会话的勾选），选择存在渲染层当前会话的内存状态里，
 * 下发时通过 `enabledSkills` 随消息带给主进程。
 */
export interface AISkillInfo {
  id: string
  name: string
  description: string
  source: 'builtin' | 'user'
  /** 技能目录（内置在 resources/skills，导入在 userData/skills） */
  dir: string
}

/**
 * 技能的唯一键 = `来源:id`。
 *
 * 内置技能与导入技能**可能同名**（例如用户把内置的 `wjxt-file-download` 又导入了一份），
 * 两者在面板里要各自成行、勾选状态互相独立，因此凡是「按技能标识」的地方
 * （勾选、注入提示词、下发工具）都用这个键，而不是裸 id。
 */
export function skillKey(s: Pick<AISkillInfo, 'source' | 'id'>): string {
  return `${s.source}:${s.id}`
}

/** 从技能键里取回裸 id（兼容直接传裸 id 的旧调用） */
export function bareSkillId(key: string): string {
  const k = String(key || '')
  const i = k.indexOf(':')
  return (i >= 0 ? k.slice(i + 1) : k).trim()
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
  // 随消息发出的附件（图片 / 文本 / 其他文件），见 AIAttachment
  attachments?: AIAttachment[]
  // 本会话启用的技能 id（内置 + 导入）。build 模式下会把它们的 SKILL.md 注入系统提示，
  // 并按其声明下发对应工具（如鸿翼文件查询）。
  enabledSkills?: string[]
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
  // 新增 / 删除 / 重置自定义供应商：自定义供应商存于 ai-providers.json 的 __custom 数组
  ADD_CUSTOM_PROVIDER: 'ai:add-custom-provider',
  DELETE_CUSTOM_PROVIDER: 'ai:delete-custom-provider',
  RESET_PROVIDER: 'ai:reset-provider',
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
  // 技能（1.0.43）：列表 / 导入（zip 或文件夹）/ 删除
  // 注：没有「启用停用」通道 —— 勾选是按会话存在渲染层的（见 AISkillInfo 注释）
  SKILLS_LIST: 'ai:skills-list',
  SKILL_IMPORT: 'ai:skill-import',
  SKILL_REMOVE: 'ai:skill-remove',
  // 增强提示词：用当前供应商把草稿改写成更明确的提示词（一次性请求，不落历史）
  OPTIMIZE_PROMPT: 'ai:optimize-prompt',
  EVENT: 'ai:event'
} as const
