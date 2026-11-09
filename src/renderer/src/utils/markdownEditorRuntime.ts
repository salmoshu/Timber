import type { MarkdownCommandRequest } from './markdownCommands'

export interface EditorSearchOptions {
  caseSensitive: boolean
  wholeWord: boolean
}

export interface EditorSearchResult {
  count: number
  index: number
}

export interface EditorCursor {
  line: number
  column: number
  selectedText: string
}

/** The host UI talks to this contract instead of editor-private DOM nodes. */
export interface MarkdownEditorRuntime {
  readonly kind: 'muya' | 'source'
  readonly root: HTMLElement
  getValue(): string
  flush(): void
  focus(): void
  execute(request: MarkdownCommandRequest): void
  getSelectionOffsets(): { start: number; end: number } | null
  setSelectionOffsets(start: number, end: number): void
  search(query: string, options: EditorSearchOptions): EditorSearchResult
  find(direction: 1 | -1): EditorSearchResult
  replace(value: string, all: boolean): EditorSearchResult
  clearSearch(): void
  scrollToLine(line: number): void
  viewportLine(): number | null
  caretRect(offset?: number): DOMRect | null
  undo(): void
  redo(): void
  getCursor(): EditorCursor | null
}

let activeEditor: MarkdownEditorRuntime | null = null

export function registerMarkdownEditor(editor: MarkdownEditorRuntime | null): void {
  activeEditor = editor
  window.dispatchEvent(new Event('timber:editor-runtime-changed'))
}

export function getMarkdownEditor(): MarkdownEditorRuntime | null {
  return activeEditor
}

/** Persist pending Muya transactions before draft snapshots and mode changes. */
export function flushMarkdownEditor(): string | undefined {
  if (!activeEditor) return undefined
  activeEditor.flush()
  return activeEditor.getValue()
}
