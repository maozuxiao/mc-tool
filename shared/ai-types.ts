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

export interface AISendPayload {
  conversationId?: string
  providerId: string
  modelId: string
  content: string
  useMcSkill: boolean
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
  EVENT: 'ai:event'
} as const
