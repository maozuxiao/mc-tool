import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { AISkillInfo, McpServerConfig, McpStatus } from '@shared/ai-types'
import { skillKey } from '@shared/ai-types'
import { Button, Icon } from 'animal-island-ui'
import { useStore } from '../../store'

/**
 * MCP 服务管理弹窗（1.0.46）。
 *
 * 服务在应用内登记（command/args/env/cwd，存 userData/mcp-servers.json）并绑定到一个技能；
 * 勾选该技能后，对话前会自动拉起服务并把它的工具下发给模型（见 mcpClient.ts）。
 *
 * 依赖安装遵循「不静默执行」：缺 node_modules 时明确提示，用户点「准备依赖」才执行，
 * 进度以日志流形式展示、可取消；结果经 ai:mcp-event 推送回这里。
 */

type Reason = 'stopped' | 'timeout'

interface Props {
  open: boolean
  onClose: () => void
  /** 可选的绑定目标（Skills 面板里已列出的全部技能） */
  skills: AISkillInfo[]
}

interface Draft {
  id?: string
  name: string
  command: string
  args: string
  cwd: string
  env: string
  skillKey: string
  enabled: boolean
}

const emptyDraft = (): Draft => ({ name: '', command: 'node', args: '', cwd: '', env: '', skillKey: '', enabled: true })

function envToText(env: Record<string, string> | undefined): string {
  return Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join('\n')
}

function textToEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i <= 0) continue
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  }
  return out
}

/** 复制自技能文档「兜底路径」的示例：tech-agent-skill 的 MCP 服务 */
const EXAMPLE_JSON = JSON.stringify({
  mcpServers: {
    'Tech-agent-mcp': {
      command: 'node',
      args: ['src/index.js'],
      cwd: '%APPDATA%\\mc-material-query\\skills\\tech-agent-skill\\runtime\\mcp-dingtalk-v1-template',
      env: {
        DINGDING_CONFIG_PATH: '%APPDATA%\\mc-material-query\\skills\\tech-agent-skill\\templates\\config.tech-agent.json'
      }
    }
  }
}, null, 2)

