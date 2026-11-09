import { Muya, SelectionType } from '@muyajs/core'
import { MarkdownToState } from '@muyajs/core/state/markdownToState'
import { ScrollPage } from '@muyajs/core/block/scrollPage'
import type { MarkdownCommandRequest } from './markdownCommands'
import type { EditorSearchResult, MarkdownEditorRuntime } from './markdownEditorRuntime'

const FORMAT_COMMANDS: Record<string, string> = {
  bold: 'strong', italic: 'em', strike: 'del', highlight: 'mark', 'inline-code': 'inline_code',
  'inline-math': 'inline_math', link: 'link', image: 'image'
}

const PARAGRAPH_COMMANDS: Record<string, string> = {
  paragraph: 'paragraph', h1: 'heading 1', h2: 'heading 2', h3: 'heading 3', h4: 'heading 4', h5: 'heading 5', h6: 'heading 6',
  quote: 'blockquote', list: 'ul-bullet', 'ordered-list': 'ol-order', check: 'ul-task', code: 'pre', line: 'hr', math: 'mathblock', frontmatter: 'front-matter'
}

function searchResult(muya: Muya): EditorSearchResult {
  const search = muya.editor.searchModule
  return { count: search.matches.length, index: search.index }
}

/** Insert inline source without replacing the document or its undo history. */
function insertInline(muya: Muya, markdown: string): boolean {
  const selection = muya.editor.selection.getTextSelection()
  if (!selection || selection.anchor.block !== selection.focus.block) return false
  const block = selection.anchor.block
  const start = Math.min(selection.anchor.offset, selection.focus.offset)
  const end = Math.max(selection.anchor.offset, selection.focus.offset)
  block.text = block.text.slice(0, start) + markdown + block.text.slice(end)
  block.setCursor(start + markdown.length, start + markdown.length, true)
  return true
}

/** Parse block markdown through Muya itself; pasted snippets never remain literal fences. */
function insertBlocks(muya: Muya, markdown: string): void {
  const selection = muya.getSelection()
  if (selection?.kind !== SelectionType.TEXT) return
  const anchor = selection.context.anchorBlock.outMostBlock
  if (!anchor?.parent) return
  const states = new MarkdownToState(muya.options).generate(markdown)
  if (!states.length) return
  muya.transact(() => {
    let reference = anchor
    for (const state of states) {
      const block = ScrollPage.loadBlock(state.name).create(muya, state)
      reference.parent!.insertAfter(block, reference)
      reference = block
    }
    const current = selection.context.anchorBlock
    if (current.blockName === 'paragraph' && !current.text.trim() && anchor.parent)
      anchor.remove()
    reference.lastContentInDescendant()?.setCursor(0, 0, true)
  })
}

export function insertMarkdownInMuya(muya: Muya, markdown: string): void {
  muya.focus()
  if (!markdown.includes('\n') && insertInline(muya, markdown)) return
  insertBlocks(muya, markdown)
}

export function executeMuyaCommand(muya: Muya, request: MarkdownCommandRequest): void {
  muya.focus()
  if (request.markdown !== undefined) {
    insertMarkdownInMuya(muya, request.markdown)
    return
  }
  if (request.command === 'table') {
    const rows = Math.max(1, request.table?.rows ?? 2)
    const columns = Math.max(1, request.table?.columns ?? 3)
    muya.createTable({ rows: rows + 1, columns })
    return
  }
  if (request.command === 'footnote') {
    let id = 1
    while (muya.getMarkdown().includes(`[^note${id}]`)) id++
    insertMarkdownInMuya(muya, `[^note${id}]`)
    insertBlocks(muya, `[^note${id}]: 脚注内容`)
    return
  }
  const format = FORMAT_COMMANDS[request.command]
  if (format) muya.format(format)
  const paragraph = PARAGRAPH_COMMANDS[request.command]
  if (paragraph) muya.updateParagraph(paragraph)
}

export function createMuyaRuntime(muya: Muya): MarkdownEditorRuntime {
  return {
    kind: 'muya',
    root: muya.domNode,
    getValue: () => {
      muya.flush()
      return muya.getMarkdown()
    },
    flush: () => muya.flush(),
    focus: () => muya.focus(),
    execute: (request) => executeMuyaCommand(muya, request),
    getSelectionOffsets: () => null,
    setSelectionOffsets: () => undefined,
    search: (query, options) => {
      muya.setSearchVisible(true)
      muya.search(query, {
        isCaseSensitive: options.caseSensitive,
        isWholeWord: options.wholeWord,
        isRegexp: false,
        selectHighlight: true
      })
      return searchResult(muya)
    },
    find: (direction) => {
      muya.find(direction > 0 ? 'next' : 'previous')
      return searchResult(muya)
    },
    replace: (value, all) => {
      muya.replace(value, { isSingle: !all, isRegexp: false })
      return searchResult(muya)
    },
    clearSearch: () => {
      muya.search('')
      muya.setSearchVisible(false)
    },
    scrollToLine: () => undefined,
    viewportLine: () => null,
    caretRect: () => {
      const selection = muya.domNode.ownerDocument.getSelection()
      if (!selection?.rangeCount) return null
      const range = selection.getRangeAt(0)
      if (!muya.domNode.contains(range.startContainer)) return null
      const rect = range.getClientRects()[0] ?? range.getBoundingClientRect()
      return rect.height || rect.width ? rect : null
    },
    undo: () => muya.undo(),
    redo: () => muya.redo(),
    getCursor: () => ({ line: 1, column: 1, selectedText: muya.getSelectedText() })
  }
}
