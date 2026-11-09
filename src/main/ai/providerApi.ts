import { app, net } from 'electron'
import { appendFileSync } from 'fs'
import { join } from 'path'
import type { AIModelInfo } from '@shared/ai-types'
import { getProvider, saveCachedModels } from './providerStore'

/** 1.0.75：翻译链路写进 debug-ai.log —— 以前这里一行日志都没有，慢/卡只能靠猜 */
function translateLog(msg: string): void {
  try {
    appendFileSync(join(app.getPath('userData'), 'debug-ai.log'),
      `[${new Date().toISOString()}] [translate] ${msg}\n`, 'utf8')
  } catch { /* 日志失败不影响翻译 */ }
}

/**
 * 增强提示词（1.0.43）：用当前供应商把用户的草稿改写成更明确、可执行的提示词。
 * 一次性请求、不落历史、不产生会话；失败时把原因原样返回给渲染层提示。
 */
export async function optimizePrompt(input: {
  providerId: string
  modelId?: string
  text: string
  lang?: string
}): Promise<{ ok: boolean; text?: string; message?: string }> {
  const text = String(input?.text || '').trim()
  if (!text) return { ok: false, message: '请先输入内容' }
  const { config, apiKey } = getProvider(input.providerId)
  if (!apiKey && input.providerId !== 'ollama') return { ok: false, message: '请先配置 API Key' }
  const sys = input.lang === 'en'
    ? 'You are a prompt engineer. Rewrite the user input into a clearer, executable instruction for an AI assistant: state the goal, scope, output format and constraints, remove ambiguity and filler, keep the original intent and language. Output ONLY the rewritten prompt, no explanation, no quotes, no code fence.'
    : '你是提示词工程助手。把用户输入改写成更明确、可执行、对 AI 更友好的指令：补全目标、范围、输出格式与约束，去掉歧义与口语废话，保持原意与语言（中文输入输出中文）。只输出改写后的提示词本身，不要解释、不要引号、不要代码块。'
  try {
    const data = await requestJSON<any>(`${config.baseUrl}/chat/completions`, apiKey, {
      method: 'POST',
      body: JSON.stringify({
        model: input.modelId || config.defaultModel,
        stream: false,
        temperature: 0.3,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: text }
        ]
      })
    })
    const out = String(data?.choices?.[0]?.message?.content || '').trim()
    if (!out) return { ok: false, message: '模型没有返回内容' }
    return { ok: true, text: out }
  } catch (e: any) {
    return { ok: false, message: `增强失败：${e?.message || e}` }
  }
}

/** 进行中翻译任务的 AbortController 登记表（taskId → controller） */
const translateAborts = new Map<string, AbortController>()

/**
 * 单批翻译请求的硬超时（1.0.67）。
 *
 * 此前这条链路**完全没有超时**：`net.fetch` 在上游不响应（网络卡住 / 供应商排队 /
 * 中转站挂起）时会一直挂着，渲染层的循环永远等不到 `res`，按钮就一直停在
 * 「翻译中 x/y」上，既不报错也没有任何提示（用户反馈「翻译超时或失败时没有任何提示」）。
 * 90 秒按「一批 15 条描述、最慢的推理模型」留了余量；超时后立刻中断在途请求并
 * 返回可读文案，已在译出的批次仍保留，用户可直接再点一次续翻。
 */
const TRANSLATE_TIMEOUT_MS = 90_000
/** 1.0.75：只有 1 条描述时别让用户干等 90 秒 —— 一条短翻译超出 30 秒基本可判上游异常 */
const TRANSLATE_TIMEOUT_SINGLE_MS = 30_000

/**
 * 1.0.75：识别「网关不认识关闭 thinking 的参数」这类 400，
 * 以便去掉未知字段重试一次。OpenAI 兼容网关大多忽略未知字段，
 * 但严格校验的会 400，此时必须回退到原始请求体，不能让翻译整个失败。
 */
function isUnsupportedThinkingParam(e: any): boolean {
  const s = String(e?.message || e || '')
  // 2026-11-09 真机：OpenCode Go + gpt-5.6-luna 走 openai-responses 后端，
  // 报 `enable_thinking: cannot be represented by openai-responses; use scoped
  // provider_options…`，原正则不含这些词 → 没触发回退，翻译直接失败。
  return /400|unknown|unsupported|not supported|unexpected|not allowed|extra field|invalid.*param|参数|cannot be represented|provider_options|openai-responses|reasoning_effort|enable_thinking/i.test(s)
}

