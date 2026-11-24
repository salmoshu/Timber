import type { AiArchProgress, AiArchUsage, AiConversationExchange } from '../api'
import type { ArchAgentBackend, ArchAgentKind, ArchAgentOptions, ArchChatMode } from './archAgentOptions'

export interface AiFailure {
  title: string
  detail: string
  hint: string
  output?: string
  showSettings?: boolean
}

export interface ArchActivity extends Omit<AiArchProgress, 'text' | 'usage' | 'status'> {
  key: string
  status?: AiArchProgress['status'] | 'stopped'
  output?: string
}

export interface ArchChatTurn {
  id: string
  prompt: string
  action: 'ask' | 'edit' | 'optimize'
  backend: ArchAgentBackend
  model?: string
  startedAt: number
  finishedAt?: number
  ref?: string
  status: 'running' | 'done' | 'stopped' | 'error'
  steps: ArchActivity[]
  answer?: string
  result?: string
  usage?: AiArchUsage
  failure?: AiFailure
}

export interface ArchChatSession {
  id: string
  title: string
  draft: string
  turns: ArchChatTurn[]
  agent?: ArchAgentKind
  mode?: ArchChatMode
  options?: Partial<Record<ArchAgentBackend, Partial<ArchAgentOptions>>>
}

export interface ArchConversation {
  activeId: string
  sessions: ArchChatSession[]
}

const storageKey = (project: string) => `timber-arch-conversations-v1:${project}`

export function createArchSession(): ArchChatSession {
  return { id: crypto.randomUUID(), title: '新会话', draft: '', turns: [] }
}

export function readArchConversation(project: string): ArchConversation {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(project)) ?? 'null') as ArchConversation | null
    if (saved?.sessions?.length) {
      const sessions = saved.sessions.map((session) => ({
        ...session,
        turns: session.turns.map((turn) => turn.status === 'running' ? finishArchTurn(turn, 'stopped') : turn)
      }))
      return { activeId: sessions.find((session) => session.id === saved.activeId)?.id ?? sessions[0].id, sessions }
    }
  } catch { /* Start a conversation if the saved data is unreadable. */ }
  const session = createArchSession()
  return { activeId: session.id, sessions: [session] }
}

export function saveArchConversation(project: string, conversation: ArchConversation): void {
  localStorage.setItem(storageKey(project), JSON.stringify(conversation))
}

export function finishArchTurn(turn: ArchChatTurn, status: 'done' | 'error' | 'stopped'): ArchChatTurn {
  return {
    ...turn, status, finishedAt: Date.now(),
    steps: turn.steps.map((step) => step.status === 'running' ? { ...step, status } : step)
  }
}

export function recentArchExchanges(turns: ArchChatTurn[]): AiConversationExchange[] {
  return turns.filter((turn) => turn.status === 'done' && turn.action !== 'optimize').slice(-6).map((turn) => ({
    prompt: turn.prompt,
    answer: turn.answer ?? turn.result ?? ''
  }))
}
