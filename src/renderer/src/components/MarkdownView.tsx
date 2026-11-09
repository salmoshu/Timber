import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  CodeBlockLanguageSelector, EmojiSelector, FootnoteTool, ImageEditTool, ImageResizeBar, ImageToolBar,
  InlineFormatToolbar, LinkTools, Muya, ParagraphFrontButton, ParagraphFrontMenu, ParagraphQuickInsertMenu,
  PreviewToolBar, TableChessboard, TableColumnToolbar, TableDragBar, TableRowColumMenu, zhCN,
  type IPreviewDiagramPayload, type ISerializedHistory, type TSelectionState
} from '@muyajs/core'
import type { Annotation } from '@shared/types'
import { origProjectId, rawBaseFor, useStore } from '../store'
import { isDarkTheme, type AppSettings } from '../utils/settings'
import { useResolvedTheme } from '../utils/useResolvedTheme'
import { collectText, findAnnotationRange, setTextHighlight } from '../utils/textRanges'
import { formattingShortcut, MARKDOWN_COMMAND_EVENT, type MarkdownCommandRequest } from '../utils/markdownCommands'
import { saveMarkdownImages, saveMarkdownImageSource } from '../utils/markdownImages'
import { createMuyaRuntime, executeMuyaCommand, insertMarkdownInMuya } from '../utils/muyaRuntime'
import { getMarkdownEditor, registerMarkdownEditor } from '../utils/markdownEditorRuntime'
import { useWritingPreferences } from '../utils/writingPreferences'

interface Props {
  annotations: Annotation[]
  onSelectAnn: (id: string) => void
}

const normSlashes = (path: string): string => path.replace(/\\/g, '/')

function projectRootVariants(root: string): string[] {
  const normalized = normSlashes(root).replace(/\/+$/, '')
  const match = /^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+(\/.*)$/i.exec(normalized)
  return match ? [normalized, match[1]] : [normalized]
}

export function resolveDocLink(fromPath: string, href: string, projectPath?: string): string | null {
  let path = normSlashes(href.split('#')[0].split('?')[0])
  try { path = decodeURIComponent(path) } catch { /* Keep the literal path when it is not URI encoded. */ }
  if (!path) return null
  if (/^([a-z]+:)?\/\//i.test(path) && !/^\/\/(?:wsl\.localhost|wsl\$)\//i.test(path)) return null
  if (path.startsWith('/') || /^[a-zA-Z]:\//.test(path)) {
    if (!projectPath) return null
    const candidate = path.replace(/\/+$/, '')
    for (const root of projectRootVariants(projectPath)) {
      if (candidate.toLowerCase().startsWith(root.toLowerCase() + '/')) return candidate.slice(root.length + 1)
    }
    return null
  }
  const segments = [...fromPath.split('/').slice(0, -1), ...path.split('/')]
  const result: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!result.length) return null
      result.pop()
    } else result.push(segment)
  }
  return result.join('/')
}

const LINKABLE_EXTS = [
  '.md', '.markdown', '.mdown', '.mkd', '.mdx', '.rst', '.html', '.htm', '.txt',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico',
  '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml', '.log', '.csv', '.tsv', '.sql',
  '.py', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cpp', '.cs', '.rb', '.php', '.lua', '.css', '.scss', '.sh', '.ps1'
]

function openLink(href: string): void {
  const state = useStore.getState()
  if (/^https?:/i.test(href)) {
    state.openExtPage(href)
    return
  }
  const isDrivePath = /^[a-zA-Z]:[\\/]/.test(href)
  if (!href || href.startsWith('#') || (/^[a-z][a-z0-9+.-]*:/i.test(href) && !isDrivePath) || !state.activeDoc) return
  const project = state.projects.find((item) => item.id === state.activeProjectId)
  const resolved = resolveDocLink(state.activeDoc.path, href, project?.path)
  if (!resolved) state.toast('info', `无法解析链接目标：${href}（不在当前项目内）`)
  else if (!LINKABLE_EXTS.some((ext) => resolved.toLowerCase().endsWith(ext))) state.toast('info', '暂不支持预览该类型文件')
  else void state.openDoc(resolved)
}

const CJK_CHAR = /[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\u3000-\u303f]/
const PRELIKE = new Set(['pre', 'textarea', 'script'])

