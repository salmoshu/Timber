import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ArchRefs, CommitInfo } from '@shared/types'
import { archRefs } from '../api'
import { apiCallFor, useStore, type HistoryMode } from '../store'
import CommitDetail from './CommitDetail'
import HistorySessions from './HistorySessions'
import { HistoryActivity, HistoryGraph } from './HistoryVisuals'
import { IconChevronUp, IconChevronDown, IconClose, IconPanelRight, IconSearch, WorkspaceIcon } from './icons'
import './HistoryWorkspace.css'

const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long' })
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' })

const historyViews: { mode: HistoryMode; label: string }[] = [
  { mode: 'commits', label: '提交详情' },
  { mode: 'graph', label: '分支图' },
  { mode: 'activity', label: '活动概览' },
  { mode: 'sessions', label: 'AI 会话' }
]

function CommitRow({ commit }: { commit: CommitInfo }) {
  const selected = useStore((s) => s.selectedSha === commit.sha)
  const { selectCommit, setHistoryMode } = useStore.getState()
  const date = new Date(commit.time * 1000)
  return (
    <button
      type="button"
      className={`hv-row ${selected ? 'selected' : ''}`}
      data-sha={commit.sha}
      aria-current={selected ? 'true' : undefined}
      onClick={() => {
        setHistoryMode('commits')
        void selectCommit(commit.sha)
      }}
    >
      <span className={`hv-lane ${commit.parents.length > 1 ? 'merge' : ''}`} aria-hidden="true"><span className="hv-dot" /></span>
      <span className="hv-main">
        <span className="hv-line1">
          <span className="hv-subject" title={commit.subject}>{commit.subject}</span>
          {commit.entireCheckpoint && <span className="hv-entire" title="含关联的 AI 会话">AI</span>}
        </span>
        <span className="hv-line2">
          <span className="hv-author" title={commit.author}>{commit.author}</span>
          <code>{commit.short}</code>
          <time className="hv-time" dateTime={date.toISOString()}>{timeFormat.format(date)}</time>
        </span>
      </span>
    </button>
  )
}

function groupByDay(commits: CommitInfo[]) {
  const groups: { label: string; commits: CommitInfo[] }[] = []
  for (const commit of commits) {
    const label = dateFormat.format(new Date(commit.time * 1000))
    const previous = groups.at(-1)
    if (previous?.label === label) previous.commits.push(commit)
    else groups.push({ label, commits: [commit] })
  }
  return groups
}

export function HistoryList() {
  const projectId = useStore((s) => s.activeProjectId)
  const commits = useStore((s) => s.commits)
  const total = useStore((s) => s.commitsTotal)
  const loading = useStore((s) => s.commitsLoading)
  const error = useStore((s) => s.commitsError)
  const search = useStore((s) => s.commitsQuery)
  const ref = useStore((s) => s.commitsRef)
  const selectedSha = useStore((s) => s.selectedSha)
  const { loadMoreCommits, loadCommits } = useStore.getState()
  const [query, setQuery] = useState(search)
  const [refs, setRefs] = useState<ArchRefs | null>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!projectId) return
    let disposed = false
    archRefs(projectId, apiCallFor(projectId)).then((value) => {
      if (!disposed) setRefs(value)
    }).catch(() => {})
    return () => { disposed = true }
  }, [projectId])

  useEffect(() => {
    if (query.trim() === search) return
    const timer = window.setTimeout(() => {
      list.current?.scrollTo({ top: 0 })
      void loadCommits(query.trim(), ref)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [query, search, ref, loadCommits])

  useEffect(() => {
    list.current?.querySelector('.hv-row.selected')?.scrollIntoView({ block: 'nearest' })
  }, [selectedSha, commits])

  if (!projectId) return <div className="hv-empty">请先在左侧选择项目</div>

  return (
    <>
      <div className="history-side-head">
        <strong>提交历史</strong>
        <span aria-live="polite">{loading ? '加载中' : `${total} 条提交`}</span>
        <button type="button" className="history-icon" aria-label="刷新提交历史" title="刷新提交历史" onClick={() => void loadCommits(query.trim(), ref)}>⟳</button>
      </div>
      <div className="history-filters">
        <div className="history-search">
          <IconSearch />
          <input type="search" aria-label="搜索提交" placeholder="标题、作者或 SHA" value={query} onChange={(event) => setQuery(event.target.value)} />
          {query && <button type="button" className="history-icon" aria-label="清除提交搜索" onClick={() => setQuery('')}><IconClose size={12} /></button>}
        </div>
        <select aria-label="历史分支或标签" value={ref} onChange={(event) => void loadCommits(query.trim(), event.target.value)}>
          <option value="HEAD">当前分支 · HEAD</option>
          <option value="all-branches">所有分支与标签</option>
          {!!refs?.branches?.length && <optgroup label="分支">{refs.branches.filter((branch) => !branch.name.startsWith('entire/checkpoints/')).map((branch) =>
            <option key={branch.name} value={branch.ref ?? `refs/heads/${branch.name}`}>{branch.name}</option>
          )}</optgroup>}
          {!!refs?.tags?.length && <optgroup label="标签">{refs.tags.map((tag) =>
            <option key={tag.name} value={tag.ref ?? `refs/tags/${tag.name}`}>{tag.name}</option>
          )}</optgroup>}
        </select>
      </div>
      <div className="hv-list" ref={list} aria-busy={loading} onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        const target = (event.target as HTMLElement).closest('.hv-row')
        if (!target) return
        const rows = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('.hv-row') ?? [])
        const next = rows[rows.indexOf(target as HTMLButtonElement) + (event.key === 'ArrowUp' ? -1 : 1)]
        event.preventDefault()
        next?.focus()
        next?.click()
      }}>
        {groupByDay(commits).map((group) => (
          <section className="hv-day" key={group.commits[0].sha} aria-label={group.label}>
            <h3>{group.label}</h3>
            {group.commits.map((commit) => <CommitRow key={commit.sha} commit={commit} />)}
          </section>
        ))}
        {loading && <div className="hv-loading" role="status">正在读取提交…</div>}
        {error && <div className="hv-empty" role="alert">{error}</div>}
        {!loading && !error && commits.length === 0 && (
          <div className="hv-empty">{search ? '没有匹配的提交' : '当前引用暂无提交'}</div>
        )}
        {!loading && commits.length > 0 && commits.length < total && (
          <button className="hv-more" onClick={() => void loadMoreCommits()}>加载更多（{commits.length}/{total}）</button>
        )}
      </div>
    </>
  )
}

