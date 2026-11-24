import { useCallback, useEffect, useRef, useState } from 'react'
import { aiCliStatus, api, type AiCliConnectionStatus } from '../api'
import { apiCallFor } from '../store'
import { CLI_AGENTS } from './archAgentOptions'

export interface AgentConnection extends AiCliConnectionStatus {
  loading: boolean
  error?: string
}

const initial = (): AgentConnection => ({ cli: null, installed: false, authenticated: false, loading: true })

export function useAgentConnections(projectId: string | null) {
  const [connections, setConnections] = useState({ kimi: initial(), codex: initial() })
  const pending = useRef<AbortController | null>(null)
  const refresh = useCallback(() => {
    pending.current?.abort()
    const request = new AbortController()
    pending.current = request
    setConnections((current) => ({
      kimi: { ...current.kimi, loading: true, error: undefined },
      codex: { ...current.codex, loading: true, error: undefined }
    }))
    const call = projectId ? apiCallFor(projectId) : api
    for (const agent of CLI_AGENTS) {
      aiCliStatus(projectId, call, agent, request.signal).then((status) => {
        if (!request.signal.aborted) {
          setConnections((current) => ({ ...current, [agent]: { ...status, loading: false } }))
        }
      }).catch((error) => {
        if (!request.signal.aborted) {
          setConnections((current) => ({ ...current, [agent]: { ...initial(), loading: false, error: String(error) } }))
        }
      })
    }
  }, [projectId])

  useEffect(() => {
    setConnections({ kimi: initial(), codex: initial() })
    refresh()
    return () => pending.current?.abort()
  }, [refresh])

  const ready = CLI_AGENTS.find((agent) => connections[agent].installed && connections[agent].authenticated)
    ?? CLI_AGENTS.find((agent) => connections[agent].installed)

  return { connections, refresh, ready }
}

export function connectionLabel(connection: AgentConnection): string {
  if (connection.loading) return '检测中…'
  if (connection.error) return '检测失败'
  if (!connection.installed) return '未安装'
  if (connection.authenticated) return '已登录'
  return '未登录'
}
