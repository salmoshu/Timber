import { useEffect } from 'react'
import { useWritingPreferences, toggleWritingPreference } from './writingPreferences'
import { getMarkdownEditor } from './markdownEditorRuntime'

export function useWritingExperience(enabled: boolean, paged: boolean): string {
  const { focus, typewriter, distractionFree } = useWritingPreferences()
  useEffect(() => {
    document.documentElement.classList.toggle('writing-immersive', enabled && !paged && distractionFree)
    return () => document.documentElement.classList.remove('writing-immersive')
  }, [enabled, paged, distractionFree])
  useEffect(() => {
    if (!enabled || paged) return
    const shortcuts = (event: KeyboardEvent): void => {
      if (event.isComposing || (event.target as Element)?.closest('dialog, [role="dialog"], .find-panel')) return
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'j') { event.preventDefault(); toggleWritingPreference('focus') }
      else if (event.key === 'F8') { event.preventDefault(); toggleWritingPreference('focus') }
      else if (event.key === 'F9') { event.preventDefault(); toggleWritingPreference('typewriter') }
      else if (event.key === 'F10') { event.preventDefault(); toggleWritingPreference('distractionFree') }
      else if ((event.ctrlKey || event.metaKey) && event.key === '/') { event.preventDefault(); window.dispatchEvent(new Event('timber:open-insert')) }
      else if (event.key === 'Escape' && distractionFree) { event.preventDefault(); toggleWritingPreference('distractionFree') }
    }
    window.addEventListener('keydown', shortcuts)
    return () => window.removeEventListener('keydown', shortcuts)
  }, [enabled, paged, distractionFree])
  useEffect(() => {
    if (!enabled || paged || (!focus && !typewriter)) return
    let frame = 0
    let shouldCenter = false
    const update = (): void => {
      frame = 0
      const body = document.querySelector<HTMLElement>('.resource-reader .document-workspace > .reader-body')
      if (!body) return
      const runtime = getMarkdownEditor()
      let caret: DOMRect | null = null
      body.querySelectorAll('.writing-current-block, .writing-current-line').forEach((node) => node.classList.remove('writing-current-block', 'writing-current-line'))
      if (runtime?.kind === 'source' && runtime.root.contains(document.activeElement)) {
        const offsets = runtime.getSelectionOffsets()
        caret = runtime.caretRect()
        const first = offsets && offsets.start !== offsets.end ? runtime.caretRect(offsets.start) : caret
        if (caret && first) {
          const rootRect = runtime.root.getBoundingClientRect()
          runtime.root.style.setProperty('--source-focus-top', `${first.top - rootRect.top + runtime.root.scrollTop}px`)
          runtime.root.style.setProperty('--source-focus-height', `${Math.max(caret.height, caret.bottom - first.top)}px`)
        }
        if (offsets && offsets.start !== offsets.end) shouldCenter = false
      } else {
        const prose = body.querySelector<HTMLElement>('.markdown-editor .prose')
        const selection = window.getSelection()
        if (prose && selection?.rangeCount && prose.contains(selection.anchorNode)) {
          const range = selection.getRangeAt(0)
          const element = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer as Element
          let block = element as HTMLElement | null
          const container = prose.querySelector(':scope > .mu-container')
          const boundary = container ?? prose
          while (block?.parentElement && block.parentElement !== boundary) block = block.parentElement
          if (block && block !== prose && block !== container) block.classList.add('writing-current-block')
          element?.closest('li')?.classList.add('writing-current-line')
          caret = runtime?.caretRect() ?? range.getBoundingClientRect()
          if (!caret?.height && block) caret = block.getBoundingClientRect()
          if (!range.collapsed) shouldCenter = false
        }
      }
      if (typewriter && shouldCenter && caret) body.scrollTop += caret.top - body.getBoundingClientRect().top - body.clientHeight * 0.45
      shouldCenter = false
    }
    const schedule = (event?: Event): void => {
      const target = event?.target as Element | null
      if (event?.type === 'input' || event?.type === 'keyup') shouldCenter = !!target?.closest('.markdown-editor .prose, .editor-plain')
      if (!frame) frame = requestAnimationFrame(update)
    }
    document.addEventListener('selectionchange', schedule)
    document.addEventListener('input', schedule)
    document.addEventListener('keyup', schedule)
    window.addEventListener('markdown-rendered', schedule)
    window.addEventListener('timber:editor-runtime-changed', schedule)
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', schedule)
      document.removeEventListener('input', schedule)
      document.removeEventListener('keyup', schedule)
      window.removeEventListener('markdown-rendered', schedule)
      window.removeEventListener('timber:editor-runtime-changed', schedule)
      document.querySelectorAll('.writing-current-block, .writing-current-line').forEach((node) => node.classList.remove('writing-current-block', 'writing-current-line'))
    }
  }, [enabled, paged, focus, typewriter])
  return enabled && !paged ? `${focus ? 'writing-focus' : ''} ${typewriter ? 'writing-typewriter' : ''}` : ''
}
