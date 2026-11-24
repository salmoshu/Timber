import { useMemo, useState } from 'react'
import type { CommitInfo } from '@shared/types'

const shortDate = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' })
const fullDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long' })
const number = new Intl.NumberFormat('zh-CN')
const rowHeight = 46
const laneWidth = 16

interface Lane { sha: string; color: number }
interface Segment { from: number; to: number; start: number; end: number; color: number; dashed?: boolean }

function layoutGraph(commits: CommitInfo[]) {
  const remaining = new Set(commits.map((commit) => commit.sha))
  const lanes: (Lane | null)[] = []
  let width = 1
  let nextColor = 0
  const freeLane = (): number => {
    const index = lanes.indexOf(null)
    return index < 0 ? lanes.length : index
  }

  const rows = commits.map((commit) => {
    remaining.delete(commit.sha)
    const incoming = lanes.findIndex((lane) => lane?.sha === commit.sha)
    const column = incoming < 0 ? freeLane() : incoming
    const color = lanes[column]?.color ?? nextColor++
    const middle = rowHeight / 2
    const segments: Segment[] = []
    lanes.forEach((lane, index) => {
      if (lane) segments.push({ from: index, to: index, start: 0, end: index === column ? middle : rowHeight, color: lane.color })
    })
    lanes[column] = null

    commit.parents.forEach((parent, index) => {
      if (!remaining.has(parent)) return
      let target = lanes.findIndex((lane) => lane?.sha === parent)
      if (target < 0) {
        target = index === 0 ? column : freeLane()
        lanes[target] = { sha: parent, color: index === 0 ? color : nextColor++ }
      }
      segments.push({ from: column, to: target, start: middle, end: rowHeight, color: lanes[target]?.color ?? color })
    })
    if (commit.parents.some((parent) => !remaining.has(parent))) {
      segments.push({ from: column, to: column + .42, start: middle, end: rowHeight - 4, color, dashed: true })
    }
    width = Math.max(width, lanes.length, column + 1)
    return { commit, column, color, segments }
  })
  return { rows, width: (width + .25) * laneWidth }
}

