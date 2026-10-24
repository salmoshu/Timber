// 提交历史：右侧栏记录列表（lane 圆点 + kind 徽章 + 统计 + 架构影响懒算），中间提交详情
import { useEffect, useRef } from 'react'
import type { CommitInfo } from '@shared/types'
import { useStore } from '../store'
import CommitDetail from './CommitDetail'

/** kind → lane/徽章配色：品牌蓝单色编码，仅 fix 用功能红表达语义 */
const KIND_COLORS: Record<string, string> = {
  feat: 'var(--Colors-KMBlue)',
  fix: 'var(--Colors-Red)',
  docs: 'var(--Colors-KMBlue)',
  refactor: 'var(--Colors-KMBlue)',
  test: 'var(--Colors-KMBlue)',
  build: 'var(--Colors-KMBlue)',
  change: 'var(--Colors-KMBlue)'
}

export function kindColor(kind: string): string {
  return KIND_COLORS[kind] ?? 'var(--Colors-KMBlue)'
}

/** unix 秒 → 相对时间 */
export function relativeTime(unixSec: number): string {
  const diff = Math.max(0, Date.now() - unixSec * 1000)
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  const month = Math.floor(day / 30)
  if (month < 12) return `${month} 个月前`
  return `${Math.floor(month / 12)} 年前`
}

/** 单个提交行（进入视口或选中时懒算架构影响） */
function CommitRow({ commit }: { commit: CommitInfo }) {
  const selectedSha = useStore((s) => s.selectedSha)
  const selectCommit = useStore((s) => s.selectCommit)
  const ensureCommitImpact = useStore((s) => s.ensureCommitImpact)
  const impact = useStore((s) => s.commitImpactCache.get(commit.sha))
  const rowRef = useRef<HTMLDivElement | null>(null)
  const selected = selectedSha === commit.sha
  const merge = commit.parents.length > 1
  const color = kindColor(commit.kind)

  // 懒算：进入视口一次或选中时触发（store 内部按 sha 缓存/去重）
  useEffect(() => {
    if (selected) void ensureCommitImpact(commit)
  }, [selected, commit, ensureCommitImpact])
  useEffect(() => {
    const el = rowRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const ob = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          void ensureCommitImpact(commit)
          ob.disconnect()
        }
      },
      { root: el.closest('.hv-list') }
    )
    ob.observe(el)
    return () => ob.disconnect()
  }, [commit, ensureCommitImpact])

  return (
    <div
      ref={rowRef}
      className={`hv-row ${selected ? 'selected' : ''}`}
      onClick={() => void selectCommit(commit.sha)}
    >
      {/* lane：merge 提交双环圆点 */}
      <span className={`hv-lane ${merge ? 'merge' : ''}`} style={{ color }}>
        <span className="hv-dot" style={{ background: color }} />
      </span>
      <div className="hv-main">
        <div className="hv-line1">
          <span className="hv-kind" style={{ background: color }}>{commit.kind}</span>
          <span className="hv-subject" title={commit.subject}>{commit.subject}</span>
          {commit.entireCheckpoint && (
            <span className="hv-entire" title="含 AI 会话记录（Entire checkpoint）">✨</span>
          )}
        </div>
        <div className="hv-line2">
          <span className="hv-stat ins">+{commit.insertions}</span>
          <span className="hv-stat del">−{commit.deletions}</span>
          <span className="hv-stat files">{commit.files} 文件</span>
          <span className="hv-time">{relativeTime(commit.time)}</span>
          {impact && impact.text && <span className="hv-impact">{impact.text}</span>}
        </div>
      </div>
    </div>
  )
}

export function HistoryList() {
  const activeProjectId = useStore((s) => s.activeProjectId)
  const commits = useStore((s) => s.commits)
  const commitsTotal = useStore((s) => s.commitsTotal)
  const commitsLoading = useStore((s) => s.commitsLoading)
  const loadMoreCommits = useStore((s) => s.loadMoreCommits)

  if (!activeProjectId) return <div className="hv-empty">请先在左侧选择项目</div>

  return (
    <>
      <div className="history-side-head">
        <strong>提交历史</strong>
        {commitsTotal > 0 && <span>{commits.length} / {commitsTotal}</span>}
      </div>
      <div className="hv-list">
        {commits.map((c) => (
          <CommitRow key={c.sha} commit={c} />
        ))}
        {commitsLoading && <div className="hv-loading">加载中…</div>}
        {!commitsLoading && commits.length === 0 && (
          <div className="hv-empty">暂无提交记录（或该项目不是 Git 仓库）</div>
        )}
        {!commitsLoading && commits.length > 0 && commits.length < commitsTotal && (
          <button className="hv-more" onClick={() => void loadMoreCommits()}>
            加载更多（{commits.length}/{commitsTotal}）
          </button>
        )}
      </div>
    </>
  )
}

export default function HistoryView() {
  const activeProjectId = useStore((s) => s.activeProjectId)
  const commitsProjectId = useStore((s) => s.commitsProjectId)
  const commitsLoading = useStore((s) => s.commitsLoading)
  const loadCommits = useStore((s) => s.loadCommits)

  // 项目切换后（或首次进入）加载第一页
  useEffect(() => {
    if (activeProjectId && commitsProjectId !== activeProjectId && !commitsLoading) {
      void loadCommits()
    }
  }, [activeProjectId, commitsProjectId, commitsLoading, loadCommits])

  if (!activeProjectId) return <div className="hv-empty">请先在左侧选择项目</div>

  return (
    <div className="history-view">
      <div className="hv-detail">
        <CommitDetail />
      </div>
    </div>
  )
}
