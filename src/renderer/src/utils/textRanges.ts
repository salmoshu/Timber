import type { Annotation } from '@shared/types'
import { smoothScrollTo } from './scroll'

/** 用 Range 高亮文字，不向可编辑正文插入节点，避免污染 Markdown 和撤销记录。 */
export function setTextHighlight(name: string, ranges: Range[]): void {
  if (typeof Highlight === 'undefined' || !CSS.highlights) return
  if (ranges.length) {
    const highlight = new Highlight(...ranges)
    highlight.priority = name === 'find-current' || name === 'ann-flash' ? 2 : name.startsWith('ann-') ? 0 : 1
    CSS.highlights.set(name, highlight)
  } else CSS.highlights.delete(name)
}

export function collectText(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest('script, style, textarea, [aria-hidden="true"], [style*="display: none"], [style*="display:none"]')
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
  })
  const nodes: Text[] = []
  const starts: number[] = []
  let full = ''
  let node = walker.nextNode()
  while (node) {
    nodes.push(node as Text)
    starts.push(full.length)
    full += node.textContent ?? ''
    node = walker.nextNode()
  }
  return { nodes, starts, full }
}

function textRange(text: ReturnType<typeof collectText>, start: number, end: number): Range | null {
  const first = text.nodes.findIndex((node, i) => text.starts[i] + node.length > start)
  const last = text.nodes.findIndex((node, i) => text.starts[i] + node.length >= end)
  if (first < 0 || last < 0) return null
  const range = document.createRange()
  range.setStart(text.nodes[first], start - text.starts[first])
  range.setEnd(text.nodes[last], end - text.starts[last])
  return range
}

export function findTextRanges(root: HTMLElement, query: string): Range[] {
  if (!query) return []
  const text = collectText(root)
  const full = text.full.toLowerCase()
  const needle = query.toLowerCase()
  const ranges: Range[] = []
  let index = full.indexOf(needle)
  while (index >= 0) {
    const range = textRange(text, index, index + needle.length)
    if (range) ranges.push(range)
    index = full.indexOf(needle, index + needle.length)
  }
  return ranges
}

export function findAnnotationRange(root: HTMLElement, annotation: Annotation): Range | null {
  if (!annotation.quote) return null
  const text = collectText(root)
  let best = -1
  let bestScore = -1
  let index = text.full.indexOf(annotation.quote)
  while (index >= 0) {
    let score = 0
    const before = text.full.slice(Math.max(0, index - annotation.prefix.length), index)
    const after = text.full.slice(index + annotation.quote.length, index + annotation.quote.length + annotation.suffix.length)
    if (annotation.prefix && before === annotation.prefix) score += 2
    if (annotation.suffix && after === annotation.suffix) score += 2
    if (score > bestScore) { best = index; bestScore = score }
    index = text.full.indexOf(annotation.quote, index + 1)
  }
  return best < 0 ? null : textRange(text, best, best + annotation.quote.length)
}

export function scrollToRange(range: Range): void {
  const node = range.startContainer
  const element = node instanceof Element ? node : node.parentElement
  const body = element?.closest<HTMLElement>('.reader-body')
  if (!body) return
  const rect = range.getBoundingClientRect()
  const top = rect.top - body.getBoundingClientRect().top + body.scrollTop
  smoothScrollTo(body, Math.max(0, top - body.clientHeight / 2 + rect.height / 2), 120)
}
