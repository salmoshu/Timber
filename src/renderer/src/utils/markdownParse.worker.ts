import { MarkdownToState } from '@muyajs/core/state/markdownToState'
import type { TState } from '@muyajs/core'
import type { MarkdownParseOptions } from './parseLongMarkdown'

export type MarkdownParseResult = { state: TState[] } | { error: string }

self.onmessage = ({ data }: MessageEvent<{ markdown: string; options: MarkdownParseOptions }>): void => {
  try {
    const state = new MarkdownToState(data.options).generate(data.markdown)
    self.postMessage({ state } satisfies MarkdownParseResult)
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) } satisfies MarkdownParseResult)
  }
}
