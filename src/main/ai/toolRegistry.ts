import { app, dialog } from 'electron'
import { tmpdir } from 'os'
import { existsSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { tr } from './uiLang'

/**
 * 1.0.75：AI 写已有文件前的确认请求。文案已由主进程 `uiLang` 翻译好，
 * 渲染层只负责用同款暖米色 Modal 排版展示，避免中英混杂。
 */
export interface WriteConfirmPayload {
  title: string
  message: string
  detail: string[]
  okText: string
  cancelText: string
}
/** 返回 null = 渲染层不可用，调用方回退原生 dialog；false = 用户取消 / 等待超时 */
export type WriteConfirmHandler = (payload: WriteConfirmPayload) => Promise<boolean | null>
let writeConfirmHandler: WriteConfirmHandler | null = null
export function setWriteConfirmHandler(h: WriteConfirmHandler | null): void {
  writeConfirmHandler = h
}
import { join } from 'path'
import {
  READ_LOCAL_FILE_TOOL_DEFINITION, readLocalTextFile
} from './attachmentMedia'
import { bareSkillId } from '@shared/ai-types'
import type { AIAgentMode, AIExtraRoot } from '@shared/ai-types'
import { MC_QUERY_TOOL_DEFINITION, runMcQuery, type McRunSink } from './mcSkill'
import {
  FILE_TOOL_DEFINITIONS, fileSkillRead, runFileSkillCommand,
  FILE_READ_TOOL_DEFINITION, FILE_LIST_TOOL_DEFINITION, FILE_SEARCH_TOOL_DEFINITION,
  FILE_WRITE_TOOL_DEFINITION,
  FILE_READ_BATCH_TOOL_DEFINITION, FILE_OPEN_FOLDER_TOOL_DEFINITION,
  FILE_DOWNLOAD_TOOL_DEFINITION, FILE_TRANSLATE_DOCX_TOOL_DEFINITION, fileSkillDownload
} from './fileSkill'
import {
  WJXT_SEARCH_TOOL_DEFINITION, WJXT_DOWNLOAD_TOOL_DEFINITION,
  runWjxtSearch, runWjxtDownload
} from './wjxtSkill'
import { cachedToolDefinitions, cachedToolNames, callTool as mcpCallTool, getMcpToolRoute, isMcpTool, setReservedNames } from './mcpClient'
import { MAIL_TOOL_ENTRIES } from './emailSkill'
import { JIRA_TOOL_ENTRIES } from './jiraSkill'

export interface OpenFolderResult {
  ok: boolean
  alias?: string
  path?: string
  error?: string
  message?: string
}

/**
 * 工具执行上下文。
 * onRun 由调用方构造（已绑定本次工具运行的 run id），工具只需按需回调，
 * 不必关心 UI 卡片是怎么落库的。
 */
export interface ToolContext {
  signal: AbortSignal
  /** Build 模式的已授权目录白名单（多根）：文件/命令工具据此限制范围 */
  allowedRoots: AIExtraRoot[]
  /**
   * 本会话已启用的技能键（来源:id）。MCP 工具据此校验归属：
   * 服务可能因上一个会话仍连着，不能让模型调用「技能未启用」的 MCP 工具（1.0.46）。
   */
  enabledSkills?: string[]
  /**
   * 打开目录的控制回调（会话级）。open_folder 工具调用它做校验 + 用户确认，
   * 并把新目录加入本会话的白名单。由 chatService 注入（需 conversationId）。
   */
  requestRoot?: (path: string) => Promise<OpenFolderResult>
  onRun?: McRunSink
}

interface ToolEntry {
  definition: any
  run: (input: any, ctx: ToolContext) => Promise<any>
}

const REGISTRY: Record<string, ToolEntry> = {
  mc_query: {
    definition: MC_QUERY_TOOL_DEFINITION,
    run: (input, ctx) => runMcQuery(input, ctx.onRun, ctx.signal)
  },
  // 1.0.74：工具下载的日志 / 文档按需读全文；图片走多模态回灌，不走这里
  read_local_file: {
    definition: READ_LOCAL_FILE_TOOL_DEFINITION,
    run: async (input, ctx) => {
      const filePath = String(input?.filePath || '').trim()
      const maxChars = Math.min(Math.max(Number(input?.maxChars) || 40000, 1000), 200000)
      const dir = join(app.getPath('userData'), 'attachments')
      const r = readLocalTextFile(filePath, { maxChars, allowedDir: dir })
      if (r.ok) return r
      // PDF / Office 转纯文本：绝对路径 + 空 roots 时 file-office-local 直接放行
      if (/\.(pdf|docx?|xlsx?|pptx?|rtf|odt|ods|odp|epub|xls|ppt)$/i.test(filePath)) {
        try {
          const doc = await fileSkillRead({
            path: filePath, roots: [], maxBytes: 50 * 1024 * 1024, signal: ctx.signal
          })
          return { ...doc, ok: true, path: filePath, text: doc?.text ?? doc }
        } catch (e: any) {
          return { ok: false, error: e?.message || String(e) }
        }
      }
      return { ok: false, error: r.error }
    }
  },
  // ── 内置技能「鸿翼文件查询下载」提供的工具（仅 build 模式 + 已启用该技能时下发）──
  wjxt_search: {
    definition: WJXT_SEARCH_TOOL_DEFINITION,
    // 1.0.51：透传 signal —— 用户点「停止」时 chatService 会 abort 它，
    // 鸿翼执行链（pageFetch / ensureCtxWin / warmup / 策略循环）据此立刻抛 AbortError 退出。
    // 此前这里没传，内部也从不读 signal，于是「停止」按钮对 wjxt_search 完全无效（用户实测）。
    run: (input, ctx) => runWjxtSearch(input, { signal: ctx.signal })
  },
  wjxt_download: {
    definition: WJXT_DOWNLOAD_TOOL_DEFINITION,
    run: (input, ctx) => runWjxtDownload(input, ctx.allowedRoots, ctx.signal)
  },
  file_read: {
    definition: FILE_TOOL_DEFINITIONS[0],
    run: async (input, ctx) => {
      const p = String(input?.path || '').trim()
      if (!p) return { ok: false, error: 'MISSING_ARG', message: '缺少 path 参数' }
      return fileSkillRead({
        roots: ctx.allowedRoots,
        path: p,
        offset: Number.isFinite(Number(input?.offset)) ? Number(input.offset) : undefined,
        limit: Number.isFinite(Number(input?.limit)) ? Number(input.limit) : undefined,
        signal: ctx.signal
      })
    }
  },
  file_list: {
    definition: FILE_TOOL_DEFINITIONS[1],
    run: async (input, ctx) => {
      const args = []
      if (input?.path) args.push(input.path)
      if (typeof input?.depth === 'number') args.push('--depth', String(input.depth))
      return runFileSkillCommand('list', args, ctx.allowedRoots, ctx.signal, 30000)
    }
  },
  file_search: {
    definition: FILE_TOOL_DEFINITIONS[2],
    run: async (input, ctx) => {
      const args = [String(input?.query || '')]
      if (input?.path) args.push(input.path)
      if (input?.nameOnly) args.push('--name-only')
      if (input?.regex) args.push('--regex')
      if (input?.glob) args.push('--glob', String(input.glob))
      if (input?.ext) args.push('--ext', String(input.ext))
      if (input?.index === true) args.push('--index')
      return runFileSkillCommand('search', args, ctx.allowedRoots, ctx.signal, 30000)
    }
  },
  // 写文件（文本 / docx / xlsx）。正文走**临时文件**而不是命令行参数（1.0.67）：
  // ① 正文曾经直接拼进 argv，Windows 命令行上限约 32K 字符，长文件会被截断、
  //    甚至整个 spawn 失败，用户看到的就是「文件被写坏/写了一半」；
  // ② 正文以 `--` 开头（典型：md 的 `---` frontmatter）时会被脚本的参数解析当成 flag，
  //    `--content` 被解析成布尔 true，最终把原文件覆盖成字面量 "true"。
  // 写临时文件后由脚本 `--content-file` 读取，上面两个坑都不存在。
  // 超时也从 30s 放宽到 120s：xlsx/docx 大文件写盘超过 30s 会被 kill，正好kill在写盘中途。
  file_write: {
    definition: FILE_TOOL_DEFINITIONS[3],
    run: async (input, ctx) => {
      const p = String(input?.path || '').trim()
      if (!p) return { ok: false, error: 'MISSING_ARG', message: '缺少 path 参数' }
      const content = String(input?.content ?? '')
      const tmp = join(tmpdir(), `mc-write-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
      const args = [p, '--content-file', tmp]
      if (input?.append) args.push('--append')
      if (input?.update) args.push('--update')
      if (input?.newsheet && input.newsheet !== 'false' && input.newsheet !== 'False') {
        const ns = typeof input.newsheet === 'string' && input.newsheet.toLowerCase() !== 'true'
          ? input.newsheet
          : undefined
        if (ns) args.push('--newsheet', ns)
        else args.push('--newsheet')
      }
      // startColumn / headerRow 以独立参数给出更不容易被模型写错位置（1.0.68），
      // 这里把它们注入 update 的 JSON spec；模型直接写在 JSON 顶层时以 JSON 里的为准。
      let payload = content
      if (input?.update && (input?.startColumn || input?.headerRow)) {
        try {
          const spec: any = JSON.parse(String(content).replace(/^\uFEFF/, '').trim())
          if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
            if (input.startColumn && spec.startColumn === undefined) spec.startColumn = String(input.startColumn)
            if (input.headerRow && spec.headerRow === undefined) spec.headerRow = Number(input.headerRow)
            payload = JSON.stringify(spec)
          }
        } catch {
          // 不是合法 JSON 就原样交给脚本，由脚本照常报 BAD_JSON（错误信息更具体）
        }
      }
      // 1.0.75 #8 P0-3：覆盖已有文件前，把「将改哪些内容、上一版还在不在」摆给用户确认。
      // 新建文件不弹（没有可覆盖的内容）；脚本层本来就会生成 .bak 备份，这里一并告知。
      if (existsSync(p)) {
        // 1.0.75：文案走主进程 i18n，英文界面下不再中英混杂
        const mode = input?.update ? tr('writeModeUpdate')
          : input?.append ? tr('writeModeAppend')
            : input?.newsheet ? tr('writeModeNewsSheet') : tr('writeModeOverwrite')
        let size = 0
        try { size = statSync(p).size } catch { /* ignore */ }
        const lineCount = payload.split(/\r?\n/).filter(Boolean).length
        const ui: WriteConfirmPayload = {
          title: tr('writeConfirmTitle'),
          message: tr('writeConfirmMsg', { name: p.split(/[\\/]/).pop() || p }),
          detail: [
            tr('writeConfirmTarget', { p }),
            tr('writeConfirmExisting', { size }),
            tr('writeConfirmMode', { mode }),
            tr('writeConfirmLines', { lines: lineCount, chars: payload.length }),
            tr('writeConfirmPreview', { text: payload.replace(/\s+/g, ' ').slice(0, 160) }),
            ...(input?.startColumn ? [tr('writeConfirmStartCol', { v: input.startColumn })] : []),
            ...(input?.headerRow ? [tr('writeConfirmHeaderRow', { v: input.headerRow })] : []),
            '',
            tr('writeConfirmBackup')
          ],
          okText: tr('writeConfirmOk'),
          cancelText: tr('writeConfirmCancel')
        }
        // 1.0.75：优先走渲染层的库 Modal（与「关于 / 批量删除确认」同款暖米色风格）。
        // 渲染层不可用时回退原生框，工具链不能因此丢功能；超时按「取消」处理，绝不误写。
        let approved: boolean | null = writeConfirmHandler ? await writeConfirmHandler(ui) : null
        if (approved === null) {
          const r = await dialog.showMessageBox({
            type: 'question',
            buttons: [ui.okText, ui.cancelText],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
            title: ui.title,
            message: ui.message,
            detail: ui.detail.join('\n')
          })
          approved = r.response === 0
        }
        if (!approved) {
          return { ok: false, error: 'USER_CANCELLED', message: tr('writeCancelled') }
        }
      }
      try {
        writeFileSync(tmp, payload, 'utf8')
        return await runFileSkillCommand('write', args, ctx.allowedRoots, ctx.signal, 120000)
      } finally {
        try { unlinkSync(tmp) } catch { /* 临时文件清理失败不影响结果 */ }
      }
    }
  },
  // 保布局翻译 docx（1.0.46）：只替换 <w:t> 文字，样式/表格/图片/页眉页脚/编号原样保留。
  // mapping 走临时文件而不是命令行参数 —— 译文可能几十 KB，Windows 命令行上限约 32K 会截断。
  translate_docx: {
    definition: FILE_TRANSLATE_DOCX_TOOL_DEFINITION,
    run: async (input, ctx) => {
      const action = String(input?.action || '').trim()
      const p = String(input?.path || '').trim()
      if (!p) return { ok: false, error: 'MISSING_ARG', message: '缺少 path 参数' }
      const args = [action, p]
      if (action === 'extract') {
        if (Number.isFinite(Number(input?.offset))) args.push('--offset', String(Number(input.offset)))
        if (Number.isFinite(Number(input?.limit))) args.push('--limit', String(Number(input.limit)))
        return runFileSkillCommand('translate_docx', args, ctx.allowedRoots, ctx.signal, 60000)
      }
      if (action !== 'apply') return { ok: false, error: 'BAD_ACTION', message: 'action 必须是 extract 或 apply' }
      if (input?.dst) args.push('--dst', String(input.dst))
      if (input?.lang) args.push('--lang', String(input.lang))
      const mapping = input?.mapping
      if (mapping === undefined || mapping === null) {
        return { ok: false, error: 'MISSING_ARG', message: 'apply 缺少 mapping（id → 译文）' }
      }
      const tmp = join(tmpdir(), `mc-docx-mapping-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
      try {
        writeFileSync(tmp, typeof mapping === 'string' ? mapping : JSON.stringify(mapping), 'utf8')
        args.push('--mapping-file', tmp)
        return await runFileSkillCommand('translate_docx', args, ctx.allowedRoots, ctx.signal, 120000)
      } finally {
        try { unlinkSync(tmp) } catch { /* 临时文件删不掉不影响结果 */ }
      }
    }
  },
  // 批量读取：一次读多个文件，只消耗 1 轮
  [FILE_READ_BATCH_TOOL_DEFINITION.function.name]: {
    definition: FILE_READ_BATCH_TOOL_DEFINITION,
    run: async (input, ctx) => {
      const paths = Array.isArray(input?.paths) ? input.paths.map(String) : []
      if (!paths.length) return { ok: false, error: 'MISSING_ARG', message: '缺少 paths 参数' }
      return runFileSkillCommand('read_batch', paths, ctx.allowedRoots, ctx.signal, 60000)
    }
  },
  // 会话级打开目录：校验 + 用户确认，由 chatService 的 requestRoot 实现
  [FILE_OPEN_FOLDER_TOOL_DEFINITION.function.name]: {
    definition: FILE_OPEN_FOLDER_TOOL_DEFINITION,
    run: async (input, ctx) => {
      const p = String(input?.path || '').trim()
      if (!p) return { ok: false, error: 'MISSING_ARG', message: '缺少 path 参数' }
      if (!ctx.requestRoot) return { ok: false, error: 'NO_REQUEST_ROOT', message: '当前环境不支持打开目录' }
      return ctx.requestRoot(p)
    }
  },
  // 下载文件到目录：主进程执行，目录受授权工作区约束
  [FILE_DOWNLOAD_TOOL_DEFINITION.function.name]: {
    definition: FILE_DOWNLOAD_TOOL_DEFINITION,
    run: async (input, ctx) => fileSkillDownload({
      url: input?.url,
      dir: input?.dir,
      name: input?.name,
      roots: ctx.allowedRoots
    })
  },
  // Outlook 工作邮箱助手（1.0.61）：执行层在主进程，不随包分发脚本/运行时
  ...MAIL_TOOL_ENTRIES,
  // Jira/JSM 工单助手（1.0.71）：14 个 jira_* 工具，凭据落 userData/jira-jsm
  ...JIRA_TOOL_ENTRIES
}

/**
 * 技能 id → 该技能提供的工具名（1.0.43）。
 * 只有「该会话启用了此技能」且处于 build 模式时，这些工具才下发给模型；
 * 提示词侧由 skillRegistry 注入对应 SKILL.md（见 skillsPromptBlock）。新增内置技能时在这里登记一行。
 */
// MCP 工具重名让位：把内置工具名注入 mcpClient —— MCP 侧同名工具下发时会自动加 `<服务id>_` 前缀
setReservedNames(Object.keys(REGISTRY))

const SKILL_TOOLS: Record<string, string[]> = {
  'wjxt-file-download': ['wjxt_search', 'wjxt_download'],
  // Outlook 工作邮箱助手（1.0.61）：授权 / 配置 / 检索 / 读取 / 写草稿 / 回读草稿
  'email-auto': ['mail_auth', 'mail_config', 'mail_search', 'mail_read', 'mail_draft_save', 'mail_drafts_list'],
  // Jira/JSM 工单助手（1.0.71）：配置 3 + 只读 8 + 写入 3。
  // 只在 build 模式且勾选该技能时下发 —— 写操作（建单/评论/流转）不能被物料或对话模式误触。
  'jira-jsm': [
    'jira_config', 'jira_panel_status', 'jira_save_panel_curl',
    'jira_current_user', 'jira_service_desks', 'jira_request_types', 'jira_request_type_fields',
    'jira_search_issues', 'jira_get_issue', 'jira_get_issue_attachments', 'jira_request_status', 'jira_panel_rdms',
    'jira_create_ticket', 'jira_add_comment', 'jira_transition_issue'
  ]
}

/**
 * 已启用技能带来的工具名集合。
 * 技能键是「来源:id」（内置与导入可能同名），这里按裸 id 查表并**去重** ——
 * 同名技能的内置版与导入版同时启用时，工具只能下发一份（重复的 function name 会被接口拒绝）。
 */
function skillToolNames(enabledSkills?: string[]): string[] {
  const set = new Set<string>()
  for (const key of enabledSkills || []) {
    for (const name of SKILL_TOOLS[bareSkillId(key)] || []) set.add(name)
  }
  // 导入技能带来的 MCP 工具（1.0.46）：仅在「绑定的技能被勾选」且服务已连接时才有名字
  for (const name of cachedToolNames(enabledSkills || [])) set.add(name)
  return [...set]
}

/** 已启用技能带来的工具定义（顺序与 skillToolNames 一致；内置查 REGISTRY，MCP 查连接缓存） */
function skillToolDefinitions(enabledSkills?: string[]): any[] {
  const mcpByName = new Map(cachedToolDefinitions(enabledSkills || []).map(d => [d.function.name, d]))
  return skillToolNames(enabledSkills)
    .map(name => REGISTRY[name]?.definition || mcpByName.get(name))
    .filter(Boolean)
}

/**
 * 物料模式下发的文件工具（1.0.71）：只读四件套 + 写入，**不含 open_folder / 命令执行**。
 * 物料模式没有工作区，rootArgs() 不传 --root，脚本侧 resolveSafe('' , target) 走全盘模式
 * （只拦受保护系统目录），因此绝对路径可直接读写；不给 open_folder 是为了少一步授权弹窗。
 */
const MC_MODE_FILE_TOOL_DEFINITIONS = [
  FILE_READ_TOOL_DEFINITION,
  FILE_LIST_TOOL_DEFINITION,
  FILE_SEARCH_TOOL_DEFINITION,
  FILE_WRITE_TOOL_DEFINITION,
  FILE_READ_BATCH_TOOL_DEFINITION,
  FILE_DOWNLOAD_TOOL_DEFINITION
]

/** 该模式下允许调用的工具名，用于兜底拦截模型臆造的工具调用 */
export function toolNamesForMode(mode: AIAgentMode, hasWorkspace: boolean, enabledSkills?: string[]): string[] {
  if (mode === 'ask') return []
  // mc：mc_query + 本地文件读写（1.0.71）。物料模式下用户的真实诉求常是
  // 「把这个目录下的 Excel 筛一遍」「把 DS100 的规格书下到桌面」——只给 mc_query 时模型
  // 只能列清单、让用户自己点链接，或回「请切换到 Build 模式」（用户反馈的核心痛点）。
  // 1.0.54 先放开了 file_download；1.0.71 起再放开只读四件套 + file_write，
  // 边界仍由「受保护系统目录」闸门把守，且不开放 open_folder 与命令执行。
  if (mode === 'mc') return [...MC_MODE_FILE_TOOL_DEFINITIONS.map(t => t.function.name), 'mc_query', 'read_local_file']
  // build：文件工具 + 打开目录 + mc_query 全量下发；未授权目录时文件工具会引导用 open_folder
  void hasWorkspace
  return [...FILE_TOOL_DEFINITIONS.map(t => t.function.name), 'mc_query', 'read_local_file', ...skillToolNames(enabledSkills)]
}

/**
 * 按模式生成下发给大模型的 tools 数组。
 * ask 模式必须返回空数组：不下发工具定义，模型才不会去「调用」不存在的工具。
 */
export function toolsForMode(mode: AIAgentMode, hasWorkspace: boolean, enabledSkills?: string[]): any[] {
  if (mode === 'ask') return []
  if (mode === 'mc') return [...MC_MODE_FILE_TOOL_DEFINITIONS, MC_QUERY_TOOL_DEFINITION, READ_LOCAL_FILE_TOOL_DEFINITION]
  // build：文件工具 + 打开目录 + mc_query 全量下发（不再强制先选工作区）+ 已启用技能带来的工具
  void hasWorkspace
  return [...FILE_TOOL_DEFINITIONS, MC_QUERY_TOOL_DEFINITION, READ_LOCAL_FILE_TOOL_DEFINITION, ...skillToolDefinitions(enabledSkills)]
}

// 非 mc_query 工具没有 runMcQuery 那种「内部回调 onRun」机制，
// 这里统一在结束时补发一次终态，让 UI 工具卡片能从转圈变成完成。
function buildFileSummary(name: string, result: any): string {
  if (!result || result.ok === false) return `失败：${result?.error || result?.error_message || '未知错误'}`
  switch (name) {
    case 'wjxt_search': return result?.ok ? `找到 ${result.count ?? 0} 个文件` : `失败：${result?.error || '未知错误'}`
    case 'wjxt_download': return result?.ok ? `已下载 ${result.items?.length ?? 0} 个文件` : `失败：${result?.error || '未知错误'}`
    case 'file_read': return `已读取 ${result.relative || result.path}`
    case 'file_list': return `已列出 ${result.count ?? 0} 项`
    case 'file_search': return `找到 ${result.count ?? 0} 个匹配`
    case 'file_write':
      return result?.ok === false
        ? `失败：${result?.error || '未知错误'}`
        : `已写入 ${result.relative || result.path}`
    case 'file_download': return `已下载 ${result.relative || result.savedPath || ''}（${result.size ?? 0} 字节）`
    case 'file_read_batch': return `已批量读取 ${result.count ?? 0} 个文件`
    case 'translate_docx':
      return result?.action === 'extract'
        ? `已抽取 ${result.total ?? 0} 段待翻译（本次返回 ${result.returned ?? 0} 段）`
        : `已写回 ${result.replaced ?? 0} 段，生成 ${result.path || ''}（布局保持原样）`
    case 'open_folder':
      return result.ok ? `已打开目录（别名 ${result.alias}）` : `打开目录被拒绝：${result.error || ''}`
    // ── Outlook 工作邮箱助手（1.0.61）─────────────────────
    case 'mail_auth':
      if (result?.userCode) return `待授权：验证码 ${result.userCode}`
      return result?.authorized ? '邮箱已授权' : '邮箱未授权'
    case 'mail_config':
      return result?.updated?.length ? `已更新配置 ${result.updated.join(',')}` : '已读取配置'
    case 'mail_search':
      return result?.hasMore
        ? `找到 ${result.total ?? 0} 封（还有更多）`
        : `找到 ${result.total ?? 0} 封邮件`
    case 'mail_read':
      return `已读取「${String(result?.subject || '').slice(0, 24)}」${result?.truncated ? '（正文已截断）' : ''}`
    case 'mail_draft_save':
      if (result?.dryRun) return `排版自检：${result.paragraphs ?? 0} 段${result.formatOk ? '' : '（需改写）'}`
      return result?.formatOk
        ? `已写入草稿箱（${result.paragraphs ?? 0} 段）`
        : `草稿已写入但结构存疑（${result.paragraphs ?? 0} 段）`
    case 'mail_drafts_list':
      return `草稿箱最近 ${result?.total ?? 0} 封`
    // ── Jira/JSM 工单助手（1.0.71）───────────────────────
    case 'jira_config':
      if (result?.ready) return 'JSM 凭据已配置'
      return result?.templateCreated ? '已生成配置模板并打开目录' : '凭据未配置完成'
    case 'jira_panel_status':
      return result?.configured
        ? (result?.expired ? '面板凭据已过期' : `面板凭据可用（约 ${Math.round((result?.expiresInSec || 0) / 60)} 分钟）`)
        : '还没有面板凭据'
    case 'jira_save_panel_curl':
      return `面板凭据已保存（约 ${Math.round((result?.expiresInSec || 0) / 60)} 分钟）`
    case 'jira_current_user':
      return `当前账号：${result?.displayName || ''}`
    case 'jira_service_desks':
      return `找到 ${result?.serviceDesks?.length ?? 0} 个服务台`
    case 'jira_request_types':
      return `找到 ${result?.requestTypes?.length ?? 0} 个工单类型`
    case 'jira_request_type_fields':
      return `必填 ${result?.requiredFields?.length ?? 0} 项${result?.organizations ? '／含组织字段' : ''}`
    case 'jira_search_issues':
      return `找到 ${result?.total ?? 0} 个工单`
    case 'jira_get_issue':
      return `已读取 ${result?.issueKey || ''}（${result?.status || ''}）`
    case 'jira_request_status':
      return `${result?.issueKey || ''}：${result?.status || ''}`
    case 'jira_panel_rdms': {
      const list = Array.isArray(result?.results) ? result.results : []
      const hit = list.filter((r: any) => r.rmId).length
      return `查到 ${hit}/${list.length} 个工单的 RDMS 关联`
    }
    case 'jira_create_ticket':
      return `已创建 ${result?.issueKey || ''}`
    case 'jira_add_comment':
      return `已评论 ${result?.issueKey || ''}${result?.attachments?.length ? `（附件 ${result.attachments.length} 个）` : ''}`
    case 'jira_transition_issue':
      return `已流转到「${result?.to || result?.transitionName || ''}」`
    default:
      // MCP 工具：摘要带上返回体量，便于一眼看出「调用成功但内容为空」
      if (result?.source === 'mcp') {
        const text = String(result.text || '')
        return text ? `已返回 ${text.length} 字` : '已完成（无文本返回）'
      }
      return `已完成 ${name}`
  }
}

/**
 * 分发工具调用。
 * - 用户中止（AbortError）必须向上抛，让调用方中断整个循环；
 * - 其余错误转成结构化结果回给模型，让它知道失败原因并自行改策略
 *   （例如换个路径、分段读取），而不是让整轮对话直接崩掉；
 * - mc_query 在 runMcQuery 内部已自行回调 onRun，这里跳过避免重复。
 */
export async function dispatchTool(name: string, input: any, ctx: ToolContext): Promise<any> {
  const entry = REGISTRY[name]
  // MCP 工具（1.0.46）：不在 REGISTRY 里，按对外名路由到对应服务转发执行
  if (!entry && !isMcpTool(name)) return { error: `不支持的工具：${name}` }
  const start = Date.now()
  const finish = (result: any, status: 'done' | 'error') => {
    if (ctx.onRun && name !== 'mc_query') {
      ctx.onRun({
        toolName: name,
        input,
        status,
        summary: buildFileSummary(name, result),
        output: result,
        durationMs: Date.now() - start
      })
    }
  }
  try {
    let result: any
    if (!entry) {
      // 归属校验：服务可能因上一个会话仍连着，模型不能调用「技能未启用」的 MCP 工具
      const route = getMcpToolRoute(name)
      if (route?.skillKey && ctx.enabledSkills && !ctx.enabledSkills.includes(route.skillKey)) {
        return {
          ok: false,
          error: `MCP 工具 ${name} 所属的技能未在本会话启用（已启用：${ctx.enabledSkills.join(', ') || '无'}），请先在 Skills 面板勾选`,
          source: 'mcp'
        }
      }
      // MCP 转发：content 文本合并后回给模型；isError 的返回按失败处理（模型会自行改策略或提示登录）
      const r = await mcpCallTool(name, input, ctx.signal)
      result = r.ok
        ? { ok: true, text: r.text, source: 'mcp' }
        : { ok: false, error: r.text || 'MCP 工具执行失败', source: 'mcp' }
    } else {
      result = await entry.run(input, ctx)
    }
    finish(result, result && result.ok === false ? 'error' : 'done')
    return result
  } catch (e: any) {
    if (e?.name === 'AbortError' || /aborted/i.test(String(e?.message))) throw e
    const errResult = { ok: false, error: e?.message || String(e) }
    finish(errResult, 'error')
    return errResult
  }
}
