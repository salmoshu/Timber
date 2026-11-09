/** Markdown transformations shared by toolbar actions, source editing and regression checks. */
export type MarkdownCommand = 'bold' | 'italic' | 'strike' | 'inline-code' | 'highlight' | 'inline-math' |
  'link' | 'image' | 'paragraph' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' |
  'quote' | 'list' | 'ordered-list' | 'check' | 'code' | 'table' | 'line' | 'math' | 'footnote' | 'frontmatter'

export interface TextEdit {
  start: number
  end: number
  text: string
  selectionStart: number
  selectionEnd: number
}

function edit(start: number, end: number, text: string, from = text.length, to = from): TextEdit {
  return { start, end, text, selectionStart: start + from, selectionEnd: start + to }
}

function lineBounds(value: string, start: number, end: number): [number, number] {
  const from = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const last = end > start && value[end - 1] === '\n' ? end - 1 : end
  const next = value.indexOf('\n', last)
  return [start === 0 ? 0 : from, next < 0 ? value.length : next]
}

/** Handles longer closing fences and ignores backticks inside a tilde fence. */
export function insideCodeFence(value: string, position: number): boolean {
  let fence: { char: string; size: number } | null = null
  for (const line of value.slice(0, position).split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!m) continue
    if (!fence) {
      if (m[1][0] === '`' && m[2].includes('`')) continue
      fence = { char: m[1][0], size: m[1].length }
    } else if (m[1][0] === fence.char && m[1].length >= fence.size && !m[2].trim()) fence = null
  }
  return fence !== null
}

export function markdownTable(rows = 2, columns = 3): string {
  rows = Math.min(50, Math.max(1, Math.trunc(rows) || 2))
  columns = Math.min(20, Math.max(1, Math.trunc(columns) || 3))
  const header = '| ' + Array.from({ length: columns }, (_, i) => `列 ${i + 1}`).join(' | ') + ' |'
  const separator = '| ' + Array(columns).fill('---').join(' | ') + ' |'
  const row = '| ' + Array(columns).fill(' ').join(' | ') + ' |'
  return [header, separator, ...Array(rows).fill(row)].join('\n')
}

