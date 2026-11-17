import type { CodeRange } from '@shared/code'
import { useStore } from '../store'

export interface CodeNavigationLocation {
  projectId: string
  path: string
  range: CodeRange
}

interface HistoryEntry {
  back: CodeNavigationLocation[]
  forward: CodeNavigationLocation[]
}

const histories = new Map<string, HistoryEntry>()
const pending = new Map<string, CodeNavigationLocation>()
let activeLocation: CodeNavigationLocation | null = null
const HISTORY_LIMIT = 100

function sameLocation(a: CodeNavigationLocation, b: CodeNavigationLocation): boolean {
  return a.projectId === b.projectId && a.path === b.path &&
    a.range.start.line === b.range.start.line && a.range.start.character === b.range.start.character
}

function history(projectId: string): HistoryEntry {
  let value = histories.get(projectId)
  if (!value) {
    value = { back: [], forward: [] }
    histories.set(projectId, value)
  }
  return value
}

export function setActiveCodeLocation(location: CodeNavigationLocation): void {
  activeLocation = location
}

export function consumePendingCodeLocation(projectId: string, path: string): CodeNavigationLocation | null {
  const value = pending.get(projectId)
  if (!value || value.path !== path) return null
  pending.delete(projectId)
  return value
}

export async function openCodeLocation(location: CodeNavigationLocation, record = true): Promise<void> {
  if (record && activeLocation && activeLocation.projectId === location.projectId && !sameLocation(activeLocation, location)) {
    const entries = history(location.projectId)
    if (entries.back.length >= HISTORY_LIMIT) entries.back.shift()
    entries.back.push(activeLocation)
    entries.forward = []
  }
  pending.set(location.projectId, location)
  await useStore.getState().openTab(location.path, { pinned: false })
  window.dispatchEvent(new Event('timber:code-location'))
}

export async function navigateCodeHistory(direction: -1 | 1, projectId: string): Promise<boolean> {
  if (!activeLocation || activeLocation.projectId !== projectId) return false
  const entries = history(projectId)
  const source = direction < 0 ? entries.back : entries.forward
  const target = source.pop()
  if (!target) return false
  const destination = direction < 0 ? entries.forward : entries.back
  destination.push(activeLocation)
  await openCodeLocation(target, false)
  return true
}

export function resetCodeNavigation(): void {
  histories.clear()
  pending.clear()
  activeLocation = null
}
