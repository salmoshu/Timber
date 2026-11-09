import AnnotationPanel, { DocumentOutline } from './AnnotationPanel'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import MarkdownView, { selectionAnchor } from './MarkdownView'
import EditorPane from './EditorPane'
import Logo from './Logo'
import TabsBar from './TabsBar'
import FindBar from './FindBar'
import PagedPreview from './PagedPreview'
import ExcelView from './ExcelView'
import ContextMenu, { type MenuItem } from './ContextMenu'
import { findTextRanges, scrollToRange, setTextHighlight } from '../utils/textRanges'
import { rawBaseFor, origProjectId } from '../store'
import { exportActiveDocument, type DocumentExportKind } from '../utils/documentExport'
import { IconAnnotation, IconExport, IconRead, IconSource, IconPagePreview } from './icons'
import { MarkdownInsertPalette, WritingStatus } from './WritingTools'
import { useWritingExperience } from '../utils/useWritingExperience'
import { getMarkdownEditor } from '../utils/markdownEditorRuntime'

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']

/** 模块级滚动记忆（tabId → scrollTop）：切视图（文档/代码/架构/历史）会卸载 Reader，
 *  store 的 tab.scrollTop 只在切标签/项目时保存，覆盖不到卸载场景；这里持续记录、重挂载恢复 */
const scrollMem = new Map<string, number>()

/** 在 .prose 内查找关键词首个出现处，滚动并短暂高亮 */
function locateKeyword(keyword: string): boolean {
  const prose = document.querySelector('.prose')
  if (!prose) return false
  const range = findTextRanges(prose as HTMLElement, keyword)[0]
  if (!range) return false
  setTextHighlight('search-hit', [range])
  scrollToRange(range)
  setTimeout(() => setTextHighlight('search-hit', []), 2400)
  return true
}