export function McpModal({ open, onClose, skills }: Props): React.ReactElement | null {
  const t = useStore(s => s.t)
  const lang = useStore(s => s.lang)
  const [servers, setServers] = useState<McpServerConfig[]>([])
  const [statuses, setStatuses] = useState<Record<string, McpStatus>>({})
  const [logs, setLogs] = useState<{ id: string; lines: string[] }>({ id: '', lines: [] })
  const [installing, setInstalling] = useState<string | null>(null)
  const [testBusy, setTestBusy] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [importText, setImportText] = useState('')
  const [notice, setNotice] = useState('')

  const refresh = useCallback(async () => {
    try {
      const [list, sts] = await Promise.all([
        window.mcApi.ai.mcpList() as Promise<McpServerConfig[]>,
        window.mcApi.ai.mcpStatus() as Promise<McpStatus[]>
      ])
      setServers(list || [])
      const map: Record<string, McpStatus> = {}
      for (const s of sts || []) map[s.id] = s
      setStatuses(map)
    } catch { /* 主进程不可达时保持现状 */ }
  }, [])

  // 打开时拉一次；MCP 事件（状态变化 / 安装日志）实时增量更新
  useEffect(() => {
    if (!open) return
    void refresh()
    return window.mcApi.ai.onMcpEvent((event: any) => {
      if (event?.type === 'status') {
        setStatuses(prev => ({ ...prev, [event.id]: event.status }))
      } else if (event?.type === 'install-log') {
        setLogs(prev => (prev.id === event.id
          ? { id: event.id, lines: [...prev.lines, event.line].slice(-200) }
          : { id: event.id, lines: [event.line] }))
      } else if (event?.type === 'install-done') {
        setLogs(prev => (prev.id === event.id
          ? { id: event.id, lines: [...prev.lines, event.ok ? '✔ 依赖安装完成' : `✘ ${event.error || '安装失败'}`] }
          : prev))
        setInstalling(prev => (prev === event.id ? null : prev))
        void refresh()
      }
    })
  }, [open, refresh])

  const skillName = useCallback((key: string) => {
    if (!key) return t('mcpBoundNone')
    const s = skills.find(x => skillKey(x) === key)
    return s ? s.name : key
  }, [skills, t])

  const stateBadge = useCallback((st: McpStatus | undefined) => {
    if (!st || st.state === 'stopped') return { cls: 'off', text: t('mcpStateStopped') }
    if (st.state === 'connecting') return { cls: 'wait', text: t('mcpStateConnecting') }
    if (st.state === 'connected') return { cls: 'on', text: t('mcpStateConnected', { n: st.toolCount }) }
    return { cls: 'err', text: t('mcpStateFailed') }
  }, [t])

  const startEdit = (s?: McpServerConfig) => {
    setNotice('')
    setDraft(s
      ? {
          id: s.id, name: s.name, command: s.command,
          args: (s.args || []).join(' '), cwd: s.cwd || '',
          env: envToText(s.env), skillKey: s.skillKey || '', enabled: s.enabled !== false
        }
      : emptyDraft())
  }

  const saveDraft = async () => {
    if (!draft) return
    if (!draft.name.trim() || !draft.command.trim()) { setNotice(t('mcpErrRequired')); return }
    const res: any = await window.mcApi.ai.mcpSave({
      id: draft.id,
      name: draft.name.trim(),
      command: draft.command.trim(),
      args: draft.args.trim() ? draft.args.trim().split(/\s+/) : [],
      cwd: draft.cwd.trim(),
      env: textToEnv(draft.env),
      skillKey: draft.skillKey,
      enabled: draft.enabled
    })
    setDraft(null)
    setNotice(res?.id ? t('mcpSaved') : t('aiRequestFailed'))
    void refresh()
  }

  const doImport = async () => {
    if (!importText.trim()) { setNotice(t('mcpErrRequired')); return }
    const res: any = await window.mcApi.ai.mcpImportJson(importText, draft?.skillKey || '')
    setNotice(res?.ok ? (res.message || t('mcpImportOk')) : (res?.message || t('aiRequestFailed')))
    if (res?.ok) { setImportText(''); void refresh() }
  }

  const doTest = async (id: string) => {
    setTestBusy(id)
    setNotice('')
    try {
      const r: any = await window.mcApi.ai.mcpTest(id)
      const s = servers.find(x => x.id === id)
      if (r?.ok) setNotice(t('mcpTestOk', { n: r.toolCount, list: (r.tools || []).join(', ') || '-' }))
      else if (r?.needsInstall) setNotice(t('mcpTestNeedInstall'))
      else setNotice(`${s?.name || id}：${r?.error || t('aiRequestFailed')}`)
      void refresh()
    } finally { setTestBusy(null) }
  }

  const doPrepare = async (id: string) => {
    setInstalling(id)
    setLogs({ id, lines: [] })
    setNotice('')
    const r: any = await window.mcApi.ai.mcpPrepare(id)
    if (!r?.ok) { setInstalling(null); setNotice(r?.error || t('aiRequestFailed')) }
  }

  const doDelete = async (id: string) => {
    const s = servers.find(x => x.id === id)
    const ok = await window.mcApi.showConfirm({
      message: t('mcpConfirmDelete', { name: s?.name || id }),
      lang
    })
    if (!ok) return
    await window.mcApi.ai.mcpDelete(id)
    void refresh()
  }

  if (!open) return null

  const st = (id: string): McpStatus | undefined => statuses[id]

  return (
    <div className="ai-prompt-modal-overlay" onClick={onClose}>
      <div className="ai-prompt-modal ai-mcp-modal" onClick={e => e.stopPropagation()}>
        <div className="ai-prompt-modal-head">{t('mcpTitle')}</div>
        <div className="ai-prompt-modal-body">
          {/* ── 服务列表 ── */}
          {!servers.length && <div className="ai-skill-empty">{t('mcpEmpty')}</div>}
          {servers.map(s => {
            const badge = stateBadge(st(s.id))
            const dep = st(s.id)?.needsInstall
            return (
              <div key={s.id} className="ai-mcp-item">
                <div className="ai-mcp-item__head">
                  <label className="ai-mcp-item__check" title={t('mcpEnabledTip')}>
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      onChange={async e => {
                        await window.mcApi.ai.mcpSetEnabled(s.id, e.target.checked)
                        void refresh()
                      }}
                    />
                  </label>
                  <span className={`ai-mcp-badge ai-mcp-badge--${badge.cls}`}>{badge.text}</span>
                  <span className="ai-mcp-item__name">{s.name}</span>
                </div>
                <div className="ai-mcp-item__meta">
                  {t('mcpBoundTo')}：{skillName(s.skillKey)} · {s.command} {(s.args || []).join(' ')}
                </div>
                {dep && <div className="ai-mcp-item__warn">{t('mcpNeedInstall')}</div>}
                {st(s.id)?.state === 'failed' && (
                  <div className="ai-mcp-item__warn">{st(s.id)?.error || ''}</div>
                )}
                <div className="ai-mcp-item__ops">
                  <Button size="small" ghost onClick={() => void doTest(s.id)} disabled={testBusy === s.id}>
                    {testBusy === s.id ? t('mcpTesting') : t('mcpTest')}
                  </Button>
                  <Button size="small" ghost onClick={() => void doPrepare(s.id)} disabled={installing === s.id}>
                    {installing === s.id ? t('mcpPreparing') : t('mcpPrepare')}
                  </Button>
                  <Button size="small" ghost onClick={() => void window.mcApi.ai.mcpOpenLog(s.id)}>{t('mcpLogs')}</Button>
                  <Button size="small" ghost onClick={() => startEdit(s)}>{t('edit')}</Button>
                  <Button size="small" ghost danger onClick={() => void doDelete(s.id)}>{t('mcpDelete')}</Button>
                </div>
              </div>
            )
          })}

          {/* ── 安装日志流 ── */}
          {installing && (
            <div className="ai-mcp-log">
              <div className="ai-mcp-log__head">
                {t('mcpInstalling')}
                <button className="ai-mcp-log__cancel" onClick={() => void window.mcApi.ai.mcpCancelPrepare(installing)}>
                  {t('mcpCancel')}
                </button>
              </div>
              <pre className="ai-mcp-log__body">{(logs.id === installing ? logs.lines : []).join('\n')}</pre>
            </div>
          )}

          {/* ── 添加 / 编辑 ── */}
          <div className="ai-mcp-form">
            <div className="ai-mcp-form__head">
              {draft?.id ? t('mcpEdit') : t('mcpAdd')}
              {!draft && <Button size="small" ghost onClick={() => startEdit()}>{t('mcpAddBtn')}</Button>}
            </div>
            {draft && (
              <>
                <label className="ai-mcp-field">
                  <span>{t('mcpFieldName')}</span>
                  <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="Tech-agent-mcp" />
                </label>
                <label className="ai-mcp-field">
                  <span>{t('mcpFieldCommand')}</span>
                  <input value={draft.command} onChange={e => setDraft({ ...draft, command: e.target.value })} placeholder="node" />
                </label>
                <label className="ai-mcp-field">
                  <span>{t('mcpFieldArgs')}</span>
                  <input value={draft.args} onChange={e => setDraft({ ...draft, args: e.target.value })} placeholder="src/index.js" />
                </label>
                <label className="ai-mcp-field">
                  <span>{t('mcpFieldCwd')}</span>
                  <div className="ai-mcp-field__row">
                    <input value={draft.cwd} onChange={e => setDraft({ ...draft, cwd: e.target.value })} />
                    <Button size="small" ghost onClick={async () => {
                      const r: any = await window.mcApi.ai.mcpSelectDir()
                      if (r?.ok && r.cwd) setDraft(d => (d ? { ...d, cwd: r.cwd } : d))
                    }}>{t('mcpPickDir')}</Button>
                  </div>
                </label>
                <label className="ai-mcp-field">
                  <span>{t('mcpFieldEnv')}</span>
                  <textarea
                    rows={3}
                    value={draft.env}
                    onChange={e => setDraft({ ...draft, env: e.target.value })}
                    placeholder={'DINGDING_CONFIG_PATH=...\\config.tech-agent.json'}
                  />
                </label>
                <label className="ai-mcp-field">
                  <span>{t('mcpFieldSkill')}</span>
                  <select value={draft.skillKey} onChange={e => setDraft({ ...draft, skillKey: e.target.value })}>
                    <option value="">{t('mcpBoundNone')}</option>
                    {skills.map(s => (
                      <option key={skillKey(s)} value={skillKey(s)}>
                        {s.name}（{s.source === 'user' ? t('aiSkillUser') : t('aiSkillBuiltin')}）
                      </option>
                    ))}
                  </select>
                </label>
                <label className="ai-mcp-field ai-mcp-field--check">
                  <input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />
                  <span>{t('mcpEnabled')}</span>
                </label>
                <div className="ai-mcp-form__ops">
                  <Button size="small" type="primary" onClick={() => void saveDraft()}>{t('mcpSave')}</Button>
                  <Button size="small" ghost onClick={() => setDraft(null)}>{t('mcpCancelEdit')}</Button>
                </div>
              </>
            )}
          </div>

          {/* ── 粘贴 JSON 导入（技能文档「兜底路径」的写法）── */}
          <div className="ai-mcp-form">
            <div className="ai-mcp-form__head">{t('mcpImportTitle')}</div>
            <textarea
              className="ai-mcp-json"
              rows={5}
              value={importText}
              onChange={e => setImportText(e.target.value)}
              placeholder={EXAMPLE_JSON}
            />
            <div className="ai-mcp-form__ops">
              <Button size="small" ghost onClick={() => void doImport()} disabled={!importText.trim()}>{t('mcpImport')}</Button>
              <button className="ai-mcp-example" onClick={() => setImportText(EXAMPLE_JSON)}>{t('mcpUseExample')}</button>
            </div>
          </div>

          {notice && <div className="ai-mcp-notice">{notice}</div>}
          <div className="ai-mcp-hint">{t('mcpHint')}</div>
        </div>
        <div className="ai-prompt-modal-foot">
          <Button onClick={onClose}>{t('mcpClose')}</Button>
        </div>
      </div>
    </div>
  )
}