/**
 * 把一批中文物料描述翻译成英文（1.0.54，「翻译物料描述」按钮用）。
 * 一次性请求、不落历史、不产生会话 —— 与 optimizePrompt 同一套 getProvider + requestJSON 模式。
 *
 * 协议：texts 按「编号. 描述」逐行拼进 user 消息，system prompt 要求模型按**相同编号**
 * 逐行返回译文；返回按编号对齐，解析不到 / 模型漏译的单条**回退原文**，
 * 保证条数与顺序和入参严格一致（调用方按 index 写回表格，不能错位）。
 *
 * 取消（1.0.54 补）：调用方传 taskId 时登记一个 AbortController，之后可用 cancelTranslate(taskId)
 * 立刻中断在途请求 —— 只检查「批次之间的取消标志」不够：最后一批在途时用户点了取消，
 * 要等它整个跑完才停，观感就是「点了取消没反应」。
 */
export async function translateDescriptions(input: {
  providerId: string
  modelId?: string
  texts: string[]
  /** 本次翻译任务的标识（取消用）；不传则不参与取消登记 */
  taskId?: string
}): Promise<{ ok: boolean; items?: string[]; message?: string; canceled?: boolean; timeout?: boolean; error?: string }> {
  const texts = (input?.texts || []).map(t => String(t ?? '')).filter(t => t.trim())
  const started = Date.now()
  if (!texts.length) return { ok: false, message: '没有需要翻译的描述' }
  const { config, apiKey } = getProvider(input.providerId)
  if (!apiKey && input.providerId !== 'ollama') return { ok: false, message: '请先在 AI 助手面板配置 API Key' }
  const taskId = String(input?.taskId || '').trim()
  const ac = taskId ? new AbortController() : null
  if (taskId && ac) translateAborts.set(taskId, ac)
  // 超时与「用户取消」两个中断源汇流到一个内部 controller，同时用 timedOut 标记区分
  // 是谁打断的：取消 → 安静收尾（canceled），超时 → 按失败提示（timeout）。
  const ctl = new AbortController()
  const timeoutMs = texts.length <= 1 ? TRANSLATE_TIMEOUT_SINGLE_MS : TRANSLATE_TIMEOUT_MS
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { ctl.abort() } catch { /* 已中止 */ }
  }, timeoutMs)
  const onCancel = () => { try { ctl.abort() } catch { /* 已中止 */ } }
  ac?.signal.addEventListener('abort', onCancel, { once: true })
  const cleanupAbortSources = () => {
    clearTimeout(timer)
    ac?.signal.removeEventListener('abort', onCancel)
  }
  const sys = '你是物料描述翻译引擎，服务于硬件/电子制造行业。把用户给出的中文物料描述逐条翻译成英文。' +
    '要求：① 料号、型号、规格参数、单位、括号内容与缩写保持原样，不增删信息；' +
    '② 已是英文或纯数字/符号的片段原样保留；③ 只输出译文，不解释、不加引号、不用代码块。' +
    '用户消息是编号列表（每行「编号. 描述」），你必须按相同编号逐行输出（每行「编号. 译文」），' +
    '编号与行数一一对应，不要合并、不要省略、不要输出额外内容。'
  const list = texts.map((t, i) => `${i + 1}. ${t}`).join('\n')
  const baseBody = {
    model: input.modelId || config.defaultModel,
    stream: false,
    temperature: 0.2,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: list }
    ]
  }
  // 1.0.75：关闭 thinking。翻译是「编号列表 → 编号列表」的确定性任务，
  // 推理模型却会先生成一大段思维链（实测 1500~3200 字符、20~26 秒），1 条描述也慢。
  // 只带 OpenAI 标准的 `reasoning_effort:'none'` —— 原来还带 Qwen/DashScope 私有的
  // `enable_thinking:false`，实测会让走 openai-responses 后端的模型（gpt-5.6-luna）
  // 直接报错「cannot be represented」。不认识该字段的网关多数忽略，
  // 少数严格校验返回参数错误 —— 那时去掉参数用原始 body 重试一次。
  const NO_THINK = { reasoning_effort: 'none' }
  const url = `${config.baseUrl}/chat/completions`
  const post = (body: any) => requestJSON<any>(url, apiKey, {
    method: 'POST', body: JSON.stringify(body)
  }, ctl.signal)
  translateLog(`start provider=${input.providerId} model=${baseBody.model} texts=${texts.length} noThink=yes timeout=${timeoutMs}ms`)
  try {
    let data: any
    try {
      data = await post({ ...baseBody, ...NO_THINK })
    } catch (e: any) {
      if (ctl.signal.aborted || !isUnsupportedThinkingParam(e)) throw e
      translateLog(`gateway rejected no-think params (${String(e?.message || '').slice(0, 90)}) -> retry plain body`)
      data = await post(baseBody)
    }
    const out = String(data?.choices?.[0]?.message?.content || '').trim()
    if (!out) {
      translateLog(`empty output model=${baseBody.model} texts=${texts.length} ms=${Date.now() - started}`)
      return { ok: false, message: '模型没有返回内容' }
    }
    // 按行首编号解析译文；模型偶尔会把多条并成一行或换行输出，按编号对齐后
    // 缺失的条目回退原文（不错位、不丢行）。
    const byIndex = new Map<number, string>()
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*(\d+)\s*[.、:：)\]]\s*(.+?)\s*$/.exec(line)
      if (m) byIndex.set(Number(m[1]), m[2])
    }
    const items = texts.map((t, i) => byIndex.get(i + 1) || t)
    translateLog(`done model=${baseBody.model} texts=${texts.length} ms=${Date.now() - started}`)
    return { ok: true, items }
  } catch (e: any) {
    translateLog(`fail model=${baseBody.model} texts=${texts.length} ms=${Date.now() - started} timedOut=${timedOut} reason=${String(e?.message || e).slice(0, 160)}`)
    // 超时：上游迟迟不返回，net.fetch 本身没有超时，必须自己判（否则界面会一直「翻译中」）
    if (timedOut) {
      return { ok: false, timeout: true, error: 'TIMEOUT', message: `翻译超时（${Math.round(timeoutMs / 1000)} 秒内没有响应）` }
    }
    // 被 cancelTranslate 中断：不算失败，返回 canceled 让调用方安静收尾
    if (ac?.signal.aborted || e?.name === 'AbortError') {
      return { ok: false, canceled: true, error: 'CANCELED', message: '已取消' }
    }
    // 文案不再自带「翻译失败：」前缀 —— 渲染层会按界面语言加，避免出现「翻译失败：翻译失败：…」
    return { ok: false, message: e?.message || String(e) }
  } finally {
    cleanupAbortSources()
    if (taskId) translateAborts.delete(taskId)
  }
}

