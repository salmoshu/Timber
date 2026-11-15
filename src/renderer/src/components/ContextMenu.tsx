import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  key: string
  label: string
  onClick(): void
  danger?: boolean
  separatorBefore?: boolean
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose(): void
}

/** 右键菜单：fixed 定位，点击外部 / Esc / 滚动关闭；靠近边缘自动翻转 */
export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const nx = Math.min(x, window.innerWidth - r.width - 8)
    const ny = y + r.height > window.innerHeight - 8 ? Math.max(8, y - r.height - 22) : y
    setPos({ x: Math.max(8, nx), y: ny })
  }, [x, y])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const close = () => onClose()
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [onClose])

  // 挂载到 body，避免标签栏 / 路径栏等父级层叠上下文裁切或覆盖菜单。
  return createPortal(
    <div className="ctx-menu" ref={ref} style={{ left: pos.x, top: pos.y }}>
      {items.map((it) => (
        <div key={it.key} className="ctx-sep-wrap">
          {it.separatorBefore && <div className="ctx-sep" />}
          <button
            className={`ctx-item ${it.danger ? 'danger' : ''}`}
            onClick={() => {
              onClose()
              it.onClick()
            }}
          >
            {it.label}
          </button>
        </div>
      ))}
    </div>,
    document.body
  )
}
