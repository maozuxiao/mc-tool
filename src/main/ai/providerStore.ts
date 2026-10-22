import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AIProviderConfig, AIProviderPreset, AddCustomProviderInput, AIProtocol } from '@shared/ai-types'

interface StoredProvider extends AIProviderConfig {
  encryptedApiKey?: string
}

const SETTINGS_PATH = () => join(app.getPath('userData'), 'ai-providers.json')
// 全局偏好（上次使用的服务商 / 模型）。与 ai-providers.json 分开存，
// 避免和 preset id 撞键，也便于单独读写。
const PREFS_PATH = () => join(app.getPath('userData'), 'ai-prefs.json')

export interface AIPreferences {
  lastProviderId?: string
  lastModelId?: string
  /** Build 模式的工作区根目录，空字符串表示未选择 */
  workspaceRoot?: string
  /** 额外可访问目录白名单（工作区之外），跨启动持久化；会话内 open_folder 打开的目录不在此列 */
  extraRoots?: { alias: string; path: string }[]
}

function readPrefs(): AIPreferences {
  try {
    if (!existsSync(PREFS_PATH())) return {}
    const parsed = JSON.parse(readFileSync(PREFS_PATH(), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

function writePrefs(prefs: AIPreferences): void {
  try { writeFileSync(PREFS_PATH(), JSON.stringify(prefs, null, 2), 'utf8') } catch { /* 忽略写入失败 */ }
}

export function getPreferences(): AIPreferences {
  return readPrefs()
}

export function savePreferences(patch: AIPreferences): AIPreferences {
  const next = { ...readPrefs() }
  if (patch.lastProviderId) next.lastProviderId = patch.lastProviderId
  if (patch.lastModelId) next.lastModelId = patch.lastModelId
  // workspaceRoot 允许被清空（传空字符串），所以用 undefined 判断而不是真值判断
  if (patch.workspaceRoot !== undefined) next.workspaceRoot = patch.workspaceRoot
  // extraRoots 用 undefined 判断：传 [] 表示清空白名单
  if (patch.extraRoots !== undefined) next.extraRoots = patch.extraRoots
  writePrefs(next)
  return next
}

// ── 模型清单缓存（1.0.56）────────────────────────────────────────────
// 点过「获取模型」之后把结果落盘：重启应用、切回该供应商时下拉里直接可选，
// 不用为了「看一眼有哪些模型」再打一次 /models。此前只存在渲染进程的
// `modelOptions` state 里，关面板 / 关应用即丢，只剩代码里写死的预设候选。
//
// 键 = providerId + baseUrl：改 Base URL 就是换了一套网关，旧清单必须作废；
// 改 API Key 会显式清空该供应商的缓存（不同 key 能看到的清单可能不同）。
const MODELS_CACHE_PATH = () => join(app.getPath('userData'), 'ai-models-cache.json')
const MODELS_CACHE_TTL = 7 * 24 * 60 * 60 * 1000

interface ModelsCacheEntry { models: string[]; fetchedAt: number }
type ModelsCache = Record<string, ModelsCacheEntry>

function modelsCacheKey(providerId: string, baseUrl: string): string {
  return `${providerId}::${(baseUrl || '').replace(/\/+$/, '')}`
}

function readModelsCache(): ModelsCache {
  try {
    if (!existsSync(MODELS_CACHE_PATH())) return {}
    const parsed = JSON.parse(readFileSync(MODELS_CACHE_PATH(), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

function writeModelsCache(cache: ModelsCache): void {
  try { writeFileSync(MODELS_CACHE_PATH(), JSON.stringify(cache, null, 2), 'utf8') } catch { /* 忽略写入失败 */ }
}

/** 读缓存：过期视为「没有」，但不在读取时删文件（避免每次打开面板都写盘） */
export function getCachedModels(providerId: string, baseUrl: string): string[] {
  const entry = readModelsCache()[modelsCacheKey(providerId, baseUrl)]
  if (!entry || !Array.isArray(entry.models) || !entry.models.length) return []
  if (Date.now() - (entry.fetchedAt || 0) > MODELS_CACHE_TTL) return []
  return entry.models.filter(m => typeof m === 'string' && m)
}

/** 「获取模型」成功后调用；顺手清掉同一供应商下其他 baseUrl 的旧键 */
export function saveCachedModels(providerId: string, baseUrl: string, models: string[]): void {
  const cache = readModelsCache()
  const key = modelsCacheKey(providerId, baseUrl)
  for (const k of Object.keys(cache)) {
    if (k !== key && k.startsWith(`${providerId}::`)) delete cache[k]
  }
  cache[key] = {
    models: Array.from(new Set(models.filter(m => typeof m === 'string' && m))),
    fetchedAt: Date.now()
  }
  writeModelsCache(cache)
}

/** 清空某供应商的缓存：换 API Key / 重置配置时调用 */
export function clearCachedModels(providerId: string): void {
  const cache = readModelsCache()
  let changed = false
  for (const k of Object.keys(cache)) {
    if (k.startsWith(`${providerId}::`)) { delete cache[k]; changed = true }
  }
  if (changed) writeModelsCache(cache)
}

export const PROVIDER_PRESETS: AIProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1-mini',
    suggestedModels: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o4-mini']
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    protocol: 'openai-compatible',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    // 1.0.56：原默认 `deepseek-v4-flash` 已在 Go / Zen 两份实时清单里都不存在
    // （现役是 `deepseek-v4.1-flash`），用默认值发第一条消息必 503
    // `Endpoint is unavailable`。预设候选按 GET /zen/go/v1/models 实测清单重写。
    defaultModel: 'deepseek-v4.1-flash',
    suggestedModels: [
      'deepseek-v4.1-flash', 'deepseek-v4-pro',
      'glm-5.3', 'glm-5.3-flash',
      'qwen3.8-max', 'qwen3.8-flash',
      'kimi-k3', 'kimi-k2.7-code',
      'grok-4.7', 'grok-4.6',
      'minimax-m3', 'mimo-v2.6-pro',
      'longcat-2.0', 'hy4-preview', 'step-5-preview'
    ]
  },

  {
    // OpenCode Zen：官方 AI 网关，OpenAI 兼容端点，模型列表 GET /v1/models。
    // 与上面的 opencode-go（/zen/go/v1，订阅制）不是同一套：Zen 走按量付费，
    // 并提供若干限时免费模型（名称带 free / Free）。
    // 免费模型由上游动态调度，常见报错「Model is unavailable」通常表示该模型
    // 当前无可用额度或临时下架；点「获取模型」可拉取实时列表，换其它模型即可。
    // ⚠️ 隐私提示：免费模型的服务方可能在免费期内收集数据用于改进模型，
    // NVIDIA 的免费端点更明确写着「请勿提交个人或机密数据」。查询物料、BOM
    // 等内部数据时请改用付费模型。
    // 文档：https://opencode.ai/docs/zh-cn/zen/
    id: 'opencode-zen',
    name: 'OpenCode Zen（含免费模型）',
    protocol: 'openai-compatible',
    baseUrl: 'https://opencode.ai/zen/v1',
    defaultModel: 'deepseek-v4.1-flash',
    suggestedModels: [
      // ── 付费（常用，默认推荐）；按 GET /zen/v1/models 实测清单重写（1.0.56）──
      'deepseek-v4.1-flash', 'deepseek-v4-pro',
      'glm-5.3', 'glm-5.3-flash',
      'kimi-k3', 'kimi-k2.7-code',
      'minimax-m3', 'grok-4.6', 'grok-4.7',
      'claude-sonnet-5-5', 'claude-opus-5-5',
      'gpt-5.5', 'gpt-6-sol',
      'gemini-3.1-pro', 'qwen3.8-max',
      // ── 限时免费（不稳定，可能报 unavailable；且可能收集数据改进模型）──
      'deepseek-v4.1-flash-free', 'glm-5.3-flash-free',
      'minimax-m3.1-flash-free', 'mimo-v2.6-flash-free',
      'big-pickle', 'beam-free', 'longcat-2.5-preview-free'
    ]
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    suggestedModels: ['deepseek-chat', 'deepseek-reasoner']
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-20250514',
    suggestedModels: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-7-sonnet-20250219', 'claude-3-5-haiku-20241022']
  },
  {
    id: 'moonshot',
    name: 'Kimi / Moonshot',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2-0905-preview',
    suggestedModels: ['kimi-k2-0905-preview', 'moonshot-v1-128k']
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    protocol: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.5',
    suggestedModels: ['glm-4.5', 'glm-4.5-air', 'glm-4-flash']
  },
  {
    id: 'qwen',
    name: '阿里 Qwen',
    protocol: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    suggestedModels: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen3-coder-plus']
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3.1',
    suggestedModels: ['deepseek-ai/DeepSeek-V3.1', 'Qwen/Qwen3-235B-A22B', 'zai-org/GLM-4.5']
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    suggestedModels: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4', 'deepseek/deepseek-chat', 'qwen/qwen3-coder']
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    protocol: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen3:8b',
    suggestedModels: ['qwen3:8b', 'deepseek-r1:8b', 'llama3.1:8b']
  }
]

function encryptKey(apiKey: string): string | undefined {
  try {
    if (!apiKey) return undefined
    if (!safeStorage.isEncryptionAvailable()) return `plain:${apiKey}`
    return `enc:${safeStorage.encryptString(apiKey).toString('base64')}`
  } catch {
    return undefined
  }
}

function decryptKey(value?: string): string | undefined {
  if (!value) return undefined
  if (value.startsWith('enc:')) {
    try { return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64')) } catch { return undefined }
  }
  if (value.startsWith('plain:')) return value.slice(6)
  return undefined
}

function readSettings(): Record<string, any> {
  try {
    if (!existsSync(SETTINGS_PATH())) return {}
    return JSON.parse(readFileSync(SETTINGS_PATH(), 'utf8'))
  } catch { return {} }
}

function writeSettings(settings: Record<string, any>): void {
  writeFileSync(SETTINGS_PATH(), JSON.stringify(settings, null, 2), 'utf8')
}

function publicProvider(stored: StoredProvider): AIProviderConfig {
  const { encryptedApiKey, ...pub } = stored
  const preset = PROVIDER_PRESETS.find(p => p.id === pub.id)
  // name 一律回落到预设名：兼容早期 settings 文件里没有 name 的情况，再不济用 id。
  return {
    ...pub,
    name: pub.name || preset?.name || pub.id,
    // protocol 优先取存储值，回落到预设；自定义供应商一律带自己的 protocol
    protocol: pub.protocol || preset?.protocol || 'openai-compatible',
    isCustom: !!pub.isCustom,
    hasApiKey: !!encryptedApiKey
  }
}

// 把 settings 文件拆成「内置供应商（按 id 索引）」与「自定义供应商（数组）」两部分
function readAll(): { settings: Record<string, StoredProvider>; custom: StoredProvider[] } {
  const settings = readSettings()
  const custom = Array.isArray(settings['__custom']) ? (settings['__custom'] as StoredProvider[]) : []
  return { settings, custom }
}
function writeAll(settings: Record<string, any>, custom: StoredProvider[]): void {
  if (custom.length) settings['__custom'] = custom
  else delete settings['__custom']
  writeSettings(settings)
}

export function listProviders(): AIProviderConfig[] {
  const { settings, custom } = readAll()
  const builtins = PROVIDER_PRESETS.map(preset => {
    const saved = settings[preset.id]
    if (saved) return publicProvider(saved)
    return {
      id: preset.id,
      name: preset.name,
      baseUrl: preset.baseUrl,
      defaultModel: preset.defaultModel,
      protocol: preset.protocol,
      hasApiKey: preset.id === 'ollama',
      enabled: true
    }
  })
  const customs = custom.map(publicProvider)
  return [...builtins, ...customs]
}

export function getProvider(id: string): { preset?: AIProviderPreset; config: AIProviderConfig; apiKey?: string } {
  const { settings, custom } = readAll()
  const preset = PROVIDER_PRESETS.find(p => p.id === id)
  if (preset) {
    const saved = settings[id]
    const config = saved ? publicProvider(saved) : {
      id: preset.id,
      name: preset.name,
      baseUrl: preset.baseUrl,
      defaultModel: preset.defaultModel,
      protocol: preset.protocol,
      hasApiKey: false,
      enabled: true
    }
    return { preset, config, apiKey: saved ? decryptKey(saved.encryptedApiKey) : undefined }
  }
  const stored = custom.find(c => c.id === id)
  if (!stored) throw new Error(`未知的 AI Provider: ${id}`)
  return { config: publicProvider(stored), apiKey: decryptKey(stored.encryptedApiKey) }
}

export function saveProvider(input: {
  id: string
  baseUrl?: string
  defaultModel?: string
  apiKey?: string
  enabled?: boolean
  // 自定义供应商保存时可能改协议（openai-compatible / anthropic）
  protocol?: string
}): AIProviderConfig {
  const settings = readSettings()
  // 自定义供应商（id 以 custom- 开头）走 __custom 数组，与内置预设解耦
  if (input.id.startsWith('custom-')) {
    const custom = Array.isArray(settings['__custom']) ? (settings['__custom'] as StoredProvider[]) : []
    const idx = custom.findIndex(c => c.id === input.id)
    const current = idx >= 0 ? custom[idx] : undefined
    const encryptedApiKey = input.apiKey === undefined ? current?.encryptedApiKey : encryptKey(input.apiKey)
    const updated: StoredProvider = {
      id: input.id,
      name: current?.name || input.id,
      protocol: (input.protocol as AIProtocol) || current?.protocol || 'openai-compatible',
      isCustom: true,
      baseUrl: (input.baseUrl || current?.baseUrl || '').replace(/\/+$/, ''),
      defaultModel: input.defaultModel || current?.defaultModel || '',
      hasApiKey: !!encryptedApiKey,
      enabled: input.enabled ?? current?.enabled ?? true,
      encryptedApiKey
    }
    if (idx >= 0) custom[idx] = updated
    else custom.push(updated)
    settings['__custom'] = custom
    writeSettings(settings)
    // 换了 API Key / Base URL：能看到的模型清单可能不同，缓存作废
    if (input.apiKey !== undefined) clearCachedModels(input.id)
    return publicProvider(updated)
  }
  const preset = PROVIDER_PRESETS.find(p => p.id === input.id)
  if (!preset) throw new Error(`未知的 AI Provider: ${input.id}`)
  const current = settings[preset.id]
  const encryptedApiKey = input.apiKey === undefined
    ? current?.encryptedApiKey
    : encryptKey(input.apiKey)
  const saved: StoredProvider = {
    id: preset.id,
    name: preset.name,
    protocol: preset.protocol,
    isCustom: false,
    baseUrl: (input.baseUrl || current?.baseUrl || preset.baseUrl).replace(/\/+$/, ''),
    defaultModel: input.defaultModel || current?.defaultModel || preset.defaultModel,
    hasApiKey: !!encryptedApiKey,
    enabled: input.enabled ?? current?.enabled ?? true,
    encryptedApiKey
  }
  settings[preset.id] = saved
  writeSettings(settings)
  // 换了 API Key / Base URL：能看到的模型清单可能不同，缓存作废
  if (input.apiKey !== undefined) clearCachedModels(preset.id)
  return publicProvider(saved)
}

// 新增自定义供应商：生成唯一 id（custom-<时间戳>-<随机>），与内置预设互不冲突
export function addCustomProvider(input: AddCustomProviderInput): AIProviderConfig {
  const name = (input.name || '').trim()
  if (!name) throw new Error('请填写供应商名称')
  const baseUrl = (input.baseUrl || '').trim()
  if (!baseUrl) throw new Error('请填写 Base URL')
  const id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const encryptedApiKey = input.apiKey ? encryptKey(input.apiKey) : undefined
  const stored: StoredProvider = {
    id,
    name,
    protocol: input.protocol || 'openai-compatible',
    isCustom: true,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    defaultModel: (input.defaultModel || '').trim(),
    hasApiKey: !!encryptedApiKey,
    enabled: true,
    encryptedApiKey
  }
  const settings = readSettings()
  const custom = Array.isArray(settings['__custom']) ? (settings['__custom'] as StoredProvider[]) : []
  custom.push(stored)
  settings['__custom'] = custom
  writeSettings(settings)
  return publicProvider(stored)
}

// 删除自定义供应商；若删除的正是当前偏好，清空 lastProviderId 让界面回退到内置供应商
export function deleteCustomProvider(id: string): void {
  const settings = readSettings()
  const custom = Array.isArray(settings['__custom']) ? (settings['__custom'] as StoredProvider[]) : []
  const next = custom.filter(c => c.id !== id)
  if (next.length === custom.length) return
  const prefs = getPreferences()
  if (prefs.lastProviderId === id) savePreferences({ lastProviderId: undefined })
  settings['__custom'] = next
  writeSettings(settings)
}

// 重置 API 配置：内置供应商恢复预设 Base URL / 默认模型并清空 API Key；
// 自定义供应商仅清空 API Key（名称 / 地址 / 模型由用户自定义，无「默认」可言）。
export function resetProvider(id: string): AIProviderConfig {
  const settings = readSettings()
  const preset = PROVIDER_PRESETS.find(p => p.id === id)
  if (preset) {
    const saved: StoredProvider = {
      id: preset.id,
      name: preset.name,
      protocol: preset.protocol,
      isCustom: false,
      baseUrl: preset.baseUrl,
      defaultModel: preset.defaultModel,
      hasApiKey: false,
      enabled: true,
      encryptedApiKey: undefined
    }
    settings[preset.id] = saved
    writeSettings(settings)
    // 重置 = 换了 key / 回了默认地址：缓存的模型清单不再可信
    clearCachedModels(preset.id)
    return publicProvider(saved)
  }
  const custom = Array.isArray(settings['__custom']) ? (settings['__custom'] as StoredProvider[]) : []
  const idx = custom.findIndex(c => c.id === id)
  if (idx < 0) throw new Error(`未知的 AI Provider: ${id}`)
  const updated: StoredProvider = { ...custom[idx], hasApiKey: false, encryptedApiKey: undefined }
  custom[idx] = updated
  settings['__custom'] = custom
  writeSettings(settings)
  clearCachedModels(id)
  return publicProvider(updated)
}

export function getSuggestedModels(providerId: string): string[] {
  const preset = PROVIDER_PRESETS.find(p => p.id === providerId)
  const { settings, custom } = readAll()
  const stored = preset ? settings[preset.id] : custom.find(c => c.id === providerId)
  const baseUrl = (stored?.baseUrl || preset?.baseUrl || '').replace(/\/+$/, '')
  // 缓存（上次「获取模型」拿到的真实目录）排在前面，预设排在后面兜底：
  // 预设写死在代码里，网关一换型号就过期（1.0.56 就是栽在 `deepseek-v4-flash` 上），
  // 但缓存也可能过期/为空，两个都留着比只留一个稳。
  const cached = getCachedModels(providerId, baseUrl)
  const declared = preset ? preset.suggestedModels : (stored?.suggestedModels || [])
  return Array.from(new Set([...cached, ...declared]))
}
