import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EntireCatalogEntry } from '@shared/types'
import { entireSessions, entireSync } from '../api'
import { apiCallFor } from '../store'
import EntireCard from './EntireCard'
import EntireSetupButton from './EntireSetup'
import { IconSearch } from './icons'

const checkpointDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })

interface SessionGroup {
  id: string
  checkpoints: EntireCatalogEntry[]
}

const entryKey = (entry: EntireCatalogEntry) => `${entry.checkpointId}:${entry.index}`

function groupSessions(entries: EntireCatalogEntry[]): SessionGroup[] {
  const bySession = new Map<string, SessionGroup>()
  const newestFirst = [...entries].sort((a, b) => b.time - a.time)
  for (const entry of newestFirst) {
    const id = entry.sessionId || entryKey(entry)
    const group = bySession.get(id)
    if (group) group.checkpoints.push(entry)
    else bySession.set(id, { id, checkpoints: [entry] })
  }
  return [...bySession.values()]
}

function SessionHistory({ projectId, group, onCommit }: {
  projectId: string; group: SessionGroup; onCommit: (sha: string) => void
}) {
  const [selected, setSelected] = useState('')
  const entry = group.checkpoints.find((checkpoint) => entryKey(checkpoint) === selected) ?? group.checkpoints[0]
  return (
    <section className="history-session-detail" aria-label="会话详情">
      <h3>{group.checkpoints[0].prompt || 'AI 会话'}</h3>
      <div className="history-visual-meta">
        <span>{entry.agent || '通用 Agent'}</span>
        {entry.model && <span>{entry.model}</span>}
        {!!entry.files && <span>{entry.files} 个涉及文件</span>}
        <span>{group.checkpoints.length} 个已加载的 checkpoint</span>
      </div>
      <div className="history-checkpoints" aria-label="会话 checkpoint">
        {group.checkpoints.map((checkpoint) => (
          <button key={entryKey(checkpoint)} type="button" aria-pressed={checkpoint === entry} onClick={() => setSelected(entryKey(checkpoint))}>
            <span>{checkpoint.time > 0 ? checkpointDate.format(new Date(checkpoint.time * 1000)) : '时间未知'}</span>
            <span className="history-checkpoint-meta">
              {checkpoint.branch && <span>{checkpoint.branch}</span>}
              <code title={checkpoint.checkpointId}>{checkpoint.checkpointId.slice(0, 10)}</code>
            </span>
          </button>
        ))}
      </div>
      {!!entry.commits?.length && (
        <div className="history-session-commits" aria-label="关联提交">
          {entry.commits.map((commit) => (
            <button key={commit.sha} type="button" onClick={() => onCommit(commit.sha)} title={commit.subject}>
              <code>{commit.sha.slice(0, 8)}</code><span>{commit.subject}</span><span aria-hidden="true">→</span>
            </button>
          ))}
        </div>
      )}
      <EntireCard key={entryKey(entry)} projectId={projectId} checkpointId={entry.checkpointId} sessionIndex={entry.index} defaultOpen />
    </section>
  )
}

export default function HistorySessions({ projectId, onCommit }: { projectId: string; onCommit: (sha: string) => void }) {
  const [entries, setEntries] = useState<EntireCatalogEntry[]>([])
  const [page, setPage] = useState({ offset: 0, total: 0, unreadable: 0, linksUnavailable: false })
  const [selected, setSelected] = useState('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<AbortController | null>(null)

  const load = useCallback(async (offset: number) => {
    pending.current?.abort()
    const request = new AbortController()
    pending.current = request
    setLoading(true)
    setError('')
    try {
      const result = await entireSessions(projectId, offset, apiCallFor(projectId), request.signal)
      if (request.signal.aborted) return
      if (!result.ok) throw new Error(result.error === 'not-a-repo' ? '当前项目不是 Git 仓库' : result.error)
      setEntries((existing) => {
        if (offset === 0) return result.entries
        const seen = new Set(existing.map(entryKey))
        return [...existing, ...result.entries.filter((entry) => !seen.has(entryKey(entry)))]
      })
      setPage((previous) => ({
        offset: result.nextOffset,
        total: result.total,
        unreadable: (offset > 0 ? previous.unreadable : 0) + result.unreadable,
        linksUnavailable: (offset > 0 && previous.linksUnavailable) || result.linksUnavailable
      }))
    } catch (err) {
      if (!request.signal.aborted) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!request.signal.aborted) setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load(0)
    return () => pending.current?.abort()
  }, [load])

  const groups = useMemo(() => groupSessions(entries), [entries])
  const needle = query.trim().toLocaleLowerCase()
  const visible = needle ? groups.filter((group) => group.checkpoints.some((entry) =>
    [entry.prompt, entry.agent, entry.model, entry.branch, entry.checkpointId].some((value) => value.toLocaleLowerCase().includes(needle))
  )) : groups
  const current = visible.find((group) => group.id === selected) ?? visible[0]

  async function sync(): Promise<void> {
    setSyncing(true)
    setError('')
    try {
      const result = await entireSync(projectId, apiCallFor(projectId))
      if (!result.ok) throw new Error(result.error === 'no-remote' ? '该仓库未配置 Git 远端' : result.detail ?? result.error)
      await load(0)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSyncing(false)
    }
  }

  return (
    <section className="history-sessions" aria-label="AI 会话" aria-busy={loading || syncing}>
      <div className="history-sessions-tools">
        <div className="history-search">
          <IconSearch />
          <input type="search" aria-label="搜索已加载的 AI 会话" placeholder="搜索会话、Agent 或分支" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <button type="button" className="btn-ghost sm" disabled={loading || syncing} onClick={() => void load(0)}>刷新</button>
        <button type="button" className="btn-ghost sm" disabled={loading || syncing} onClick={() => void sync()}>{syncing ? '同步中…' : '同步'}</button>
        <EntireSetupButton projectId={projectId} />
      </div>
      {(loading || syncing) && <div className="history-progress" role="progressbar" aria-label={syncing ? '正在同步会话' : '正在读取会话'}><span /></div>}
      {error && <p className="entire-error" role="alert">{error}</p>}
      <div className="history-visual-meta" aria-live="polite">
        <span>{groups.length} 条已加载的会话</span><span>已检查 {page.offset} / {page.total} 个本地 checkpoint</span>
      </div>
      {!!page.unreadable && <p className="history-visual-meta">{page.unreadable} 个 checkpoint 的元数据无法读取。</p>}
      {page.linksUnavailable && <p className="history-visual-meta">暂时无法检查关联的 Git 提交。</p>}
      {current ? (
        <div className="history-sessions-layout">
          <div className="history-session-list" aria-label="会话列表">
            {visible.map((group) => {
              const latest = group.checkpoints[0]
              return (
                <button key={group.id} type="button" aria-pressed={group === current} onClick={() => setSelected(group.id)}>
                  <strong title={latest.prompt}>{latest.prompt || 'AI 会话'}</strong>
                  <span>{latest.agent || '通用 Agent'} · {group.checkpoints.length} 个 checkpoint</span>
                </button>
              )
            })}
          </div>
          <SessionHistory key={current.id} group={current} projectId={projectId} onCommit={onCommit} />
        </div>
      ) : !loading && !error && <p className="hv-empty">{needle ? '已加载的会话中没有匹配结果。' : '暂无可读的 Entire 会话。'}</p>}
      {page.offset < page.total && (
        <button type="button" className="hv-more" disabled={loading || syncing} onClick={() => void load(page.offset)}>加载更多 checkpoint</button>
      )}
    </section>
  )
}
