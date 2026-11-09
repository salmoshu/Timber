import { useEffect, useRef } from 'react'
import CodeMirror from 'codemirror'
import 'codemirror/lib/codemirror.css'
import 'codemirror/addon/edit/closebrackets'
import 'codemirror/addon/selection/active-line'
import 'codemirror/mode/xml/xml'
import 'codemirror/mode/javascript/javascript'
import 'codemirror/mode/css/css'
import 'codemirror/mode/htmlmixed/htmlmixed'
import 'codemirror/mode/markdown/markdown'
import { useStore } from '../store'
import { indentMarkdown, pairMarkdown, smartEnter } from '../utils/markdownEditing'
import { formattingShortcut, MARKDOWN_COMMAND_EVENT, type MarkdownCommandRequest } from '../utils/markdownCommands'
import { useWritingPreferences } from '../utils/writingPreferences'
import { clipboardImageFiles, saveMarkdownImages } from '../utils/markdownImages'
import { applyCodeMirrorCommand, applyCodeMirrorEdit, createSourceRuntime } from '../utils/sourceEditorRuntime'
import { getMarkdownEditor, registerMarkdownEditor } from '../utils/markdownEditorRuntime'

/** CodeMirror source view; the outer reader owns scrolling just like the Muya view. */
export default function EditorPane() {
  const hostRef = useRef<HTMLDivElement>(null)
  const cmRef = useRef<CodeMirror.Editor | null>(null)
  const tabId = useStore((state) => state.activeTabId)
  const docPath = useStore((state) => state.activeDoc?.path)
  const isMarkdown = useStore((state) => /^(md|markdown|mdown|mkd)$/.test(state.activeDoc?.ext ?? ''))

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const initialValue = useStore.getState().draft
    const cm = CodeMirror(host, {
      value: initialValue,
      mode: isMarkdown ? 'markdown' : 'htmlmixed',
      lineNumbers: true,
      lineWrapping: true,
      viewportMargin: Infinity,
      styleActiveLine: true,
      autofocus: true,
      indentUnit: 2,
      tabSize: 2,
      inputStyle: 'textarea',
      spellcheck: false
    })
    cmRef.current = cm
    cm.getWrapperElement().classList.add('editor-plain', 'timber-source-editor')
    cm.getWrapperElement().setAttribute('data-editor', 'source')
    cm.getWrapperElement().setAttribute('aria-label', '原文编辑器')
    const runtime = createSourceRuntime(cm)
    registerMarkdownEditor(runtime)

    const onChange = (): void => {
      if (useStore.getState().draft !== cm.getValue()) useStore.getState().setDraft(cm.getValue())
    }
    cm.on('change', onChange)
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (state.activeTabId !== tabId || state.draft === previous.draft) return
      if (state.draft !== cm.getValue()) {
        const cursor = cm.getCursor()
        cm.setValue(state.draft)
        cm.setCursor(cursor)
      }
    })

    const insertImages = async (files: File[]): Promise<void> => {
      const state = useStore.getState()
      if (!state.activeProjectId || !state.activeDoc) return
      const value = cm.getValue()
      const start = cm.indexFromPos(cm.getCursor('from'))
      const end = cm.indexFromPos(cm.getCursor('to'))
      const currentTab = state.activeTabId
      try {
        const markdown = await saveMarkdownImages(files, state.activeProjectId, state.activeDoc.path)
        if (cmRef.current !== cm || useStore.getState().activeTabId !== currentTab || cm.getValue() !== value) {
          state.toast('info', '图片已保存到文档旁的 assets 目录；编辑位置已变化，请从目录插入')
          return
        }
        applyCodeMirrorEdit(cm, { start, end, text: markdown, selectionStart: start + markdown.length, selectionEnd: start + markdown.length })
      } catch (error) {
        state.toast('err', `图片插入失败：${error instanceof Error ? error.message : error}`)
      }
    }

    const onImages = (event: Event): void => { void insertImages((event as CustomEvent<File[]>).detail) }
    const onCommand = (event: Event): void => {
      if (isMarkdown) applyCodeMirrorCommand(cm, (event as CustomEvent<MarkdownCommandRequest>).detail)
    }
    const onPaste = (event: ClipboardEvent): void => {
      if (!isMarkdown) return
      const files = clipboardImageFiles(event.clipboardData)
      if (files.length) {
        event.preventDefault()
        event.stopPropagation()
        void insertImages(files)
      }
    }
    const onDrop = (event: DragEvent): void => {
      if (!isMarkdown) return
      const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith('image/'))
      if (files.length) {
        event.preventDefault()
        event.stopPropagation()
        void insertImages(files)
      }
    }
    const onDragOver = (event: DragEvent): void => {
      if (isMarkdown && event.dataTransfer?.types.includes('Files')) event.preventDefault()
    }
    const wrapper = cm.getWrapperElement()
    wrapper.addEventListener('paste', onPaste, true)
    wrapper.addEventListener('drop', onDrop, true)
    wrapper.addEventListener('dragover', onDragOver)
    window.addEventListener('timber:insert-images', onImages)
    window.addEventListener(MARKDOWN_COMMAND_EVENT, onCommand)

    cm.on('keydown', (editor, event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void useStore.getState().saveDoc()
        return
      }
      if (!isMarkdown || event.isComposing) return
      const command = formattingShortcut(event)
      if (command) {
        event.preventDefault()
        applyCodeMirrorCommand(editor, { command })
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const start = editor.indexFromPos(editor.getCursor('from'))
      const end = editor.indexFromPos(editor.getCursor('to'))
      const value = editor.getValue()
      if (event.key === '/' && start === end && !value.slice(value.lastIndexOf('\n', start - 1) + 1, start).trim()) {
        event.preventDefault()
        window.dispatchEvent(new Event('timber:open-insert'))
        return
      }
      const preferences = useWritingPreferences.getState()
      const change = event.key === 'Tab' ? indentMarkdown(value, start, end, event.shiftKey)
        : event.key === 'Enter' && !event.shiftKey && preferences.smartLists ? smartEnter(value, start, end)
          : preferences.autoPair ? pairMarkdown(value, start, end, event.key) : null
      if (change) {
        event.preventDefault()
        applyCodeMirrorEdit(editor, change)
      }
    })

    return () => {
      unsubscribe()
      window.removeEventListener('timber:insert-images', onImages)
      window.removeEventListener(MARKDOWN_COMMAND_EVENT, onCommand)
      wrapper.removeEventListener('paste', onPaste, true)
      wrapper.removeEventListener('drop', onDrop, true)
      wrapper.removeEventListener('dragover', onDragOver)
      if (getMarkdownEditor() === runtime) registerMarkdownEditor(null)
      cmRef.current = null
      wrapper.remove()
      host.replaceChildren()
    }
  }, [tabId, docPath, isMarkdown])

  return <div className="editor-pane" ref={hostRef} />
}
