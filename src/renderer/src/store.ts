import { create } from 'zustand'
import type { BackgroundType } from 'animal-island-ui'
import { I18N, Lang, translate } from '@shared/i18n'
import { applyTheme, persistTheme, readStoredTheme } from './theme'
import {
  buildSearchUrl, buildItemNoUrl, buildBatchUrl, buildBomUrl, buildFileUrl, normalizeRows,
  parseBatchItemNos, mergeBatchResults, applyMaterialFilter, applyBomFilter,
  getDedupedData, sortRows, fixLinks, toCSV
} from '@shared/query'
import { OA_ORIGIN, STATUS_CLS } from '@shared/constants'
import type { MaterialRow } from '@shared/types'

export type Tab = 'mat' | 'bom' | 'file'

interface Field { id: string; val: string }

/** 查询动作标识：loading 动画只挂在当前正在执行的那个按钮上（1.0.54） */
export type BusyAction = '' | 'itemno' | 'bom' | 'file' | 'batch' | 'search'

/** 翻译功能覆盖的页面：物料结果（ITEM_DESC）/ BOM 结果（COMPONENT_ITEM_DESC） */
export type DescTransKind = 'mat' | 'bom'

/** 单页描述翻译状态（1.0.54） */
export interface DescTransState {
  /** 中文原文 → 英文译文 */
  map: Record<string, string>
  /** true 显示译文 / false 显示原文（导出 CSV 跟随此开关） */
  visible: boolean
  translating: boolean
  progress: { done: number; total: number } | null
  /** 用户已确认「取消剩余翻译」：当前批次结束后即停 */
  cancelRequested: boolean
  /** 本次翻译任务 id：取消时凭它让主进程中断在途的那一批 HTTP 请求 */
  taskId: string
}

function emptyDescTrans(): DescTransState {
  return { map: {}, visible: true, translating: false, progress: null, cancelRequested: false, taskId: '' }
}

interface State {
  lang: Lang
  loggedIn: boolean
  checkingLogin: boolean
  // SSO 落地中（扫码成功 -> OA 会话建立完成）。期间渲染全屏 Loading 覆盖层，用户看不到 OA 页面
  landing: boolean
  // 登录阶段状态：checking(检测令牌) | logging(登录中) | failed(失败)
  loginState: 'checking' | 'logging' | 'failed' | 'ok'
  // SSO 落地失败时给用户的明确提示（网络异常 / 认证失败），由主进程通过原因驱动
  loginError: string
  // 强制重新拉取二维码的序号：network 失败等场景自增，LoginOverlay 监听后自动重新拉码
  qrRefetchSeq: number
  // 1.0.34：OA 会话已失效（查询被 901 拒绝且自动自愈与重试均失败）。
  // 驱动顶部「登录失效」提示条——历史缺陷是 store.error 无任何组件消费，
  // 查询失败只写进 error、界面上一个字都不显示，用户以为点了没反应。
  // 登录成功时清除（见 App.tsx 的 onLoginChecked / onLoginReady）。
  sessionExpired: boolean
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
  // 1.0.54：物料描述 AI 译文（「翻译物料描述」）。按页面分两套（物料结果 / BOM 结果），
  // 键是**中文原文**、值是英文译文 —— 按原文键存储而不是行下标，重新查询 / 排序 / 筛选后
  // 同一条描述仍能命中译文；分批翻译时已译过的自动跳过（增量翻译）。
  // - visible：当前显示译文还是原文（「显示原文 / 显示译文」切换，导出 CSV 跟随显隐）
  // - translating / progress：翻译中与 n/m 进度（按钮 loading 文案）
  // - cancelRequested：用户点了「取消剩余翻译」，当前批次跑完后不再发起新批次
  descTrans: Record<DescTransKind, DescTransState>
  // UI
  activeTab: Tab
  loading: boolean
  // 当前正在执行的查询动作（''=无）。查询按钮的 loading 动画只显示在**被点击的那个按钮**上，
  // 而不是任一查询进行时全部转圈（1.0.54 用户反馈）。
  busyAction: BusyAction
  error: string
  batchMsg: string
  hiddenCols: string[]
  // 主题：字符串存 localStorage（与 mc-lang / mc-hidden-cols 同构）。
  // 不走主进程 prefs —— 那条通道是布尔专用（setSetting(key, boolean) + !!v），
  // 且 getAppPrefs() 是异步的，用它必然导致首屏先渲染默认主题再切肤。
  theme: BackgroundType
  updateInfo: { hasUpdate: boolean; version?: string; downloaded?: boolean; notes?: string; checking: boolean; latest?: boolean; downloading?: boolean; progress?: number; error?: string }
  appVersion: string
  // 行展开状态持久化到 store：切换 tab 时不丢失展开行与按钮点击事件
  matExpandedKeys: Set<string>
  bomExpandedKeys: Set<number>
  // 1.0.51：AI 回复里的大图预览（点开大图）。
  // 为什么放 store 而不是组件内部 state：触发方是**每条消息内部**的 markdown <img>，
  // 而预览层要**全局面板只挂一个**（历史消息很多，逐条挂 Modal 会让 DOM 节点膨胀）。
  // 用 store 串起「气泡内 img → 顶层预览层」，且 zustand 的 action 引用在 set 时不变，
  // 可以安全地被 memo 包裹的 MarkdownImg 依赖（不会打穿 MessageItem 的记忆化）。
  //
  // 1.0.51 追加：`srcs` 是**当前这条消息里的全部图片**，用于「上一张 / 下一张」切换；
  // `index` 是当前查看的那一张。之前是全屏 Modal，会把对话整个遮住 ——
  // 看图时无法继续滚动阅读上下文，用户要求改成右侧分栏。
  imgPreview: { srcs: string[]; index: number; alt?: string } | null

