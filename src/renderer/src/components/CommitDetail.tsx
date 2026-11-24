// 提交详情：header（sha/作者/时间/kind）、body、架构影响卡片、AI 会话卡片、文件列表
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CommitFile } from '@shared/types'
import { apiFor, useStore } from '../store'
import EntireCard from './EntireCard'
import { IconChevronDown, IconChevronRight, IconChevronUp, IconCopy, IconSearch } from './icons'

/** 文件变更状态徽章配色（功能色语义） */
const STATUS_COLORS: Record<string, string> = {
  A: 'var(--Colors-PositiveGreen)',
  M: 'var(--Colors-Orange)',
  D: 'var(--Colors-Red)',
  R: 'var(--Colors-KMBlue)'
}

const fullTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })

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
      <span className={`cd-chevron ${open ? 'open' : ''}`}><IconChevronRight size={12} /></span>
      <span
        className="cd-status"
        style={{ background: STATUS_COLORS[file.status] ?? 'var(--Labels-Tertiary)' }}
      >
        {file.status}
      </span>
      <span className="cd-path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
        {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      </span>
      <span className="cd-nums">
        <span className="ins">+{file.insertions}</span>
        <span className="del">−{file.deletions}</span>
      </span>
      {total > 0 && <span className="cd-bar" aria-hidden="true">
        <span className="cd-bar-ins" style={{ width: `${insPct}%` }} />
        <span className="cd-bar-del" style={{ width: `${100 - insPct}%` }} />
      </span>}
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
  let inHunk = false
  const lines = diff.split('\n')
  lines.forEach((raw, i) => {
    if (i === lines.length - 1 && raw === '') return
    if (raw.startsWith('diff --git ')) inHunk = false
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      if (m) {
        oldNo = Number(m[1])
        newNo = Number(m[2])
        inHunk = true
      }
      out.push({ kind: 'hunk', oldNo: null, newNo: null, text: raw })
      return
    }
    if (!inHunk) {
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
  const scroller = useRef<HTMLDivElement>(null)
  const [wrap, setWrap] = useState(false)
  const [hunk, setHunk] = useState(-1)
  const hunks = useMemo(() => lines.filter((line) => line.kind === 'hunk').length, [lines])
  const jump = (next: number) => {
    const parent = scroller.current
    const target = parent?.querySelectorAll<HTMLElement>('.cd-diff-line.hunk')[next]
    if (!parent || !target) return
    parent.scrollTop += target.getBoundingClientRect().top - parent.getBoundingClientRect().top
    setHunk(next)
  }
  if (!diff.trim()) {
    return <div className="cd-diff-empty">该文件在此提交中没有可显示的文本差异（可能是二进制文件或仅重命名）。</div>
  }
  return (
    <div className="cd-diff">
      <div className="cd-diff-tools">
        <span>{hunks > 0 ? `${hunks} 处差异` : '差异'}</span>
        {!!hunks && <>
          <button type="button" className="history-icon" aria-label="上一处差异" title="上一处差异" disabled={hunk <= 0} onClick={() => jump(hunk - 1)}><IconChevronUp /></button>
          <button type="button" className="history-icon" aria-label="下一处差异" title="下一处差异" disabled={hunk >= hunks - 1} onClick={() => jump(hunk + 1)}><IconChevronDown /></button>
        </>}
        <button type="button" className="cd-diff-wrap" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>自动换行</button>
      </div>
      <div className={`cd-diff-scroll ${wrap ? 'wrap' : ''}`} ref={scroller} tabIndex={0} aria-label="文件差异">
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
    </div>
  )
}

export default function CommitDetail() {
  const activeProjectId = useStore((s) => s.activeProjectId)
  const detail = useStore((s) => s.commitDetail)
  const loading = useStore((s) => s.commitDetailLoading)
  const detailError = useStore((s) => s.commitDetailError)
  const selectedSha = useStore((s) => s.selectedSha)
  const ensureCommitImpact = useStore((s) => s.ensureCommitImpact)
  const impact = useStore((s) => (s.selectedSha ? s.commitImpactCache.get(s.selectedSha) : undefined))
  const openArchDelta = useStore((s) => s.openArchDelta)
  const [fileQuery, setFileQuery] = useState('')
  const [expandedPath, setExpandedPath] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<Record<string, { diff?: string; error?: string }>>({})
  const pending = useRef<AbortController | null>(null)

  // 选中后确保影响摘要已算（列表未滚到该行时详情卡片也要显示）
  useEffect(() => {
    const c = useStore.getState().commits.find((x) => x.sha === selectedSha)
    if (c) void ensureCommitImpact(c)
  }, [selectedSha, ensureCommitImpact])

  useEffect(() => () => pending.current?.abort(), [])

  if (!selectedSha) return <div className="hv-empty">从提交列表选择一条记录</div>
  if (loading) return <div className="hv-loading" role="status">正在读取提交详情…</div>
  if (detailError || !detail) return (
    <div className="hv-empty" role="alert">
      <p>{detailError ?? '提交详情不可用'}</p>
      <button className="btn-ghost sm" onClick={() => void useStore.getState().selectCommit(selectedSha)}>重试</button>
    </div>
  )

  const c = detail.commit
  const parent = c.parents[0]
  const date = new Date(c.time * 1000)
  const query = fileQuery.trim().toLowerCase()
  const files = detail.files.filter((file) => !query || file.path.toLowerCase().includes(query) || file.oldPath?.toLowerCase().includes(query))

  const toggleDiff = async (file: CommitFile, retry = false): Promise<void> => {
    pending.current?.abort()
    if (expandedPath === file.path && !retry) { setExpandedPath(null); return }
    if (!activeProjectId) return
    setExpandedPath(file.path)
    if (diffs[file.path]?.diff !== undefined && !retry) return
    setDiffs((current) => ({ ...current, [file.path]: {} }))
    const request = new AbortController()
    pending.current = request
    try {
      const old = file.oldPath ? `&old=${encodeURIComponent(file.oldPath)}` : ''
      const r = await apiFor<{ diff: string }>(activeProjectId)(
        'GET',
        `/api/projects/${activeProjectId}/git/show/${c.sha}/diff?path=${encodeURIComponent(file.path)}${old}`,
        undefined, { signal: request.signal }
      )
      if (!request.signal.aborted) setDiffs((current) => ({ ...current, [file.path]: { diff: r.diff ?? '' } }))
    } catch (err) {
      if (!request.signal.aborted) setDiffs((current) => ({ ...current, [file.path]: { error: String(err) } }))
    }
  }

  const copySha = (): void => {
    void navigator.clipboard.writeText(c.sha)
      .then(() => useStore.getState().toast('ok', '提交 SHA 已复制'))
      .catch(() => useStore.getState().toast('err', '无法写入剪贴板'))
  }

  return (
    <div className="commit-detail">
      <div className="cd-head">
        <div className="cd-title">
          <span className={`hv-kind ${c.kind === 'fix' ? 'fix' : ''}`}>{c.kind}</span>
          <h1 className="cd-subject">{c.subject}</h1>
        </div>
        <div className="cd-meta">
          <button className="cd-sha" onClick={copySha} title={c.sha} aria-label="复制完整提交 SHA">
            <IconCopy size={13} /> {c.short}
          </button>
          <span title={c.email}>{c.author}</span>
          <time dateTime={date.toISOString()}>{fullTime.format(date)}</time>
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
        <div className="cd-files-head">
          <strong className="cd-files-title">变更文件 <span>{detail.files.length}</span></strong>
          <div className="cd-nums">
            <span className="ins">+{c.insertions}</span><span className="del">−{c.deletions}</span>
          </div>
          {detail.files.length > 1 && <div className="history-search">
            <IconSearch />
            <input aria-label="筛选变更文件" type="search" placeholder="筛选文件" value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} />
          </div>}
        </div>
        {files.length === 0 && <div className="hv-empty">{query ? '没有匹配的文件' : '此提交没有文件变更'}</div>}
        {files.map((f) => {
          const isOpen = expandedPath === f.path
          const result = diffs[f.path]
          return (
            <div key={f.oldPath + ':' + f.path} className="cd-file-group">
              <FileRow file={f} open={isOpen} onToggle={() => void toggleDiff(f)} />
              {isOpen && result?.diff === undefined && !result?.error && <div className="cd-diff-loading" role="status">正在读取差异…</div>}
              {isOpen && result?.error && (
                <div className="cd-diff-error" role="alert">
                  {result.error} <button className="btn-ghost sm" onClick={() => void toggleDiff(f, true)}>重试</button>
                </div>
              )}
              {isOpen && result?.diff !== undefined && <InlineDiff diff={result.diff} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
