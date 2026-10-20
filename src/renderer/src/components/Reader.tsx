import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import MarkdownView, { selectionAnchor } from './MarkdownView'
import EditorPane from './EditorPane'
import Logo from './Logo'
import TabsBar from './TabsBar'
import FindBar from './FindBar'
import { findTextRanges, scrollToRange, setTextHighlight } from '../utils/textRanges'
import { rawBaseFor, origProjectId } from '../store'
import { IconExportPdf, IconSave } from './icons'
import { exportActiveDocPdf } from '../utils/exportPdf'

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
  const {
    activeDoc,
    docLoading,
    docError,
    mode,
    setMode,
    pendingLocate,
    dirty,
    saving,
    saveDoc,
    refreshActiveDoc,
    annotations,
    annPanelOpen,
    toggleAnnPanel,
    setComposeQuote,
    activeProjectId,
    activeTabId,
    closeTab
  } = useStore()

  const proseWrapRef = useRef<HTMLDivElement>(null)
  const [pop, setPop] = useState<{ x: number; y: number; below?: boolean } | null>(null)
  const [rawBase, setRawBase] = useState('')
  const [findOpen, setFindOpen] = useState(false)
  const [htmlError, setHtmlError] = useState<string | null>(null)

  // HTML 文档经 sidecar /raw 以真实 URL 加载（远程项目走远端 base）
  useEffect(() => {
    void rawBaseFor(activeProjectId).then(setRawBase)
  }, [activeProjectId])

  // Ctrl+F 查找渲染正文；高亮使用 Range，不修改编辑器 DOM。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        if (useStore.getState().mode === 'source') return
        e.preventDefault()
        setFindOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 切换模式/文档时清理选区气泡和临时高亮。
  useEffect(() => {
    if (mode === 'source') setFindOpen(false)
    setPop(null)
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
  const isMd = activeDoc && ['md', 'markdown', 'mdown', 'mkd'].includes(activeDoc.ext)
  const isHtml = activeDoc && ['html', 'htm'].includes(activeDoc.ext)

  // HTML 文档 / 图片经 sidecar /raw 以真实 URL 加载（远程项目走远端 base）
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

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    // 双击保留正常选词行为；拖选文字后再显示批注气泡。
    if (e.detail > 1) {
      setPop(null)
      return
    }
    const wrap = proseWrapRef.current
    if (!wrap) return
    // 编辑模式：从源码 textarea 的选区取锚点（气泡挂在鼠标位置上方）
    if (useStore.getState().mode === 'source') {
      const textarea = wrap.querySelector<HTMLTextAreaElement>('.editor-plain')
      if (!textarea) return
      const { selectionStart: s, selectionEnd: en, value } = textarea
      const quote = value.slice(s, en)
      if (s === en || !quote.trim()) {
        setPop(null)
        return
      }
      ;(onMouseUp as unknown as { _anchor?: unknown })._anchor = {
        quote,
        prefix: value.slice(Math.max(0, s - 40), s),
        suffix: value.slice(en, en + 40)
      }
      const wrapRect = wrap.getBoundingClientRect()
      setPop({ x: e.clientX - wrapRect.left, y: e.clientY - wrapRect.top + wrap.scrollTop - 8 })
      return
    }
    const prose = wrap.querySelector('.prose') as HTMLElement | null
    if (!prose) return
    const anchor = selectionAnchor(prose)
    if (!anchor) {
      setPop(null)
      return
    }
    const sel = window.getSelection()!
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    const wrapRect = wrap.getBoundingClientRect()
    // 气泡挂在滚动容器内（position:absolute），需把视口坐标换算成内容坐标（补 scrollTop）
    const x = rect.left - wrapRect.left + rect.width / 2
    const aboveTop = rect.top - wrapRect.top
    const below = aboveTop < 48
    const y = below
      ? rect.bottom - wrapRect.top + wrap.scrollTop + 10
      : aboveTop + wrap.scrollTop - 10
    setPop({ x, y, below })
    ;(onMouseUp as unknown as { _anchor?: unknown })._anchor = anchor
  }, [])

  const startCompose = () => {
    const anchor = (onMouseUp as unknown as { _anchor?: { quote: string; prefix: string; suffix: string } })._anchor
    if (anchor) setComposeQuote(anchor)
    setPop(null)
    window.getSelection()?.removeAllRanges()
  }


  if (!activeDoc) {
    // 标签栏始终保留：打开失败的文档不再「吃掉」整个阅读区，错误卡片提供关闭出口
    return (
      <div className="reader">
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

  return (
    <div className="reader">
      <TabsBar>
        {!isImage && (
          <button
            className="rt-btn"
            onClick={() => void refreshActiveDoc()}
            title="刷新：重新从磁盘读取文档 (F5)"
          >
            ⟳
          </button>
        )}
        {(isMd || activeDoc.ext === 'txt' || isHtml) && (
          <div className="seg icon-seg">
            <button
              className={mode === 'read' ? 'active' : ''}
              onClick={() => setMode('read')}
              title={isHtml ? '阅读模式（渲染网页）' : '阅读模式（可直接编辑）'}
              aria-label="阅读模式"
              aria-pressed={mode === 'read'}
            >
              📖
            </button>
            <button
              className={mode === 'source' ? 'active' : ''}
              onClick={() => setMode('source')}
              title={isHtml ? '编辑模式（编辑 HTML 源码）' : '编辑模式（编辑源码）'}
              aria-label="编辑模式"
              aria-pressed={mode === 'source'}
            >
              ✎
            </button>
          </div>
        )}
        {dirty && !saving && (
          <button className="icon-save" onClick={() => void saveDoc()} title="保存 (Ctrl+S)">
            <IconSave />
          </button>
        )}
        {saving && <span className="icon-saving" title="保存中…">…</span>}
        {isMd && window.timber && (
          <button className="rt-btn" onClick={() => void exportActiveDocPdf()} title="导出 PDF">
            <IconExportPdf />
          </button>
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

      {findOpen && <FindBar onClose={() => setFindOpen(false)} />}

      <div
        className="reader-body"
        ref={proseWrapRef}
        onMouseUp={onMouseUp}
        onInput={() => setPop(null)}
      >
        {mode === 'source' ? (
          <EditorPane />
        ) : isMd ? (
          <MarkdownView
            annotations={annotations}
            onSelectAnn={() => {
              if (!annPanelOpen) toggleAnnPanel()
            }}
          />
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

        {pop && (mode === 'read' ? isMd : isMd || activeDoc.ext === 'txt' || isHtml) && (
          <button
            className={`ann-pop ${pop.below ? 'below' : ''}`}
            style={{ left: pop.x, top: pop.y }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={startCompose}
          >
            🏷 添加标签
          </button>
        )}
      </div>
    </div>
  )
}
