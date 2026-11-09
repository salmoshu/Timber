import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { findTextRanges, scrollToRange, setTextHighlight } from '../utils/textRanges'
import { getMarkdownEditor } from '../utils/markdownEditorRuntime'
import { IconChevronDown, IconChevronUp } from './icons'

interface Props { onClose(): void; replace?: boolean }

/** Markdown editors own search and replacement; read-only text keeps the Range fallback. */
export default function FindBar({ onClose, replace = false }: Props) {
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [showReplace, setShowReplace] = useState(replace)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [count, setCount] = useState(0)
  const [current, setCurrent] = useState(-1)
  const currentRef = useRef(-1)
  const rangesRef = useRef<Range[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const docPath = useStore((state) => state.activeDoc?.path)
  const draft = useStore((state) => state.draft)
  const mode = useStore((state) => state.mode)

  const updateResult = (total: number, index: number): void => {
    currentRef.current = index
    setCount(total)
    setCurrent(index)
  }

  const search = useCallback((reset = false): void => {
    const runtime = getMarkdownEditor()
    if (runtime) {
      rangesRef.current = []
      setTextHighlight('find-hit', [])
      setTextHighlight('find-current', [])
      const result = runtime.search(query, { caseSensitive, wholeWord })
      updateResult(result.count, result.index)
      return
    }
    const root = document.querySelector<HTMLElement>('.reader-body .txt-view, .cv-body .cv-content')
    const ranges = root && query ? findTextRanges(root, query, caseSensitive, wholeWord) : []
    rangesRef.current = ranges
    const next = ranges.length ? Math.max(0, Math.min(reset ? 0 : currentRef.current, ranges.length - 1)) : -1
    updateResult(ranges.length, next)
    setTextHighlight('find-hit', ranges)
    setTextHighlight('find-current', next < 0 ? [] : ranges.slice(next, next + 1))
  }, [query, caseSensitive, wholeWord])

  const locate = (index: number): void => {
    const range = rangesRef.current[index]
    if (!range) return
    setTextHighlight('find-current', [range])
    scrollToRange(range)
  }

  const nav = (direction: 1 | -1): void => {
    if (!count) return
    const runtime = getMarkdownEditor()
    if (runtime) {
      const result = runtime.find(direction)
      updateResult(result.count, result.index)
      return
    }
    const next = currentRef.current < 0 ? 0 : (currentRef.current + direction + count) % count
    updateResult(count, next)
    locate(next)
  }

  const replaceText = (all: boolean): void => {
    if (!count || count >= 10000) return
    const runtime = getMarkdownEditor()
    if (!runtime) return
    const replaced = all ? count : 1
    const result = runtime.replace(replacement, all)
    updateResult(result.count, result.index)
    inputRef.current?.focus({ preventScroll: true })
    useStore.getState().toast('ok', all ? `已替换 ${replaced} 处` : '已替换当前匹配')
  }

  useEffect(() => { if (replace) setShowReplace(true) }, [replace])
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
    return () => {
      getMarkdownEditor()?.clearSearch()
      setTextHighlight('find-hit', [])
      setTextHighlight('find-current', [])
    }
  }, [])
  useEffect(() => {
    const timer = window.setTimeout(() => { search(true); if (!getMarkdownEditor()) locate(0) }, 120)
    return () => clearTimeout(timer)
  }, [query, caseSensitive, wholeWord, docPath, mode])
  useEffect(() => {
    const refresh = (): void => search()
    const timer = window.setTimeout(refresh, 100)
    window.addEventListener('markdown-rendered', refresh)
    window.addEventListener('timber:editor-runtime-changed', refresh)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('markdown-rendered', refresh)
      window.removeEventListener('timber:editor-runtime-changed', refresh)
    }
  }, [search, draft])

  const editable = !!getMarkdownEditor()
  return (
    <div className="find-panel" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
      <div className="find-bar">
        {editable && <button className="fb-btn" aria-label="展开替换" aria-expanded={showReplace} onClick={() => setShowReplace(!showReplace)}>{showReplace ? '⌄' : '›'}</button>}
        <input ref={inputRef} aria-label="查找文本" value={query} onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); nav(event.shiftKey ? -1 : 1) } }} placeholder="查找…" spellCheck={false} />
        <button className={`fb-btn ${caseSensitive ? 'active' : ''}`} aria-label="区分大小写" aria-pressed={caseSensitive} onClick={() => setCaseSensitive(!caseSensitive)}>Aa</button>
        <button className={`fb-btn ${wholeWord ? 'active' : ''}`} aria-label="全字匹配" aria-pressed={wholeWord} onClick={() => setWholeWord(!wholeWord)}>ab</button>
        <span className="fb-count" aria-live="polite">{count >= 10000 ? '≥10000，请缩小范围' : count > 0 ? `${current + 1}/${count}` : query ? '无结果' : ''}</span>
        <button className="fb-btn" disabled={!count} onClick={() => nav(-1)} title="上一个 (Shift+Enter)" aria-label="上一个匹配"><IconChevronUp /></button>
        <button className="fb-btn" disabled={!count} onClick={() => nav(1)} title="下一个 (Enter)" aria-label="下一个匹配"><IconChevronDown /></button>
        <button className="fb-btn" onClick={onClose} title="关闭 (Esc)" aria-label="关闭查找">✕</button>
      </div>
      {showReplace && editable && <div className="find-bar find-replace-row">
        <input aria-label="替换文本" value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder="替换为…" spellCheck={false}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); replaceText(event.ctrlKey || event.metaKey) } }} />
        <button className="fb-btn" disabled={!count || count >= 10000} onClick={() => replaceText(false)}>替换</button>
        <button className="fb-btn" disabled={!count || count >= 10000} onClick={() => replaceText(true)}>全部替换</button>
      </div>}
    </div>
  )
}