  // actions
  t: (key: string, vars?: Record<string, string | number>) => string
  setLang: (l: Lang) => void
  setTheme: (id: BackgroundType) => void
  setLoggedIn: (v: boolean) => void
  setCheckingLogin: (v: boolean) => void
  setLanding: (v: boolean) => void
  // 这三个 setter 之前只在实现里写了、接口里漏声明，
  // 导致实现侧参数拿不到上下文类型（隐式 any），消费侧 useStore(s => s.setLoginState) 报「属性不存在」。
  setLoginState: (v: 'checking' | 'logging' | 'failed' | 'ok') => void
  setLoginError: (v: string) => void
  setQrRefetchSeq: (v: number) => void
  setSessionExpired: (v: boolean) => void

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
  // 1.0.51：AI 回复大图预览的开关（见 imgPreview 字段的说明）
  openImgPreview: (p: { srcs: string[]; index: number; alt?: string }) => void
  closeImgPreview: () => void
  /** 在当前预览的图片列表里切换（delta = ±1，自动环绕） */
  stepImgPreview: (delta: number) => void

  setActiveTab: (t: Tab) => void
  toggleCol: (k: string) => void
  setError: (m: string) => void
  setUpdateInfo: (p: Partial<State['updateInfo']>) => void
  reset: () => void

  exportMatCSV: () => void
  exportBomCSV: () => void
  /**
   * 「翻译物料描述」：用 AI 助手里配置的供应商把当前结果集的中文描述译成英文
   * （分批、带进度；翻译中再次调用 = 弹确认取消剩余批次）。
   */
  translateDescs: (kind: DescTransKind) => Promise<void>
  /** 「显示原文 / 显示译文」切换（导出 CSV 跟随显隐） */
  toggleDescVisible: (kind: DescTransKind) => void

  clearLogin: () => void
  checkUpdate: () => Promise<void>
  startDownload: () => Promise<void>
  reLogin: () => void

  // 内部辅助
  applyFilterInternal: () => void
  /** 按当前 bomKw / bomKwNot / bomSortKey 从 bomData 重算 bomFiltered（各入口共用） */
  recomputeBomFiltered: () => void
}

const STATUS_CLS_MAP = STATUS_CLS

/** 每个翻译页面要替换的描述字段：物料结果 → ITEM_DESC；BOM 结果 → 组件描述 */
const DESC_FIELD: Record<DescTransKind, string> = {
  mat: 'ITEM_DESC',
  bom: 'COMPONENT_ITEM_DESC'
}

/** 按译文缓存替换指定描述列（仅当该页处于「显示译文」时）；未翻译的行保持中文原值。
 *  只换字段值，列序 / 表头 / 其他字段原样不动；译文按「中文原文」为键，错行不会错位。 */
