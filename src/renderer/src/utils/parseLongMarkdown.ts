import type { TState } from '@muyajs/core'
import type { MarkdownParseResult } from './markdownParse.worker'

// Used by both the worker and Muya so references, extensions, and fence rules stay identical.
export const MARKDOWN_PARSE_OPTIONS = {
  frontMatter: true,
  footnote: true,
  texMathDollars: true,
  texMathGfm: true,
  githubAlerts: true,
  fancyLists: false,
  multilineBlockquote: false,
  trimUnnecessaryCodeBlockEmptyLines: false
}

export type MarkdownParseOptions = typeof MARKDOWN_PARSE_OPTIONS
export const LONG_MARKDOWN_LENGTH = 32 * 1024

// Keep only the two most recently parsed long documents. No live DOM or plugin listeners are retained.
const recent: { markdown: string; state: TState[] }[] = []

export async function parseLongMarkdown(markdown: string, signal: AbortSignal): Promise<TState[]> {
  signal.throwIfAborted()
  const hit = recent.findIndex((entry) => entry.markdown === markdown)
  if (hit !== -1) {
    const [entry] = recent.splice(hit, 1)
    recent.unshift(entry)
    return entry.state
  }
  const worker = new Worker(new URL('./markdownParse.worker.ts', import.meta.url), { type: 'module' })
  const workerLifetime = new AbortController()
  try {
    const state = await new Promise<TState[]>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true, signal: workerLifetime.signal })
      worker.onmessage = ({ data }: MessageEvent<MarkdownParseResult>) => 'state' in data ? resolve(data.state) : reject(new Error(data.error))
      worker.onerror = (event) => { event.preventDefault(); reject(new Error(event.message || 'Markdown 解析线程未能启动')) }
      worker.onmessageerror = () => reject(new Error('Markdown 解析结果无法读取'))
      worker.postMessage({ markdown, options: MARKDOWN_PARSE_OPTIONS })
    })
    signal.throwIfAborted()
    recent.unshift({ markdown, state })
    recent.length = Math.min(recent.length, 2)
    return state
  } finally {
    workerLifetime.abort()
    worker.terminate()
  }
}
