// 资源视图代码阅读器：highlight.js 只读渲染（行号、等宽、主题跟随）。
// 由 ResourceView 按活动标签文件类型分发挂载（key=tab.id，切文件整体重建，无需手动复位查找条）
import { useEffect, useMemo, useState } from 'react'
import hljs from 'highlight.js/lib/common'
import { useStore } from '../store'
import FindBar from './FindBar'
import TabsBar from './TabsBar'

/** 扩展名 → highlight.js 语言名（common 包内；未知扩展按纯文本） */
const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  cjs: 'javascript', go: 'go', py: 'python', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', cc: 'cpp', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp', rb: 'ruby',
  php: 'php', swift: 'swift', scala: 'scala', sh: 'bash', ps1: 'powershell',
  css: 'css', scss: 'scss', html: 'xml', vue: 'xml', svelte: 'xml',
  md: 'markdown', markdown: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml',
  toml: 'ini', xml: 'xml', csv: 'plaintext', txt: 'plaintext', log: 'plaintext'
}

/** 超大文件截断（highlight 与行号渲染开销保护） */
const MAX_BYTES = 512 * 1024

export default function CodeReader({ path }: { path: string }) {
  const activeDoc = useStore((s) => s.activeDoc)
  const docLoading = useStore((s) => s.docLoading)
  const docError = useStore((s) => s.docError)
  const [findOpen, setFindOpen] = useState(false)

  // Ctrl+F 查找代码正文（组件仅在活动标签为代码文件时挂载，挂载即有效）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setFindOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const rawContent = activeDoc?.path === path ? activeDoc.content : null
  const { content, truncated } = useMemo(() => ({
    content: rawContent === null ? null : rawContent.slice(0, MAX_BYTES),
    truncated: rawContent !== null && rawContent.length > MAX_BYTES
  }), [rawContent])
  const loading = docLoading && rawContent === null
  const error = rawContent === null ? docError : null

  // 语法高亮（失败回退转义纯文本）
  const highlighted = useMemo(() => {
    if (content === null) return null
    const ext = (path.split('.').pop() ?? '').toLowerCase()
    const lang = LANG_BY_EXT[ext]
    try {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(content, { language: lang }).value
      return hljs.highlightAuto(content).value
    } catch {
      return null
    }
  }, [content, path])

  const lines = useMemo(() => {
    if (content === null) return ''
    const count = content.split('\n').length
    let s = ''
    for (let i = 1; i <= count; i++) s += (i > 1 ? '\n' : '') + i
    return s
  }, [content])

  return (
    <div className="reader">
      <TabsBar />
      <div className="rt-breadcrumb cv-head" title={path}>
        {path.split('/').map((c, i, arr) => (
          <span key={i} className="crumb">
            {c}
            {i < arr.length - 1 && <span className="crumb-sep">›</span>}
          </span>
        ))}
        <span className="cv-meta">
          {content !== null && !loading ? `${content.split('\n').length} 行 · ` : ''}只读
        </span>
      </div>
      {findOpen && <FindBar onClose={() => setFindOpen(false)} />}
      <div className="cv-body reader-body">
        {loading && <div className="hv-loading">加载中…</div>}
        {!loading && error && <div className="hv-empty">文件加载失败：{error}</div>}
        {!loading && !error && content !== null && (
          <div className="cv-card">
            {truncated && <div className="cv-truncated">文件过大，仅显示前 512 KB</div>}
            {/* 行号列 + 高亮代码块同行并排（同字号行高天然对齐） */}
            <div className="cv-pre">
              <pre className="cv-gutter">{lines}</pre>
              {highlighted !== null ? (
                <pre
                  className="cv-content hljs"
                  // hljs 输出的 HTML（span 包裹的转义内容）
                  dangerouslySetInnerHTML={{ __html: highlighted }}
                />
              ) : (
                <pre className="cv-content">{content}</pre>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
