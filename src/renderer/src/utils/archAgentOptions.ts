export type ArchAgentKind = 'auto' | 'kimi' | 'codex' | 'api'

export interface ArchAgentOptions {
  agent: ArchAgentKind
  model: string
  effort: string
  speed: string
  permission: string
}

const STORAGE_KEY = 'timber-arch-agent-options-v1'
const DEFAULT_OPTIONS: ArchAgentOptions = { agent: 'auto', model: '', effort: '', speed: 'default', permission: 'read-only' }

export function loadArchAgentOptions(): ArchAgentOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<ArchAgentOptions> | null
    return {
      agent: ['auto', 'kimi', 'codex', 'api'].includes(saved?.agent ?? '') ? saved!.agent! : DEFAULT_OPTIONS.agent,
      model: typeof saved?.model === 'string' ? saved.model : DEFAULT_OPTIONS.model,
      effort: typeof saved?.effort === 'string' ? saved.effort : DEFAULT_OPTIONS.effort,
      speed: typeof saved?.speed === 'string' ? saved.speed : DEFAULT_OPTIONS.speed,
      permission: typeof saved?.permission === 'string' ? saved.permission : DEFAULT_OPTIONS.permission
    }
  } catch {
    return DEFAULT_OPTIONS
  }
}

export function saveArchAgentOptions(options: ArchAgentOptions): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(options)) } catch { /* 存储不可用时仅保留本次选择 */ }
}

export function effectiveArchAgent(options: ArchAgentOptions, hasApi: boolean, fallbackCli: 'kimi' | 'codex' | null): 'kimi' | 'codex' | 'api' {
  if (options.agent !== 'auto') return options.agent
  return hasApi ? 'api' : fallbackCli ?? 'kimi'
}
