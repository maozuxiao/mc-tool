import { app } from 'electron'
import { spawnSync } from 'child_process'
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync
} from 'fs'
import { basename, join } from 'path'
import { bareSkillId, skillKey } from '@shared/ai-types'
import type { AISkillInfo } from '@shared/ai-types'

/**
 * 技能注册表（1.0.43）。
 *
 * 目录约定（沿用 skillRuntime 的双层结构）：
 * - 内置：`resources/skills/<id>/`（打包后 `resources/skills/<id>/`），随安装包分发；
 * - 导入：`userData/skills/<id>/`，由用户在「Skills」面板里导入（zip 或文件夹）。
 * 两者只要目录里有 `SKILL.md` 就算一个技能 —— 新增内置技能不需要改任何代码。
 *
 * 启用状态**不在这里**：技能是**按会话独立**选择的（1.0.43 调整）。
 * 早先版本把勾选持久化到 `userData/ai-skills.json`，结果「上一个会话勾了就到处都勾着」，
 * 新建会话也照样继承；现在勾选存在渲染层「当前会话」的内存状态里，
 * 发送时通过 `enabledSkills` 带给主进程（注入提示词 + 下发工具）。
 * 因此：新建会话从零开始，切回旧会话仍是原样，进程重启后全部不勾选。
 */

const SKILL_MD = 'SKILL.md'
/** 注入系统提示的 SKILL.md 上限：鸿翼那份 24KB，全量注入会白烧 token */
const PROMPT_MAX = 12000

function builtinRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'skills')
    : join(app.getAppPath(), 'resources', 'skills')
}

function userSkillRoot(): string {
  return join(app.getPath('userData'), 'skills')
}

/** 解析 SKILL.md 的 front-matter（只取 name / description 两行，够用且不引 yaml 依赖） */
export function parseSkillMeta(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''))
  if (!m) return {}
  const out: { name?: string; description?: string } = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w+)\s*:\s*(.+)$/.exec(line.trim())
    if (!kv) continue
    const key = kv[1].toLowerCase()
    if (key !== 'name' && key !== 'description') continue
    out[key] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

function readSkillMeta(dir: string): { name: string; description: string } | null {
  const p = join(dir, SKILL_MD)
  if (!existsSync(p)) return null
  let text = ''
  try { text = readFileSync(p, 'utf8') } catch { return null }
  const meta = parseSkillMeta(text)
  return { name: meta.name || basename(dir), description: meta.description || '' }
}

/**
 * 实现层技能：它们也在 resources/skills 下，但**不是**给用户勾选的「能力包」——
 * 其行为已经硬编码在工具定义与 mcSkill/fileSkill 的系统提示里（脚本路径也由 skillRuntime 解析）。
 * 若把它们列进 Skills 面板，SKILL.md（各 20KB+）会被注入到每次 build 对话，既费 token 又干扰模型。
 */
const INTERNAL_SKILLS = new Set(['mc-material-query-local', 'file-office-local'])

function listDirDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  } catch {
    return []
  }
}

/** 全部技能（内置在前、导入在后）。启用状态由渲染层按会话维护，这里不返回 */
export function listSkills(): AISkillInfo[] {
  const out: AISkillInfo[] = []
  for (const [source, root] of [['builtin', builtinRoot()], ['user', userSkillRoot()]] as const) {
    for (const id of listDirDirs(root)) {
      if (INTERNAL_SKILLS.has(id)) continue
      // 内置与导入**同名也各列一条**（用户要能看到两份、并分别勾选）：
      // 唯一键是「来源:id」（见 shared/ai-types 的 skillKey），所以不会互相串状态。
      const dir = join(root, id)
      const meta = readSkillMeta(dir)
      if (!meta) continue
      out.push({
        id,
        name: meta.name,
        description: meta.description,
        source,
        dir
      })
    }
  }
  return out
}

