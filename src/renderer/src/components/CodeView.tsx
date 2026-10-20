// 代码视图：highlight.js 只读阅读器（行号、等宽、主题跟随）；
// 源码文件树为 CodeTree（v0.5.6 起挂入侧栏「文件」tab，与文档视图的项目管理区域一致）
import { useEffect, useMemo, useRef, useState } from 'react'
import hljs from 'highlight.js/lib/common'
import type { DocNode } from '@shared/types'
import { origProjectId, rawBaseFor, useStore } from '../store'
import Chevron from './Chevron'
import Logo from './Logo'

/** 扩展名 → 文件类型图标（与侧栏文档树同款，保证两棵树视觉一致；勿从 Sidebar 引入以免循环依赖） */
function extIcon(ext?: string): string {
  switch (ext) {
    case '.md':
    case '.markdown':
    case '.mdown':
    case '.mkd':
      return 'M↓'
    case '.html':
    case '.htm':
      return '<>'
    default:
      return '≡'
  }
}

function extClass(ext?: string): string {
  if (ext === '.md' || ext === '.markdown' || ext === '.mdown' || ext === '.mkd') return 'ext-md'
  if (ext === '.html' || ext === '.htm') return 'ext-html'
  return 'ext-txt'
}

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

/** 递归收集树中的文件节点（带搜索过滤；目录保留有命中的分支） */
function filterTree(node: DocNode, kw: string): DocNode | null {
  if (node.type === 'doc') {
    if (kw && !node.path.toLowerCase().includes(kw)) return null
    return node
  }
  const children = (node.children ?? [])
    .map((c) => filterTree(c, kw))
    .filter((c): c is DocNode => c !== null)
  if (children.length === 0 && kw && !node.name.toLowerCase().includes(kw)) return null
  if (children.length === 0 && node.type === 'dir') return node
  return { ...node, children }
}

function TreeNode({ node, depth }: { node: DocNode; depth: number }) {
  const codeFile = useStore((s) => s.codeFile)
  // 目录默认折叠（0.5.2 起），点击目录名展开
  const [open, setOpen] = useState(false)
  // v0.5.7 起与文档树共用 tree-dir / tree-doc 结构（Chevron 箭头 + 类型图标列），样式完全一致
  if (node.type === 'doc') {
    return (
      <button
        className={`tree-doc ${codeFile === node.path ? 'active' : ''}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => useStore.setState({ codeFile: node.path })}
        title={node.path}
      >
        <span className={`doc-icon ${extClass(node.ext)}`}>{extIcon(node.ext)}</span>
        <span className="doc-name">{node.name}</span>
      </button>
    )
  }
  return (
    <div>
      <button
        className="tree-dir"
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => setOpen(!open)}
      >
        <Chevron open={open} />
        <span className="dir-name">{node.name}</span>
      </button>
      {open && (node.children ?? []).map((c) => <TreeNode key={c.path} node={c} depth={depth + 1} />)}
    </div>
  )
}

export default function CodeView() {
  const activeProjectId = useStore((s) => s.activeProjectId)
  const codeFile = useStore((s) => s.codeFile)
  const [content, setContent] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const codeRef = useRef<HTMLDivElement | null>(null)

  // codeFile 变化：经 /raw 拉取原文（远程项目走远端 base），滚到顶
  useEffect(() => {
    if (!activeProjectId || !codeFile) {
      setContent(null)
      return
    }
    let disposed = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const base = await rawBaseFor(activeProjectId)
        const url = `${base}/raw/${origProjectId(activeProjectId)}/${codeFile
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`
        const r = await fetch(url)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        let text = await r.text()
        const over = text.length > MAX_BYTES
        if (over) text = text.slice(0, MAX_BYTES)
        if (!disposed) {
          setContent(text)
          setTruncated(over)
          setLoading(false)
          if (codeRef.current) codeRef.current.scrollTop = 0
        }
      } catch (err) {
        if (!disposed) {
          setError(String(err))
          setLoading(false)
        }
      }
    })()
    return () => {
      disposed = true
    }
  }, [activeProjectId, codeFile, refreshTick])

  // 语法高亮（失败回退转义纯文本）
  const highlighted = useMemo(() => {
    if (content === null || !codeFile) return null
    const ext = (codeFile.split('.').pop() ?? '').toLowerCase()
    const lang = LANG_BY_EXT[ext]
    try {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(content, { language: lang }).value
      return hljs.highlightAuto(content).value
    } catch {
      return null
    }
  }, [content, codeFile])

  const lines = useMemo(() => {
    if (content === null) return ''
    const count = content.split('\n').length
    let s = ''
    for (let i = 1; i <= count; i++) s += (i > 1 ? '\n' : '') + i
    return s
  }, [content])

  // 空态与文档视图一致：居中应用图标 + 提示（v0.5.7）
  if (!activeProjectId)
    return (
      <div className="reader-empty">
        <Logo size={72} />
        <div className="re-hint">请先在左侧选择项目</div>
      </div>
    )

  return (
    <div className="code-view">
      <div className="cv-code">
        {!codeFile && (
          <div className="reader-empty">
            <Logo size={72} />
            <div className="re-hint">从左侧文件树选择文件，或在历史详情中点击变更文件</div>
          </div>
        )}
        {codeFile && (
          <div className="rt-breadcrumb cv-head" title={codeFile}>
            {codeFile.split('/').map((c, i, arr) => (
              <span key={i} className="crumb">
                {c}
                {i < arr.length - 1 && <span className="crumb-sep">›</span>}
              </span>
            ))}
            <span className="cv-meta">
              {content !== null && !loading ? `${content.split('\n').length} 行 · ` : ''}只读
            </span>
            <button
              className="rt-btn cv-refresh"
              onClick={() => setRefreshTick((t) => t + 1)}
              title="刷新：重新从磁盘读取文件"
            >
              ⟳
            </button>
          </div>
        )}
        <div className="cv-body" ref={codeRef}>
          {codeFile && loading && <div className="hv-loading">加载中…</div>}
          {codeFile && !loading && error && <div className="hv-empty">文件加载失败：{error}</div>}
          {codeFile && !loading && !error && content !== null && (
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
    </div>
  )
}

/** 源码文件树（侧栏「文件」tab 使用，v0.5.6；数据由 store.loadCodeTree 托管，过滤条件本地维护） */
export function CodeTree() {
  const codeTree = useStore((s) => s.codeTree)
  const codeTreeLoading = useStore((s) => s.codeTreeLoading)
  const [filter, setFilter] = useState('')

  const shownTree = useMemo(() => {
    if (!codeTree) return null
    return filterTree(codeTree, filter.trim().toLowerCase())
  }, [codeTree, filter])

  return (
    <>
      <div className="sb-filter">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="搜索文件…"
          spellCheck={false}
        />
      </div>
      <div className="sb-tree">
        {codeTreeLoading && <div className="sb-empty">扫描中…</div>}
        {!codeTreeLoading && shownTree && (shownTree.children ?? []).length === 0 && (
          <div className="sb-empty">无匹配文件</div>
        )}
        {shownTree?.children?.map((c) => <TreeNode key={c.path} node={c} depth={0} />)}
      </div>
    </>
  )
}
