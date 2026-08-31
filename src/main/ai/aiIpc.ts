import { ipcMain, BrowserWindow, dialog } from 'electron'
import { homedir } from 'os'
import { resolve } from 'path'
import { AI_IPC } from '@shared/ai-types'
import { listModels, testProvider } from './providerApi'
import { listProviders, saveProvider, getSuggestedModels, getPreferences, savePreferences } from './providerStore'
import { dirBlockReason, makeAlias } from './rootGuard'
import {
  createConversation, deleteConversation, getConversation,
  listConversations, renameConversation
} from './historyStore'
import { sendMessage, stopMessage } from './chatService'

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
}
