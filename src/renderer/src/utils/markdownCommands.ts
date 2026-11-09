import { useStore } from '../store'
import { formatMarkdown, type MarkdownCommand, type TextEdit } from './markdownEditing'

export interface MarkdownCommandRequest {
  command: MarkdownCommand
  table?: { rows: number; columns: number }
  markdown?: string
}

export const MARKDOWN_COMMAND_EVENT = 'timber:markdown-command'

export function runMarkdownCommand(command: MarkdownCommand, table?: { rows: number; columns: number }): void {
  window.dispatchEvent(new CustomEvent<MarkdownCommandRequest>(MARKDOWN_COMMAND_EVENT, { detail: { command, table } }))
}

/** Chromium's native insertion preserves textarea undo, including multi-line toolbar edits. */
export function applyTextareaEdit(textarea: HTMLTextAreaElement, change: TextEdit): void {
  textarea.focus({ preventScroll: true })
  textarea.setSelectionRange(change.start, change.end)
  if (change.start !== change.end || change.text) {
    if (!document.execCommand('insertText', false, change.text)) textarea.setRangeText(change.text, change.start, change.end, 'end')
    useStore.getState().setDraft(textarea.value)
  }
  textarea.setSelectionRange(change.selectionStart, change.selectionEnd)
  textarea.dispatchEvent(new Event('select', { bubbles: true }))
}

export function applySourceCommand(textarea: HTMLTextAreaElement, request: MarkdownCommandRequest): void {
  const { selectionStart: start, selectionEnd: end, value } = textarea
  const change = request.markdown === undefined ? formatMarkdown(value, start, end, request.command, request.table)
    : { start, end, text: request.markdown, selectionStart: start + request.markdown.length, selectionEnd: start + request.markdown.length }
  applyTextareaEdit(textarea, change)
}

export function formattingShortcut(event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key' | 'code'>): MarkdownCommand | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null
  const key = event.key.toLowerCase()
  if (!event.shiftKey) return ({ b: 'bold', i: 'italic', k: 'link', '`': 'inline-code' } as const)[key as 'b'] ?? null
  if (/^Digit[1-6]$/.test(event.code)) return `h${event.code.slice(-1)}` as MarkdownCommand
  return ({ x: 'strike', h: 'highlight', c: 'code', q: 'quote', u: 'list', o: 'ordered-list', l: 'check', t: 'table', m: 'math' } as const)[key as 'x'] ?? null
}
