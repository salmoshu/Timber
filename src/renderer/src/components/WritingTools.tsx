import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import { documentStats, type MarkdownCommand } from '../utils/markdownEditing'
import { MARKDOWN_COMMAND_EVENT, runMarkdownCommand } from '../utils/markdownCommands'
import { useWritingPreferences, toggleWritingPreference } from '../utils/writingPreferences'
import { getMarkdownEditor } from '../utils/markdownEditorRuntime'

interface InsertItem { label: string; keywords: string; command: MarkdownCommand; markdown?: string }
const INSERT_ITEMS: InsertItem[] = [
  ...Array.from({ length: 6 }, (_, index) => ({ label: `${index + 1} 级标题`, keywords: `heading h${index + 1} 标题`, command: `h${index + 1}` as MarkdownCommand })),
  { label: '正文段落', keywords: 'paragraph 正文 段落', command: 'paragraph' },
  { label: '无序列表', keywords: 'bullet list 无序 列表', command: 'list' },
  { label: '有序列表', keywords: 'ordered list 有序 列表', command: 'ordered-list' },
  { label: '任务清单', keywords: 'task checkbox todo 任务 清单', command: 'check' },
  { label: '引用', keywords: 'quote 引用', command: 'quote' },
  { label: '代码块', keywords: 'code fence 代码', command: 'code' },
  { label: '表格', keywords: 'table 表格', command: 'table' },
  { label: '分隔线', keywords: 'line divider 分隔', command: 'line' },
  { label: '数学公式', keywords: 'math latex 公式 数学', command: 'math' },
  { label: '行内公式', keywords: 'inline math 行内 公式', command: 'inline-math' },
  { label: '文本高亮', keywords: 'highlight mark 高亮', command: 'highlight' },
  { label: '脚注', keywords: 'footnote 脚注', command: 'footnote' },
  { label: 'YAML 文档信息', keywords: 'front matter yaml 元信息 文档 信息', command: 'frontmatter' },
  { label: 'Mermaid 流程图', keywords: 'mermaid diagram flowchart 流程图 图表', command: 'code', markdown: '```mermaid\nflowchart LR\n  A[开始] --> B[结束]\n```\n' },
  { label: '提示块', keywords: 'callout note 提示', command: 'quote', markdown: '> [!NOTE]\n> 提示内容\n' },
  ...Object.entries({ '😀 笑脸': ':smile:', '👍 赞': ':+1:', '🎉 庆祝': ':tada:', '❤️ 爱心': ':heart:', '🚀 火箭': ':rocket:', '✅ 完成': ':white_check_mark:', '⚠️ 注意': ':warning:', '💡 想法': ':bulb:' })
    .map(([label, keywords]) => ({ label, keywords: `emoji 表情 ${keywords}`, command: 'paragraph' as MarkdownCommand, markdown: label.split(' ')[0] }))
]

export function InlineFormatButtons() {
  return <>{([
    ['bold', 'B', '加粗 (Ctrl+B)'], ['italic', 'I', '斜体 (Ctrl+I)'], ['strike', 'S̶', '删除线 (Ctrl+Shift+X)'],
    ['highlight', 'H', '高亮 (Ctrl+Shift+H)'], ['inline-code', '‹›', '行内代码 (Ctrl+`)'], ['link', '↗', '链接 (Ctrl+K)']
  ] as [MarkdownCommand, string, string][]).map(([command, label, title]) => <button key={command} className="writing-format-btn" title={title} aria-label={title} onMouseDown={(event) => event.preventDefault()} onClick={() => runMarkdownCommand(command)}>{label}</button>)}</>
}