export function formatMarkdown(value: string, start: number, end: number, command: MarkdownCommand, table?: { rows: number; columns: number }): TextEdit {
  const selected = value.slice(start, end)
  const wrappers: Partial<Record<MarkdownCommand, string>> = {
    bold: '**', italic: '*', strike: '~~', highlight: '==', 'inline-math': '$'
  }
  let marker = wrappers[command]
  if (command === 'inline-code') {
    const longest = Math.max(0, ...[...selected.matchAll(/`+/g)].map((m) => m[0].length))
    marker = '`'.repeat(longest + 1)
  }
  if (marker) {
    const n = marker.length
    if (start >= n && value.slice(start - n, start) === marker && value.slice(end, end + n) === marker) {
      return edit(start - n, end + n, selected, 0, selected.length)
    }
    if (selected.length >= n * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
      return edit(start, end, selected.slice(n, -n), 0, selected.length - n * 2)
    }
    const text = selected || '文字'
    // Backtick-delimited code containing a backtick at an edge needs padding.
    const pad = command === 'inline-code' && /^`|`$/.test(text) ? ' ' : ''
    return edit(start, end, marker + pad + text + pad + marker, n + pad.length, n + pad.length + text.length)
  }
  if (command === 'link' || command === 'image') {
    const label = (selected || (command === 'image' ? '图片说明' : '链接文字')).replace(/([\\[\]])/g, '\\$1')
    const prefix = command === 'image' ? '!' : ''
    const text = `${prefix}[${label}](https://)`
    const offset = text.indexOf('https://')
    return edit(start, end, text, offset, offset + 8)
  }
  if (command === 'frontmatter') {
    const existing = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(value)
    if (existing) return edit(0, existing[0].length, existing[0], 4, existing[0].lastIndexOf('\n---') > 0 ? existing[0].lastIndexOf('\n---') : existing[0].length)
    return edit(0, 0, '---\ntitle: ""\n---\n\n', 12)
  }
  if (command === 'footnote') {
    let id = 1
    while (value.includes(`[^note${id}]`)) id++
    const reference = `[^note${id}]`
    const before = value.slice(0, start) + selected + reference + value.slice(end)
    const definition = `\n\n${reference}: 脚注内容\n`
    return edit(0, value.length, before + definition, before.length + definition.indexOf('脚注内容'), before.length + definition.indexOf('脚注内容') + 4)
  }
  const [from, to] = lineBounds(value, start, end)
  const lines = value.slice(from, to).split('\n')
  const prefixes: Partial<Record<MarkdownCommand, string>> = { quote: '> ', list: '- ', 'ordered-list': '1. ', check: '- [ ] ' }
  if (command === 'paragraph' || /^h[1-6]$/.test(command) || prefixes[command]) {
    const prefix = command === 'paragraph' ? '' : /^h[1-6]$/.test(command) ? '#'.repeat(Number(command[1])) + ' ' : prefixes[command]!
    const allHavePrefix = !!prefix && lines.every((line) => !line.trim() || (command === 'ordered-list' ? /^\s*\d+[.)]\s+/.test(line)
      : command === 'check' ? /^\s*[-+*]\s+\[[ xX]\]\s*/.test(line)
        : command === 'list' ? /^\s*[-+*]\s+/.test(line) : line.trimStart().startsWith(prefix)))
    let number = 1
    const text = lines.map((line) => {
      if (lines.length > 1 && !line.trim() && command !== 'quote') return line
      const indent = /^\s*/.exec(line)![0]
      const plain = line.slice(indent.length).replace(/^(?:#{1,6}\s+|>\s?|(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/, '')
      const nextPrefix = command === 'ordered-list' ? `${number++}. ` : prefix
      return indent + (allHavePrefix ? '' : nextPrefix) + plain
    }).join('\n')
    return edit(from, to, text, text.length)
  }
  let text = command === 'code' ? `\`\`\`\n${selected || '代码'}\n\`\`\``
    : command === 'math' ? `$$\n${selected || 'E = mc^2'}\n$$`
      : command === 'table' ? markdownTable(table?.rows, table?.columns) : '---'
  const leading = start > 0 && value[start - 1] !== '\n' ? '\n\n' : ''
  const trailing = end < value.length && value[end] !== '\n' ? '\n\n' : '\n'
  const inner = command === 'code' ? text.indexOf('\n') + 1 : command === 'math' ? 3 : 0
  const length = command === 'code' ? (selected || '代码').length : command === 'math' ? (selected || 'E = mc^2').length : text.length
  text = leading + text + trailing
  return edit(start, end, text, leading.length + inner, leading.length + inner + length)
}

export function smartEnter(value: string, start: number, end: number, tabSize = 2): TextEdit | null {
  if (start !== end) return null
  const from = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1
  const before = value.slice(from, start)
  const indent = /^[\t ]*/.exec(before)![0]
  const fenced = insideCodeFence(value, from)
  if (fenced) return edit(start, end, '\n' + indent)
  const opener = /^ {0,3}(`{3,}|~{3,})[^`]*$/.exec(before)
  if (opener && !value.slice(start).trimStart().startsWith(opener[1])) return edit(start, end, '\n\n' + opener[1], 1)
  const list = /^(\s*(?:>\s*)*)((?:[-+*]|\d+[.)]))(\s+)(\[[ xX]\]\s+)?(.*)$/.exec(before)
  if (list) {
    const [, prefix, marker, , task, content] = list
    const restOfLine = value.slice(start).split('\n')[0]
    if (!content.trim() && !restOfLine.trim()) {
      const nested = /(?: {2,}|\t)$/.test(prefix)
      const dedented = prefix.replace(new RegExp(`(?: {1,${tabSize}}|\\t)$`), '')
      return edit(from, start, nested ? dedented + marker + ' ' + (task ? '[ ] ' : '') : prefix)
    }
    const ordered = /^(\d+)([.)])$/.exec(marker)
    const nextMarker = ordered ? `${Number(ordered[1]) + 1}${ordered[2]}` : marker
    return edit(start, end, '\n' + prefix + nextMarker + ' ' + (task ? '[ ] ' : ''))
  }
  const quote = /^(\s*(?:>\s*)+)(.*)$/.exec(before)
  if (quote) {
    if (!quote[2].trim() && !value.slice(start).split('\n')[0].trim()) return edit(from, start, quote[1].replace(/>\s*$/, ''))
    return edit(start, end, '\n' + quote[1])
  }
  return indent ? edit(start, end, '\n' + indent) : null
}

export function indentMarkdown(value: string, start: number, end: number, outdent: boolean, tabSize = 2): TextEdit {
  const indentation = ' '.repeat(tabSize)
  if (!outdent && start === end) return edit(start, end, indentation)
  const [from, to] = lineBounds(value, start, end)
  const lines = value.slice(from, to).split('\n')
  const leading = new RegExp(`^(?:\\t| {1,${tabSize}})`)
  const deltas = lines.map((line) => outdent ? -(leading.exec(line)?.[0].length ?? 0) : tabSize)
  const text = lines.map((line, i) => outdent ? line.slice(-deltas[i]) : indentation + line).join('\n')
  return { start: from, end: to, text, selectionStart: Math.max(from, start + deltas[0]), selectionEnd: Math.max(from, end + deltas.reduce((a, b) => a + b, 0)) }
}

export function pairMarkdown(value: string, start: number, end: number, key: string): TextEdit | null {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' }
  if (key === 'Backspace' && start === end && start > 0 && pairs[value[start - 1]] === value[start]) return edit(start - 1, end + 1, '')
  if (start === end && /[)\]}"'`]/.test(key) && key.length === 1 && value[start] === key) return edit(start, end, '', 1)
  const close = pairs[key]
  if (!close || (start > 0 && value[start - 1] === '\\')) return null
  if (start !== end) return edit(start, end, key + value.slice(start, end) + close, 1, end - start + 1)
  const previous = value[start - 1] ?? ''
  const next = value[start] ?? ''
  if (key === '`' && /^\s*`{1,2}$/.test(value.slice(value.lastIndexOf('\n', start - 1) + 1, start))) return null
  if ((key === '"' || key === "'" || key === '`') && /[\p{L}\p{N}]/u.test(previous)) return null
  if (next && !/[\s)\]}.,;:!?]/.test(next)) return null
  return edit(start, end, key + close, 1)
}

