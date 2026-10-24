// 提交详情：header（sha/作者/时间/kind）、body、架构影响卡片、AI 会话卡片、文件列表
import { useEffect, useState } from 'react'
import type { CommitFile } from '@shared/types'
import { useStore } from '../store'
import { kindColor, relativeTime } from './HistoryView'
import EntireCard from './EntireCard'

/** 文件变更状态徽章配色（功能色语义） */
const STATUS_COLORS: Record<string, string> = {
  A: 'var(--Colors-PositiveGreen)',
  M: 'var(--Colors-Orange)',
  D: 'var(--Colors-Red)',
  R: 'var(--Colors-KMBlue)'
}

function fullTime(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function FileRow({ file }: { file: CommitFile }) {
  const openFile = useStore((s) => s.openFile)
  const total = file.insertions + file.deletions
  // ± 行数条：绿色/红色比例（全 0 时显示空条）
  const insPct = total > 0 ? (file.insertions / total) * 100 : 0
  return (
    <div className="cd-file" onClick={() => openFile(file.path)} title="在资源视图中打开">
      <span
        className="cd-status"
        style={{ background: STATUS_COLORS[file.status] ?? 'var(--Labels-Tertiary)' }}
      >
        {file.status}
      </span>
      <span className="cd-path">
        {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      </span>
      <span className="cd-nums">
        <span className="ins">+{file.insertions}</span>
        <span className="del">−{file.deletions}</span>
      </span>
      <span className="cd-bar">
        <span className="cd-bar-ins" style={{ width: `${insPct}%` }} />
        <span className="cd-bar-del" style={{ width: `${100 - insPct}%` }} />
      </span>
    </div>
  )
}

export default function CommitDetail() {
  const activeProjectId = useStore((s) => s.activeProjectId)
  const detail = useStore((s) => s.commitDetail)
  const loading = useStore((s) => s.commitDetailLoading)
  const selectedSha = useStore((s) => s.selectedSha)
  const ensureCommitImpact = useStore((s) => s.ensureCommitImpact)
  const impact = useStore((s) => (s.selectedSha ? s.commitImpactCache.get(s.selectedSha) : undefined))
  const openArchDelta = useStore((s) => s.openArchDelta)
  const [copied, setCopied] = useState(false)

  // 选中后确保影响摘要已算（列表未滚到该行时详情卡片也要显示）
  useEffect(() => {
    const c = useStore.getState().commits.find((x) => x.sha === selectedSha)
    if (c) void ensureCommitImpact(c)
  }, [selectedSha, ensureCommitImpact])

  if (!selectedSha) return <div className="hv-empty">选择右侧提交查看详情</div>
  if (loading || !detail) return <div className="hv-loading">加载中…</div>

  const c = detail.commit
  const color = kindColor(c.kind)
  const parent = c.parents[0]

  const copySha = (): void => {
    void navigator.clipboard?.writeText(c.sha).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="commit-detail">
      <div className="cd-head">
        <div className="cd-title">
          <span className="hv-kind" style={{ background: color }}>{c.kind}</span>
          <span className="cd-subject">{c.subject}</span>
        </div>
        <div className="cd-meta">
          <button className="cd-sha" onClick={copySha} title="点击复制完整 SHA">
            {copied ? '已复制 ✓' : c.short}
          </button>
          <span>{c.author}</span>
          <span>{fullTime(c.time)}（{relativeTime(c.time)}）</span>
        </div>
      </div>
      {detail.body && <pre className="cd-body">{detail.body}</pre>}
      {impact && impact.text && (
        <div className="cd-impact">
          <div className="cd-impact-title">架构影响</div>
          <div className="cd-impact-summary">{impact.text}</div>
          {parent && (
            <button className="cd-impact-btn" onClick={() => openArchDelta(parent, c.sha)}>
              查看架构对比 →
            </button>
          )}
        </div>
      )}
      {c.entireCheckpoint && activeProjectId && (
        <EntireCard key={c.entireCheckpoint} projectId={activeProjectId} checkpointId={c.entireCheckpoint} />
      )}
      <div className="cd-files">
        <div className="cd-files-title">变更文件（{detail.files.length}）</div>
        {detail.files.map((f) => (
          <FileRow key={f.oldPath + ':' + f.path} file={f} />
        ))}
      </div>
    </div>
  )
}