/** 中断指定任务的在途翻译请求；任务不存在（已结束）时静默返回 */
export function cancelTranslate(taskId: string): void {
  const ac = translateAborts.get(String(taskId || ''))
  if (!ac) return
  try { ac.abort() } catch { /* 已中止过：忽略 */ }
  translateAborts.delete(String(taskId || ''))
}

/**
 * OpenCode（Go / Zen，域名 opencode.ai）要求每个请求携带稳定的 x-opencode-session 头。
 * 官方通知：自 2026-09-06 起，缺失该头的请求将报错。
 * 有会话时用会话 ID（one stable ID per conversation）；拉模型 / 测试连接这类无会话的
 * 请求用本进程内稳定的应用级 ID，保证同一批次请求 ID 一致、便于服务端优化。
 */
let appSessionId = ''
function stableAppSessionId(): string {
  if (!appSessionId) appSessionId = `mc-tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return appSessionId
}
export function opencodeSessionHeaders(url?: string, conversationId?: string): Record<string, string> {
  if (!url || !/opencode\.ai/i.test(url)) return {}
  // header 值只允许 ASCII 安全字符，避免会话 ID 含特殊字符导致请求被拒
  const safe = (conversationId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128)
  return { 'x-opencode-session': safe || stableAppSessionId() }
}

async function requestJSON<T>(url: string, apiKey: string | undefined, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...opencodeSessionHeaders(url),
    ...(init.headers as Record<string, string> || {})
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const res = await net.fetch(url, { ...init, headers, signal })
  const text = await res.text()
  let data: any
  try { data = text ? JSON.parse(text) : {} } catch { throw new Error(`接口响应不是 JSON（HTTP ${res.status}）`) }
  if (!res.ok) throw new Error(data?.error?.message || data?.message || `HTTP ${res.status}`)
  return data as T
}

export async function listModels(providerId: string): Promise<AIModelInfo[]> {
  const { config, apiKey } = getProvider(providerId)
  if (!apiKey && providerId !== 'ollama') throw new Error('请先配置 API Key')
  const data = await requestJSON<any>(`${config.baseUrl}/models`, apiKey)
  const models = Array.isArray(data?.data) ? data.data : []
  const out = models.map((m: any) => ({
    id: String(m.id || m.name || ''),
    name: String(m.name || m.id || ''),
    contextLength: m.context_length || m.contextLength || undefined,
    maxOutputTokens: m.max_output_tokens || m.maxOutputTokens || undefined
  })).filter((m: AIModelInfo) => m.id)
  // 落盘（1.0.56）：只成功时写，失败保留旧缓存 —— 免得一次网络抖动把可用清单清空。
  // 下次启动 / 切回该供应商时，下拉里直接就是这份真实清单，不必再点「获取模型」。
  try { saveCachedModels(providerId, config.baseUrl, out.map((m: AIModelInfo) => m.id)) } catch { /* 缓存失败不影响本次返回 */ }
  return out
}

export async function testProvider(providerId: string, modelId?: string): Promise<{ ok: boolean; models: number; message: string }> {
  const { config, apiKey } = getProvider(providerId)
  if (!apiKey && providerId !== 'ollama') throw new Error('请先配置 API Key')
  const model = modelId || config.defaultModel || ''
  await requestJSON<any>(`${config.baseUrl}/chat/completions`, apiKey, {
    method: 'POST',
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false
    })
  })
  return { ok: true, models: 0, message: `连接成功：${model}` }
}