function applyDescTrans(rows: any[], st: DescTransState, field: string): any[] {
  if (!st.visible || !Object.keys(st.map).length) return rows
  return rows.map((r: any) => {
    const zh = String(r[field] ?? '')
    const en = st.map[zh]
    return en ? { ...r, [field]: en } : r
  })
}

/** 当前结果集里尚未翻译的描述（去重、保序）—— 已译过的按原文键跳过，支持增量续翻 */
function pendingDescs(rows: any[], st: DescTransState, field: string): string[] {
  return Array.from(new Set(
    (rows || []).map((r: any) => String(r[field] ?? '').trim()).filter(Boolean)
  )).filter(d => !st.map[d])
}

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
          // 1.0.34：自愈（refreshOaSession）与重试都失败，标记失效以显示顶部提示条
          try { useStore.getState().setSessionExpired(true) } catch {}
          try { useStore.getState().reLogin() } catch {}
          throw new Error('会话已失效，请重新登录')
        }
        throw err2
      })
    }
    if (err?.message === 'NEED_RELOGIN') {
      try { useStore.getState().setSessionExpired(true) } catch {}
      try { useStore.getState().reLogin() } catch {}
      throw new Error('会话已失效，请重新登录')
    }
    throw err
  }
}

// t 必须是「随语言变化而换新引用」的函数：zustand 的选择器靠引用比较决定是否重渲染，
// 若 t 永远是同一个闭包，useStore(s => s.t) 的组件在切换语言时不会重渲染，
// 表现为「切了语言但界面还是旧文案，要切个页面才刷新」。
const initialLang: Lang = (localStorage.getItem('mc-lang') as Lang) || 'zh'
const makeT = (lang: Lang) => (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars)

/**
 * 关键词 / 类型筛选的「停止输入后再算」（1.0.42 性能优化）。
 *
 * 这三个输入框原先每按一个键就同步跑一次全量过滤：过滤本身是 O(结果集行数)，
 * 更贵的是它会让 `filtered` 换引用 → 整张表（结果集行数量级的 DOM）重渲染。
 * 连续打字时这笔开销每键一次，输入框会明显发木。
 * 现改为：输入框自身的值（kw / kwNot / typeFilter）仍然即时写入 store（手感不变），
 * 只把「重算 filtered」推迟到停止输入 120ms 之后。
 */
let filterDebounceTimer: number | null = null
function scheduleFilter(run: () => void): void {
  if (filterDebounceTimer !== null) window.clearTimeout(filterDebounceTimer)
  filterDebounceTimer = window.setTimeout(() => {
    filterDebounceTimer = null
    run()
  }, 120)
}
/** 把尚未执行的那次过滤立刻跑完（导出这类「按当前结果集取数」的动作前调用，避免拿到旧结果）。 */
function flushPendingFilter(): void {
  if (filterDebounceTimer === null) return
  window.clearTimeout(filterDebounceTimer)
  filterDebounceTimer = null
  useStore.getState().applyFilterInternal()
}

