import { create } from 'zustand'

interface WritingPreferences {
  focus: boolean
  typewriter: boolean
  distractionFree: boolean
  autoPair: boolean
  smartLists: boolean
}

const defaults: WritingPreferences = { focus: false, typewriter: false, distractionFree: false, autoPair: true, smartLists: true }
function load(): WritingPreferences {
  try {
    const raw = JSON.parse(localStorage.getItem('timber-writing-v1') ?? '{}')
    return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, typeof raw[key] === 'boolean' ? raw[key] : value])) as unknown as WritingPreferences
  } catch { return { ...defaults } }
}

export const useWritingPreferences = create<WritingPreferences>(() => load())
export function toggleWritingPreference(key: keyof WritingPreferences): void {
  const next = { ...useWritingPreferences.getState(), [key]: !useWritingPreferences.getState()[key] }
  useWritingPreferences.setState(next)
  try { localStorage.setItem('timber-writing-v1', JSON.stringify(next)) } catch { /* Session settings still work when storage is unavailable. */ }
}
