import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { McpImportResult, McpServerConfig } from '@shared/ai-types'

/**
 * MCP 服务登记持久化（1.0.46）。
 *
 * 存 `userData/mcp-servers.json` —— **刻意不放技能目录里**：导入同 id 技能＝覆盖更新，
 * 放技能目录里的配置会跟着被清掉；放用户目录才能跨「技能更新」保留。
 *
 * env 值的加密沿用 providerStore 的 `enc:` / `plain:` 前缀约定：
 * 键名看起来敏感（token/secret/key/password/cookie/credential/session）的值在保存时加密，
 * 渲染层拿到的是打码形态（`enc:••••`），回传同样的打码值＝「未修改」，主进程保留原值。
 */

const STORE_PATH = () => join(app.getPath('userData'), 'mcp-servers.json')
const SENSITIVE_KEY = /(token|secret|key|password|passwd|cookie|credential|session)/i
/** 渲染层看到的「已加密未修改」占位符 */
export const ENV_MASK = 'enc:••••'

interface StoreFile {
  version: 1
  servers: McpServerConfig[]
}

let cache: StoreFile | null = null

/**
 * 把解析失败的库存文件挪成带时间戳的旁车备份（1.0.52）。
 *
 * 为什么不直接丢弃：`readStore` 遇到损坏会返回空库存，**内存里的 cache 就是空的**，
 * 而任何一次保存（改个名字、启停一下、导入一条）都会拿这个空库存把原文件覆盖掉 ——
 * 用户全部 MCP 配置静默消失，且毫无报错。挪走原文件既保住数据又让新库从干净状态起步。
 */
function quarantineCorruptStore(err: unknown): void {
  const p = STORE_PATH()
  try {
    if (!existsSync(p)) return
    const bak = `${p}.corrupt-${Date.now()}`
    renameSync(p, bak)
    console.error(`[mcpStore] mcp-servers.json 解析失败，已备份到 ${bak}，本次按空库存处理：`, err)
  } catch (e: any) {
    console.error('[mcpStore] mcp-servers.json 解析失败，且备份失败（原文件保留）：', err, e)
  }
}

function readStore(): StoreFile {
  if (cache) return cache
  try {
    const p = STORE_PATH()
    if (existsSync(p)) {
      const parsed = JSON.parse(readFileSync(p, 'utf8'))
      if (parsed && Array.isArray(parsed.servers)) {
        cache = { version: 1, servers: parsed.servers as McpServerConfig[] }
        return cache
      }
      // 结构不对也要当损坏处理：此前的写法只是落空库存而不留痕迹，
      // 于是「下次保存覆盖」这条数据丢失路径没有任何提示。
      throw new Error(`结构不符合预期（期望顶层含 servers 数组，实际得到 ${Array.isArray(parsed?.servers) ? '未知' : typeof parsed}）`)
    }
  } catch (e: any) {
    quarantineCorruptStore(e)
  }
  cache = { version: 1, servers: [] }
  return cache
}

/**
 * 写盘。**失败必须抛出**（1.0.52）。
 *
 * 此前是「写盘失败就 catch 掉、不再抛出」—— 磁盘满、文件被占用、杀软拦截时一律静默通过，
 * 调用方照样返回「已保存」，UI 也照常刷新。于是用户看到保存成功，重启后配置全部归零，
 * 且没有任何线索可查。抛出去之后，`prepareWritableRuntime` 的 try/catch 能如实上报，
 * IPC 层的 `MCP_SAVE` 也会 reject 到渲染层。
 */
function persist(): void {
  writeFileSync(STORE_PATH(), JSON.stringify(readStore(), null, 2), 'utf8')
}

function encryptValue(key: string, value: string): string {
  if (!value || value.startsWith('enc:') || value.startsWith('plain:')) return value
  if (!SENSITIVE_KEY.test(key)) return value
  try {
    if (!safeStorage.isEncryptionAvailable()) return `plain:${value}`
    return `enc:${safeStorage.encryptString(value).toString('base64')}`
  } catch { return `plain:${value}` }
}

