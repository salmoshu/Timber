import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { findTextRanges, scrollToRange, setTextHighlight } from '../utils/textRanges'
import { textMatches, type TextMatch } from '../utils/markdownEditing'
import { applyTextareaEdit } from '../utils/markdownCommands'
import { textareaCaretRect } from '../utils/editorGeometry'
import { IconChevronDown, IconChevronUp } from './icons'

interface Props { onClose(): void; replace?: boolean }

/** Search stays outside the editor DOM; replacements use native undo and text nodes. */
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
  const sourceMatches = useRef<TextMatch[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const docPath = useStore((state) => state.activeDoc?.path)
  const draft = useStore((state) => state.draft)
  const mode = useStore((state) => state.mode)

  const search = useCallback((reset = false): void => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.reader-body .editor-plain')
    const root = document.querySelector<HTMLElement>('.reader-body .prose, .reader-body .txt-view, .cv-body .cv-content')
    const ranges = !textarea && root && query ? findTextRanges(root, query, caseSensitive, wholeWord) : []
    const matches = textarea && query ? textMatches(textarea.value, query, caseSensitive, wholeWord) : []
    rangesRef.current = ranges
    sourceMatches.current = matches
    const total = textarea ? matches.length : ranges.length
    const next = total ? Math.max(0, Math.min(reset ? 0 : currentRef.current, total - 1)) : -1
    currentRef.current = next
    setCount(total)
    setCurrent(next)
    setTextHighlight('find-hit', ranges)
    setTextHighlight('find-current', next < 0 ? [] : ranges.slice(next, next + 1))
  }, [query, caseSensitive, wholeWord])

  const locate = (index: number): void => {
    const ta = document.querySelector<HTMLTextAreaElement>('.reader-body .editor-plain')
    const match = sourceMatches.current[index]
    if (ta && match) {
      ta.setSelectionRange(match.start, match.end)
      const body = ta.closest<HTMLElement>('.reader-body')
      if (body) body.scrollTop += textareaCaretRect(ta, match.start).top - body.getBoundingClientRect().top - body.clientHeight / 2
    } else if (rangesRef.current[index]) {
      setTextHighlight('find-current', [rangesRef.current[index]])
      scrollToRange(rangesRef.current[index])
    }
  }
  const nav = (direction: 1 | -1): void => {
    if (!count) return
    const next = currentRef.current < 0 ? 0 : (currentRef.current + direction + count) % count
    currentRef.current = next
    setCurrent(next)
    locate(next)
  }

  const replaceText = (all: boolean): void => {
    if (!count || count >= 10000) return
    const ta = document.querySelector<HTMLTextAreaElement>('.reader-body .editor-plain')
    if (ta) {
      const matches = sourceMatches.current
      const match = matches[currentRef.current]
      if (!match) return
      if (all) {
        let value = ta.value
        for (const item of [...matches].reverse()) value = value.slice(0, item.start) + replacement + value.slice(item.end)
        const caret = Math.min(value.length, match.start + replacement.length)
        applyTextareaEdit(ta, { start: 0, end: ta.value.length, text: value, selectionStart: caret, selectionEnd: caret })
      } else applyTextareaEdit(ta, { start: match.start, end: match.end, text: replacement, selectionStart: match.start + replacement.length, selectionEnd: match.start + replacement.length })
    } else {
      const prose = document.querySelector<HTMLElement>('.reader-body .prose[contenteditable="true"]')
      if (!prose) return
      const selection = window.getSelection()
      if (!selection) return
      prose.focus({ preventScroll: true })
      let range = rangesRef.current[currentRef.current]
      if (!range || !prose.contains(range.commonAncestorContainer)) return
      if (all) {
        const clone = prose.cloneNode(true) as HTMLElement
        for (const match of findTextRanges(clone, query, caseSensitive, wholeWord).reverse()) {
          match.deleteContents()
          match.insertNode(document.createTextNode(replacement))
        }
        range = document.createRange()
        range.selectNodeContents(prose)
        selection.removeAllRanges()
        selection.addRange(range)
        document.execCommand('insertHTML', false, clone.innerHTML)
      } else {
        selection.removeAllRanges()
        selection.addRange(range)
        document.execCommand('insertText', false, replacement)
      }
      prose.dispatchEvent(new InputEvent('input', { inputType: 'insertReplacementText', bubbles: true }))
    }
    search()
    inputRef.current?.focus({ preventScroll: true })
    useStore.getState().toast('ok', all ? `已替换 ${count} 处` : '已替换当前匹配')
  }

  useEffect(() => { if (replace) setShowReplace(true) }, [replace])
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
    return () => { setTextHighlight('find-hit', []); setTextHighlight('find-current', []) }
  }, [])
  useEffect(() => {
    const timer = window.setTimeout(() => { search(true); locate(0) }, 120)
    return () => clearTimeout(timer)
  }, [query, caseSensitive, wholeWord, docPath, mode])
  useEffect(() => {
    const refresh = (): void => search()
    const timer = window.setTimeout(refresh, 100)
    window.addEventListener('markdown-rendered', refresh)
    return () => { clearTimeout(timer); window.removeEventListener('markdown-rendered', refresh) }
  }, [search, draft])

  const editable = mode === 'source' || !!document.querySelector('.reader-body .prose[contenteditable="true"]')
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