export function MarkdownWritingToolbar() {
  const mode = useStore((s) => s.mode)
  const preferences = useWritingPreferences()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [rows, setRows] = useState(2)
  const [columns, setColumns] = useState(3)
  const [position, setPosition] = useState({ left: 100, top: 120 })
  const trigger = useRef<HTMLButtonElement>(null)
  const palette = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const items = INSERT_ITEMS.filter((item) => `${item.label} ${item.keywords}`.toLowerCase().includes(query.toLowerCase().trim()))
  const close = (): void => { setOpen(false); getMarkdownEditor()?.focus() }
  const show = (): void => {
    const rect = trigger.current?.getBoundingClientRect()
    setPosition({ left: Math.max(8, Math.min(rect?.left ?? 120, window.innerWidth - 352)), top: Math.max(8, Math.min((rect?.bottom ?? 90) + 6, window.innerHeight - 420)) })
    setQuery(''); setIndex(0); setOpen(true)
  }
  const choose = (item: InsertItem): void => {
    if (item.markdown !== undefined) window.dispatchEvent(new CustomEvent(MARKDOWN_COMMAND_EVENT, { detail: { command: item.command, markdown: item.markdown } }))
    else runMarkdownCommand(item.command, item.command === 'table' ? { rows, columns } : undefined)
    setOpen(false)
  }
  useEffect(() => {
    window.addEventListener('timber:open-insert', show)
    return () => window.removeEventListener('timber:open-insert', show)
  }, [])
  useEffect(() => {
    if (!open) return
    search.current?.focus()
    const outside = (event: PointerEvent): void => { if (!palette.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false) }
    const hide = (): void => setOpen(false)
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', hide)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', hide) }
  }, [open])
  useEffect(() => { palette.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [index])

  return <div className="writing-toolbar" aria-label="Markdown 写作工具">
    {mode === 'source' && <div className="writing-format-group"><InlineFormatButtons /></div>}
    <button ref={trigger} className="writing-tool" aria-expanded={open} aria-haspopup="dialog" onMouseDown={(event) => event.preventDefault()} onClick={() => open ? close() : show()} title="空行输入 / 或 Ctrl+/">＋ 插入</button>
    <button className="writing-tool" onMouseDown={(event) => event.preventDefault()} onClick={() => runMarkdownCommand('table', { rows, columns })} title="插入表格">▦ 表格</button>
    <button className="writing-tool" onMouseDown={(event) => event.preventDefault()} onClick={() => fileInput.current?.click()} title="也可粘贴截图或拖入图片">▧ 图片</button>
    <input ref={fileInput} type="file" className="writing-file-input" multiple accept="image/png,image/jpeg,image/gif,image/webp" aria-label="选择要插入的图片" onChange={(event) => {
      const files = Array.from(event.currentTarget.files ?? [])
      if (files.length) window.dispatchEvent(new CustomEvent('timber:insert-images', { detail: files }))
      event.currentTarget.value = ''
    }} />
    <span className="writing-toolbar-spacer" />
    <button className={`writing-tool ${preferences.focus ? 'active' : ''}`} aria-pressed={preferences.focus} onClick={() => toggleWritingPreference('focus')} title="专注当前段落 (F8 / Ctrl+Shift+J)">专注</button>
    <button className={`writing-tool ${preferences.typewriter ? 'active' : ''}`} aria-pressed={preferences.typewriter} onClick={() => toggleWritingPreference('typewriter')} title="输入时光标保持在阅读区中央 (F9)">打字机</button>
    <button className={`writing-tool ${preferences.distractionFree ? 'active' : ''}`} aria-pressed={preferences.distractionFree} onClick={() => toggleWritingPreference('distractionFree')} title="收起两侧面板，Esc 退出 (F10)">沉浸</button>
    <details className="writing-options"><summary className="writing-tool" title="写作设置" aria-label="写作设置">⚙</summary><div>
      <label><input type="checkbox" checked={preferences.autoPair} onChange={() => toggleWritingPreference('autoPair')} />源码括号与引号自动配对</label>
      <label><input type="checkbox" checked={preferences.smartLists} onChange={() => toggleWritingPreference('smartLists')} />源码列表与引用智能续行</label>
      <small>Tab / Shift+Tab 缩进 · Ctrl+H 查找替换</small>
    </div></details>
    {open && createPortal(<div ref={palette} className="writing-insert-palette" role="dialog" aria-modal="false" aria-label="Markdown 快速插入" style={position} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && event.target === search.current) { event.preventDefault(); setIndex((current) => Math.max(0, Math.min(items.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))) }
      if (event.key === 'Enter' && event.target === search.current && items[index]) { event.preventDefault(); choose(items[index]) }
    }}>
      <input ref={search} className="writing-insert-search" aria-label="搜索插入格式" placeholder="搜索格式、表格、公式、表情…" value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0) }} aria-controls="writing-insert-list" aria-activedescendant={items[index] ? `writing-insert-${index}` : undefined} />
      <div id="writing-insert-list" className="writing-insert-list" role="listbox" aria-label="插入选项">
        {items.map((item, i) => <button id={`writing-insert-${i}`} key={item.label} role="option" aria-selected={index === i} className={index === i ? 'active' : ''} onMouseDown={(event) => event.preventDefault()} onPointerMove={() => setIndex(i)} onClick={() => choose(item)}>{item.label}<span>↵</span></button>)}
        {!items.length && <p>没有匹配的格式</p>}
      </div>
      <div className="writing-table-size"><span>表格尺寸</span><label>行 <input type="number" min="1" max="50" aria-label="表格数据行数" value={rows} onChange={(event) => setRows(Math.max(1, Math.min(50, Number(event.target.value) || 1)))} /></label><label>列 <input type="number" min="1" max="20" aria-label="表格列数" value={columns} onChange={(event) => setColumns(Math.max(1, Math.min(20, Number(event.target.value) || 1)))} /></label></div>
    </div>, document.body)}
  </div>
}

