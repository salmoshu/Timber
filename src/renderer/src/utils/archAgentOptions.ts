export const CLI_AGENTS = ['kimi', 'codex'] as const
export type CliAgent = typeof CLI_AGENTS[number]
export type ArchAgentBackend = CliAgent | 'api'
export type ArchAgentKind = ArchAgentBackend | 'auto'
export type ArchChatMode = 'auto' | 'ask' | 'edit'

export const AGENT_LABELS: Record<ArchAgentKind, string> = {
  auto: '自动',
  kimi: 'Kimi Code',
  codex: 'Codex',
  api: '兼容 API'
}

export interface ArchAgentOptions {
  model: string
  effort: string
  speed: 'default' | 'priority'
  permission: 'read-only' | 'workspace-write' | 'danger-full-access'
}

export interface ArchAgentPreferences {
  agent: ArchAgentKind
  mode: ArchChatMode
  sendShortcut: 'enter' | 'mod-enter'
  providers: Record<ArchAgentBackend, ArchAgentOptions>
}

export const DEFAULT_AGENT_OPTIONS: ArchAgentOptions = { model: '', effort: '', speed: 'default', permission: 'read-only' }

export const DEFAULT_AGENT_PREFERENCES: ArchAgentPreferences = {
  agent: 'auto',
  mode: 'auto',
  sendShortcut: 'enter',
  providers: { kimi: DEFAULT_AGENT_OPTIONS, codex: DEFAULT_AGENT_OPTIONS, api: DEFAULT_AGENT_OPTIONS }
}

const EFFORT_OPTIONS = {
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大'
}

export function agentEffortChoices(agent: ArchAgentBackend): { value: string; label: string }[] {
  const levels = agent === 'kimi' ? ['low', 'medium', 'high', 'xhigh', 'max'] as const
    : agent === 'codex' ? ['minimal', 'low', 'medium', 'high', 'xhigh'] as const : []
  return [{ value: '', label: '跟随 CLI' }, ...levels.map((value) => ({ value, label: EFFORT_OPTIONS[value] }))]
}

export function normalizeAgentOptions(value: Partial<ArchAgentOptions> | undefined, agent: ArchAgentBackend): ArchAgentOptions {
  const scope = value?.permission
  const effort = value?.effort ?? ''
  return {
    model: typeof value?.model === 'string' ? value.model : '',
    effort: agentEffortChoices(agent).some((item) => item.value === effort) ? effort : '',
    speed: agent === 'codex' && value?.speed === 'priority' ? 'priority' : 'default',
    permission: agent === 'codex' && (scope === 'workspace-write' || scope === 'danger-full-access') ? scope : 'read-only'
  }
}

export function loadArchAgentPreferences(value?: ArchAgentPreferences): ArchAgentPreferences {
  let legacy: (Partial<ArchAgentOptions> & { agent?: ArchAgentKind }) | undefined
  if (!value) {
    try { legacy = JSON.parse(localStorage.getItem('timber-arch-agent-options-v1') ?? 'null') ?? undefined } catch { /* Ignore unreadable preferences. */ }
  }
  const agent = value?.agent ?? legacy?.agent ?? 'auto'
  return {
    agent: Object.hasOwn(AGENT_LABELS, agent) ? agent : 'auto',
    mode: value?.mode === 'ask' || value?.mode === 'edit' ? value.mode : 'auto',
    sendShortcut: value?.sendShortcut === 'mod-enter' ? 'mod-enter' : 'enter',
    providers: {
      kimi: normalizeAgentOptions(value?.providers?.kimi ?? (agent === 'auto' || agent === 'kimi' ? legacy : undefined), 'kimi'),
      codex: normalizeAgentOptions(value?.providers?.codex ?? (agent === 'auto' || agent === 'codex'
        ? legacy : { speed: legacy?.speed, permission: legacy?.permission }), 'codex'),
      api: normalizeAgentOptions(value?.providers?.api ?? (agent === 'api' ? legacy : undefined), 'api')
    }
  }
}

export function effectiveArchAgent(agent: ArchAgentKind, hasApi: boolean, fallbackCli?: CliAgent): ArchAgentBackend {
  if (agent !== 'auto') return agent
  return hasApi ? 'api' : fallbackCli ?? 'kimi'
}

export function archRuntimeOptionsForAgent(options: ArchAgentOptions, agent: ArchAgentBackend) {
  const normalized = normalizeAgentOptions(options, agent)
  return {
    model: normalized.model.trim(),
    effort: normalized.effort,
    speed: normalized.speed,
    permission: agent === 'codex' ? normalized.permission : agent === 'kimi' ? 'auto' : 'default'
  }
}
