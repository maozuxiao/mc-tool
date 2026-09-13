// ── 中国法定节假日 / 调休上班日 ──
//
// 三层数据来源，优先级从高到低：
//
//   1) 远端实时数据 —— 启动时由主进程逐年拉取（timor.tech / holiday-cn，
//      见 src/main/holidaySync.ts），渲染层拿到后经 applyRemotePlan() 写进来。
//      有这一层，**下面那张内置表正常情况下不用再逐年维护**。
//   2) 内置兜底表 PLANS —— 首次启动就没网、或所有数据源都不可达时用。
//   3) 两者都没有 —— 退化成「周一到周五上班」。
//
// 内置表数据来源（国务院办公厅《关于XXXX年部分节假日安排的通知》）：
//   2025 年：国办发明电〔2024〕12号
//   2026 年：国办发明电〔2025〕7号
// 追加一年的写法：
//   2027: { off: [['2027-01-01', '2027-01-03']], work: ['2027-01-04'] }
// 不追加也不会出错 —— 只会让「首次启动且无网」时那一年的调休判断退化成周末判断。

/** 一年的放假安排（内置表的书写形式：写区间比逐日列举更贴近通知原文） */
interface YearPlan {
  /** 放假区间 [起, 止]，含首尾，公历 YYYY-MM-DD */
  off: Array<[string, string]>
  /** 调休上班日：本来就是周六/周日，但按通知要上班 */
  work: string[]
}

/** 展开后的形式：按天查表 */
interface DaySets {
  off: Set<string>
  work: Set<string>
}

const PLANS: Record<number, YearPlan> = {
  // 国办发明电〔2024〕12号
  2025: {
    off: [
      ['2025-01-01', '2025-01-01'], // 元旦
      ['2025-01-28', '2025-02-04'], // 春节（除夕起 8 天）
      ['2025-04-04', '2025-04-06'], // 清明节
      ['2025-05-01', '2025-05-05'], // 劳动节
      ['2025-05-31', '2025-06-02'], // 端午节
      ['2025-10-01', '2025-10-08'] // 国庆节 + 中秋节（合并 8 天）
    ],
    work: ['2025-01-26', '2025-02-08', '2025-04-27', '2025-09-28', '2025-10-11']
  },
  // 国办发明电〔2025〕7号
  2026: {
    off: [
      ['2026-01-01', '2026-01-03'], // 元旦
      ['2026-02-15', '2026-02-23'], // 春节（9 天）
      ['2026-04-04', '2026-04-06'], // 清明节
      ['2026-05-01', '2026-05-05'], // 劳动节
      ['2026-06-19', '2026-06-21'], // 端午节
      ['2026-09-25', '2026-09-27'], // 中秋节
      ['2026-10-01', '2026-10-07'] // 国庆节
    ],
    work: ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']
  }
}

/** 按本地时区格式化为 YYYY-MM-DD（不能用 toISOString：它按 UTC 切日，东八区会差一天） */
function ymd(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${m}-${d}`
}

/** 把 YYYY-MM-DD 解析为**本地时区**当天零点 */
function parseYmd(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** 把区间展开成逐日 Set：查表 O(1)，省掉每次渲染都做一遍区间遍历 */
function expand(plan: YearPlan): DaySets {
  const off = new Set<string>()
  for (const [from, to] of plan.off) {
    const end = parseYmd(to).getTime()
    // 逐日推进用 new Date(y, m, d + 1)：跨月/跨年由 Date 自动进位（比 +86400000 稳，不怕夏令时）
    for (let d = parseYmd(from); d.getTime() <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      off.add(ymd(d))
    }
  }
  return { off, work: new Set(plan.work) }
}

const BUILTIN = new Map<number, DaySets>()
for (const [year, plan] of Object.entries(PLANS)) BUILTIN.set(Number(year), expand(plan))

/** 主进程拉回来的实时数据，按年覆盖内置表 */
const REMOTE = new Map<number, DaySets>()

/**
 * 写入某年的实时放假安排（数据来自主进程 holidaySync）。
 *
 * 传 null / 空数据会被直接忽略并继续用内置表 —— 调用方不必自己判断，
 * 拉取失败时无脑调用即可。
 */
export function applyRemotePlan(year: number, plan: { off: string[]; work: string[] } | null | undefined): void {
  if (!plan || !Number.isInteger(year) || year <= 0) return
  if (!Array.isArray(plan.off) || !Array.isArray(plan.work)) return
  if (!plan.off.length && !plan.work.length) return
  REMOTE.set(year, { off: new Set(plan.off), work: new Set(plan.work) })
}

/**
 * 当天是否需要上班。
 *
 * 判断优先级：调休上班日 > 放假日 > 周一至周五。
 * 最后一条是兜底：没有任何数据的那一年就只按周末算。
 */
export function isWorkday(date: Date): boolean {
  const sets = REMOTE.get(date.getFullYear()) ?? BUILTIN.get(date.getFullYear())
  if (sets) {
    const key = ymd(date)
    if (sets.work.has(key)) return true
    if (sets.off.has(key)) return false
  }
  const w = date.getDay()
  return w >= 1 && w <= 5
}
