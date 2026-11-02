import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { EXPORT_PAGE_CSS, PAGED_SCREEN_CSS, renderMarkdownForExport, waitForHtmlImages } from '../utils/documentExport'

const A4_WIDTH = 794

interface Props {
  docPath: string
  projectId: string
  /** 对照编辑：左侧显示所见即所得编辑器，编辑实时重新分页（Reader 布局） */
  editOn?: boolean
  onToggleEdit?: () => void
}

export default function PagedPreview({ docPath, projectId, editOn = false, onToggleEdit }: Props) {
  const markdown = useStore((s) => s.draft)
  const hostRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [pages, setPages] = useState(0)
  const [error, setError] = useState('')
  const [scale, setScale] = useState(1)

  useEffect(() => {
    const host = scrollRef.current
    if (!host) return
    const update = () => setScale(Math.min(1, Math.max(0.35, (host.clientWidth - 36) / A4_WIDTH)))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    // 草稿变化后立即作废旧页：导出等待逻辑不能在新分页完成前读到上一版结果。
    setPages(0)
    // 对照编辑时每次击键静止后都会整篇重新分页，防抖稍长以减少重排闪烁
    const timer = window.setTimeout(async () => {
      const root = hostRef.current
      if (!root) return
      setError('')
      try {
        const body = await renderMarkdownForExport(markdown, docPath, projectId)
        await waitForHtmlImages(body)
        if (cancelled) return
        const { Previewer } = await import('pagedjs')
        if (cancelled) return
        const slot = document.createElement('div')
        root.replaceChildren(slot)
        const result = await new Previewer().preview(body, [
          { [window.location.href]: `${EXPORT_PAGE_CSS}\n${PAGED_SCREEN_CSS}` }
        ], slot)
        if (!cancelled) setPages(result.total)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    }, editOn ? 500 : 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [markdown, docPath, projectId, editOn])

  return (
    <div className="paged-preview" ref={scrollRef}>
      <div className="paged-preview-meta">
        <span className="paged-preview-count">A4 分页预览{pages > 0 ? ` · 共 ${pages} 页` : ' · 正在分页…'}</span>
        <span className="paged-preview-hint">PDF 将严格按此分页导出</span>
        {onToggleEdit && (
          <button className={`paged-edit-toggle ${editOn ? 'active' : ''}`} onClick={onToggleEdit} aria-pressed={editOn}>
            {editOn ? '✎ 对照编辑中' : '✎ 对照编辑'}
          </button>
        )}
      </div>
      {error ? (
        <div className="re-error">
          <div className="re-error-icon">⚠</div>
          <div className="re-error-title">分页失败</div>
          <div className="re-error-desc">{error}</div>
        </div>
      ) : (
        <div className="paged-preview-zoom" style={{ zoom: scale }}>
          <div ref={hostRef} className="paged-preview-pages" />
        </div>
      )}
    </div>
  )
}
