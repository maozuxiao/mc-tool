import { ipcMain, BrowserWindow, dialog, shell } from 'electron'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { resolve } from 'path'
import { AI_IPC } from '@shared/ai-types'
import { listModels, testProvider, optimizePrompt } from './providerApi'
import { listSkills, importSkillZip, importSkillDir, removeSkill } from './skillRegistry'
import { listProviders, saveProvider, getSuggestedModels, getPreferences, savePreferences, addCustomProvider, deleteCustomProvider, resetProvider } from './providerStore'
import { dirBlockReason, makeAlias } from './rootGuard'
import {
  createConversation, deleteConversation, getConversation,
  listConversations, renameConversation
} from './historyStore'
import { sendMessage, stopMessage } from './chatService'
import { listPrompts, savePrompt, updatePrompt, deletePrompt } from './promptStore'
import {
  listServers as listMcpServers,
  saveServer as saveMcpServer,
  deleteServer as deleteMcpServer,
  setEnabled as setMcpEnabled,
  importServersJson as importMcpServersJson,
  getServerRaw as getMcpServerRaw
} from './mcpStore'
import {
  connect as connectMcp,
  disconnect as disconnectMcp,
  listStatuses as listMcpStatuses,
  checkDependencies as checkMcpDependencies,
  installDependencies as installMcpDependencies,
  cancelInstall as cancelMcpInstall,
  onMcpEvent,
  logPath as mcpLogPath
} from './mcpClient'

