import { useState, type FormEvent } from 'react'
import type { EntireSearchHit, SearchResponse } from '@shared/types'
import { apiCallFor, apiFor } from '../store'
import { DOC_FORMAT_GROUPS } from '@shared/types'
import { useStore } from '../store'
import { isBlocked } from '../utils/local-store'
import { entireSearch } from '../api'
import EntireCard from './EntireCard'

/** 关键词高亮：大小写不敏感切分文本 */
function highlight(text: string, kw: string): (string | { hit: string })[] {
  const out: (string | { hit: string })[] = []
  const lower = text.toLowerCase()
  const needle = kw.toLowerCase()
  let i = 0
  while (i < text.length) {
    const idx = lower.indexOf(needle, i)
    if (idx < 0) {
      out.push(text.slice(i))
      break
    }
    if (idx > i) out.push(text.slice(i, idx))
    out.push({ hit: text.slice(idx, idx + needle.length) })
    i = idx + needle.length
  }
  return out
}

/** 侧栏「搜索」页签：项目内全文搜索（sidecar /search），命中点击跳转文档并定位 */
export default function SearchPanel({ projectId }: { projectId: string }) {
  const { openDoc, setPendingLocate, toast } = useStore()
  const [q, setQ] = useState('')
  const [result, setResult] = useState<SearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  // 包含 AI 会话（Entire checkpoint 搜索，默认关）
  const [withEntire, setWithEntire] = useState(false)
  const [entireHits, setEntireHits] = useState<EntireSearchHit[] | null>(null)

  const doSearch = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    const kw = q.trim()
    if (!kw || loading) return
    setLoading(true)
    try {
      const keys = useStore.getState().settings.docFormats
      const exts = DOC_FORMAT_GROUPS.filter((g) => keys.includes(g.key)).flatMap((g) => g.exts)
      const r = await apiFor<SearchResponse>(projectId)(
        'GET',
        `/api/projects/${projectId}/search?q=${encodeURIComponent(kw)}&exts=${encodeURIComponent(exts.join(','))}`
      )
      // 屏蔽的文档不参与结果
      r.files = r.files.filter((f) => !isBlocked(projectId, f.path))
      setResult(r)
      if (withEntire) {
        // 会话搜索失败不影响文件结果
        try {
          const er = await entireSearch(projectId, kw, apiCallFor(projectId))
          setEntireHits(er.ok ? er.results : [])
        } catch {
          setEntireHits([])
        }
      } else {
        setEntireHits(null)
      }
    } catch (err) {
      toast('err', `搜索失败：${err}`)
    } finally {
      setLoading(false)
    }
  }

  const jump = (path: string): void => {
    setPendingLocate({ path, keyword: q.trim() })
    void openDoc(path)
    // 在代码/架构等视图下搜索时，跳回文档视图以呈现结果
    const s = useStore.getState()
    if (s.view !== 'docs') s.setView('docs')
  }

  const totalMatches = result?.files.reduce((n, f) => n + f.count, 0) ?? 0

  return (
    <div className="search-panel">
      <form className="sp-head" onSubmit={(e) => void doSearch(e)}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索项目文档内容…"
          spellCheck={false}
          autoFocus
        />
        <button className="sp-go" type="submit" disabled={loading || !q.trim()} title="搜索">
          {loading ? '…' : '⌕'}
        </button>
      </form>
      <label className="sp-entire-toggle">
        <input
          type="checkbox"
          checked={withEntire}
          onChange={(e) => setWithEntire(e.target.checked)}
        />
        包含 AI 会话
      </label>

      <div className="sp-results">
        {result && result.files.length === 0 && (
          <div className="sb-empty">没有找到包含「{result.query}」的文档。</div>
        )}
        {result && result.files.length > 0 && (
          <div className="sp-summary">
            「{result.query}」命中 {result.files.length} 个文件 / {totalMatches} 处
            {result.truncated ? '（已截断）' : ''}
          </div>
        )}
        {result?.files.map((f) => (
          <div key={f.path} className="sp-file">
            <button className="sp-file-name" onClick={() => jump(f.path)} title={f.path}>
              <span className="doc-icon ext-md">{f.ext === '.html' || f.ext === '.htm' ? '<>' : 'M↓'}</span>
              <span className="sp-file-text">{f.path.split('/').pop()}</span>
              <span className="sp-file-count">{f.count}</span>
            </button>
            <div className="sp-matches">
              {f.matches.map((m, i) => (
                <button key={i} className="sp-match" onClick={() => jump(f.path)} title={`第 ${m.line} 行`}>
                  <span className="sp-line">{m.line}</span>
                  <span className="sp-text">
                    {highlight(m.text, result.query).map((part, j) =>
                      typeof part === 'string' ? (
                        <span key={j}>{part}</span>
                      ) : (
                        <mark className="sp-kw" key={j}>
                          {part.hit}
                        </mark>
                      )
                    )}
                  </span>
                </button>
              ))}
              {f.count > f.matches.length && (
                <div className="sp-more">…另有 {f.count - f.matches.length} 处命中</div>
              )}
            </div>
          </div>
        ))}
        {withEntire && entireHits && (
          <div className="sp-entire">
            <div className="sp-entire-title">AI 会话（{entireHits.length}）</div>
            {entireHits.length === 0 && <div className="sb-empty">AI 会话无命中（或该项目无 Entire 记录）</div>}
            {entireHits.map((h) => (
              <EntireSearchRow key={h.checkpointId} hit={h} projectId={projectId} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** AI 会话命中行：点击内联展开会话卡片（复用提交详情的 EntireCard） */
function EntireSearchRow({ hit, projectId }: { hit: EntireSearchHit; projectId: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="sp-entire-hit">
      <button className="sp-entire-row" onClick={() => setOpen(!open)}>
        <span className="ec-spark">✨</span>
        <span className="sp-entire-id">{hit.checkpointId.slice(0, 8)}</span>
        <span className="sp-entire-kinds">{hit.files.join(' / ')}</span>
        <span className="ec-chevron">{open ? '▴' : '▾'}</span>
      </button>
      {hit.prompt && <div className="sp-entire-prompt" title={hit.prompt}>{hit.prompt}</div>}
      {open && (
        <EntireCard projectId={projectId} checkpointId={hit.checkpointId} defaultOpen />
      )}
    </div>
  )
}