function joinSoftBreaks(part: string): string {
  return part.replace(/\n/g, (_newline, offset: number, whole: string): string => {
    const previous = whole.slice(0, offset).replace(/\s+$/, '').slice(-1)
    const next = /\S/.exec(whole.slice(offset + 1))?.[0] ?? ''
    return CJK_CHAR.test(previous) || CJK_CHAR.test(next) ? '<span data-an-softbreak>\n</span>' : '\n'
  })
}

/** Preserve the existing export treatment for CJK soft line breaks. */
export function wrapSoftBreaks(html: string): string {
  if (!html.includes('\n')) return html
  const parts = html.split(/(<[^>]*>)/)
  let preDepth = 0
  return parts.map((part) => {
    if (part.startsWith('<')) {
      const name = /^<\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(part)?.[1].toLowerCase() ?? ''
      if (PRELIKE.has(name)) preDepth = part[1] === '/' ? Math.max(0, preDepth - 1) : preDepth + 1
      return part
    }
    return preDepth === 0 ? joinSoftBreaks(part) : part
  }).join('')
}

async function persistImageForActiveDocument(source: { src: string; alt: string }): Promise<string> {
  const state = useStore.getState()
  if (!state.activeProjectId || !state.activeDoc) throw new Error('请先打开一个项目文档')
  try {
    return await saveMarkdownImageSource(source.src, source.alt, state.activeProjectId, state.activeDoc.path)
  } catch (error) {
    state.toast('err', `图片保存失败：${error instanceof Error ? error.message : error}。可通过 / 插入图片重试。`)
    throw error
  }
}

let pluginsRegistered = false
function registerMuyaPlugins(): void {
  if (pluginsRegistered) return
  pluginsRegistered = true
  Muya.use(EmojiSelector)
  Muya.use(FootnoteTool)
  Muya.use(InlineFormatToolbar, {
    keyboardShortcuts: false,
    annotationLabel: '添加批注',
    annotationAction: () => {
      const root = getMarkdownEditor()?.root
      const anchor = root && selectionAnchor(root)
      if (anchor) useStore.getState().setComposeQuote(anchor)
    }
  })
  Muya.use(ImageEditTool, { imageAction: persistImageForActiveDocument })
  Muya.use(ImageToolBar)
  Muya.use(ImageResizeBar)
  Muya.use(CodeBlockLanguageSelector)
  Muya.use(LinkTools, { jumpClick: (info: { href?: string } | null) => { if (info?.href) openLink(info.href) } })
  Muya.use(ParagraphFrontButton)
  Muya.use(ParagraphFrontMenu)
  Muya.use(TableChessboard)
  Muya.use(TableColumnToolbar)
  Muya.use(ParagraphQuickInsertMenu, { keyboardShortcuts: false })
  Muya.use(TableDragBar)
  Muya.use(TableRowColumMenu)
  Muya.use(PreviewToolBar)
}
registerMuyaPlugins()

interface LightboxInfo { src: string; original: string; alt: string }
function ImageLightbox({ info, onClose }: { info: LightboxInfo; onClose: () => void }) {
  const [originalSize, setOriginalSize] = useState(false)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return <div className="img-lightbox" onClick={onClose}>
    <button className="img-lightbox-close" onClick={onClose} title="关闭 (Esc)">✕</button>
    <div className={`img-lightbox-stage${originalSize ? ' orig' : ''}`}>
      <img src={info.src} alt={info.alt} onClick={(event) => { event.stopPropagation(); setOriginalSize((value) => !value) }} />
    </div>
    <div className="img-lightbox-meta" onClick={(event) => event.stopPropagation()}>
      <span>{info.original || info.alt}</span>
      <button onClick={() => void navigator.clipboard.writeText(info.original || info.src)}>复制路径</button>
      {window.timber && <button onClick={() => void window.timber!.copyImage(info.src)}>复制图片</button>}
    </div>
  </div>
}

