import { useEffect, useRef, useState } from 'react'
import type { CodeDocumentInput, CodeDocumentRef, CodeLanguageId, CodeLocation, CodeRange, CodeSymbol } from '@shared/code'
import { codeLanguageForPath } from '@shared/code'
import type { DocContent } from '@shared/types'
import { apiFor, origProjectId, useStore } from '../store'
import { isDarkTheme } from '../utils/settings'
import { useResolvedTheme } from '../utils/useResolvedTheme'
import { monaco, configureMonaco, monacoLanguageForPath, monacoTheme } from '../code/monaco-setup'
import {
  consumePendingCodeLocation,
  navigateCodeHistory,
  openCodeLocation,
  setActiveCodeLocation,
  type CodeNavigationLocation
} from '../code/navigation'
import TabsBar from './TabsBar'
import './CodeEditor.css'

interface Props {
  path: string
}

const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>()

function runEditorAction(editor: monaco.editor.IStandaloneCodeEditor, id: string): void {
  try {
    editor.trigger('timber-code-navigation', id, {})
  } catch (error) {
    if (error instanceof Error && error.message === 'Canceled') return
    console.error(error)
  }
}

function codeUri(projectId: string, path: string): monaco.Uri {
  return monaco.Uri.from({ scheme: 'timber-code', authority: encodeURIComponent(projectId), path: `/${encodeURIComponent(path)}` })
}

function codeLocationFromUri(resource: monaco.Uri, selection?: monaco.IRange | monaco.IPosition): CodeNavigationLocation | null {
  if (resource.scheme !== 'timber-code') return null
  const path = decodeURIComponent(resource.path.replace(/^\/+/, ''))
  const range = selection && 'startLineNumber' in selection
    ? {
        start: { line: selection.startLineNumber - 1, character: selection.startColumn - 1 },
        end: { line: selection.endLineNumber - 1, character: selection.endColumn - 1 }
      }
    : selection
      ? { start: { line: selection.lineNumber - 1, character: selection.column - 1 }, end: { line: selection.lineNumber - 1, character: selection.column - 1 } }
      : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
  return { projectId: decodeURIComponent(resource.authority), path, range }
}

function monacoRange(range: CodeRange): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1
  }
}

async function ensureModel(projectId: string, path: string, content?: string): Promise<monaco.editor.ITextModel> {
  const uri = codeUri(projectId, path)
  const existing = monaco.editor.getModel(uri)
  if (existing) {
    if (content !== undefined && existing.getValue() !== content) existing.setValue(content)
    return existing
  }
  let value = content
  if (value === undefined) {
    const doc = await apiFor<DocContent>(projectId)('GET', `/api/projects/${origProjectId(projectId)}/doc?path=${encodeURIComponent(path)}`)
    value = doc.content
  }
  return monaco.editor.createModel(value, monacoLanguageForPath(path), uri)
}

async function monacoLocations(projectId: string, locations: CodeLocation[]): Promise<monaco.languages.Location[]> {
  await Promise.all(locations.map((location) => ensureModel(projectId, location.path).catch(() => null)))
  return locations.map((location) => ({ uri: codeUri(projectId, location.path), range: monacoRange(location.range) }))
}

function monacoSymbol(symbol: CodeSymbol): monaco.languages.DocumentSymbol {
  return {
    name: symbol.name,
    detail: symbol.detail,
    kind: Math.max(0, Math.min(25, symbol.kind - 1)),
    tags: [],
    containerName: symbol.containerName,
    range: monacoRange(symbol.range),
    selectionRange: monacoRange(symbol.selectionRange),
    children: symbol.children?.map(monacoSymbol)
  }
}

const SYMBOL_KINDS = ['文件', '模块', '命名空间', '包', '类', '方法', '属性', '字段', '构造函数', '枚举', '接口', '函数', '变量', '常量', '字符串', '数字', '布尔值', '数组', '对象', '键', '空值', '枚举成员', '结构体', '事件', '运算符', '类型参数']

