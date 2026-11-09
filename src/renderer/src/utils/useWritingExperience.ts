import { useEffect } from 'react'
import { useWritingPreferences, toggleWritingPreference } from './writingPreferences'
import { textareaCaretRect } from './editorGeometry'

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
      const ta = body.querySelector<HTMLTextAreaElement>('.editor-plain')
      let caret: DOMRect | null = null
      if (ta && document.activeElement === ta) {
        caret = textareaCaretRect(ta)
        const first = ta.selectionStart === ta.selectionEnd ? caret : textareaCaretRect(ta, ta.selectionStart)
        ta.style.setProperty('--source-focus-top', `${first.top - ta.getBoundingClientRect().top + ta.scrollTop}px`)
        ta.style.setProperty('--source-focus-height', `${caret.bottom - first.top}px`)
        if (ta.selectionStart !== ta.selectionEnd) shouldCenter = false
      } else {
        const prose = body.querySelector<HTMLElement>('.markdown-editor .prose')
        const selection = window.getSelection()
        if (prose && selection?.rangeCount && prose.contains(selection.anchorNode)) {
          const range = selection.getRangeAt(0)
          const element = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer as Element
          let block = element as HTMLElement | null
          while (block?.parentElement && block.parentElement !== prose) block = block.parentElement
          body.querySelectorAll('.writing-current-block, .writing-current-line').forEach((node) => node.classList.remove('writing-current-block', 'writing-current-line'))
          if (block && block !== prose) block.classList.add('writing-current-block')
          element?.closest('li')?.classList.add('writing-current-line')
          caret = range.getBoundingClientRect()
          if (!caret.height && block) caret = block.getBoundingClientRect()
          if (!range.collapsed) shouldCenter = false
        }
      }
      if (typewriter && shouldCenter && caret?.height) body.scrollTop += caret.top - body.getBoundingClientRect().top - body.clientHeight * 0.45
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
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', schedule)
      document.removeEventListener('input', schedule)
      document.removeEventListener('keyup', schedule)
      window.removeEventListener('markdown-rendered', schedule)
      document.querySelectorAll('.writing-current-block, .writing-current-line').forEach((node) => node.classList.remove('writing-current-block', 'writing-current-line'))
    }
  }, [enabled, paged, focus, typewriter])
  return enabled && !paged ? `${focus ? 'writing-focus' : ''} ${typewriter ? 'writing-typewriter' : ''}` : ''
}