function decryptValue(value: string): string {
  if (!value) return value
  if (value.startsWith('enc:')) {
    try { return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64')) } catch { return '' }
  }
  if (value.startsWith('plain:')) return value.slice(6)
  return value
}

/** 展示态：敏感值打码（保留 enc: 前缀让 UI 知道这是密文） */
function maskEnv(env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env || {})) {
    out[k] = v.startsWith('enc:') && v !== 'enc:' ? ENV_MASK : v
  }
  return out
}

/** 使用态：解密后的真实 env（MCP 进程用；日志里不要用它） */
export function decryptEnv(env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env || {})) out[k] = decryptValue(v)
  return out
}

/** 全部服务（展示态：敏感 env 打码） */
export function listServers(): McpServerConfig[] {
  return readStore().servers.map(s => ({ ...s, env: maskEnv(s.env) }))
}

/** 原始服务（含解密后的 env）。仅供主进程内部使用，不要把结果发给渲染层 */
export function getServerRaw(id: string): McpServerConfig | undefined {
  const s = readStore().servers.find(x => x.id === id)
  return s ? { ...s, env: decryptEnv(s.env) } : undefined
}

/** 给定技能键（已启用的）对应、且启用中的服务（原始 env） */
export function serversForSkillKeys(enabledKeys: string[]): McpServerConfig[] {
  const keys = new Set(enabledKeys || [])
  return readStore().servers
    .filter(s => s.enabled && s.skillKey && keys.has(s.skillKey))
    .map(s => ({ ...s, env: decryptEnv(s.env) }))
}

/**
 * 归一化成完整的服务配置。
 *
 * 1.0.52：`old` 存在时**缺省字段沿用旧值**，而不是填默认值。
 * 此前这里是纯「全量替换」语义，而 `mcpClient.prepareWritableRuntime` 调的是
 * `saveServer({ id, cwd: dst })`（只给两个字段）—— 于是每次迁移到可写副本，
 * `command` / `args` / `env` / `skillKey` 都会被默认值清空，服务当场报废。
 * 一律用 `??` 而非 `||`：空串是**有意义的清空值**（`cwd: ""` 表示「交给绑定技能自行推断」），
 * 用 `||` 会把「显式清空」和「未提供」混为一谈。
 */
function normalize(
  input: Partial<McpServerConfig>,
  fallbackName: string,
  old?: McpServerConfig
): McpServerConfig {
  const name = String(input.name || old?.name || fallbackName || 'mcp').trim().slice(0, 60) || 'mcp'
  return {
    id: String(input.id || old?.id || `mcp_${randomUUID().slice(0, 8)}`),
    name,
    skillKey: String(input.skillKey ?? old?.skillKey ?? '').trim(),
    transport: 'stdio',
    command: String(input.command ?? old?.command ?? '').trim(),
    args: Array.isArray(input.args) ? input.args.map(a => String(a)) : [...(old?.args || [])],
    env: input.env && typeof input.env === 'object' ? { ...input.env } : { ...(old?.env || {}) },
    cwd: String(input.cwd ?? old?.cwd ?? '').trim(),
    enabled: input.enabled === undefined ? old?.enabled !== false : input.enabled !== false,
    installArgs: Array.isArray(input.installArgs)
      ? input.installArgs.map(a => String(a))
      : old?.installArgs
        ? [...old.installArgs]
        : undefined,
    timeoutMs: Number.isFinite(Number(input.timeoutMs)) && Number(input.timeoutMs) > 0
      ? Number(input.timeoutMs)
      : old?.timeoutMs,
    createdAt: Number(old?.createdAt) || Number(input.createdAt) || Date.now()
  }
}

/** 新增 / 更新（按 id）。返回展示态 */
export function saveServer(input: Partial<McpServerConfig>): McpServerConfig {
  const store = readStore()
  const old = input.id ? store.servers.find(s => s.id === input.id) : undefined
  const norm = normalize({ ...input, id: input.id || old?.id }, input.name || old?.name || 'mcp', old)

  // 合并 env：打码占位符 = 「用户没改这个值」→ 保留旧存储值；其余按需加密
  const mergedEnv: Record<string, string> = {}
  const oldEnv = old?.env || {}
  for (const [k, v] of Object.entries(norm.env || {})) {
    mergedEnv[k] = v === ENV_MASK && oldEnv[k] !== undefined ? oldEnv[k] : encryptValue(k, v)
  }
  norm.env = mergedEnv

  const idx = store.servers.findIndex(s => s.id === norm.id)
  if (idx >= 0) store.servers[idx] = norm
  else store.servers.push(norm)
  persist()
  return { ...norm, env: maskEnv(norm.env) }
}