export default function CodeEditor({ path }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const syncRef = useRef<Promise<boolean>>(Promise.resolve(false))
  const activeDoc = useStore((state) => state.activeDoc)
  const docLoading = useStore((state) => state.docLoading)
  const docError = useStore((state) => state.docError)
  const projectId = useStore((state) => state.activeProjectId)
  const project = useStore((state) => state.projects.find((item) => item.id === state.activeProjectId))
  const settings = useStore((state) => state.settings)
  const resolvedTheme = useResolvedTheme()
  const [serviceState, setServiceState] = useState<'loading' | 'ready' | 'error' | 'none'>('none')
  const [serviceMessage, setServiceMessage] = useState('')
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [workspaceQuery, setWorkspaceQuery] = useState('')
  const [workspaceSymbols, setWorkspaceSymbols] = useState<CodeSymbol[]>([])
  const [workspaceIndex, setWorkspaceIndex] = useState(0)
  const [workspaceSearching, setWorkspaceSearching] = useState(false)
  const content = activeDoc?.path === path ? activeDoc.content : null
  const languageId = codeLanguageForPath(path)
  const languageLabel = languageId === 'c' ? 'C' : languageId === 'cpp' ? 'C/C++' : languageId === 'objective-c' ? 'Objective-C' : 'TS / JS'
  const cppLanguage = languageId === 'c' || languageId === 'cpp' || languageId === 'objective-c'
  const rootPath = project && project.kind !== 'file' && !project.remoteId && projectId && !projectId.includes(':') ? project.path : null

  useEffect(() => {
    if (content === null || !projectId) return
    const bridge = window.timber
    if (!bridge || !rootPath || !languageId) {
      syncRef.current = Promise.resolve(false)
      setServiceState('none')
      return
    }
    let active = true
    setServiceState((current) => current === 'ready' ? current : 'loading')
    const input: CodeDocumentInput = { rootPath, path, languageId, content }
    syncRef.current = bridge.codeSyncDocument(input).then((status) => {
      if (!active) return false
      setServiceState(status.ok ? 'ready' : 'error')
      setServiceMessage(status.message ?? '')
      return status.ok
    }).catch((error) => {
      if (!active) return false
      setServiceState('error')
      setServiceMessage(error instanceof Error ? error.message : String(error))
      return false
    })
    return () => { active = false }
  }, [content, languageId, path, projectId, rootPath])

  useEffect(() => {
    const host = hostRef.current
    if (!host || content === null || !projectId) return
    configureMonaco()
    let disposed = false
    const model = monaco.editor.getModel(codeUri(projectId, path)) ?? monaco.editor.createModel(content, monacoLanguageForPath(path), codeUri(projectId, path))
    if (model.getValue() !== content) model.setValue(content)
    const editor = monaco.editor.create(host, {
      model,
      readOnly: true,
      readOnlyMessage: { value: '代码文件目前以只读模式打开' },
      automaticLayout: true,
      fontFamily: 'var(--code-font-family)',
      fontSize: settings.codeFontSize,
      lineNumbers: settings.sourceCodeLineNumbers ? 'on' : 'off',
      wordWrap: settings.wrapCodeBlocks ? 'on' : 'off',
      tabSize: settings.tabSize,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      folding: true,
      stickyScroll: { enabled: true },
      minimap: { enabled: false },
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true },
      hover: { enabled: true, delay: 250 },
      contextmenu: true,
      occurrencesHighlight: 'off',
      theme: monacoTheme(isDarkTheme(resolvedTheme))
    })
    editorRef.current = editor
    const viewKey = `${projectId}:${path}`
    const viewState = viewStates.get(viewKey)
    if (viewState) editor.restoreViewState({ ...viewState, contributionsState: {} })
    const disposables: monaco.IDisposable[] = []
    const revealPending = (): void => {
      const pending = consumePendingCodeLocation(projectId, path)
      if (!pending) return
      const range = monacoRange(pending.range)
      editor.setPosition({ lineNumber: range.startLineNumber, column: range.startColumn })
      editor.revealRangeInCenter(range)
      editor.focus()
      setActiveCodeLocation(pending)
    }
    disposables.push(editor.onDidChangeCursorPosition((event) => {
      const position = event.position
      setCursor({ line: position.lineNumber, column: position.column })
      setActiveCodeLocation({
        projectId,
        path,
        range: {
          start: { line: position.lineNumber - 1, character: position.column - 1 },
          end: { line: position.lineNumber - 1, character: position.column - 1 }
        }
      })
    }))
    const initialPosition = editor.getPosition() ?? new monaco.Position(1, 1)
    setActiveCodeLocation({
      projectId,
      path,
      range: {
        start: { line: initialPosition.lineNumber - 1, character: initialPosition.column - 1 },
        end: { line: initialPosition.lineNumber - 1, character: initialPosition.column - 1 }
      }
    })
    revealPending()
    window.addEventListener('timber:code-location', revealPending)
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.LeftArrow, () => { void navigateCodeHistory(-1, projectId) })
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.RightArrow, () => { void navigateCodeHistory(1, projectId) })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyT, () => setWorkspaceOpen(true))
    disposables.push(monaco.editor.registerEditorOpener({
      openCodeEditor: (_source, resource, selection) => {
        const location = codeLocationFromUri(resource, selection)
        if (!location || location.projectId !== projectId) return false
        void openCodeLocation(location)
        return true
      }
    }))

    const bridge = window.timber
    if (bridge && rootPath && languageId) {
      const document: CodeDocumentRef = { rootPath, path, languageId }
      const ready = async (): Promise<boolean> => !disposed && await syncRef.current
      const fail = (error: unknown): void => {
        if (disposed) return
        setServiceState('error')
        setServiceMessage(error instanceof Error ? error.message : String(error))
      }
      // Monaco 语言 id 与后端语义语言可能不同（C 共用 cpp 语法、objective-c 保留连字符）
      const selector: monaco.languages.LanguageSelector = [monacoLanguageForPath(path)]
      disposables.push(monaco.languages.registerDefinitionProvider(selector, {
        provideDefinition: async (source, position) => {
          try {
            if (!await ready()) return null
            const locations = await bridge.codeDefinition(document, { line: position.lineNumber - 1, character: position.column - 1 })
            return monacoLocations(projectId, locations)
          } catch (error) { fail(error); return null }
        }
      }))
      const goToDefinition = async (position: monaco.Position): Promise<void> => {
        try {
          if (!await ready()) return
          const locations = await bridge.codeDefinition(document, { line: position.lineNumber - 1, character: position.column - 1 })
          if (locations.length === 1) {
            await openCodeLocation({ projectId, path: locations[0].path, range: locations[0].range })
          } else if (locations.length > 1) {
            await monacoLocations(projectId, locations)
            runEditorAction(editor, 'editor.action.peekDefinition')
          }
        } catch (error) { fail(error) }
      }
      const onNavigationKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'F12') {
          event.preventDefault()
          event.stopImmediatePropagation()
          if (event.shiftKey) {
            runEditorAction(editor, 'editor.action.referenceSearch.trigger')
          } else {
            const position = editor.getPosition()
            if (position) void goToDefinition(position)
          }
        } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'o') {
          event.preventDefault()
          event.stopImmediatePropagation()
          runEditorAction(editor, 'editor.action.quickOutline')
        }
      }
      host.addEventListener('keydown', onNavigationKeyDown, true)
      disposables.push({ dispose: () => host.removeEventListener('keydown', onNavigationKeyDown, true) })
      disposables.push(editor.onMouseDown((event) => {
        const position = event.target.position
        if (!position || !event.event.leftButton || (!event.event.ctrlKey && !event.event.metaKey)) return
        event.event.preventDefault()
        event.event.stopPropagation()
        void goToDefinition(position)
      }))
      disposables.push(monaco.languages.registerReferenceProvider(selector, {
        provideReferences: async (source, position) => {
          try {
            if (!await ready()) return []
            const locations = await bridge.codeReferences(document, { line: position.lineNumber - 1, character: position.column - 1 })
            return monacoLocations(projectId, locations)
          } catch (error) { fail(error); return [] }
        }
      }))
      disposables.push(monaco.languages.registerHoverProvider(selector, {
        provideHover: async (source, position) => {
          try {
            if (!await ready()) return null
            const result = await bridge.codeHover(document, { line: position.lineNumber - 1, character: position.column - 1 })
            return result ? {
              contents: result.contents.map((value) => ({ value })),
              range: result.range ? monacoRange(result.range) : undefined
            } : null
          } catch (error) { fail(error); return null }
        }
      }))
      disposables.push(monaco.languages.registerDocumentSymbolProvider(selector, {
        displayName: languageLabel,
        provideDocumentSymbols: async () => {
          try {
            if (!await ready()) return []
            const symbols = await bridge.codeDocumentSymbols(document)
            return symbols.map(monacoSymbol)
          } catch (error) { fail(error); return [] }
        }
      }))
    }

    return () => {
      disposed = true
      viewStates.set(viewKey, editor.saveViewState())
      window.removeEventListener('timber:code-location', revealPending)
      for (const disposable of disposables) disposable.dispose()
      editor.dispose()
      if (editorRef.current === editor) editorRef.current = null
    }
  }, [path, projectId, content === null])

  useEffect(() => {
    monaco.editor.setTheme(monacoTheme(isDarkTheme(resolvedTheme)))
    editorRef.current?.updateOptions({
      fontFamily: 'var(--code-font-family)',
      fontSize: settings.codeFontSize,
      lineNumbers: settings.sourceCodeLineNumbers ? 'on' : 'off',
      wordWrap: settings.wrapCodeBlocks ? 'on' : 'off',
      tabSize: settings.tabSize
    })
  }, [resolvedTheme, settings])

  useEffect(() => {
    if (content === null || !projectId) return
    const model = monaco.editor.getModel(codeUri(projectId, path))
    if (model && model.getValue() !== content) model.setValue(content)
  }, [content, path, projectId])

  useEffect(() => {
    if (!workspaceOpen || !rootPath || !window.timber || !workspaceQuery.trim()) {
      setWorkspaceSymbols([])
      setWorkspaceSearching(false)
      return
    }
    let active = true
    setWorkspaceSearching(true)
    const timer = window.setTimeout(() => {
      void window.timber!.codeWorkspaceSymbols(rootPath, workspaceQuery.trim(), languageId ?? undefined).then((symbols) => {
        if (!active) return
        setWorkspaceSymbols(symbols.slice(0, 100))
        setWorkspaceIndex(0)
      }).catch(() => {
        if (active) setWorkspaceSymbols([])
      }).finally(() => {
        if (active) setWorkspaceSearching(false)
      })
    }, 200)
    return () => { active = false; clearTimeout(timer) }
  }, [workspaceOpen, workspaceQuery, rootPath, languageId])

  const openWorkspaceSymbol = (symbol: CodeSymbol): void => {
    if (!projectId) return
    setWorkspaceOpen(false)
    void openCodeLocation({ projectId, path: symbol.path, range: symbol.selectionRange })
  }

  return (
    <div className="reader">
      <TabsBar />
      <div className="rt-breadcrumb cv-head" title={path}>
        {path.split('/').map((part, index, parts) => (
          <span key={index} className="crumb">
            {part}
            {index < parts.length - 1 && <span className="crumb-sep">›</span>}
          </span>
        ))}
        <span className="cv-meta">
          {content !== null && `${content.split('\n').length} 行 · ${cursor.line}:${cursor.column} · `}
          {languageId && rootPath ? (
            <span
              className={`code-editor-status ${serviceState === 'ready' ? 'ready' : serviceState === 'error' ? 'error' : ''}`}
              title={serviceMessage || (cppLanguage ? `${languageLabel} 内置索引（定义 / 引用 / 符号）` : 'TypeScript / JavaScript 语言服务')}
            >
              {serviceState === 'ready'
                ? `${cppLanguage ? 'C/C++' : 'TS'} 导航已就绪`
                : serviceState === 'error'
                  ? '仅语法高亮'
                  : cppLanguage ? 'C/C++ 索引构建中' : 'TS 服务启动中'}
            </span>
          ) : '只读'}
        </span>
      </div>
      <div className="code-editor-shell">
        {content === null ? (
          <div className={docLoading ? 'hv-loading' : 'hv-empty'}>{docLoading ? '加载中…' : `文件加载失败：${docError ?? '未知错误'}`}</div>
        ) : <div className="code-editor-host" ref={hostRef} data-code-path={path} />}
        {workspaceOpen && (
          <>
            <div className="code-symbol-backdrop" onClick={() => setWorkspaceOpen(false)} />
            <div className="code-symbol-palette" role="dialog" aria-label="工作区符号">
              <input
                className="code-symbol-input"
                autoFocus
                value={workspaceQuery}
                placeholder="搜索项目中的类、函数、变量…"
                aria-label="工作区符号搜索"
                onChange={(event) => setWorkspaceQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setWorkspaceOpen(false)
                  else if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    setWorkspaceIndex((index) => Math.min(index + 1, workspaceSymbols.length - 1))
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    setWorkspaceIndex((index) => Math.max(0, index - 1))
                  } else if (event.key === 'Enter' && workspaceSymbols[workspaceIndex]) {
                    openWorkspaceSymbol(workspaceSymbols[workspaceIndex])
                  }
                }}
              />
              <div className="code-symbol-list">
                {workspaceSearching && <div className="code-symbol-empty">搜索中…</div>}
                {!workspaceSearching && !workspaceQuery.trim() && <div className="code-symbol-empty">输入符号名称开始搜索</div>}
                {!workspaceSearching && workspaceQuery.trim() && !workspaceSymbols.length && <div className="code-symbol-empty">未找到匹配符号</div>}
                {!workspaceSearching && workspaceSymbols.map((symbol, index) => (
                  <button
                    type="button"
                    className={`code-symbol-item ${index === workspaceIndex ? 'active' : ''}`}
                    key={`${symbol.path}:${symbol.selectionRange.start.line}:${symbol.name}:${index}`}
                    onMouseEnter={() => setWorkspaceIndex(index)}
                    onClick={() => openWorkspaceSymbol(symbol)}
                  >
                    <span className="code-symbol-name">{symbol.name}</span>
                    <span className="code-symbol-kind">{SYMBOL_KINDS[symbol.kind - 1] ?? '符号'}</span>
                    <span className="code-symbol-path">{symbol.path}:{symbol.selectionRange.start.line + 1}</span>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