function refLabel(ref: string): string {
  return ref.replace(/^refs\/(?:heads|remotes|tags)\//, '')
}

export function HistoryGraph({ commits, total, loading, onMore, onCommit }: {
  commits: CommitInfo[]; total: number; loading: boolean; onMore: () => void; onCommit: (sha: string) => void
}) {
  const graph = useMemo(() => layoutGraph(commits), [commits])
  return (
    <section className="history-graph" aria-label="提交拓扑" aria-busy={loading}>
      <div className="history-visual-meta">
        <span>已加载 {number.format(commits.length)} / {number.format(total)} 条提交</span>
        <span>双环表示合并，虚线指向当前列表之外的父提交</span>
      </div>
      <div className="history-graph-scroll">
        <div className="history-graph-rows" style={{ minWidth: graph.width + 216 }}>
          {graph.rows.map(({ commit, column, color, segments }) => (
            <button key={commit.sha} type="button" className="history-graph-row" onClick={() => onCommit(commit.sha)}>
              <svg aria-hidden="true" width={graph.width} height={rowHeight} viewBox={`0 0 ${graph.width} ${rowHeight}`}>
                {segments.map(({ from, to, start, end, color, dashed }, index) => {
                  const startX = (from + .5) * laneWidth
                  const endX = (to + .5) * laneWidth
                  const center = (start + end) / 2
                  return <path key={index} className={`history-lane lane-${color % 6}`} d={`M ${startX} ${start} C ${startX} ${center} ${endX} ${center} ${endX} ${end}`} strokeDasharray={dashed ? '2.5 3' : undefined} />
                })}
                <circle className={`history-node lane-${color % 6}`} cx={(column + .5) * laneWidth} cy={rowHeight / 2} r={5} />
                {commit.parents.length > 1 && <circle className={`history-node-core lane-${color % 6}`} cx={(column + .5) * laneWidth} cy={rowHeight / 2} r={2} />}
              </svg>
              <span className="history-graph-description">
                <span className="history-graph-title">
                  <span title={commit.subject}>{commit.subject}</span>
                  {commit.entireCheckpoint && <span className="history-ref ai" title="关联 AI 会话">AI</span>}
                </span>
                <span className="history-graph-byline">
                  <code>{commit.short}</code><span>{commit.author}</span>
                  <span>{shortDate.format(new Date(commit.time * 1000))}</span>
                </span>
              </span>
              {!!commit.refs?.length && <span className="history-ref-list" title={commit.refs.map(refLabel).join(' · ')}>
                {commit.refs.slice(0, 3).map((ref) => (
                  <span key={ref} className={`history-ref${ref.startsWith('refs/tags/') ? ' tag' : ''}`}>{refLabel(ref)}</span>
                ))}
                {commit.refs.length > 3 && <span className="history-ref">+{commit.refs.length - 3}</span>}
              </span>}
            </button>
          ))}
        </div>
      </div>
      {commits.length < total && (
        <button type="button" className="hv-more" disabled={loading} onClick={onMore}>{loading ? '正在读取…' : '加载更多提交'}</button>
      )}
    </section>
  )
}

interface ActivityDay {
  date: Date
  commits: CommitInfo[]
  insertions: number
  deletions: number
}

const activitySpan = 28

function activityDays(commits: CommitInfo[]): ActivityDay[] {
  const last = new Date(commits.reduce((latest, commit) => Math.max(latest, commit.time), commits[0].time) * 1000)
  const days = Array.from({ length: activitySpan }, (_, index): ActivityDay => {
    const date = new Date(last.getFullYear(), last.getMonth(), last.getDate() - activitySpan + 1 + index)
    return { date, commits: [], insertions: 0, deletions: 0 }
  })
  const byDay = new Map(days.map((day) => [day.date.toDateString(), day]))
  for (const commit of commits) {
    const day = byDay.get(new Date(commit.time * 1000).toDateString())
    if (!day) continue
    day.commits.push(commit)
    day.insertions += commit.insertions
    day.deletions += commit.deletions
  }
  return days
}

export function HistoryActivity({ commits, onCommit }: { commits: CommitInfo[]; onCommit: (sha: string) => void }) {
  const [metric, setMetric] = useState<'commits' | 'lines'>('commits')
  const [selectedDate, setSelectedDate] = useState('')
  const days = useMemo(() => activityDays(commits), [commits])
  const active = days.find((day) => day.date.toDateString() === selectedDate) ?? days[days.length - 1]
  const totals = days.reduce((sum, day) => ({
    count: sum.count + day.commits.length,
    insertions: sum.insertions + day.insertions,
    deletions: sum.deletions + day.deletions
  }), { count: 0, insertions: 0, deletions: 0 })
  const measure = (day: ActivityDay) => metric === 'commits' ? day.commits.length : day.insertions + day.deletions
  const maximum = Math.max(1, ...days.map(measure))

  return (
    <section className="history-activity" aria-label="提交活动">
      <div className="history-visual-meta">
        <span>{shortDate.format(days[0].date)} 至 {shortDate.format(days[days.length - 1].date)}</span>
        <span>基于已加载的 {number.format(commits.length)} 条提交</span>
      </div>
      <dl className="history-activity-totals">
        <div><dt>提交</dt><dd>{number.format(totals.count)}</dd></div>
        <div><dt>新增行</dt><dd className="history-insertions">+{number.format(totals.insertions)}</dd></div>
        <div><dt>删除行</dt><dd className="history-deletions">−{number.format(totals.deletions)}</dd></div>
      </dl>
      <div className="history-activity-controls" role="group" aria-label="活动指标">
        <button type="button" className="btn-ghost sm" aria-pressed={metric === 'commits'} onClick={() => setMetric('commits')}>提交数</button>
        <button type="button" className="btn-ghost sm" aria-pressed={metric === 'lines'} onClick={() => setMetric('lines')}>变更行</button>
      </div>
      <div className="history-activity-chart" role="group" aria-label="每日活动">
        {days.map((day) => {
          const value = measure(day)
          const label = `${fullDate.format(day.date)}，${day.commits.length} 条提交，新增 ${day.insertions} 行，删除 ${day.deletions} 行`
          return (
            <button type="button" key={day.date.toDateString()} title={label} aria-label={label} aria-pressed={day === active}
              onClick={() => setSelectedDate(day.date.toDateString())}>
              <span className="history-activity-mark" style={{ height: value ? `${value / maximum * 100}%` : '2px' }}>
                {metric === 'lines' && value > 0 && (
                  <>
                    <span className="history-activity-add" style={{ flexGrow: day.insertions }} />
                    <span className="history-activity-remove" style={{ flexGrow: day.deletions }} />
                  </>
                )}
              </span>
            </button>
          )
        })}
      </div>
      <div className="history-activity-axis">{days.filter((_, index) => index % 7 === 0).map((day) => (
        <span key={day.date.toDateString()}>{shortDate.format(day.date)}</span>
      ))}</div>
      <h3 className="history-activity-date">{fullDate.format(active.date)} · {active.commits.length} 条提交</h3>
      {active.commits.length ? (
        <div className="history-activity-commits">
          {active.commits.map((commit) => (
            <button key={commit.sha} type="button" onClick={() => onCommit(commit.sha)}>
              <span title={commit.subject}>{commit.subject}</span>
              <span className="history-activity-counts"><span className="history-insertions">+{commit.insertions}</span><span className="history-deletions">−{commit.deletions}</span></span>
            </button>
          ))}
        </div>
      ) : <p className="history-visual-meta">这一天没有已加载的提交。</p>}
    </section>
  )
}