export function deleteServer(id: string): boolean {
  const store = readStore()
  const before = store.servers.length
  store.servers = store.servers.filter(s => s.id !== id)
  if (store.servers.length !== before) persist()
  return store.servers.length !== before
}

export function setEnabled(id: string, enabled: boolean): McpServerConfig | undefined {
  const store = readStore()
  const s = store.servers.find(x => x.id === id)
  if (!s) return undefined
  s.enabled = enabled
  persist()
  return { ...s, env: maskEnv(s.env) }
}

/**
 * 解析用户粘贴的 MCP JSON。兼容四种形态：
 * 1) `{ "mcpServers": { "名字": { command, args, env } } }`（Claude / 常见宿主的写法）
 * 2) `{ "名字": { command, args, env } }`（直接一张名字→配置的映射）
 * 3) `[{ name?, command, args, env }, ...]`
 * 4) 单个 `{ name?, command, args, env }`
 * 全部归一化成 McpServerConfig 并入库存（skillKey 为空 = 未绑定，需在 UI 里补选）。
 *
 * skillKey 取值优先级（1.0.55）：**JSON 里显式写的 > 调用方传入的**（McpModal 表单选择）。
 * 内置技能示例（「填入示例」）自带 `skillKey: 'builtin:tech-agent-skill'` —— 没有它，
 * 用户照示例导入的服务就是「未绑定」状态，连「按绑定技能推断 runtime 目录」这条自动定位
 * 都用不上，只能得到一条在别人机器上有效的 cwd（1.0.55 分发实测）。
 */
export function importServersJson(text: string, skillKey = ''): McpImportResult {
  let parsed: any
  try { parsed = JSON.parse(String(text || '')) } catch (e: any) {
    return { ok: false, message: `JSON 解析失败：${e.message}` }
  }

  const rawList: { name?: string; cfg: any }[] = []
  const push = (name: string | undefined, cfg: any) => {
    if (cfg && typeof cfg === 'object' && (cfg.command || cfg.url)) rawList.push({ name, cfg })
  }

  if (Array.isArray(parsed)) {
    for (const item of parsed) push(item?.name, item)
  } else if (parsed && typeof parsed === 'object') {
    if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
      for (const [name, cfg] of Object.entries(parsed.mcpServers as Record<string, any>)) push(name, cfg)
    } else if (parsed.command || parsed.url) {
      push(parsed.name, parsed)
    } else {
      for (const [name, cfg] of Object.entries(parsed as Record<string, any>)) push(name, cfg)
    }
  }

  if (!rawList.length) {
    return { ok: false, message: '没识别出可用的服务配置：需要包含 command（与可选 args/env）字段' }
  }

  const store = readStore()
  const imported: McpServerConfig[] = []
  for (const { name, cfg } of rawList) {
    const norm = normalize({
      name: name || cfg?.name,
      command: cfg.command,
      args: cfg.args,
      env: cfg.env,
      cwd: cfg.cwd,
      // JSON 里显式写了 skillKey 就用它（示例 JSON 自带绑定，用户不必再补选）；
      // 没写才用调用方传入的（McpModal 表单里选的那个）
      skillKey: String(cfg?.skillKey ?? skillKey ?? ''),
      enabled: true
    }, `mcp-${store.servers.length + 1}`)
    // 同名（展示名）覆盖＝更新，避免反复导入堆出一堆重复项
    const dupIdx = store.servers.findIndex(s => s.name === norm.name)
    if (dupIdx >= 0) store.servers[dupIdx] = { ...norm, id: store.servers[dupIdx].id }
    else store.servers.push(norm)
    imported.push(norm)
  }
  persist()
  return {
    ok: true,
    imported: imported.length,
    servers: imported.map(s => ({ ...s, env: maskEnv(s.env) })),
    message: imported.length === 1 ? `已导入服务「${imported[0].name}」` : `已导入 ${imported.length} 个服务`
  }
}