export function registerAIIPC(): void {
  ipcMain.handle(AI_IPC.GET_PROVIDERS, () => {
    const providers = listProviders()
    return {
      providers,
      suggestions: Object.fromEntries(providers.map(p => [p.id, getSuggestedModels(p.id)])),
      // 上次使用的服务商 / 模型，作为全局配置在下一次启动时恢复
      preferences: getPreferences()
    }
  })

  ipcMain.handle(AI_IPC.SAVE_PROVIDER, (_e, input: any) => {
    const saved = saveProvider(input)
    // 保存配置的同时记住这次选择，下次打开 app 直接回到这套配置
    savePreferences({ lastProviderId: input.id, lastModelId: input.defaultModel || saved.defaultModel })
    return saved
  })

  // 新增自定义供应商（名称 / 协议 / Base URL / 模型 / API Key），支持添加多个
  ipcMain.handle(AI_IPC.ADD_CUSTOM_PROVIDER, (_e, input: any) => {
    const config = addCustomProvider({
      name: input?.name,
      protocol: input?.protocol,
      baseUrl: input?.baseUrl,
      defaultModel: input?.defaultModel,
      apiKey: input?.apiKey
    })
    // 新增后自动选中它
    savePreferences({ lastProviderId: config.id, lastModelId: config.defaultModel })
    return config
  })

  // 删除自定义供应商（内置预设不可删）
  ipcMain.handle(AI_IPC.DELETE_CUSTOM_PROVIDER, (_e, id: string) => {
    deleteCustomProvider(id)
    return { ok: true }
  })

  // 重置 API 配置：内置恢复默认 Base URL / 模型并清空 Key；自定义仅清空 Key
  ipcMain.handle(AI_IPC.RESET_PROVIDER, (_e, id: string) => {
    return resetProvider(id)
  })
  ipcMain.handle(AI_IPC.LIST_MODELS, async (_e, providerId: string) => {
    try {
      return { ok: true, models: await listModels(providerId), suggestions: getSuggestedModels(providerId) }
    } catch (e: any) {
      return { ok: false, error: e.message, suggestions: getSuggestedModels(providerId) }
    }
  })
  ipcMain.handle(AI_IPC.TEST_PROVIDER, async (_e, input: { providerId: string; modelId?: string }) => {
    try {
      // testProvider 自身已返回 { ok, models, message }，再展开一层 ok:true 会被覆盖（TS2783）。
      // 失败时它抛异常，由 catch 统一包成 { ok:false, error }。
      return await testProvider(input.providerId, input.modelId)
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle(AI_IPC.LIST_CONVERSATIONS, () => listConversations())
  ipcMain.handle(AI_IPC.GET_CONVERSATION, (_e, id: string) => getConversation(id))
  ipcMain.handle(AI_IPC.RENAME_CONVERSATION, (_e, id: string, title: string) => renameConversation(id, title))
  ipcMain.handle(AI_IPC.DELETE_CONVERSATION, (_e, id: string) => deleteConversation(id))

  ipcMain.handle(AI_IPC.SEND_MESSAGE, async (_e, payload: any) => {
    try {
      await sendMessage(payload)
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })
  ipcMain.handle(AI_IPC.STOP_MESSAGE, (_e, conversationId: string) => stopMessage(conversationId))

  // Build 模式的工作区根目录。选目录必须由主进程弹系统对话框：
  // 渲染层不直接碰 fs，也避免 <input type=file> 在 Electron 下的路径差异。
  ipcMain.handle(AI_IPC.SELECT_WORKSPACE, async () => {
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
    if (!win) return { ok: false, error: 'no main window' }
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择 AI 工作区目录'
    })
    if (canceled || !filePaths.length) return { ok: true, canceled: true }

    const root = filePaths[0]
    // 把磁盘根目录或用户主目录整个开放给 AI，爆炸半径过大，给个提示但仍然尊重用户选择
    let warning: string | undefined
    try {
      if (/^[a-zA-Z]:[\\/]*$/.test(root)) warning = 'WORKSPACE_TOO_BROAD'
      else if (resolve(root) === resolve(homedir())) warning = 'WORKSPACE_IS_HOME'
    } catch { /* 路径比较失败不影响选择结果 */ }

    savePreferences({ workspaceRoot: root })
    return { ok: true, workspaceRoot: root, warning }
  })

  ipcMain.handle(AI_IPC.CLEAR_WORKSPACE, () => {
    savePreferences({ workspaceRoot: '' })
    return { ok: true, workspaceRoot: '' }
  })

  // 额外可访问目录（工作区之外）白名单：主进程弹系统目录框多选，持久化到偏好。
  // 受保护的系统目录（C:\Windows、应用自身资源、AppData、用户主目录）一律拦截。
  ipcMain.handle(AI_IPC.ADD_EXTRA_ROOT, async () => {
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
    if (!win) return { ok: false, error: 'no main window' }
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory', 'multiSelections'],
      title: '添加可访问目录（工作区之外，模型可读写）'
    })
    if (canceled || !filePaths.length) {
      return { ok: true, canceled: true, extraRoots: getPreferences().extraRoots || [] }
    }
    const cur = getPreferences().extraRoots || []
    const next = cur.slice()
    const added: { alias: string; path: string }[] = []
    const blocked: { path: string; reason: string }[] = []
    for (const p of filePaths) {
      const reason = dirBlockReason(p)
      if (reason) { blocked.push({ path: p, reason }); continue }
      if (next.some(r => resolve(r.path) === resolve(p))) continue
      const alias = makeAlias(p, next)
      next.push({ alias, path: p })
      added.push({ alias, path: p })
    }
    savePreferences({ extraRoots: next })
    return { ok: true, extraRoots: next, added, blocked }
  })

  ipcMain.handle(AI_IPC.REMOVE_EXTRA_ROOT, async (_e, input: { alias?: string; path?: string }) => {
    const cur = getPreferences().extraRoots || []
    const next = input?.alias
      ? cur.filter(r => r.alias !== input.alias)
      : cur.filter(r => resolve(r.path) !== resolve(input?.path || ''))
    savePreferences({ extraRoots: next })
    return { ok: true, extraRoots: next }
  })

  // 用户自定义提示词（快捷调用）：列表 / 保存当前输入框 / 删除
  ipcMain.handle(AI_IPC.LIST_PROMPTS, () => listPrompts())
  ipcMain.handle(AI_IPC.SAVE_PROMPT, (_e, input: { text: string; title?: string }) => {
    return savePrompt(input?.text || '', input?.title)
  })
  ipcMain.handle(AI_IPC.UPDATE_PROMPT, (_e, input: { id: string; text: string; title?: string }) => {
    return updatePrompt(input?.id || '', input?.text || '', input?.title)
  })
  ipcMain.handle(AI_IPC.DELETE_PROMPT, (_e, id: string) => deletePrompt(id))

  // ── 技能（1.0.43）────────────────────────────────────────────
  // 列表 / 删除；导入支持 zip 与文件夹两种入口（都由主进程弹系统选择框）。
  // 注意没有「启用停用」通道：勾选是按会话存在渲染层的（见 skillRegistry 文件头说明）
  ipcMain.handle(AI_IPC.SKILLS_LIST, () => listSkills())
  ipcMain.handle(AI_IPC.SKILL_REMOVE, (_e, id: string) => removeSkill(String(id || '')))
  ipcMain.handle(AI_IPC.SKILL_IMPORT, async (e, kind: 'zip' | 'dir') => {
    const win = BrowserWindow.fromWebContents(e.sender) || undefined
    if (kind === 'dir') {
      const picked = await dialog.showOpenDialog(win as any, {
        title: '选择技能文件夹（需包含 SKILL.md）',
        properties: ['openDirectory']
      })
      if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true }
      return importSkillDir(picked.filePaths[0])
    }
    const picked = await dialog.showOpenDialog(win as any, {
      title: '选择技能压缩包（内含 SKILL.md）',
      properties: ['openFile'],
      filters: [{ name: '技能包', extensions: ['zip'] }]
    })
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true }
    return importSkillZip(picked.filePaths[0])
  })

  // 增强提示词：一次性请求当前供应商改写草稿，不落历史
  ipcMain.handle(AI_IPC.OPTIMIZE_PROMPT, (_e, input: { providerId: string; modelId?: string; text: string; lang?: string }) =>
    optimizePrompt(input))

  // ── MCP 服务（1.0.46）────────────────────────────────────────────
  // 登记 stdio MCP 服务 → 对话前自动拉起 → 工具下发给模型（仅当绑定的技能被勾选）。
  // 依赖安装**不静默执行**：UI 先征求同意，再走 MCP_PREPARE（进度经 MCP_EVENT 推送、可取消）。
  const pushMcpEvent = (payload: unknown) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(AI_IPC.MCP_EVENT, payload)
    }
  }
  onMcpEvent(e => pushMcpEvent(e))

  ipcMain.handle(AI_IPC.MCP_LIST, () => listMcpServers())
  ipcMain.handle(AI_IPC.MCP_SAVE, (_e, input: any) => saveMcpServer(input || {}))
  ipcMain.handle(AI_IPC.MCP_DELETE, (_e, id: string) => {
    const gid = String(id || '')
    disconnectMcp(gid, '删除服务')
    return { ok: deleteMcpServer(gid) }
  })
  ipcMain.handle(AI_IPC.MCP_SET_ENABLED, (_e, id: string, enabled: boolean) => {
    const saved = setMcpEnabled(String(id || ''), !!enabled)
    // 停用即断开并收回工具；启用不主动连接（等下一次对话前的 prepareForSkills）
    if (saved && !enabled) disconnectMcp(String(id || ''), '服务被停用')
    return { ok: !!saved, server: saved }
  })
  ipcMain.handle(AI_IPC.MCP_IMPORT_JSON, (_e, text: string, skillKey?: string) =>
    importMcpServersJson(String(text || ''), String(skillKey || '')))
  ipcMain.handle(AI_IPC.MCP_STATUS, () => listMcpStatuses())
  // 测试连接：连上并列出工具；测完即断开（避免留驻进程；真正使用时对话前会再连）
  ipcMain.handle(AI_IPC.MCP_TEST, async (_e, id: string) => {
    const cfg = getMcpServerRaw(String(id || ''))
    if (!cfg) return { ok: false, error: '服务不存在' }
    try {
      await connectMcp(cfg)
      const st = listMcpStatuses().find(s => s.id === cfg.id)
      return { ok: true, tools: st?.tools || [], toolCount: st?.toolCount || 0 }
    } catch (err: any) {
      const dep = checkMcpDependencies(cfg)
      return { ok: false, error: err?.message || String(err), needsInstall: dep.needsInstall }
    } finally {
      disconnectMcp(cfg.id, '测试连接结束')
    }
  })
  // 一键准备依赖：立即返回「已启动」，进度与结果经 MCP_EVENT 推送（install-log / install-done）
  ipcMain.handle(AI_IPC.MCP_PREPARE, (_e, id: string) => {
    const cfg = getMcpServerRaw(String(id || ''))
    if (!cfg) return { ok: false, error: '服务不存在' }
    void installMcpDependencies(cfg, line => pushMcpEvent({ type: 'install-log', id: cfg.id, line }))
      .then(r => pushMcpEvent({ type: 'install-done', id: cfg.id, ok: r.ok, error: r.error }))
      .catch((err: any) => pushMcpEvent({ type: 'install-done', id: cfg.id, ok: false, error: err?.message || String(err) }))
    return { ok: true, started: true }
  })
  ipcMain.handle(AI_IPC.MCP_PREPARE_CANCEL, (_e, id: string) => {
    cancelMcpInstall(String(id || ''))
    return { ok: true }
  })
  ipcMain.handle(AI_IPC.MCP_OPEN_LOG, (_e, id: string) => {
    const p = mcpLogPath(String(id || ''))
    if (!p || !existsSync(p)) return { ok: false, error: '日志文件还不存在（服务尚未启动过）' }
    shell.showItemInFolder(p)
    return { ok: true }
  })
  // 为 MCP 服务选工作目录（MCP 的相对配置路径都基于它解析）
  ipcMain.handle(AI_IPC.MCP_SELECT_DIR, async e => {
    const win = BrowserWindow.fromWebContents(e.sender) || undefined
    const picked = await dialog.showOpenDialog(win as any, {
      title: '选择 MCP 服务工作目录',
      properties: ['openDirectory']
    })
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true }
    return { ok: true, cwd: picked.filePaths[0] }
  })
}