export interface TextMatch { start: number; end: number }
export function textMatches(value: string, query: string, caseSensitive = false, wholeWord = false): TextMatch[] {
  if (!query) return []
  const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'gu' : 'giu')
  const result: TextMatch[] = []
  const wordChar = (s: string): boolean => /[\p{L}\p{N}_]/u.test(s)
  for (const match of value.matchAll(regex)) {
    const start = match.index!
    const end = start + match[0].length
    if (wholeWord && ((start > 0 && wordChar(value[start - 1])) || (end < value.length && wordChar(value[end])))) continue
    result.push({ start, end })
    if (result.length >= 10000) break
  }
  return result
}

export function documentStats(markdown: string) {
  const content = markdown.replace(/^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/, '')
  const text = content.replace(/^\s*(?:`{3,}|~{3,}).*$/gm, '').replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '').replace(/^\s*(?:#{1,6}\s+|>\s*|(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?)/gm, '')
    .replace(/[*_`~=$|]/g, '').trim()
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? []
  const latin = text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ' ').match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) ?? []
  const characters = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.replace(/\s/g, ''))].length
  let fence: { char: string; size: number } | null = null
  let tasks = 0
  let completed = 0
  for (const line of content.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (marker) {
      if (!fence && !(marker[1][0] === '`' && marker[2].includes('`'))) fence = { char: marker[1][0], size: marker[1].length }
      else if (fence && marker[1][0] === fence.char && marker[1].length >= fence.size && !marker[2].trim()) fence = null
      continue
    }
    const task = !fence && /^\s*(?:>\s*)*[-+*]\s+\[([ xX])\]\s+/.exec(line)
    if (task) { tasks++; if (task[1].toLowerCase() === 'x') completed++ }
  }
  const words = cjk.length + latin.length
  return { words, characters, lines: markdown ? markdown.split('\n').length : 0, minutes: words ? Math.max(1, Math.ceil(cjk.length / 400 + latin.length / 220)) : 0, tasks, completed }
}
