import { create } from 'zustand'
import { I18N, Lang, translate } from '@shared/i18n'
import {
  buildSearchUrl, buildItemNoUrl, buildBatchUrl, buildBomUrl, buildFileUrl, normalizeRows,
  parseBatchItemNos, mergeBatchResults, applyMaterialFilter, applyBomFilter,
  getDedupedData, sortRows, fixLinks, toCSV
} from '@shared/query'
import { OA_ORIGIN, STATUS_CLS } from '@shared/constants'
import type { MaterialRow } from '@shared/types'

export type Tab = 'mat' | 'bom' | 'file'

interface Field { id: string; val: string }

interface State {
  lang: Lang
  loggedIn: boolean
  checkingLogin: boolean
  // SSO 落地中（扫码成功 -> OA 会话建立完成）。期间渲染全屏 Loading 覆盖层，用户看不到 OA 页面
  landing: boolean
  // 登录阶段状态：checking(检测令牌) | logging(登录中) | failed(失败)
  loginState: 'checking' | 'logging' | 'failed' | 'ok'
  // 基础输入
  itemNo: string
  fields: Field[]
  batchText: string
  // 结果
  allData: MaterialRow[]
  filtered: MaterialRow[]
  bomData: MaterialRow[]
  bomFiltered: MaterialRow[]
  fileData: MaterialRow[]
  // 批量未命中（FR-2）
  notFound: string[]
  // 过滤 / 排序 / 去重
  kw: string
  kwNot: string
  typeFilter: string
  selectedStatuses: string[]
  dedup: boolean
  sortKey: string
  sortAsc: boolean
  bomKw: string
  bomKwNot: string
  bomSortKey: string
  bomSortAsc: boolean
  // UI
  activeTab: Tab
  loading: boolean
  error: string
  batchMsg: string
  hiddenCols: string[]
  updateInfo: { hasUpdate: boolean; version?: string; downloaded?: boolean; notes?: string; checking: boolean; latest?: boolean; downloading?: boolean; progress?: number; error?: string }
  appVersion: string
  // 行展开状态持久化到 store：切换 tab 时不丢失展开行与按钮点击事件
  matExpandedKeys: Set<string>
  bomExpandedKeys: Set<number>

  // actions
  t: (key: string, vars?: Record<string, string | number>) => string
  setLang: (l: Lang) => void
  setLoggedIn: (v: boolean) => void
  setCheckingLogin: (v: boolean) => void
  setLanding: (v: boolean) => void

  setItemNo: (v: string) => void
  addField: () => void
  removeField: (id: string) => void
  setFieldVal: (id: string, v: string) => void
  reorderField: (from: number, to: number) => void
  setBatchText: (v: string) => void

  searchMaterial: () => Promise<void>
  searchByItemNo: () => Promise<void>
  batchSearch: () => Promise<void>
  searchBom: (preset?: string) => Promise<void>
  searchFile: (preset?: string) => Promise<void>

  toggleMatExpanded: (k: string) => void
  toggleBomExpanded: (k: number) => void

  setKw: (v: string) => void
  setKwNot: (v: string) => void
  setTypeFilter: (v: string) => void
  toggleStatus: (s: string) => void
  clearStatus: () => void
  toggleDedup: () => void
  sortBy: (k: string) => void

  setBomKw: (v: string) => void
  setBomKwNot: (v: string) => void
  bomSortBy: (k: string) => void

  setActiveTab: (t: Tab) => void
  toggleCol: (k: string) => void
  setError: (m: string) => void
  setUpdateInfo: (p: Partial<State['updateInfo']>) => void
  reset: () => void

  exportMatCSV: () => void
  exportBomCSV: () => void

  clearLogin: () => void
  checkUpdate: () => Promise<void>
  startDownload: () => Promise<void>
  reLogin: () => void

  // 内部辅助
  applyFilterInternal: () => void
}

const STATUS_CLS_MAP = STATUS_CLS

