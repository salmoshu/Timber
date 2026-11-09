import type { MarkdownCommand } from './markdownEditing'

export interface MarkdownCommandRequest {
  command: MarkdownCommand
  table?: { rows: number; columns: number }
  markdown?: string
}

export const MARKDOWN_COMMAND_EVENT = 'timber:markdown-command'

export function runMarkdownCommand(command: MarkdownCommand, table?: { rows: number; columns: number }): void {
  window.dispatchEvent(new CustomEvent<MarkdownCommandRequest>(MARKDOWN_COMMAND_EVENT, { detail: { command, table } }))
}

export function formattingShortcut(event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key' | 'code'>): MarkdownCommand | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null
  const key = event.key.toLowerCase()
  if (!event.shiftKey) return ({ b: 'bold', i: 'italic', k: 'link', '`': 'inline-code' } as const)[key as 'b'] ?? null
  if (/^Digit[1-6]$/.test(event.code)) return `h${event.code.slice(-1)}` as MarkdownCommand
  return ({ x: 'strike', h: 'highlight', c: 'code', q: 'quote', u: 'list', o: 'ordered-list', l: 'check', t: 'table', m: 'math' } as const)[key as 'x'] ?? null
}