export function WritingStatus() {
  const draft = useStore((s) => s.draft)
  const deferred = useDeferredValue(draft)
  const stats = useMemo(() => documentStats(deferred), [deferred])
  const dirty = useStore((s) => s.dirty)
  const saving = useStore((s) => s.saving)
  const mode = useStore((s) => s.mode)
  const [selection, setSelection] = useState('')
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  useEffect(() => {
    let frame = 0
    const update = (): void => {
      frame = 0
      const runtime = getMarkdownEditor()
      const current = runtime?.getCursor()
      if (!runtime || !current || !runtime.root.isConnected) {
        setSelection('')
        return
      }
      if (runtime.kind === 'source') setCursor({ line: current.line, column: current.column })
      setSelection(current.selectedText)
    }
    const schedule = (): void => { if (!frame) frame = requestAnimationFrame(update) }
    document.addEventListener('selectionchange', schedule)
    document.addEventListener('keyup', schedule)
    window.addEventListener('timber:editor-runtime-changed', schedule)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', schedule)
      document.removeEventListener('keyup', schedule)
      window.removeEventListener('timber:editor-runtime-changed', schedule)
    }
  }, [])
  const selected = useMemo(() => selection ? documentStats(selection) : null, [selection])
  return <div className="writing-status" aria-label="文档统计">
    <span>{mode === 'source' ? `第 ${cursor.line} 行，第 ${cursor.column} 列` : 'Markdown'}</span>
    <span title="中日韩文字按字统计，其他文字按词统计">{selected ? `选中 ${selected.words} / ` : ''}{stats.words.toLocaleString()} 字词</span>
    <span>{stats.characters.toLocaleString()} 字符</span>
    <span>约 {stats.minutes} 分钟</span>
    {stats.tasks > 0 && <span>任务 {stats.completed}/{stats.tasks}</span>}
    <span className="writing-toolbar-spacer" />
    <span className={dirty ? 'writing-unsaved' : ''}>{saving ? '保存中…' : dirty ? '未保存' : '已保存'}</span>
  </div>
}
