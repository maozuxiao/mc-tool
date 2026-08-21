import { useEffect, useRef } from 'react'

interface ColResizeOptions {
  storageKey?: string
}

// 列宽拖拽（与用户脚本 initColResizers 行为一致）：拖动某列时钉死其余列宽，避免被压缩；
// 拖动结束后恢复 100%，使 zoom/resize 时表格随容器自适应；可选 localStorage 持久化。
export function useColResize(
  tableRef: React.RefObject<HTMLTableElement>,
  options: ColResizeOptions = {}
) {
  const { storageKey } = options
  const draggingRef = useRef<{ th: HTMLTableCellElement; startX: number; startW: number } | null>(null)

  useEffect(() => {
    const table = tableRef.current
    if (!table) return
    const ths = Array.from(table.querySelectorAll<HTMLTableCellElement>('thead th'))

    // 恢复已保存的列宽
    if (storageKey) {
      try {
        const saved = JSON.parse(localStorage.getItem(storageKey) || '{}')
        ths.forEach(th => {
          const k = th.dataset.k
          if (k && saved[k]) th.style.width = saved[k]
        })
      } catch { /* ignore */ }
    }

    const resizers = ths.map((th, idx) => {
      if (idx === ths.length - 1) return null // 最后一列不拉伸
      const resizer = document.createElement('span')
      resizer.className = 'col-resizer'
      resizer.addEventListener('mousedown', (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        draggingRef.current = { th, startX: e.pageX, startW: th.offsetWidth }
        // 固定每列当前宽度，避免拖动某列时其余列被压缩
        ths.forEach(t => { t.style.width = t.offsetWidth + 'px' })
        table.style.width = table.offsetWidth + 'px'
        const onMove = (ev: MouseEvent) => {
          if (!draggingRef.current) return
          const diff = ev.pageX - draggingRef.current.startX
          const newW = Math.max(40, draggingRef.current.startW + diff)
          draggingRef.current.th.style.width = newW + 'px'
          table.style.width = table.offsetWidth + 'px'
        }
        const onUp = () => {
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
          // 拖动结束后恢复 100%，使 zoom/resize 时表格能随容器自适应
          table.style.width = '100%'
          if (storageKey) {
            const save: Record<string, string> = {}
            ths.forEach(t => { if (t.dataset.k) save[t.dataset.k] = t.style.width })
            localStorage.setItem(storageKey, JSON.stringify(save))
          }
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
      })
      th.appendChild(resizer)
      return resizer
    })

    return () => {
      resizers.forEach(r => r && r.remove())
    }
  }, [tableRef, storageKey])
}
