// 提交详情：header（sha/作者/时间/kind）、body、架构影响卡片、AI 会话卡片、文件列表
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CommitFile } from '@shared/types'
import { apiFor, useStore } from '../store'
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

function FileRow({ file, open, onToggle }: { file: CommitFile; open: boolean; onToggle(): void }) {
  const total = file.insertions + file.deletions
  // ± 行数条：绿色/红色比例（全 0 时显示空条）
  const insPct = total > 0 ? (file.insertions / total) * 100 : 0
  return (
    <button
      type="button"
      className={`cd-file ${open ? 'open' : ''}`}
      onClick={onToggle}
      title={open ? '收起差异' : '在历史中查看差异'}
      aria-expanded={open}
    >
      <span className={`cd-chevron ${open ? 'open' : ''}`} aria-hidden="true">▸</span>
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
    </button>
  )
}

interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'
  oldNo: number | null
  newNo: number | null
  text: string
}

/** 解析 unified diff：hunk 头跟踪新旧行号，空行按上下文行正常计数 */
function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  const lines = diff.split('\n')
  lines.forEach((raw, i) => {
    if (i === lines.length - 1 && raw === '') return
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      if (m) {
        oldNo = Number(m[1])
        newNo = Number(m[2])
      }
      out.push({ kind: 'hunk', oldNo: null, newNo: null, text: raw })
      return
    }
    // 文件头 ---/+++ 属于元信息，不能当删除/新增行
    if (raw.startsWith('+++') || raw.startsWith('---')) {
      out.push({ kind: 'meta', oldNo: null, newNo: null, text: raw })
      return
    }
    if (raw.startsWith('+')) {
      out.push({ kind: 'add', oldNo: null, newNo: newNo++, text: raw.slice(1) })
      return
    }
    if (raw.startsWith('-')) {
      out.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: raw.slice(1) })
      return
    }
    if (raw.startsWith(' ')) {
      out.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: raw.slice(1) })
      return
    }
    out.push({ kind: 'meta', oldNo: null, newNo: null, text: raw })
  })
  return out
}

/** 历史详情内的原地差异视图：双行号 + 增删着色，超长时内部滚动 */
function InlineDiff({ diff }: { diff: string }) {
  const lines = useMemo(() => parseDiff(diff), [diff])
  if (!diff.trim()) {
    return <div className="cd-diff-empty">该文件在此提交中没有可显示的文本差异（可能是二进制文件或仅重命名）。</div>
  }
  return (
    <div className="cd-diff">
      {lines.map((line, i) => (
        <div key={i} className={`cd-diff-line ${line.kind}`}>
          <span className="cd-diff-no">{line.oldNo ?? ''}</span>
          <span className="cd-diff-no">{line.newNo ?? ''}</span>
          <span className="cd-diff-sign">
            {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : line.kind === 'ctx' ? ' ' : ''}
          </span>
          <span className="cd-diff-text">{line.text || ' '}</span>
        </div>
      ))}
    </div>
  )
}

interface ExpandedDiff {
  path: string
  diff: string
  loading: boolean
  error: string | null
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
  const [expanded, setExpanded] = useState<ExpandedDiff | null>(null)
  const diffSeq = useRef(0)

  // 选中后确保影响摘要已算（列表未滚到该行时详情卡片也要显示）
  useEffect(() => {
    const c = useStore.getState().commits.find((x) => x.sha === selectedSha)
    if (c) void ensureCommitImpact(c)
  }, [selectedSha, ensureCommitImpact])

  // 切换提交/项目时收起已展开的差异，并让在途请求失效
  useEffect(() => {
    diffSeq.current++
    setExpanded(null)
  }, [selectedSha, activeProjectId])

  if (!selectedSha) return <div className="hv-empty">选择右侧提交查看详情</div>
  if (loading || !detail) return <div className="hv-loading">加载中…</div>

  const c = detail.commit
  const color = kindColor(c.kind)
  const parent = c.parents[0]

  const toggleDiff = async (file: CommitFile): Promise<void> => {
    if (expanded?.path === file.path) {
      diffSeq.current++
      setExpanded(null)
      return
    }
    if (!activeProjectId) return
    const seq = ++diffSeq.current
    setExpanded({ path: file.path, diff: '', loading: true, error: null })
    try {
      const old = file.oldPath ? `&old=${encodeURIComponent(file.oldPath)}` : ''
      const r = await apiFor<{ diff: string }>(activeProjectId)(
        'GET',
        `/api/projects/${activeProjectId}/git/show/${c.sha}/diff?path=${encodeURIComponent(file.path)}${old}`
      )
      if (diffSeq.current !== seq) return
      setExpanded({ path: file.path, diff: r.diff, loading: false, error: null })
    } catch (err) {
      if (diffSeq.current !== seq) return
      setExpanded({ path: file.path, diff: '', loading: false, error: String(err) })
    }
  }

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
        {detail.files.map((f) => {
          const isOpen = expanded?.path === f.path
          return (
            <div key={f.oldPath + ':' + f.path} className="cd-file-group">
              <FileRow file={f} open={isOpen} onToggle={() => void toggleDiff(f)} />
              {isOpen && expanded.loading && <div className="cd-diff-loading">加载差异…</div>}
              {isOpen && !expanded.loading && expanded.error && (
                <div className="cd-diff-error">差异加载失败：{expanded.error}</div>
              )}
              {isOpen && !expanded.loading && !expanded.error && <InlineDiff diff={expanded.diff} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
