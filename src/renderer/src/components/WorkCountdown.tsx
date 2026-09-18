import { useEffect, useMemo, useState } from 'react'
import { Countdown } from 'animal-island-ui'
import { applyRemotePlan, isWorkday } from '@shared/holidays'
import { useStore } from '../store'

/**
 * 下班时间（本地时区）。
 * 全公司统一 18:00，所以直接写常量；哪天要做成可配置项，挪到设置面板即可。
 */
const OFF_WORK_HOUR = 18
const OFF_WORK_MINUTE = 0

/** 取某一天的「下班时刻」 */
function offWorkAt(day: Date): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), OFF_WORK_HOUR, OFF_WORK_MINUTE, 0, 0)
}

/**
 * 拉取当年（12 月顺带拉次年）的法定节假日安排，写入 @shared/holidays 的运行时覆盖层。
 *
 * 失败就什么都不做 —— 那一年的判断继续走内置兜底表。
 * 12 月预拉次年，是为了跨年那一刻（1/1 零点）就能正确判断元旦放不放假。
 */
async function syncHolidayPlans(): Promise<void> {
  const getHolidays = window.mcApi?.getHolidays
  if (!getHolidays) return
  const start = new Date()
  const years = [start.getFullYear()]
  if (start.getMonth() === 11) years.push(start.getFullYear() + 1)
  await Promise.all(
    years.map(async y => {
      const plan = await getHolidays(y).catch(() => null)
      if (plan) applyRemotePlan(y, plan)
    })
  )
}

/**
 * 顶栏「距离下班还有 hh:mm:ss」。
 *
 * 三种状态，二选一地渲染：
 * - 休息日（周末 / 法定节假日 / 调休放假）：不显示倒计时，改显示一句祝福；
 * - 上班日且未到下班点：库 <Countdown variant="default">，format=HH:mm:ss；
 * - 上班日但已过下班点：同样不显示倒计时（否则会僵在 00:00:00），改显示祝福。
 *
 * 「今天算不算上班日」交给 @shared/holidays，数据三层优先级：
 * 主进程联网拉取的实时数据 > 内置兜底表 > 只按周末算（详见 shared/holidays.ts）。
 *
 * 为什么不用 setInterval 每秒重算状态：
 * 倒计时数字由库组件自己按 250ms 刷新，这里只需要在「结论会变的两个时刻」重新求值
 * —— 下班那一刻、以及次日零点（跨天后要重新判断今天是上班还是休息）。
 * 于是每天最多 setState 两次，不会因为顶栏挂着一个计时器就让整个面板持续重渲染。
 * 后面那条 30s 的守卫定时器同理：只有结论真的变了才 setState（见代码内注释）。
 */
export function WorkCountdown() {
  const t = useStore(s => s.t)
  // 只用来判定「今天是什么日子 / 是否已过下班点」，不参与倒计时数字的刷新
  const [now, setNow] = useState(() => new Date())
  // 节假日数据是异步到达的：首帧先用内置兜底表（通常就已正确），
  // 实时数据回来后再触发一次重渲染，把「今天算不算上班日」重算一遍。
  const [, setPlanVer] = useState(0)

  useEffect(() => {
    let alive = true
    const run = () => {
      void syncHolidayPlans().then(() => {
        if (alive) setPlanVer(v => v + 1)
      })
    }
    // 1.0.42 启动优化：节假日同步要走 IPC + 联网，原先在挂载时立即发起，等于和首屏渲染
    // 抢主线程。这里推到首帧渲染完成之后的空闲时段（不支持 requestIdleCallback 时退化为
    // 250ms 延时）；内置兜底表在首帧就已给出正确判断，所以推迟不影响显示。
    const idle = (window as any).requestIdleCallback as
      | ((cb: () => void, opts?: { timeout: number }) => number)
      | undefined
    const handle = idle ? idle(run, { timeout: 2000 }) : window.setTimeout(run, 250)
    return () => {
      alive = false
      const cancelIdle = (window as any).cancelIdleCallback as ((h: number) => void) | undefined
      if (idle && cancelIdle) cancelIdle(handle)
      else window.clearTimeout(handle)
    }
  }, [])

  useEffect(() => {
    const d = new Date()
    const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 2)
    const off = offWorkAt(d)
    // 下班时刻 +1s 再判定：库的倒计时按下班点归零，留 1 秒余量避免边界抖动
    const marks = [nextMidnight.getTime()]
    if (off.getTime() > d.getTime()) marks.push(off.getTime() + 1000)
    const delay = Math.max(500, Math.min(...marks) - d.getTime())
    const id = window.setTimeout(() => setNow(new Date()), delay)
    return () => window.clearTimeout(id)
  }, [now])

  // 时钟守卫：每 30s 复查一次上面的判定结论是否已经过期。
  // 上面那条 setTimeout 是按「当前时刻 + 到拐点的距离」一次性布置的，一旦系统时钟被调
  // （跳天/跳时）或休眠唤醒后被校正，先前算出的 delay 就指向了错误的未来时刻 ——
  // 实测踩到过：应用是在时钟为周一 12:37 时启动的，之后系统时钟往回跳到周日，
  // state 里的 now 仍停在周一，而那次布置的定时器要等到「周一 24:00」才触发，
  // 于是整个周日都显示着周一的下班倒计时。
  // 这里用函数式 setState：结论没变时返回同一个 now 引用，React 会跳过重渲染，
  // 所以平均仍是一天只 setState 两次左右，不会引入持续刷新。
  useEffect(() => {
    const sameDay = (a: Date, b: Date) =>
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
    const id = window.setInterval(() => {
      setNow(prev => {
        const d = new Date()
        if (!sameDay(d, prev)) return d // 跨天：含时钟跳天、正常跨零点、休眠唤醒
        if (d.getTime() < prev.getTime() - 60_000) return d // 系统时钟往回拨
        // 刚跨过下班点：同样要重算（正常情况由上面那条定时器负责，这里只是兜底）
        if (prev.getTime() < offWorkAt(prev).getTime() && d.getTime() >= offWorkAt(d).getTime()) return d
        return prev
      })
    }, 30_000)
    return () => window.clearInterval(id)
  }, [])

  // useMemo 让 target 在「与本组件无关的重渲染」中保持同一引用：
  // 库内部以 value 作为 effect 依赖，每次换新对象都会重建一次 interval
  const target = useMemo(() => offWorkAt(now), [now])

  if (!isWorkday(now)) return <span className="brand-wish">{t('restDayWish')}</span>
  if (now.getTime() >= target.getTime()) return <span className="brand-wish">{t('afterWorkWish')}</span>

  return (
    <Countdown
      className="mc-countdown"
      variant="default"
      size="small"
      format="HH:mm:ss"
      prefix={t('offWorkPrefix')}
      value={target.getTime()}
    />
  )
}