export default function Reader() {
  const [marginExpanded, setMarginExpanded] = useState(false)
  const [marginHidden, setMarginHidden] = useState(false)
  const [marginWidth, setMarginWidth] = useState(190)
  const composeQuote = useStore((s) => s.composeQuote)
  const activeDoc = useStore((s) => s.activeDoc)
  const docLoading = useStore((s) => s.docLoading)
  const docError = useStore((s) => s.docError)
  const mode = useStore((s) => s.mode)
  const setMode = useStore((s) => s.setMode)
  const pendingLocate = useStore((s) => s.pendingLocate)
  const annotations = useStore((s) => s.annotations)
  const setComposeQuote = useStore((s) => s.setComposeQuote)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const activeTabId = useStore((s) => s.activeTabId)
  const closeTab = useStore((s) => s.closeTab)
  const annotationsOpen = !marginHidden && marginExpanded
  // 标签展开与分页预览是当前文档的临时 UI 状态：打开新文档时回到连续阅读。
  useEffect(() => {
    setMarginExpanded(false)
    setMarginHidden(false)
    setPaged(false)
    setPagedEdit(false)
    setExportMenu(null)
  }, [activeDoc?.path])
  useEffect(() => { if (composeQuote) { setMarginExpanded(true); setMarginHidden(false) } }, [composeQuote])
  useEffect(() => {
    const open = (): void => { setPaged(true); setMode('read') }
    window.addEventListener('timber:paged-preview', open)
    return () => window.removeEventListener('timber:paged-preview', open)
  }, [setMode])

  const proseWrapRef = useRef<HTMLDivElement>(null)
  const [rawBase, setRawBase] = useState('')
  const [findOpen, setFindOpen] = useState(false)
  const [findReplace, setFindReplace] = useState(false)
  const [paged, setPaged] = useState(false)
  const [pagedEdit, setPagedEdit] = useState(false)
  const [exportMenu, setExportMenu] = useState<{ x: number; y: number } | null>(null)
  const [htmlError, setHtmlError] = useState<string | null>(null)
  const startMarginResize = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = e.currentTarget.parentElement!.getBoundingClientRect().width
    const onMove = (ev: MouseEvent): void => setMarginWidth(Math.min(420, Math.max(150, startW + startX - ev.clientX)))
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('col-resizing')
    }
    document.body.classList.add('col-resizing')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // HTML 文档经 sidecar /raw 以真实 URL 加载（远程项目走远端 base）
  useEffect(() => {
    void rawBaseFor(activeProjectId).then(setRawBase)
  }, [activeProjectId])

  // Ctrl+F 查找渲染正文；高亮使用 Range，不修改编辑器 DOM。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
        const runtime = getMarkdownEditor()
        if (!runtime || !(e.target instanceof Node) || !runtime.root.contains(e.target)) return
        e.preventDefault()
        if (runtime.kind === 'source') {
          const { start, end } = runtime.getSelectionOffsets() ?? { start: 0, end: 0 }
          const value = runtime.getValue()
          const quote = value.slice(start, end)
          if (quote.trim()) setComposeQuote({ quote, prefix: value.slice(Math.max(0, start - 40), start), suffix: value.slice(end, end + 40) })
        } else {
          const anchor = selectionAnchor(runtime.root)
          if (anchor) setComposeQuote(anchor)
        }
        return
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && ['f', 'h'].includes(e.key.toLowerCase())) {
        if (!useStore.getState().activeDoc || document.querySelector('.paged-preview')) return
        e.preventDefault()
        setFindReplace(e.key.toLowerCase() === 'h')
        setFindOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 切换模式/文档时清理选区气泡和临时高亮。
  useEffect(() => {
    setFindOpen(false)
    setTextHighlight('search-hit', [])
  }, [mode, activeTabId])

  // 搜索结果跳转：文档渲染完成后滚动到关键词命中处
  useEffect(() => {
    if (!pendingLocate || !activeDoc || mode !== 'read') return
    if (pendingLocate.path !== activeDoc.path) return
    const kw = pendingLocate.keyword
    const locate = (): void => {
      if (!document.querySelector('.prose')) return
      useStore.getState().setPendingLocate(null)
      if (!locateKeyword(kw)) {
        useStore.getState().toast('info', '已打开文档，但未能定位到关键词位置')
      }
    }
    const t = setTimeout(locate, 350)
    window.addEventListener('markdown-rendered', locate, { once: true })
    return () => {
      clearTimeout(t)
      window.removeEventListener('markdown-rendered', locate)
    }
  }, [activeDoc, mode, pendingLocate])

  const isImage = activeDoc && IMAGE_EXTS.includes(activeDoc.ext)
  const isExcel = activeDoc && ['xlsx', 'xls'].includes(activeDoc.ext)
  const isMd = activeDoc && ['md', 'markdown', 'mdown', 'mkd'].includes(activeDoc.ext)
  const isHtml = activeDoc && ['html', 'htm'].includes(activeDoc.ext)
  const writingClass = useWritingExperience(!!isMd, paged)

  // HTML、图片与 Excel 经 sidecar /raw 以真实 URL 加载（远程项目走远端 base）
  const rawUrl =
    activeDoc && rawBase
      ? `${rawBase}/raw/${origProjectId(activeProjectId ?? '')}/${activeDoc.path
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`
      : ''

  // HTML 直读失败时（文件被移动/重命名、路径越界等）展示错误卡片，
  // 而不是把服务端返回的 {"error":...} JSON 原文扔进 iframe
  useEffect(() => {
    setHtmlError(null)
    if (!isHtml || !rawUrl) return
    let dead = false
    fetch(rawUrl, { headers: { Range: 'bytes=0-0' } })
      .then(async (r) => {
        if (dead || r.ok) return
        const d = (await r.json().catch(() => ({}))) as { error?: string }
        setHtmlError(d.error ?? `HTTP ${r.status}`)
      })
      .catch((err) => {
        if (!dead) setHtmlError(`无法连接文件服务：${err instanceof Error ? err.message : err}`)
      })
    return () => {
      dead = true
    }
  }, [isHtml, rawUrl])

  // 滚动位置记忆：持续记录（rAF 节流），重挂载后恢复；
  // 切回应用窗口时若滚动被异常重置到顶部，也按记忆恢复（scrollTop===0 且记忆>0 才动手，
  // 用户自己滚到顶时记忆已被滚动监听同步成 0，不会误拉回去）
  useEffect(() => {
    if (!activeTabId) return
    const tabId = activeTabId
    const body = proseWrapRef.current
    if (!body) return
    let raf = 0
    const onScroll = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => scrollMem.set(tabId, body.scrollTop))
    }
    body.addEventListener('scroll', onScroll, { passive: true })
    const remembered = scrollMem.get(tabId) ?? 0
    const restore = (): void => {
      if (remembered > 0 && body.scrollTop === 0) body.scrollTop = remembered
    }
    // 等正文渲染出来再恢复（图片等晚加载资源造成的后续位移不追）
    const t1 = setTimeout(restore, 120)
    const t2 = setTimeout(restore, 600)
    window.addEventListener('markdown-rendered', restore, { once: true })
    const onFocus = (): void => {
      const mem = scrollMem.get(tabId) ?? 0
      if (mem > 0 && body.scrollTop === 0) body.scrollTop = mem
    }
    window.addEventListener('focus', onFocus)
    return () => {
      body.removeEventListener('scroll', onScroll)
      window.removeEventListener('markdown-rendered', restore)
      window.removeEventListener('focus', onFocus)
      cancelAnimationFrame(raf)
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [activeTabId, activeDoc])


  if (!activeDoc) {
    // 标签栏始终保留：打开失败的文档不再「吃掉」整个阅读区，错误卡片提供关闭出口
    return (
      <div className="reader resource-reader">
        <TabsBar />
        <div className="reader-empty">
          {docLoading ? (
            <div className="re-hint">读取中…</div>
          ) : docError && activeTabId ? (
            <div className="re-error">
              <div className="re-error-icon">⚠</div>
              <div className="re-error-title">文档打开失败</div>
              <div className="re-error-desc">{docError}</div>
              <button className="btn-primary sm" onClick={() => closeTab(activeTabId)}>
                关闭标签页
              </button>
            </div>
          ) : (
            <Logo size={72} />
          )}
        </div>
      </div>
    )
  }

  // 面包屑分段（VSCode 风格：目录 › 目录 › 文件）
  const crumbs = activeDoc.path.split('/')
  const hasModeTools = isMd || activeDoc.ext === 'txt' || isHtml
  const exportItems: MenuItem[] = (['pdf', 'word', 'image', 'html'] as DocumentExportKind[]).map((kind) => ({
    key: kind,
    label: kind === 'pdf' ? '导出 PDF（按分页预览）' : kind === 'word' ? '导出 Word (.docx)' : kind === 'html' ? '导出 HTML（含本地图片）' : '导出长图 (.png)',
    onClick: () => void exportActiveDocument(kind)
  }))

  return (
    <div className={`reader resource-reader ${writingClass}`}>
      <TabsBar>
        {hasModeTools && (
          <div className="rt-tool-group">
            <div className="reader-mode-controls">
              <button className={`reader-mode-switch ${mode === 'source' ? 'source' : ''}`}
                role="switch" aria-label="源码模式" aria-checked={mode === 'source'}
                title={mode === 'source' ? '切换到阅读模式' : '切换到源码模式'}
                onClick={() => { setPaged(false); setMode(mode === 'source' ? 'read' : 'source') }}>
                <span className="mode-switch-thumb" aria-hidden="true" />
                <span title="阅读模式"><IconRead /></span><span title="源码模式"><IconSource /></span>
              </button>
              {isMd && (
                <button
                  className={`reader-preview-button ${paged ? 'on' : ''}`}
                  onClick={() => { setPaged(!paged); setMode('read') }}
                  title="A4 分页预览（PDF 按此分页导出）"
                  aria-label="分页预览"
                  aria-pressed={paged}
                >
                  <IconPagePreview />
                </button>
              )}
            </div>
          </div>
        )}
        {isMd && window.timber && (
          <div className="rt-tool-group">
            <button
              className="rt-btn"
              title="导出 PDF / Word / 长图 / HTML"
              aria-label="导出文档"
              aria-expanded={!!exportMenu}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                setExportMenu({ x: rect.left, y: rect.bottom + 4 })
              }}
            >
              <IconExport />
            </button>
          </div>
        )}
        {hasModeTools && (
          <div className="rt-tool-group">
            <button
              className={`rt-btn ${annotationsOpen ? 'active' : ''}`}
              title={annotationsOpen ? `收起标签（${annotations.length}）` : `展开标签（${annotations.length}）`}
              aria-label={annotationsOpen ? '收起标签' : '展开标签'}
              aria-expanded={annotationsOpen}
              onClick={() => {
                if (annotationsOpen) {
                  setMarginExpanded(false)
                  setMarginHidden(true)
                } else {
                  setMarginExpanded(true)
                  setMarginHidden(false)
                }
              }}
            >
              <IconAnnotation />
            </button>
          </div>
        )}
      </TabsBar>

      <div className="rt-breadcrumb" title={activeDoc.path}>
        {crumbs.map((c, i) => (
          <span key={i} className="crumb">
            {c}
            {i < crumbs.length - 1 && <span className="crumb-sep">›</span>}
          </span>
        ))}
      </div>

      {isMd && !paged && <MarkdownInsertPalette />}
      {findOpen && <FindBar replace={findReplace} onClose={() => setFindOpen(false)} />}

      <div className={`document-workspace ${!paged && (activeDoc.ext === 'md' || mode === 'source') ? 'with-outline' : ''}`}>
      {!paged && <DocumentOutline />}
      <div
        className="reader-body"
        ref={proseWrapRef}
      >
        {paged && isMd ? (
          pagedEdit ? (
            // 对照编辑（v0.6.11）：左侧所见即所得编辑，右侧 A4 分页实时重排
            <div className="paged-split">
              <div className="paged-editor-col">
                <MarkdownView
                  annotations={annotations}
                  onSelectAnn={() => {
                    setMarginExpanded(true)
                    setMarginHidden(false)
                  }}
                />
              </div>
              <div className="paged-preview-col">
                <PagedPreview
                  docPath={activeDoc.path}
                  projectId={activeProjectId ?? ''}
                  editOn
                  onToggleEdit={() => setPagedEdit(false)}
                />
              </div>
            </div>
          ) : (
            <PagedPreview
              docPath={activeDoc.path}
              projectId={activeProjectId ?? ''}
              editOn={false}
              onToggleEdit={() => setPagedEdit(true)}
            />
          )
        ) : mode === 'source' ? (
          <EditorPane />
        ) : isMd ? (
          <MarkdownView
            annotations={annotations}
            onSelectAnn={() => {
              setMarginExpanded(true)
              setMarginHidden(false)
            }}
          />
        ) : isExcel ? (
          <ExcelView url={rawUrl} title={activeDoc.path} />
        ) : isImage ? (
          <div className="img-view-wrap">
            <img className="img-view" src={rawUrl} alt={activeDoc.path} />
          </div>
        ) : isHtml ? (
          htmlError ? (
            <div className="reader-empty">
              <div className="re-error">
                <div className="re-error-icon">⚠</div>
                <div className="re-error-title">网页加载失败</div>
                <div className="re-error-desc">{htmlError}</div>
              </div>
            </div>
          ) : (
            rawUrl && (
              <iframe
                className="html-view"
                sandbox="allow-scripts allow-forms allow-popups allow-same-origin allow-modals"
                src={rawUrl}
                title={activeDoc.path}
              />
            )
          )
        ) : (
          <pre className="txt-view">{activeDoc.content}</pre>
        )}

      </div>
      <div
        className={`document-margin ${marginExpanded ? 'expanded' : ''} ${annotationsOpen ? '' : 'hidden'}`}
        style={{ '--document-ann-width': `${marginWidth}px` } as React.CSSProperties}
      >
        <AnnotationPanel
          key={activeDoc.path}
          onResizeStart={startMarginResize}
        />
      </div>
      </div>
      {isMd && !paged && <WritingStatus />}
      {exportMenu && (
        <ContextMenu x={exportMenu.x} y={exportMenu.y} items={exportItems} onClose={() => setExportMenu(null)} />
      )}
    </div>
  )
}
