import type CodeMirror from 'codemirror'
import { formatMarkdown, textMatches, type TextEdit, type TextMatch } from './markdownEditing'
import type { MarkdownCommandRequest } from './markdownCommands'
import type { EditorSearchOptions, EditorSearchResult, MarkdownEditorRuntime } from './markdownEditorRuntime'

export function applyCodeMirrorEdit(cm: CodeMirror.Editor, change: TextEdit): void {
  cm.focus()
  cm.replaceRange(change.text, cm.posFromIndex(change.start), cm.posFromIndex(change.end))
  cm.setSelection(cm.posFromIndex(change.selectionStart), cm.posFromIndex(change.selectionEnd))
}

export function applyCodeMirrorCommand(cm: CodeMirror.Editor, request: MarkdownCommandRequest): void {
  const start = cm.indexFromPos(cm.getCursor('from'))
  const end = cm.indexFromPos(cm.getCursor('to'))
  const value = cm.getValue()
  const change = request.markdown === undefined
    ? formatMarkdown(value, start, end, request.command, request.table)
    : { start, end, text: request.markdown, selectionStart: start + request.markdown.length, selectionEnd: start + request.markdown.length }
  applyCodeMirrorEdit(cm, change)
}

export function createSourceRuntime(cm: CodeMirror.Editor): MarkdownEditorRuntime {
  let matches: TextMatch[] = []
  let current = -1
  let query = ''
  let options: EditorSearchOptions = { caseSensitive: false, wholeWord: false }
  const result = (): EditorSearchResult => ({ count: matches.length, index: current })
  const locate = (): void => {
    const match = matches[current]
    if (!match) return
    cm.setSelection(cm.posFromIndex(match.start), cm.posFromIndex(match.end))
    cm.scrollIntoView({ from: cm.posFromIndex(match.start), to: cm.posFromIndex(match.end) }, 120)
  }
  return {
    kind: 'source',
    root: cm.getWrapperElement(),
    getValue: () => cm.getValue(),
    flush: () => undefined,
    focus: () => cm.focus(),
    execute: (request) => applyCodeMirrorCommand(cm, request),
    getSelectionOffsets: () => ({ start: cm.indexFromPos(cm.getCursor('from')), end: cm.indexFromPos(cm.getCursor('to')) }),
    setSelectionOffsets: (start, end) => {
      cm.focus()
      cm.setSelection(cm.posFromIndex(start), cm.posFromIndex(end))
    },
    search: (nextQuery, nextOptions: EditorSearchOptions) => {
      query = nextQuery
      options = nextOptions
      matches = textMatches(cm.getValue(), query, options.caseSensitive, options.wholeWord)
      current = matches.length ? 0 : -1
      locate()
      return result()
    },
    find: (direction) => {
      if (matches.length) {
        current = current < 0 ? 0 : (current + direction + matches.length) % matches.length
        locate()
      }
      return result()
    },
    replace: (value, all) => {
      if (!matches.length || current < 0) return result()
      const previous = current
      const selected = all ? matches : [matches[current]]
      cm.operation(() => {
        for (const match of [...selected].reverse())
          cm.replaceRange(value, cm.posFromIndex(match.start), cm.posFromIndex(match.end))
      })
      matches = textMatches(cm.getValue(), query, options.caseSensitive, options.wholeWord)
      current = Math.min(previous, matches.length - 1)
      locate()
      return result()
    },
    clearSearch: () => { matches = []; current = -1 },
    scrollToLine: (line) => {
      const position = { line: Math.max(0, Math.min(line, cm.lineCount() - 1)), ch: 0 }
      cm.setCursor(position)
      cm.scrollIntoView(position, 120)
    },
    viewportLine: () => {
      const body = cm.getWrapperElement().closest<HTMLElement>('.reader-body')
      if (!body) return null
      const rect = body.getBoundingClientRect()
      return cm.coordsChar({ left: rect.left + 32, top: rect.top + body.clientHeight / 2 }, 'window').line
    },
    caretRect: (offset) => {
      const index = offset ?? cm.indexFromPos(cm.getCursor('anchor'))
      const rect = cm.charCoords(cm.posFromIndex(index), 'window')
      return new DOMRect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top)
    },
    undo: () => cm.undo(),
    redo: () => cm.redo(),
    getCursor: () => {
      const cursor = cm.getCursor()
      return { line: cursor.line + 1, column: cursor.ch + 1, selectedText: cm.getSelection() }
    }
  }
}