export default function HistoryView() {
  const projectId = useStore((s) => s.activeProjectId)
  const loadedProject = useStore((s) => s.commitsProjectId)
  const commits = useStore((s) => s.commits)
  const total = useStore((s) => s.commitsTotal)
  const loading = useStore((s) => s.commitsLoading)
  const error = useStore((s) => s.commitsError)
  const mode = useStore((s) => s.historyMode)
  const sha = useStore((s) => s.selectedSha)
  const sidebarOpen = useStore((s) => s.annPanelOpen)
  const { loadCommits, loadMoreCommits, selectCommit, toggleAnnPanel, setHistoryMode } = useStore.getState()
  const detailPane = useRef<HTMLDivElement>(null)
  const index = commits.findIndex((commit) => commit.sha === sha)
  const firstPageLoading = !!projectId && (loadedProject !== projectId || (loading && commits.length === 0))

  useEffect(() => {
    if (projectId && loadedProject !== projectId) void loadCommits()
  }, [projectId, loadedProject, loadCommits])
  useEffect(() => { detailPane.current?.scrollTo({ top: 0 }) }, [sha, projectId, mode])

  const openCommit = (commitSha: string): void => {
    setHistoryMode('commits')
    void selectCommit(commitSha)
  }

  let content: ReactNode
  if (!projectId) {
    content = <div className="hv-empty">请先在左侧选择项目</div>
  } else if (mode === 'sessions') {
    content = <HistorySessions key={projectId} projectId={projectId} onCommit={openCommit} />
  } else if (firstPageLoading) {
    content = <div className="history-initial-loading" role="status"><WorkspaceIcon view="history" size={25} /><span>正在读取提交历史…</span></div>
  } else if (mode === 'commits' && (sha || !error)) {
    content = <CommitDetail key={`${projectId}:${sha}`} />
  } else if (commits.length === 0) {
    content = <div className="hv-empty" role={error ? 'alert' : undefined}>{error || '当前筛选范围没有提交'}</div>
  } else if (mode === 'graph') {
    content = <HistoryGraph commits={commits} total={total} loading={loading} onCommit={openCommit} onMore={() => void loadMoreCommits()} />
  } else {
    content = <HistoryActivity commits={commits} onCommit={openCommit} />
  }

  return (
    <div className="history-view">
      <div className="history-detail-head">
        <div className="history-view-switch" role="group" aria-label="历史视图">
          {historyViews.map((item) => (
            <button key={item.mode} type="button" aria-pressed={mode === item.mode} onClick={() => setHistoryMode(item.mode)}>{item.label}</button>
          ))}
        </div>
        <div className="history-view-actions">
          {mode === 'commits' && !firstPageLoading && index >= 0 && <>
            <span className="history-position">{index + 1} / {commits.length}</span>
            <button type="button" className="history-icon" aria-label="较新的提交" title="较新的提交" disabled={index === 0} onClick={() => void selectCommit(commits[index - 1].sha)}><IconChevronUp /></button>
            <button type="button" className="history-icon" aria-label="较旧的提交" title="较旧的提交" disabled={index === commits.length - 1} onClick={() => void selectCommit(commits[index + 1].sha)}><IconChevronDown /></button>
          </>}
          {!sidebarOpen && <button className="btn-ghost sm history-open-list" onClick={toggleAnnPanel}><IconPanelRight /> 提交列表</button>}
        </div>
      </div>
      {mode !== 'sessions' && (loading || firstPageLoading) && <div className="history-progress" role="progressbar" aria-label="正在读取提交"><span /></div>}
      <div className="hv-detail" ref={detailPane} aria-busy={mode !== 'sessions' && firstPageLoading}>
        {content}
      </div>
    </div>
  )
}