function DiagramLightbox({ payload, onClose }: { payload: IPreviewDiagramPayload; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return <div className="mm-lightbox" onClick={onClose}>
    <button className="img-lightbox-close" onClick={onClose}>✕</button>
    <div className="mm-canvas timber-diagram-preview" onClick={(event) => event.stopPropagation()}
      dangerouslySetInnerHTML={{ __html: payload.preview.innerHTML }} />
  </div>
}

interface SavedMuyaState {
  markdown: string
  history: ISerializedHistory
  selection: TSelectionState | null
}
const savedStates = new Map<string, SavedMuyaState>()

function muyaAppearance(settings: AppSettings) {
  return {
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    editorFontFamily: 'var(--reader-font-family)',
    codeFontSize: settings.codeFontSize,
    codeFontFamily: 'var(--code-font-family)',
    wrapCodeBlocks: settings.wrapCodeBlocks,
    codeBlockLineNumbers: settings.codeBlockLineNumbers,
    tabSize: settings.tabSize,
    hideQuickInsertHint: settings.hideQuickInsertHint
  }
}

function muyaWritingOptions() {
  const preferences = useWritingPreferences.getState()
  return { autoPairBracket: preferences.autoPairBracket, autoPairQuote: preferences.autoPairQuote, autoPairMarkdownSyntax: preferences.autoPairMarkdownSyntax }
}

function MarkdownView({ annotations, onSelectAnn }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const refreshRef = useRef<() => void>(() => undefined)
  const annotationsRef = useRef(annotations)
  const selectAnnRef = useRef(onSelectAnn)
  selectAnnRef.current = onSelectAnn
  const [lightbox, setLightbox] = useState<LightboxInfo | null>(null)
  const [diagram, setDiagram] = useState<IPreviewDiagramPayload | null>(null)
  const [error, setError] = useState('')
  const docPath = useStore((state) => state.activeDoc?.path)
  const projectId = useStore((state) => state.activeProjectId)
  const tabId = useStore((state) => state.activeTabId)
  const dark = isDarkTheme(useResolvedTheme())
  annotationsRef.current = annotations

  const refreshAnnotations = useCallback(() => {
    const root = hostRef.current?.querySelector<HTMLElement>('.prose')
    if (!root) return
    const open: Range[] = []
    const done: Range[] = []
    for (const annotation of annotationsRef.current) {
      const range = findAnnotationRange(root, annotation)
      if (range) (annotation.status === 'done' ? done : open).push(range)
    }
    setTextHighlight('ann-open', open)
    setTextHighlight('ann-done', done)
  }, [])
  refreshRef.current = refreshAnnotations
  useEffect(() => { refreshRef.current() }, [annotations])

  useEffect(() => {
    if (!docPath || !projectId || !tabId || !hostRef.current) return
    const host = hostRef.current
    let disposed = false
    let disposeEditor: (() => void) | undefined
    setError('')
    void rawBaseFor(projectId).then((rawBase) => {
      if (disposed) return
      const mount = document.createElement('div')
      mount.className = 'prose timber-muya'
      host.replaceChildren(mount)
      const state = useStore.getState()
      const project = state.projects.find((item) => item.id === projectId)
      const initialMarkdown = state.draft
      const saved = savedStates.get(tabId)
      const resolveImage = (src: string): string => {
        if (!src || /^(?:https?:|data:|blob:)/i.test(src)) return src
        const resolved = resolveDocLink(docPath, src, project?.path)
        if (!resolved || !rawBase) return ''
        return `${rawBase}/raw/${origProjectId(projectId)}/${resolved.split('/').map(encodeURIComponent).join('/')}`
      }
      let muya: Muya
      try {
        muya = new Muya(mount, {
          markdown: saved?.markdown ?? initialMarkdown,
          frontMatter: true,
          footnote: true,
          superSubScript: true,
          texMathGfm: true,
          githubAlerts: true,
          cjkEmphasis: true,
          ...muyaAppearance(state.settings),
          ...muyaWritingOptions(),
          spellcheckEnabled: false,
          trimUnnecessaryCodeBlockEmptyLines: false,
          bulletListMarker: '-',
          orderListDelimiter: '.',
          frontmatterType: '-',
          mermaidTheme: dark ? 'dark' : 'default',
          documentId: () => `${projectId}/${docPath}`,
          imageAction: persistImageForActiveDocument,
          resolveImageSrc: resolveImage,
          getPathForFile: () => ''
        } as ConstructorParameters<typeof Muya>[1])
        muya.locale(zhCN)
        muya.init({ focus: false })
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
        return
      }
      muya.domNode.setAttribute('data-editor', 'muya')
      muya.domNode.setAttribute('aria-label', 'Markdown 所见即所得编辑器')
      if (saved) {
        muya.setHistory(saved.history)
        if (saved.selection) muya.setSelection(saved.selection)
        muya.replaceContent(initialMarkdown)
      }
      const runtime = createMuyaRuntime(muya)
      registerMarkdownEditor(runtime)
      let frame = 0
      const rendered = (): void => {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => {
          if (disposed) return
          refreshRef.current()
          window.dispatchEvent(new Event('markdown-rendered'))
        })
      }
      const syncDraft = (): void => {
        const current = useStore.getState()
        if (current.activeTabId !== tabId) return
        const markdown = muya.getMarkdown()
        if (current.draft !== markdown) current.setDraft(markdown)
        rendered()
      }
      muya.on('json-change', syncDraft)
      muya.on('preview-image', (payload: unknown) => {
        const src = (payload as { data?: unknown }).data
        if (typeof src === 'string') setLightbox({ src, original: '', alt: '' })
      })
      muya.on('preview-diagram', (payload: unknown) => setDiagram(payload as IPreviewDiagramPayload))
      muya.on('image-drop-error', (payload: unknown) => {
        useStore.getState().toast('err', `图片插入失败：${payload instanceof Error ? payload.message : String(payload)}`)
      })
      const unsubscribe = useStore.subscribe((next, previous) => {
        if (next.activeTabId !== tabId) return
        if (next.settings !== previous.settings) {
          muya.setOptions(muyaAppearance(next.settings), next.settings.codeBlockLineNumbers !== previous.settings.codeBlockLineNumbers)
          rendered()
        }
        if (next.draft === previous.draft || next.draft === muya.getMarkdown()) return
        muya.setContent(next.draft)
        rendered()
      })
      const unsubscribeWriting = useWritingPreferences.subscribe((next, previous) => {
        if (next.autoPairBracket !== previous.autoPairBracket || next.autoPairQuote !== previous.autoPairQuote || next.autoPairMarkdownSyntax !== previous.autoPairMarkdownSyntax) muya.setOptions(muyaWritingOptions())
      })
      const onCommand = (event: Event): void => executeMuyaCommand(muya, (event as CustomEvent<MarkdownCommandRequest>).detail)
      const onKeyDown = (event: KeyboardEvent): void => {
        if (!event.isComposing && !event.altKey && (event.ctrlKey || event.metaKey)) {
          const key = event.key.toLowerCase()
          if (key === 'z' || key === 'y') {
            event.preventDefault(); event.stopImmediatePropagation()
            if (key === 'y' || event.shiftKey) muya.redo()
            else muya.undo()
            syncDraft()
            return
          }
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault(); event.stopPropagation()
          muya.flush(); syncDraft(); void useStore.getState().saveDoc()
          return
        }
        if (event.isComposing) return
        const command = formattingShortcut(event)
        if (command) {
          event.preventDefault(); event.stopPropagation()
          executeMuyaCommand(muya, { command })
        }
      }
      const onBeforeInput = (event: InputEvent): void => {
        if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') return
        event.preventDefault(); event.stopImmediatePropagation()
        if (event.inputType === 'historyUndo') muya.undo()
        else muya.redo()
        syncDraft()
      }
      const onClick = (event: MouseEvent): void => {
        const target = event.target as Element
        const link = target.closest<HTMLAnchorElement>('a[href]')
        if (link && (event.ctrlKey || event.metaKey)) {
          event.preventDefault(); openLink(link.getAttribute('href') ?? '')
          return
        }
        const image = target.closest<HTMLImageElement>('.mu-inline-image img')
        if (image && event.detail > 1) {
          const raw = image.closest<HTMLElement>('.mu-inline-image')?.dataset.raw ?? ''
          const original = /\]\((?:<)?([^\s>)]+)/.exec(raw)?.[1] ?? ''
          setLightbox({ src: image.currentSrc || image.src, original, alt: image.alt })
          return
        }
        if (event.detail !== 1) return
        const caret = document.caretRangeFromPoint?.(event.clientX, event.clientY)
        if (!caret) return
        for (const annotation of annotationsRef.current) {
          const range = findAnnotationRange(muya.domNode, annotation)
          if (range?.comparePoint(caret.startContainer, caret.startOffset) !== 0) continue
          selectAnnRef.current(annotation.id)
          requestAnimationFrame(() => document.getElementById(`ap-${annotation.id}`)?.scrollIntoView({ block: 'nearest' }))
          break
        }
      }
      const insertImages = async (files: File[]): Promise<void> => {
        if (!files.length) return
        const current = useStore.getState()
        if (!current.activeProjectId || !current.activeDoc) return
        try {
          const markdown = await saveMarkdownImages(files, current.activeProjectId, current.activeDoc.path)
          if (!disposed && current.activeTabId === useStore.getState().activeTabId) insertMarkdownInMuya(muya, markdown)
        } catch (cause) {
          current.toast('err', `图片插入失败：${cause instanceof Error ? cause.message : cause}`)
        }
      }
      const onImages = (event: Event): void => { void insertImages((event as CustomEvent<File[]>).detail) }
      const onDrop = (event: DragEvent): void => {
        const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith('image/'))
        if (!files.length) return
        event.preventDefault(); event.stopPropagation()
        void insertImages(files)
      }
      const onDragOver = (event: DragEvent): void => {
        if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
      }
      muya.domNode.addEventListener('keydown', onKeyDown, true)
      muya.domNode.addEventListener('beforeinput', onBeforeInput, true)
      muya.domNode.addEventListener('click', onClick)
      muya.domNode.addEventListener('drop', onDrop, true)
      muya.domNode.addEventListener('dragover', onDragOver)
      window.addEventListener(MARKDOWN_COMMAND_EVENT, onCommand)
      window.addEventListener('timber:insert-images', onImages)
      rendered()
      disposeEditor = () => {
        unsubscribe()
        unsubscribeWriting()
        cancelAnimationFrame(frame)
        muya.flush()
        const markdown = muya.getMarkdown()
        savedStates.set(tabId, { markdown, history: muya.getHistory(), selection: muya.getSelectionState() })
        // flush() commits pending edits through json-change. Merely unmounting must
        // preserve the source draft, including its exact trailing newlines.
        window.removeEventListener(MARKDOWN_COMMAND_EVENT, onCommand)
        window.removeEventListener('timber:insert-images', onImages)
        if (getMarkdownEditor() === runtime) registerMarkdownEditor(null)
        setTextHighlight('ann-open', [])
        setTextHighlight('ann-done', [])
        setTextHighlight('ann-flash', [])
        muya.destroy()
      }
    }).catch((cause) => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => {
      disposed = true
      disposeEditor?.()
      host.replaceChildren()
    }
  }, [docPath, projectId, tabId, dark])

  const closeOverlays = useCallback(() => { setLightbox(null); setDiagram(null) }, [])
  return <>
    <div className="markdown-editor" ref={hostRef}>
      {error && <div className="re-error timber-editor-error">
        <div className="re-error-icon">⚠</div>
        <div className="re-error-title">Markdown 编辑器初始化失败</div>
        <div className="re-error-desc">{error}。可以切换到源码模式继续编辑，草稿不会丢失。</div>
        <button className="btn-primary sm" onClick={() => useStore.getState().setMode('source')}>切换到源码模式</button>
      </div>}
    </div>
    {lightbox && createPortal(<ImageLightbox info={lightbox} onClose={closeOverlays} />, document.body)}
    {diagram && createPortal(<DiagramLightbox payload={diagram} onClose={closeOverlays} />, document.body)}
  </>
}

export default memo(MarkdownView)

export function selectionAnchor(container: HTMLElement): { quote: string; prefix: string; suffix: string } | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount || !container.contains(selection.anchorNode) || !container.contains(selection.focusNode)) return null
  const range = selection.getRangeAt(0)
  const text = collectText(container)
  const offsetAt = (atStart: boolean): number => {
    const point = range.cloneRange()
    point.collapse(atStart)
    let offset = 0
    for (const node of text.nodes) {
      if (point.comparePoint(node, node.length) <= 0) offset += node.length
      else {
        if (node === point.startContainer) offset += point.startOffset
        break
      }
    }
    return offset
  }
  const start = offsetAt(true)
  const end = offsetAt(false)
  const quote = text.full.slice(start, end)
  if (!quote.trim()) return null
  return { quote, prefix: text.full.slice(Math.max(0, start - 40), start), suffix: text.full.slice(end, end + 40) }
}
