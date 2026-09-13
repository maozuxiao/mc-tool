// ── 中国法定节假日：逐年从公开数据源同步 ──
//
// 为什么放主进程、而不是在渲染层直接 fetch：
//   1) 渲染层发跨域请求受 CORS 限制 —— timor.tech 不返回 CORS 头，必然失败；
//   2) Electron 的 net.fetch 会自动走系统代理（公司网络走代理时也能通），而 Node 的
//      全局 fetch(undici) 不认系统代理，只会超时；
//   3) 顺手落盘缓存，下次启动离线也能用。
//
// 边界：本模块只负责「尽力更新」。取不到就返回 null，渲染层继续用
// @shared/holidays 里的内置兜底表 —— 任何失败都不应该让顶栏倒计时显示不出来。
//
// 数据源（按顺序尝试，第一个成功即用）。三家都只是把同一份国办通知结构化，
// 实测 2026 年三者的放假/补班日期完全一致：
//   1) timor.tech           国内直连，最快
//   2) holiday-cn @ jsDelivr 由官方通知机器生成的静态 JSON，国内基本可达
//   3) holiday-cn @ GitHub  前两个都不通时的兜底（raw.githubusercontent 国内常被墙）

import { app, net } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { HolidayPlan } from '@shared/types'

/** 从接口原始 JSON 里抽出来的结果 */
type Parsed = { off: string[]; work: string[] }

interface Source {
  name: string
  url: (year: number) => string
  /** 结构不符时返回 null（接口改了/返回了别的东西），由调用方换下一个源 */
  parse: (data: any) => Parsed | null
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** holiday-cn 的结构：{ days: [{ date, isOffDay }] }，只含节假日与补班日，不含普通周末 */
function parseHolidayCn(data: any): Parsed | null {
  if (!data || !Array.isArray(data.days)) return null
  const off: string[] = []
  const work: string[] = []
  for (const d of data.days) {
    if (typeof d?.date !== 'string' || !DATE_RE.test(d.date)) continue
    if (d.isOffDay) off.push(d.date)
    else work.push(d.date)
  }
  return { off, work }
}

const SOURCES: Source[] = [
  {
    name: 'timor.tech',
    url: y => `https://timor.tech/api/holiday/year/${y}`,
    parse: data => {
      // 结构：{ code: 0, holiday: { '01-01': { holiday: true, date: '2026-01-01', ... } } }
      // holiday=true 是放假，false 是调休补班。同样只含节假日与补班日。
      if (!data || data.code !== 0 || !data.holiday || typeof data.holiday !== 'object') return null
      const off: string[] = []
      const work: string[] = []
      for (const v of Object.values<any>(data.holiday)) {
        const date = typeof v?.date === 'string' ? v.date : ''
        if (!DATE_RE.test(date)) continue
        if (v.holiday) off.push(date)
        else work.push(date)
      }
      return { off, work }
    }
  },
  {
    name: 'holiday-cn/jsdelivr',
    url: y => `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${y}.json`,
    parse: parseHolidayCn
  },
  {
    name: 'holiday-cn/github',
    url: y => `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${y}.json`,
    parse: parseHolidayCn
  }
]

const FETCH_TIMEOUT_MS = 8000
/** 磁盘缓存有效期。放假安排一年才公布一次，7 天足够快地感知到更新（12 月公布次年安排时
 *  最多晚一周生效），又把启动时的网络请求压到「每周最多一次」。 */
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000
/** 所有数据源都失败后的冷却时间：6 小时内不再重试，避免每次启动都卡在 8s 超时上 */
const FAIL_COOLDOWN_MS = 6 * 3600 * 1000

const uniq = (list: string[]): string[] => Array.from(new Set(list)).sort()

/** 数据体检：越界/混入别的年份一律判为不可信，宁可回退内置表也不写进缓存把错误固化 */
function isSane(p: Parsed | null, year: number): p is Parsed {
  if (!p || !Array.isArray(p.off) || !Array.isArray(p.work)) return false
  const ok = (d: unknown): d is string => typeof d === 'string' && DATE_RE.test(d) && d.startsWith(`${year}-`)
  if (!p.off.every(ok) || !p.work.every(ok)) return false
  // 一年放假 10~60 天、补班 0~40 天；越界说明对方返回了别的东西（例如整年日历）
  return p.off.length >= 5 && p.off.length <= 60 && p.work.length <= 40
}

async function httpJson(url: string): Promise<any> {
  const init: any = {
    headers: { Accept: 'application/json,*/*' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  }
  // net.fetch 需 app ready 且会自动走系统代理；万一取不到（老 Electron/异常）退化成
  // Node 全局 fetch —— 仍能联网，只是不走系统代理，好过整个功能直接失效。
  const res: any = typeof net?.fetch === 'function' ? await net.fetch(url, init) : await fetch(url, init)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function cacheFile(year: number): string {
  return join(app.getPath('userData'), 'holidays', `${year}.json`)
}

function readCache(year: number): HolidayPlan | null {
  try {
    const raw: any = JSON.parse(readFileSync(cacheFile(year), 'utf8'))
    // 先取出 source：下面 isSane 会把 raw 收窄成 Parsed，之后就读不到 source 了
    const from = typeof raw?.source === 'string' ? raw.source : '?'
    if (Date.now() - Number(raw?.fetchedAt) > CACHE_TTL_MS) return null
    if (!isSane(raw, year)) return null
    return { year, off: uniq(raw.off), work: uniq(raw.work), source: `cache(${from})` }
  } catch {
    return null // 文件不存在 / JSON 损坏 / 字段变了：一律当作没有缓存，交给网络重取
  }
}

function writeCache(plan: HolidayPlan): void {
  try {
    const dir = join(app.getPath('userData'), 'holidays')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(cacheFile(plan.year), JSON.stringify({ ...plan, fetchedAt: Date.now() }))
  } catch {
    // 缓存写失败不影响本次结果，下次启动重新拉一遍而已
  }
}

const memo = new Map<number, HolidayPlan>()
const inflight = new Map<number, Promise<HolidayPlan | null>>()
const lastFail = new Map<number, number>()

/**
 * 取某年的放假安排。命中顺序：内存 → 磁盘缓存（7 天内）→ 数据源（依次尝试）。
 *
 * 全部失败返回 null（调用方回退内置兜底表），并在 6 小时内不再重试。
 */
export function getHolidayPlan(year: number): Promise<HolidayPlan | null> {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return Promise.resolve(null)

  const hit = memo.get(year)
  if (hit) return Promise.resolve(hit)
  // 并发合并：QueryPanel 重新挂载、多个入口同时问同一年时只打一次网络
  const running = inflight.get(year)
  if (running) return running

  const task = (async (): Promise<HolidayPlan | null> => {
    const cached = readCache(year)
    if (cached) {
      memo.set(year, cached)
      return cached
    }
    if (Date.now() - (lastFail.get(year) || 0) < FAIL_COOLDOWN_MS) return null

    for (const src of SOURCES) {
      try {
        const parsed = src.parse(await httpJson(src.url(year)))
        if (!isSane(parsed, year)) continue
        const plan: HolidayPlan = { year, off: uniq(parsed.off), work: uniq(parsed.work), source: src.name }
        writeCache(plan)
        memo.set(year, plan)
        return plan
      } catch {
        // 该源不可用（超时 / 被墙 / 结构变了）→ 试下一个
      }
    }
    lastFail.set(year, Date.now())
    return null
  })()

  inflight.set(year, task)
  return task.finally(() => {
    inflight.delete(year)
  })
}
