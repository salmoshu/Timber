import { useEffect, useLayoutEffect, useRef } from 'react'
import { useStore } from '../store'

/** 原文模式：直接编辑 Markdown / HTML 源码或纯文本，与阅读模式共用草稿。
 *  textarea 随内容自增高，滚动交给 .reader-body——滚动条与阅读模式同款，且贴着右侧边栏。 */
export default function EditorPane() {
  const draft = useStore((s) => s.draft)
  const taRef = useRef<HTMLTextAreaElement>(null)

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
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault()
            void useStore.getState().saveDoc()
          }
        }}
      />
    </div>
  )
}