/** 删除导入的技能（内置技能不允许删） */
export function removeSkill(id: string): { ok: boolean; message?: string; skills: AISkillInfo[] } {
  const dir = join(userSkillRoot(), id)
  if (!existsSync(dir)) {
    return { ok: false, message: '只能删除自己导入的技能', skills: listSkills() }
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (e: any) {
    return { ok: false, message: `删除失败：${e?.message || e}`, skills: listSkills() }
  }
  // 没有持久化的启用记录要清：勾选在渲染层按会话维护，那边删除时会同步取消选中
  return { ok: true, skills: listSkills() }
}

/**
 * 读取某技能的 SKILL.md 全文（供注入系统提示）。
 * 入参可以是「来源:id」形式的唯一键（内置与导入同名时用它区分），也可以是裸 id
 * （裸 id 时按 导入 → 内置 的顺序找，保证向后兼容）。
 */
export function skillPrompt(key: string): string {
  const k = String(key || '')
  const i = k.indexOf(':')
  const src = i > 0 ? k.slice(0, i) : ''
  const id = bareSkillId(k)
  if (!id) return ''
  const roots = src === 'builtin' ? [builtinRoot()]
    : src === 'user' ? [userSkillRoot()]
      : [userSkillRoot(), builtinRoot()]
  for (const root of roots) {
    const p = join(root, id, SKILL_MD)
    if (existsSync(p)) {
      try { return readFileSync(p, 'utf8') } catch { return '' }
    }
  }
  return ''
}

/**
 * 把启用的技能说明拼成一段系统提示。
 * 只注入「已启用」的，且逐个截断 —— 技能再多也不会把上下文挤爆。
 *
 * 技能默认全部不勾选（见文件头说明），因此在 build 模式下额外补一行「未启用技能」清单：
 * 否则模型不知道这些能力存在，用户问「帮我找份资料」时只会回答「我做不到」，
 * 而不是提示用户去 Skills 面板勾选。清单只列 id + 名称，不注入正文，成本可忽略。
 *
 * `includeOffHint` 只允许在 build 模式传 true —— 对话 / 物料模式没有 Skills 按钮，
 * 提示用户去勾选会指向一个不存在的入口。
 */
export function skillsPromptBlock(ids: string[], includeOffHint = false): string {
  const blocks: string[] = []
  for (const key of ids) {
    if (INTERNAL_SKILLS.has(bareSkillId(key))) continue
    const text = skillPrompt(key).trim()
    if (!text) continue
    // 标题里带上来源：内置与导入同名时，模型/日志能看出注入的是哪一份
    blocks.push(`【已启用技能：${key}】\n${text.slice(0, PROMPT_MAX)}`)
  }

  const used = new Set(ids)
  // 未启用的（= 所有不在本次会话启用名单里的）技能，只列 id + 名称给模型。
  // 同时接受「来源:id」与裸 id 两种写法，避免旧调用漏判。
  const off = includeOffHint
    ? listSkills().filter(s => !used.has(skillKey(s)) && !used.has(s.id))
    : []
  const offHint = off.length
    ? '\n\n# 未启用的技能\n用户的输入框里还有一个「Skills」入口，可选启用以下技能：'
      + off.map(s => `${s.id}（${s.name}）`).join('、')
      + '。若用户的需求正好命中它们的描述（例如要查/下载企业内部文件系统里的文档），'
      + '请提示用户在「Skills」里勾选启用后重试；不要自行编造替代方案或声称无法访问。'
    : ''

  if (!blocks.length) return offHint
  return (
    '\n\n# 已启用技能\n' +
    '用户为本会话启用了以下技能。命中技能描述里的触发条件时必须按技能流程执行；' +
    '技能里声明「必须/禁止」的约束优先级高于你的默认习惯。\n\n' +
    blocks.join('\n\n') +
    offHint
  )
}

/** 从目录里（最多往下两层）找到含 SKILL.md 的那一层 */
function findSkillDir(root: string, depth = 0): string | null {
  if (existsSync(join(root, SKILL_MD))) return root
  if (depth >= 2) return null
  for (const name of listDirDirs(root)) {
    const hit = findSkillDir(join(root, name), depth + 1)
    if (hit) return hit
  }
  return null
}

/** id 归一化：全小写、只留字母数字与连字符下划线（技能名含中文时退回目录名） */
function slugify(input: string, fallback: string): string {
  const s = String(input || '').trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || fallback
}

function extractZip(zipPath: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true })
  if (process.platform === 'win32') {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -LiteralPath ${q(zipPath)} -DestinationPath ${q(destDir)} -Force`
    ], { windowsHide: true })
    if (r.status !== 0) throw new Error(String(r.stderr || r.stdout || '').trim() || 'Expand-Archive 失败')
    return
  }
  const r = spawnSync('unzip', ['-o', zipPath, '-d', destDir], { windowsHide: true })
  if (r.status !== 0) throw new Error(String(r.stderr || '').trim() || 'unzip 失败')
}

export interface ImportSkillResult {
  ok: boolean
  id?: string
  name?: string
  /** 同名技能被覆盖（重新导入 = 更新） */
  overwritten?: boolean
  message?: string
  skills?: AISkillInfo[]
}

/** 统一的落地逻辑：把 stage 目录里的技能搬到 userData/skills/<id>（同 id 覆盖） */
function installFromStage(stage: string): ImportSkillResult {
  const src = findSkillDir(stage)
  if (!src) return { ok: false, message: '没找到 SKILL.md，这不是一个技能包' }
  const meta = readSkillMeta(src)
  if (!meta) return { ok: false, message: 'SKILL.md 无法解析' }

  const id = slugify(meta.name, slugify(basename(src), `skill-${Date.now()}`))
  const dest = join(userSkillRoot(), id)
  const overwritten = existsSync(dest)
  try {
    mkdirSync(userSkillRoot(), { recursive: true })
    if (overwritten) rmSync(dest, { recursive: true, force: true })
    // 同盘直接 rename；跨盘（临时目录在 C、userData 在别处）rename 会 EXDEV，退回递归复制
    try {
      renameSync(src, dest)
    } catch {
      cpSync(src, dest, { recursive: true })
    }
  } catch (e: any) {
    return { ok: false, message: `写入技能目录失败：${e?.message || e}` }
  }
  // 顺手清掉暂存目录
  try { rmSync(stage, { recursive: true, force: true }) } catch { /* 清理失败无所谓 */ }

  // 返回 id：由渲染层把「刚导入的这条」勾到当前会话上（导入是明确动作，即导入即用）
  return { ok: true, id, name: meta.name, overwritten, skills: listSkills() }
}

export function importSkillZip(zipPath: string): ImportSkillResult {
  if (!zipPath || !existsSync(zipPath)) return { ok: false, message: '压缩包不存在' }
  const stage = join(userSkillRoot(), `.import-${Date.now()}`)
  try {
    extractZip(zipPath, stage)
  } catch (e: any) {
    try { rmSync(stage, { recursive: true, force: true }) } catch { /* ignore */ }
    return { ok: false, message: `解压失败：${e?.message || e}` }
  }
  return installFromStage(stage)
}

export function importSkillDir(dirPath: string): ImportSkillResult {
  if (!dirPath || !existsSync(dirPath)) return { ok: false, message: '目录不存在' }
  const src = findSkillDir(dirPath)
  if (!src) return { ok: false, message: '该目录里没有 SKILL.md' }
  const stage = join(userSkillRoot(), `.import-${Date.now()}`)
  try {
    mkdirSync(stage, { recursive: true })
    cpSync(src, join(stage, basename(src)), { recursive: true })
  } catch (e: any) {
    try { rmSync(stage, { recursive: true, force: true }) } catch { /* ignore */ }
    return { ok: false, message: `复制技能目录失败：${e?.message || e}` }
  }
  return installFromStage(stage)
}
