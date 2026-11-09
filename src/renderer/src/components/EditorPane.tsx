import { useEffect, useLayoutEffect, useRef } from 'react'
import { useStore } from '../store'
import { indentMarkdown, pairMarkdown, smartEnter } from '../utils/markdownEditing'
import { applySourceCommand, applyTextareaEdit, formattingShortcut, MARKDOWN_COMMAND_EVENT, type MarkdownCommandRequest } from '../utils/markdownCommands'
import { useWritingPreferences } from '../utils/writingPreferences'
import { clipboardImageFiles, saveMarkdownImages } from '../utils/markdownImages'

/** 原文模式：直接编辑 Markdown / HTML 源码或纯文本，与阅读模式共用草稿。
 *  textarea 随内容自增高，滚动交给 .reader-body——滚动条与阅读模式同款，且贴着右侧边栏。 */
export default function EditorPane() {
  const draft = useStore((s) => s.draft)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const isMarkdown = useStore((s) => /^(md|markdown|mdown|mkd)$/.test(s.activeDoc?.ext ?? ''))

  useEffect(() => {
    if (!isMarkdown) return
    const onCommand = (event: Event): void => {
      if (taRef.current) applySourceCommand(taRef.current, (event as CustomEvent<MarkdownCommandRequest>).detail)
    }
    window.addEventListener(MARKDOWN_COMMAND_EVENT, onCommand)
    return () => window.removeEventListener(MARKDOWN_COMMAND_EVENT, onCommand)
  }, [isMarkdown])

  const insertImages = async (files: File[]): Promise<void> => {
    const ta = taRef.current
    const state = useStore.getState()
    if (!ta || !state.activeProjectId || !state.activeDoc) return
    const { value, selectionStart, selectionEnd } = ta
    try {
      const markdown = await saveMarkdownImages(files, state.activeProjectId, state.activeDoc.path)
      if (taRef.current !== ta || useStore.getState().activeTabId !== state.activeTabId || ta.value !== value) {
        state.toast('info', '图片已保存到文档旁的 assets 目录；编辑位置已变化，请从目录插入')
        return
      }
      applyTextareaEdit(ta, { start: selectionStart, end: selectionEnd, text: markdown, selectionStart: selectionStart + markdown.length, selectionEnd: selectionStart + markdown.length })
    } catch (error) { state.toast('err', `图片插入失败：${error instanceof Error ? error.message : error}`) }
  }

  useEffect(() => {
    if (!isMarkdown) return
    const onImages = (event: Event): void => { void insertImages((event as CustomEvent<File[]>).detail) }
    window.addEventListener('timber:insert-images', onImages)
    return () => window.removeEventListener('timber:insert-images', onImages)
  }, [isMarkdown])

  const fitHeight = (): void => {
    const ta = taRef.current
    if (!ta) return
    const body = ta.closest<HTMLElement>('.reader-body')
    const scrollTop = body?.scrollTop ?? 0
    const atBottom = body ? body.scrollHeight - body.scrollTop - body.clientHeight <= 8 : false
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
    if (body) body.scrollTop = atBottom ? body.scrollHeight : scrollTop
  }

  // 内容变化即量高；窗口缩放改变换行后重量
  useLayoutEffect(fitHeight, [draft])
  useEffect(() => {
    const onResize = (): void => fitHeight()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="editor-pane">
      <textarea
        ref={taRef}
        className="editor-plain"
        aria-label="原文编辑器"
        value={draft}
        spellCheck={false}
        onChange={(e) => useStore.getState().setDraft(e.target.value)}
        onPaste={(e) => {
          if (!isMarkdown) return
          const files = clipboardImageFiles(e.clipboardData)
          if (files.length) { e.preventDefault(); void insertImages(files) }
        }}
        onDragOver={(e) => { if (isMarkdown && e.dataTransfer.types.includes('Files')) e.preventDefault() }}
        onDrop={(e) => {
          if (!isMarkdown) return
          const files = Array.from(e.dataTransfer.files).filter((file) => file.type.startsWith('image/'))
          if (files.length) { e.preventDefault(); void insertImages(files) }
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault()
            void useStore.getState().saveDoc()
            return
          }
          if (!isMarkdown || e.nativeEvent.isComposing) return
          const ta = e.currentTarget
          const command = formattingShortcut(e.nativeEvent)
          if (command) { e.preventDefault(); applySourceCommand(ta, { command }); return }
          if (e.ctrlKey || e.metaKey || e.altKey) return
          if (e.key === '/' && !ta.value.slice(ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1, ta.selectionStart).trim() && ta.selectionStart === ta.selectionEnd) {
            e.preventDefault()
            window.dispatchEvent(new Event('timber:open-insert'))
            return
          }
          const preferences = useWritingPreferences.getState()
          const change = e.key === 'Tab' ? indentMarkdown(ta.value, ta.selectionStart, ta.selectionEnd, e.shiftKey)
            : e.key === 'Enter' && !e.shiftKey && preferences.smartLists ? smartEnter(ta.value, ta.selectionStart, ta.selectionEnd)
              : preferences.autoPair ? pairMarkdown(ta.value, ta.selectionStart, ta.selectionEnd, e.key) : null
          if (change) { e.preventDefault(); applyTextareaEdit(ta, change) }
        }}
      />
    </div>
  )
}
