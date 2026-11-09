import { create } from 'zustand'

interface WritingPreferences {
  focus: boolean
  typewriter: boolean
  distractionFree: boolean
  autoPair: boolean
  autoPairBracket: boolean
  autoPairQuote: boolean
  autoPairMarkdownSyntax: boolean
  smartLists: boolean
}

const defaults: WritingPreferences = { focus: false, typewriter: false, distractionFree: false, autoPair: true, autoPairBracket: true, autoPairQuote: true, autoPairMarkdownSyntax: true, smartLists: true }
function load(): WritingPreferences {
  try {
    const raw = JSON.parse(localStorage.getItem('timber-writing-v1') ?? '{}')
    const settings = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, typeof raw[key] === 'boolean' ? raw[key] : value])) as unknown as WritingPreferences
    for (const key of ['autoPairBracket', 'autoPairQuote', 'autoPairMarkdownSyntax'] as const) {
      if (typeof raw[key] !== 'boolean') settings[key] = raw.autoPair !== false
    }
    settings.autoPair = settings.autoPairBracket || settings.autoPairQuote || settings.autoPairMarkdownSyntax
    return settings
  } catch { return { ...defaults } }
}

export const useWritingPreferences = create<WritingPreferences>(() => load())
export function toggleWritingPreference(key: keyof WritingPreferences): void {
  const next = { ...useWritingPreferences.getState(), [key]: !useWritingPreferences.getState()[key] }
  if (key === 'autoPair') {
    next.autoPairBracket = next.autoPairQuote = next.autoPairMarkdownSyntax = next.autoPair
  } else if (['autoPairBracket', 'autoPairQuote', 'autoPairMarkdownSyntax'].includes(key)) {
    next.autoPair = next.autoPairBracket || next.autoPairQuote || next.autoPairMarkdownSyntax
  }
  useWritingPreferences.setState(next)
  try { localStorage.setItem('timber-writing-v1', JSON.stringify(next)) } catch { /* Session settings still work when storage is unavailable. */ }
}