export const useStore = create<State>((set, get) => ({
  lang: initialLang,
  theme: readStoredTheme(),
  loggedIn: false,
  checkingLogin: true,
  landing: false,
  loginState: 'checking',
  loginError: '',
  qrRefetchSeq: 0,
  sessionExpired: false,
  itemNo: '',
  fields: [{ id: 'f1', val: '' }, { id: 'f2', val: '' }, { id: 'f3', val: '' }],
  batchText: '',
  allData: [], filtered: [], bomData: [], bomFiltered: [], fileData: [], notFound: [],
  kw: '', kwNot: '', typeFilter: '', selectedStatuses: [], dedup: false,
  sortKey: '', sortAsc: true, bomKw: '', bomKwNot: '', bomSortKey: '', bomSortAsc: true,
  descTrans: { mat: emptyDescTrans(), bom: emptyDescTrans() },
  activeTab: 'mat', loading: false, busyAction: '', error: '', batchMsg: '',
  hiddenCols: (() => { try { return JSON.parse(localStorage.getItem('mc-hidden-cols') || '[]') } catch { return [] } })(),
  updateInfo: { hasUpdate: false, checking: false },
  matExpandedKeys: new Set(),
  bomExpandedKeys: new Set(),
  // 1.0.51：AI 回复大图预览（null = 未打开）
  imgPreview: null,
  // 软件版本号：从主进程 app.getVersion() 实时读取，保持与 package.json 一致
  appVersion: (() => { try { return window.mcApi.appVersion() } catch { return '1.0.10' } })(),

  t: makeT(initialLang),
  setLang: (l) => {
    localStorage.setItem('mc-lang', l)
    set({ lang: l, t: makeT(l) })
    // 同步给主进程：原生弹窗（showMessageBox）的按钮与标题跟随界面语言
    try { window.mcApi.setUiLang(l) } catch { /* 忽略 */ }
  },
  setTheme: (id) => {
    // 先落 DOM 再落存储：写属性让换肤即时生效，存储失败也仅影响「下次启动的记忆」，
    // 不影响本次会话，符合 localStorage 可能被禁用的兜底预期。
    applyTheme(id)
    persistTheme(id)
    set({ theme: id })
  },
  setLoggedIn: (v) => set({ loggedIn: v }),
  setCheckingLogin: (v) => set({ checkingLogin: v }),
  setLanding: (v) => set({ landing: v }),
  setLoginState: (v) => set({ loginState: v }),
  setLoginError: (v) => set({ loginError: v }),
  setQrRefetchSeq: (v) => set({ qrRefetchSeq: v }),
  setSessionExpired: (v) => set({ sessionExpired: v }),

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

  // BOM 筛选重算：bomKw / bomKwNot → applyBomFilter → bomSortKey 排序。
  // searchBom / setBomKw / setBomKwNot / bomSortBy 全部走这一个函数，
  // 保证「换料号重新查 BOM 后，已输入的关键词/排除词/排序立即作用于新结果集」
  // （此前 searchBom 直接 bomFiltered: rows 透传，旧关键词对新结果不生效，
  // 用户必须删掉再输一遍才触发过滤）。
  recomputeBomFiltered: () => {
    const s = get()
    let ff = applyBomFilter(s.bomData, s.bomKw, s.bomKwNot)
    if (s.bomSortKey) {
      const numeric = s.bomSortKey === 'ON_HAND_QTY' || s.bomSortKey === 'BOM_LEVEL'
      ff = sortRows(ff, s.bomSortKey, s.bomSortAsc, numeric) as MaterialRow[]
    }
    set({ bomFiltered: ff })
  },

  // V1.0.6：搜索条件（描述关键词）不再拼接料号 ITEM_NUMBER，仅按描述查询
  searchMaterial: async () => {
    const s = get()
    const descQ = s.fields.map(f => f.val.trim()).filter(Boolean).join(' && ')
    if (!descQ) { set({ error: s.t('errNoInput') }); return }
    set({ loading: true, busyAction: 'search', error: '' })
    try {
      const url = buildSearchUrl(descQ)
      const json = await fetchJSON(url)
      const rows = normalizeRows(json)
      set({ allData: rows, selectedStatuses: [], matExpandedKeys: new Set() })
      get().applyFilterInternal()
      set({ activeTab: 'mat' })
    } catch (e: any) {
      set({ error: s.t('errSearch', { m: e.message }) })
    } finally { set({ loading: false, busyAction: '' }) }
  },

  // V1.0.6：查料号改为独立查询，仅按料号 ITEM_NUMBER 查询，不与描述条件拼接
  searchByItemNo: async () => {
    const s = get()
    const no = s.itemNo.trim()
    if (!no) { set({ error: s.t('errNoInput') }); return }
    set({ loading: true, busyAction: 'itemno', error: '' })
    try {
      const url = buildItemNoUrl(no)
      const json = await fetchJSON(url)
      const rows = normalizeRows(json)
      set({ allData: rows, selectedStatuses: [], matExpandedKeys: new Set() })
      get().applyFilterInternal()
      set({ activeTab: 'mat' })
    } catch (e: any) {
      set({ error: s.t('errSearch', { m: e.message }) })
    } finally { set({ loading: false, busyAction: '' }) }
  },

  batchSearch: async () => {
    const s = get()
    const list = parseBatchItemNos(s.batchText)
    if (!list.length) { set({ error: s.t('errNoBatch') }); return }
    set({ loading: true, busyAction: 'batch', error: '', batchMsg: '' })
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
    set({ activeTab: 'mat', loading: false, busyAction: '' })
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
    set({ loading: true, busyAction: 'bom', error: '' })
    try {
      const json = await fetchJSON(buildBomUrl(no))
      const rows = normalizeRows(json)
      // 先落 bomData，再按当前 bomKw/bomKwNot/排序重算 bomFiltered：
      // 换料号重查后筛选条件继续生效，不需要用户删掉关键词再输一遍
      set({ bomData: rows, bomExpandedKeys: new Set(), ...(switchTab ? { activeTab: 'bom' } : {}) })
      get().recomputeBomFiltered()
    } catch (e: any) { set({ error: s.t('errBomFail', { m: e.message }) }) }
    finally { set({ loading: false, busyAction: '' }) }
  },

  searchFile: async (preset, switchTab = true) => {
    const s = get()
    const no = preset || s.itemNo
    if (!no) { set({ error: s.t('errNoItemFile') }); return }
    if (preset) set({ itemNo: preset })
    set({ loading: true, busyAction: 'file', error: '' })
    try {
      const json = await fetchJSON(buildFileUrl(no))
      const rows = normalizeRows(json)
      set({ fileData: rows, ...(switchTab ? { activeTab: 'file' } : {}) })
    } catch (e: any) { set({ error: s.t('errFileFail', { m: e.message }) }) }
    finally { set({ loading: false, busyAction: '' }) }
  },

  // 三个筛选输入走防抖（见 scheduleFilter）：值即时更新，重算 filtered 延后到停止输入。
  setKw: (v) => { set({ kw: v }); scheduleFilter(() => get().applyFilterInternal()) },
  setKwNot: (v) => { set({ kwNot: v }); scheduleFilter(() => get().applyFilterInternal()) },
  setTypeFilter: (v) => { set({ typeFilter: v }); scheduleFilter(() => get().applyFilterInternal()) },
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

  setBomKw: (v) => { set({ bomKw: v }); get().recomputeBomFiltered() },
  setBomKwNot: (v) => { set({ bomKwNot: v }); get().recomputeBomFiltered() },
  bomSortBy: (k) => {
    const s = get()
    const asc = s.bomSortKey === k ? !s.bomSortAsc : true
    set({ bomSortKey: k, bomSortAsc: asc })
    // 排序同样要走重算（此前这里漏传 bomKwNot，排序后排除词会悄悄失效）
    get().recomputeBomFiltered()
  },

  setActiveTab: (t) => set({ activeTab: t }),

  // 1.0.51：点开/关闭 AI 回复里的大图预览（右侧分栏，不遮住对话）。
  // src 做了 trim + 过滤：markdown 允许 `![](  )` 这类空 src，进来直接不预览。
  // `srcs` 会被去重（同一张图在一条消息里可能引用多次），index 按**去重后**的下标定位。
  openImgPreview: (p) => {
    const srcs = (p?.srcs || []).map(s => String(s || '').trim()).filter(Boolean)
    if (!srcs.length) return
    const idx = Math.min(Math.max(0, Math.round(Number(p?.index) || 0)), srcs.length - 1)
    set({ imgPreview: { srcs, index: idx, alt: p?.alt } })
  },
  closeImgPreview: () => set({ imgPreview: null }),
  stepImgPreview: (delta) => set(s => {
    const cur = s.imgPreview
    if (!cur || cur.srcs.length < 2) return s
    // 取模实现「最后一张的下一张 = 第一张」，翻页不必判断边界
    const n = cur.srcs.length
    const next = (((cur.index + Math.round(delta)) % n) + n) % n
    return { imgPreview: { ...cur, index: next } }
  }),

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
    descTrans: { mat: emptyDescTrans(), bom: emptyDescTrans() },
    activeTab: 'mat', error: '', batchMsg: '', matExpandedKeys: new Set(), bomExpandedKeys: new Set(),
    fields: [{ id: 'f1', val: '' }, { id: 'f2', val: '' }, { id: 'f3', val: '' }]
  }),

  exportMatCSV: async () => {
    flushPendingFilter() // 先把防抖中的过滤跑完，避免导出到「停止输入之前」的旧结果集
    const s = get()
    if (!s.filtered.length) return
    try {
      const headers = s.t('csvMatHeaders') as unknown as string[]
      const keys = ['ITEM_NUMBER', 'ITEM_DESC', 'ITEM_TYPE', 'INV_STATUS_NAME', 'K3_ITEM_NUMBER', 'ON_HAND_QTY', 'DEVELOPMENT_SUB', 'TRACK_SUB', 'PRODUCT_ORDER_SUB', 'UPDATE_ORDER_SUB']
      // 描述列用 AI 译文（若有且当前显示译文）：只替换 ITEM_DESC 的值，列序 / 表头 /
      // 其他字段原样不动，未翻译的行保持中文原值 —— 译文按「中文原文」为键，错行不会错位
      const rows = applyDescTrans(s.filtered, s.descTrans.mat, DESC_FIELD.mat)
      const csv = toCSV(headers, keys, rows, new Set(['ITEM_NUMBER', 'K3_ITEM_NUMBER']))
      const filePath = await window.mcApi.saveCsv(csv, `${s.t('csvMat')}_${new Date().toISOString().slice(0, 10)}.csv`)
      if (!filePath) { set({ error: '' }) }
    } catch (e: any) {
      set({ error: s.t('errCsvExport', { m: e?.message || String(e) }) })
    }
  },

  // 「翻译物料描述」（1.0.54，物料 / BOM 两页通用）：用 AI 助手里配置的供应商，把当前
  // 结果集里**尚未翻译**的中文描述分批译成英文（每批 15 条，进度驱动按钮 loading 文案）。
  // 已译过的描述按原文键跳过，重复点击只翻新增部分；某批失败保留已译结果并提示，可续翻。
  // 翻译中再次点击 = 取消：弹确认，确认则置取消标志（在途批次跑完后不再发起新批次），
  // 取消则继续翻译。供应商选择与 ChatPanel 初始化一致：
  // 上次使用（preferences.lastProviderId）→ 第一个有 Key 的 → 第一个。
  translateDescs: async (kind) => {
    const s = get()
    const st = s.descTrans[kind]
    const field = DESC_FIELD[kind]
    const rows = kind === 'mat' ? s.filtered : s.bomFiltered
    const patchKind = (patch: Partial<DescTransState>) =>
      set(s2 => ({ descTrans: { ...s2.descTrans, [kind]: { ...s2.descTrans[kind], ...patch } } }))

    // 翻译中再次点击 = 取消：弹确认，确认则置取消标志，并**立刻让主进程中断在途的那一批请求**
    // （只靠批次间的标志不够——最后一批在途时要等它整个跑完，用户观感就是「点了取消没反应」）
    if (st.translating) {
      const ok = await window.mcApi.showConfirm({
        message: s.t('translateCancelConfirm', { done: st.progress?.done ?? 0, total: st.progress?.total ?? 0 }),
        lang: s.lang
      })
      if (ok) {
        patchKind({ cancelRequested: true })
        if (st.taskId) void window.mcApi.ai.cancelTranslate(st.taskId)
      }
      return
    }

    const todo = pendingDescs(rows, st, field)
    if (!todo.length) return
    let providerId = ''
    let modelId: string | undefined
    try {
      const bundle: any = await window.mcApi.ai.getProviders()
      const prefs = bundle?.preferences || {}
      const providers: any[] = bundle?.providers || []
      const restored = prefs.lastProviderId ? providers.find(p => p.id === prefs.lastProviderId) : undefined
      const target = restored || providers.find(p => p.hasApiKey) || providers[0]
      providerId = target?.id || ''
      modelId = prefs.lastModelId || target?.defaultModel || undefined
      // 没配 Key（且不是本地 Ollama）时不发请求：直接引导去 AI 助手配置
      if (providerId && !target?.hasApiKey && providerId !== 'ollama') {
        void window.mcApi.showMessage({ type: 'warning', message: s.t('translateNeedAi'), lang: s.lang })
        return
      }
    } catch { /* 拿不到供应商列表：providerId 为空，主进程会给出明确报错 */ }
    const taskId = `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    patchKind({ translating: true, taskId, progress: { done: 0, total: todo.length }, cancelRequested: false })
    set({ error: '' })
    const BATCH = 15
    const merged = { ...st.map }
    let doneCount = 0
    let canceled = false
    try {
      for (let i = 0; i < todo.length; i += BATCH) {
        // 批次之间检查取消标志（在途批次已被 cancelTranslate 中断，双保险）
        if (get().descTrans[kind].cancelRequested) { canceled = true; break }
        const chunk = todo.slice(i, i + BATCH)
        const res: any = await window.mcApi.ai.translateDescs({ providerId, modelId, texts: chunk, taskId })
        if (!res?.ok) {
          // 被取消：安静收尾，不当失败弹错
          if (res?.canceled) { canceled = true; break }
          throw new Error(res?.message || 'translate failed')
        }
        ;(res.items || []).forEach((txt: string, idx: number) => {
          const key = chunk[idx]
          const val = String(txt ?? '').trim()
          // 与原文相同（模型没译）时不写入缓存：按钮保持可点，下次还能重试
          if (key && val && val !== key) merged[key] = val
        })
        doneCount = Math.min(i + BATCH, todo.length)
        patchKind({ map: { ...merged }, progress: { done: doneCount, total: todo.length } })
      }
    } catch (e: any) {
      void window.mcApi.showMessage({ type: 'error', message: s.t('translateFail', { m: e?.message || String(e) }), lang: s.lang })
    } finally {
      // 收尾：清 translating / progress / cancelRequested / taskId；正常完成则切回「显示译文」，
      // 让用户直接看到成果；取消时维持当前显隐，不强行切换
      patchKind({
        translating: false,
        progress: null,
        cancelRequested: false,
        taskId: '',
        visible: canceled ? get().descTrans[kind].visible : true
      })
      if (canceled) {
        void window.mcApi.showMessage({ type: 'info', message: s.t('translateCanceled', { n: doneCount }), lang: s.lang })
      }
    }
  },

  /** 「显示原文 / 显示译文」切换：只改显隐，不动译文缓存；导出 CSV 跟随显隐 */
  toggleDescVisible: (kind) => set(s => ({
    descTrans: { ...s.descTrans, [kind]: { ...s.descTrans[kind], visible: !s.descTrans[kind].visible } }
  })),
  exportBomCSV: async () => {
    flushPendingFilter() // 同 exportMatCSV：导出前先把防抖中的过滤跑完
    const s = get()
    if (!s.bomFiltered.length) return
    try {
      const headers = s.t('csvBomHeaders') as unknown as string[]
      const keys = ['BOM_LEVEL', 'COMPONENT_ITEM', 'COMPONENT_ITEM_DESC', 'K3_ITEM_NUMBER', 'PRIMARY_UOM_CODE', 'LOSS_RATE', 'INVERSE_QUANTITY', 'COMPONENT_REFERENCE_DESIGNATOR', 'COMPONENT_REMARKS', 'ON_HAND_QTY', 'DEVELOPMENT_SUB', 'TRACK_SUB', 'PRODUCT_ORDER_SUB', 'UPDATE_ORDER_SUB', 'SHIP_LOT_QTY']
      // 组件描述列用 AI 译文（若有且当前显示译文），其余字段与列序原样不动
      const rows = applyDescTrans(s.bomFiltered, s.descTrans.bom, DESC_FIELD.bom)
      const csv = toCSV(headers, keys, rows, new Set(['COMPONENT_ITEM', 'K3_ITEM_NUMBER']))
      const filePath = await window.mcApi.saveCsv(csv, `${s.t('csvBom')}_${new Date().toISOString().slice(0, 10)}.csv`)
      if (!filePath) { set({ error: '' }) }
    } catch (e: any) {
      set({ error: s.t('errCsvExport', { m: e?.message || String(e) }) })
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
            // 主进程 CHECK_UPDATE 固定返回 downloading:false；正在下载/已下载完成时
            // 不能被它冲掉，否则进度满后「下载」按钮重现，再点就是整包重下
            downloading: (s.updateInfo.downloading || s.updateInfo.downloaded)
              ? s.updateInfo.downloading
              : (res.downloading || false)
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

// 启动时把上次选择的语言同步给主进程：原生弹窗（showMessageBox）的
// 按钮「确定/OK」「取消/Cancel」与默认标题需要跟随界面语言
try { window.mcApi.setUiLang(useStore.getState().lang) } catch { /* 忽略 */ }

export { STATUS_CLS_MAP }