// 通过主进程代理 HTTP 请求（自动带上 partition Cookie）
async function fetchJSON(url: string, _retry = true): Promise<any> {
  try {
    return await window.mcApi.fetchOA(url)
  } catch (err: any) {
    // OA 接口要求重新走 SSO 认证（cookie 触发 302 reauth）时：
    // 先尝试让主进程自动预热一次 OA 会话并重试，避免误打扰用户重新登录；
    // 仅当重试仍失败才拉起重新登录界面。
    if (err?.message === 'NEED_RELOGIN' && _retry) {
      try {
        // 触发主进程重新预热 OA 会话（authnEngine + portal 落地 + 探测）
        window.mcApi.refreshOaSession && await window.mcApi.refreshOaSession()
      } catch {}
      return window.mcApi.fetchOA(url).catch((err2: any) => {
        if (err2?.message === 'NEED_RELOGIN') {
          try { useStore.getState().reLogin() } catch {}
          throw new Error('会话已失效，请重新登录')
        }
        throw err2
      })
    }
    if (err?.message === 'NEED_RELOGIN') {
      try { useStore.getState().reLogin() } catch {}
      throw new Error('会话已失效，请重新登录')
    }
    throw err
  }
}

export const useStore = create<State>((set, get) => ({
  lang: (localStorage.getItem('mc-lang') as Lang) || 'zh',
  loggedIn: false,
  checkingLogin: true,
  landing: false,
  loginState: 'checking',
  itemNo: '',
  fields: [{ id: 'f1', val: '' }, { id: 'f2', val: '' }, { id: 'f3', val: '' }],
  batchText: '',
  allData: [], filtered: [], bomData: [], bomFiltered: [], fileData: [], notFound: [],
  kw: '', kwNot: '', typeFilter: '', selectedStatuses: [], dedup: false,
  sortKey: '', sortAsc: true, bomKw: '', bomKwNot: '', bomSortKey: '', bomSortAsc: true,
  activeTab: 'mat', loading: false, error: '', batchMsg: '',
  hiddenCols: (() => { try { return JSON.parse(localStorage.getItem('mc-hidden-cols') || '[]') } catch { return [] } })(),
  updateInfo: { hasUpdate: false, checking: false },
  matExpandedKeys: new Set(),
  bomExpandedKeys: new Set(),
  // 软件版本号：从主进程 app.getVersion() 实时读取，保持与 package.json 一致
  appVersion: (() => { try { return window.mcApi.appVersion() } catch { return '1.0.9' } })(),

  t: (key, vars) => translate(get().lang, key, vars),
  setLang: (l) => { localStorage.setItem('mc-lang', l); set({ lang: l }) },
  setLoggedIn: (v) => set({ loggedIn: v }),
  setCheckingLogin: (v) => set({ checkingLogin: v }),
  setLanding: (v) => set({ landing: v }),
  setLoginState: (v) => set({ loginState: v }),

  setItemNo: (v) => set({ itemNo: v }),
  addField: () => set(s => ({ fields: [...s.fields, { id: 'f' + Date.now(), val: '' }] })),
  removeField: (id) => set(s => ({ fields: s.fields.length <= 1 ? s.fields : s.fields.filter(f => f.id !== id) })),
  setFieldVal: (id, v) => set(s => ({ fields: s.fields.map(f => f.id === id ? { ...f, val: v } : f) })),
  reorderField: (from, to) => set(s => {
    const arr = [...s.fields]
    const [moved] = arr.splice(from, 1)
    arr.splice(to, 0, moved)
    return { fields: arr }
  }),
  setBatchText: (v) => set({ batchText: v }),

  applyFilterInternal: (dedupOverride?: boolean) => {
    const s = get()
    const dedup = typeof dedupOverride === 'boolean' ? dedupOverride : s.dedup
    const deduped = getDedupedData(s.allData, dedup)
    let filtered = applyMaterialFilter(deduped, {
      include: s.kw, exclude: s.kwNot, type: s.typeFilter,
      statuses: new Set(s.selectedStatuses)
    })
    if (s.sortKey) {
      const numeric = s.sortKey === 'ON_HAND_QTY'
      filtered = sortRows(filtered, s.sortKey, s.sortAsc, numeric) as MaterialRow[]
    }
    set({ filtered })
  },

  // V1.0.6：搜索条件（描述关键词）不再拼接料号 ITEM_NUMBER，仅按描述查询
  searchMaterial: async () => {
    const s = get()
    const descQ = s.fields.map(f => f.val.trim()).filter(Boolean).join(' && ')
    if (!descQ) { set({ error: s.t('errNoInput') }); return }
    set({ loading: true, error: '' })
    try {
      const url = buildSearchUrl(descQ)
      const json = await fetchJSON(url)
      const rows = normalizeRows(json)
      set({ allData: rows, selectedStatuses: [], matExpandedKeys: new Set() })
      get().applyFilterInternal()
      set({ activeTab: 'mat' })
    } catch (e: any) {
      set({ error: s.t('errSearch', { m: e.message }) })
    } finally { set({ loading: false }) }
  },

  // V1.0.6：查料号改为独立查询，仅按料号 ITEM_NUMBER 查询，不与描述条件拼接
  searchByItemNo: async () => {
    const s = get()
    const no = s.itemNo.trim()
    if (!no) { set({ error: s.t('errNoInput') }); return }
    set({ loading: true, error: '' })
    try {
      const url = buildItemNoUrl(no)
      const json = await fetchJSON(url)
      const rows = normalizeRows(json)
      set({ allData: rows, selectedStatuses: [], matExpandedKeys: new Set() })
      get().applyFilterInternal()
      set({ activeTab: 'mat' })
    } catch (e: any) {
      set({ error: s.t('errSearch', { m: e.message }) })
    } finally { set({ loading: false }) }
  },

  batchSearch: async () => {
    const s = get()
    const list = parseBatchItemNos(s.batchText)
    if (!list.length) { set({ error: s.t('errNoBatch') }); return }
    set({ loading: true, error: '', batchMsg: '' })
    const results: MaterialRow[] = []
    const notFound: string[] = []
    const failed: string[] = []
    for (let i = 0; i < list.length; i++) {
      const no = list[i]
      set({ loading: true, batchMsg: s.t('searchingN', { i: i + 1, n: list.length }) })
      try {
        const json = await fetchJSON(buildBatchUrl(no, i))
        const rows = normalizeRows(json)
        const merged = mergeBatchResults(rows, no)
        if (merged.length) results.push(...merged)
        else notFound.push(no)
      } catch { failed.push(no) }
    }
    set({ allData: results, selectedStatuses: [], batchMsg: '', notFound, matExpandedKeys: new Set() })
    get().applyFilterInternal()
    set({ activeTab: 'mat', loading: false })
    const msgs: string[] = []
    if (notFound.length) msgs.push(s.t('errNotFound', { n: notFound.length, list: notFound.join('、') }))
    if (failed.length) msgs.push(s.t('errFailed', { n: failed.length, list: failed.join('、') }))
    if (msgs.length) set({ error: msgs.join('<br>') })
  },

  searchBom: async (preset, switchTab = true) => {
    const s = get()
    const no = preset || s.itemNo
    if (!no) { set({ error: s.t('errNoItemBom') }); return }
    if (preset) set({ itemNo: preset })
    set({ loading: true, error: '' })
    try {
      const json = await fetchJSON(buildBomUrl(no))
      const rows = normalizeRows(json)
      set({ bomData: rows, bomFiltered: rows, bomExpandedKeys: new Set(), ...(switchTab ? { activeTab: 'bom' } : {}) })
    } catch (e: any) { set({ error: s.t('errBomFail', { m: e.message }) }) }
    finally { set({ loading: false }) }
  },

  searchFile: async (preset, switchTab = true) => {
    const s = get()
    const no = preset || s.itemNo
    if (!no) { set({ error: s.t('errNoItemFile') }); return }
    if (preset) set({ itemNo: preset })
    set({ loading: true, error: '' })
    try {
      const json = await fetchJSON(buildFileUrl(no))
      const rows = normalizeRows(json)
      set({ fileData: rows, ...(switchTab ? { activeTab: 'file' } : {}) })
    } catch (e: any) { set({ error: s.t('errFileFail', { m: e.message }) }) }
    finally { set({ loading: false }) }
  },

  setKw: (v) => { set({ kw: v }); get().applyFilterInternal() },
  setKwNot: (v) => { set({ kwNot: v }); get().applyFilterInternal() },
  setTypeFilter: (v) => { set({ typeFilter: v }); get().applyFilterInternal() },
  toggleStatus: (st) => {
    const cur = new Set(get().selectedStatuses)
    if (cur.has(st)) cur.delete(st); else cur.add(st)
    set({ selectedStatuses: [...cur] })
    get().applyFilterInternal()
  },
  clearStatus: () => { set({ selectedStatuses: [] }); get().applyFilterInternal() },
  toggleDedup: () => {
    const s = get()
    const nextDedup = !s.dedup
    // 原子更新 dedup 状态与 filtered，避免 set 后立即 get 的竞态
    const deduped = getDedupedData(s.allData, nextDedup)
    let filtered = applyMaterialFilter(deduped, {
      include: s.kw, exclude: s.kwNot, type: s.typeFilter,
      statuses: new Set(s.selectedStatuses)
    })
    if (s.sortKey) {
      const numeric = s.sortKey === 'ON_HAND_QTY'
      filtered = sortRows(filtered, s.sortKey, s.sortAsc, numeric) as MaterialRow[]
    }
    set({ dedup: nextDedup, filtered })
  },
  sortBy: (k) => {
    const s = get()
    const asc = s.sortKey === k ? !s.sortAsc : true
    set({ sortKey: k, sortAsc: asc })
    get().applyFilterInternal()
  },

  setBomKw: (v) => {
    const s = get()
    const f = applyBomFilter(s.bomData, v, s.bomKwNot)
    let ff = f
    if (s.bomSortKey) ff = sortRows(ff, s.bomSortKey, s.bomSortAsc, s.bomSortKey === 'ON_HAND_QTY' || s.bomSortKey === 'BOM_LEVEL') as MaterialRow[]
    set({ bomKw: v, bomFiltered: ff })
  },
  setBomKwNot: (v) => {
    const s = get()
    const f = applyBomFilter(s.bomData, s.bomKw, v)
    let ff = f
    if (s.bomSortKey) ff = sortRows(ff, s.bomSortKey, s.bomSortAsc, s.bomSortKey === 'ON_HAND_QTY' || s.bomSortKey === 'BOM_LEVEL') as MaterialRow[]
    set({ bomKwNot: v, bomFiltered: ff })
  },
  bomSortBy: (k) => {
    const s = get()
    const asc = s.bomSortKey === k ? !s.bomSortAsc : true
    let ff = applyBomFilter(s.bomData, s.bomKw)
    ff = sortRows(ff, k, asc, k === 'ON_HAND_QTY' || k === 'BOM_LEVEL') as MaterialRow[]
    set({ bomSortKey: k, bomSortAsc: asc, bomFiltered: ff })
  },

  setActiveTab: (t) => set({ activeTab: t }),

  // 手风琴式展开：点击已展开行则收起，否则仅展开当前行并关闭其他行
  toggleMatExpanded: (k) => set(s => {
    if (s.matExpandedKeys.has(k)) return { matExpandedKeys: new Set() }
    return { matExpandedKeys: new Set([k]) }
  }),
  toggleBomExpanded: (k) => set(s => {
    if (s.bomExpandedKeys.has(k)) return { bomExpandedKeys: new Set() }
    return { bomExpandedKeys: new Set([k]) }
  }),

  toggleCol: (k) => set(s => {
    const next = s.hiddenCols.includes(k)
      ? s.hiddenCols.filter(c => c !== k)
      : [...s.hiddenCols, k]
    localStorage.setItem('mc-hidden-cols', JSON.stringify(next))
    return { hiddenCols: next }
  }),
  setError: (m) => set({ error: m }),
  setUpdateInfo: (p) => set(s => ({ updateInfo: { ...s.updateInfo, ...p } })),
  reset: () => set({
    itemNo: '', batchText: '', allData: [], filtered: [], bomData: [], bomFiltered: [],
    fileData: [], notFound: [], kw: '', kwNot: '', typeFilter: '', selectedStatuses: [], dedup: false,
    sortKey: '', sortAsc: true, bomKw: '', bomKwNot: '', bomSortKey: '', bomSortAsc: true,
    activeTab: 'mat', error: '', batchMsg: '', matExpandedKeys: new Set(), bomExpandedKeys: new Set(),
    fields: [{ id: 'f1', val: '' }, { id: 'f2', val: '' }, { id: 'f3', val: '' }]
  }),

  exportMatCSV: async () => {
    const s = get()
    if (!s.filtered.length) return
    try {
      const headers = s.t('csvMatHeaders') as unknown as string[]
      const keys = ['ITEM_NUMBER', 'ITEM_DESC', 'ITEM_TYPE', 'INV_STATUS_NAME', 'K3_ITEM_NUMBER', 'ON_HAND_QTY', 'DEVELOPMENT_SUB', 'TRACK_SUB', 'PRODUCT_ORDER_SUB', 'UPDATE_ORDER_SUB']
      const csv = toCSV(headers, keys, s.filtered, new Set(['ITEM_NUMBER', 'K3_ITEM_NUMBER']))
      const filePath = await window.mcApi.saveCsv(csv, `${s.t('csvMat')}_${new Date().toISOString().slice(0, 10)}.csv`)
      if (!filePath) { set({ error: '' }) }
    } catch (e: any) {
      set({ error: `CSV导出失败: ${e?.message || e}` })
    }
  },
  exportBomCSV: async () => {
    const s = get()
    if (!s.bomFiltered.length) return
    try {
      const headers = s.t('csvBomHeaders') as unknown as string[]
      const keys = ['BOM_LEVEL', 'COMPONENT_ITEM', 'COMPONENT_ITEM_DESC', 'K3_ITEM_NUMBER', 'PRIMARY_UOM_CODE', 'LOSS_RATE', 'INVERSE_QUANTITY', 'COMPONENT_REFERENCE_DESIGNATOR', 'COMPONENT_REMARKS', 'ON_HAND_QTY', 'DEVELOPMENT_SUB', 'TRACK_SUB', 'PRODUCT_ORDER_SUB', 'UPDATE_ORDER_SUB', 'SHIP_LOT_QTY']
      const csv = toCSV(headers, keys, s.bomFiltered, new Set(['COMPONENT_ITEM', 'K3_ITEM_NUMBER']))
      const filePath = await window.mcApi.saveCsv(csv, `${s.t('csvBom')}_${new Date().toISOString().slice(0, 10)}.csv`)
      if (!filePath) { set({ error: '' }) }
    } catch (e: any) {
      set({ error: `CSV导出失败: ${e?.message || e}` })
    }
  },

  clearLogin: async () => {
    try { await window.mcApi.clearLogin() } catch {}
    set({ loggedIn: false, loginState: 'logging' })
  },

  checkUpdate: async () => {
    set(s => ({ updateInfo: { ...s.updateInfo, checking: true, error: undefined, latest: false } }))
    try {
      const res: any = await window.mcApi.checkForUpdates()
      if (res?.ok && res.latest) {
        // 无可用更新 / 版本相同
        set(s => ({ updateInfo: { ...s.updateInfo, checking: false, hasUpdate: false, latest: true, version: undefined } }))
      } else if (res?.ok && res.hasUpdate) {
        // 有更新（用户已选择是否下载）
        set(s => ({
          updateInfo: {
            ...s.updateInfo,
            checking: false,
            hasUpdate: true,
            latest: false,
            version: res.version,
            downloading: res.downloading || false
          }
        }))
      } else if (!res?.ok) {
        // 手动检查失败：不把原始错误挂到 UpdateBar，由调用方弹窗提示
        set(s => ({ updateInfo: { ...s.updateInfo, checking: false } }))
      } else {
        set(s => ({ updateInfo: { ...s.updateInfo, checking: false } }))
      }
      return res
    } catch (e: any) {
      set(s => ({ updateInfo: { ...s.updateInfo, checking: false } }))
      return { ok: false, error: e?.message || String(e) }
    }
  },

  startDownload: async () => {
    // 用户点击「下载」后，通知主进程开始下载
    set(s => ({ updateInfo: { ...s.updateInfo, downloading: true, error: undefined } }))
    try {
      const res: any = await window.mcApi.startDownload()
      if (!res?.ok) {
        set(s => ({ updateInfo: { ...s.updateInfo, downloading: false, error: res?.error || 'download failed' } }))
      }
    } catch (e: any) {
      set(s => ({ updateInfo: { ...s.updateInfo, downloading: false, error: e?.message || String(e) } }))
    }
  },

  reLogin: () => {
    // 在主窗口内重新显示 OA 登录视图（webview）；同时请主进程重新检测登录态
    set({ loggedIn: false, loginState: 'logging' })
    try { window.mcApi.reloadLogin() } catch {}
  }
}))

export { STATUS_CLS_MAP }
