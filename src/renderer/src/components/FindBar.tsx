import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { findTextRanges, scrollToRange, setTextHighlight } from '../utils/textRanges'

interface Props {
  onClose(): void
}

/** Ctrl+F 查找可编辑的阅读正文，通过 CSS Range 高亮保留内容和撤销记录。 */
export default function FindBar({ onClose }: Props) {
  const [query, setQuery] = useState('')
  const [count, setCount] = useState(0)
  const [current, setCurrent] = useState(-1)
  const rangesRef = useRef<Range[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const docPath = useStore((state) => state.activeDoc?.path ?? state.codeFile)

  const search = useCallback((q: string): void => {
    const root = document.querySelector<HTMLElement>('.reader-body .prose, .reader-body .txt-view, .cv-body .cv-content')
    const ranges = root && q ? findTextRanges(root, q) : []
    rangesRef.current = ranges
    setCount(ranges.length)
    setCurrent(ranges.length ? 0 : -1)
    setTextHighlight('find-hit', ranges)
    setTextHighlight('find-current', ranges.slice(0, 1))
  }, [])

  const nav = useCallback((direction: 1 | -1): void => {
    const ranges = rangesRef.current
    if (!ranges.length) return
    const next = current < 0 ? 0 : (current + direction + ranges.length) % ranges.length
    setTextHighlight('find-current', [ranges[next]])
    scrollToRange(ranges[next])
    setCurrent(next)
  }, [current])

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
    return () => {
      setTextHighlight('find-hit', [])
      setTextHighlight('find-current', [])
    }
  }, [])

  useEffect(() => {
    const refresh = (): void => search(query.trim())
    const timer = setTimeout(() => {
      refresh()
      if (rangesRef.current[0]) scrollToRange(rangesRef.current[0])
    }, 200)
    window.addEventListener('markdown-rendered', refresh)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('markdown-rendered', refresh)
    }
  }, [query, search, docPath])

  return (
    <div className="find-bar">
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            nav(event.shiftKey ? -1 : 1)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
        }}
        placeholder="查找…"
        spellCheck={false}
      />
      <span className="fb-count">{count > 0 ? `${current + 1}/${count}` : query ? '无结果' : ''}</span>
      <button className="fb-btn" onClick={() => nav(-1)} title="上一个 (Shift+Enter)">↑</button>
      <button className="fb-btn" onClick={() => nav(1)} title="下一个 (Enter)">↓</button>
      <button className="fb-btn" onClick={onClose} title="关闭 (Esc)">✕</button>
    </div>
  )
}
