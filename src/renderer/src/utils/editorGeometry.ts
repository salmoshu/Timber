/** A short-lived mirror measures wrapped textarea lines without changing selection or scroll. */
export function textareaCaretRect(textarea: HTMLTextAreaElement, offset = textarea.selectionEnd): DOMRect {
  const style = getComputedStyle(textarea)
  const rect = textarea.getBoundingClientRect()
  const mirror = document.createElement('div')
  for (const property of ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'tab-size', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'box-sizing', 'text-indent']) {
    mirror.style.setProperty(property, style.getPropertyValue(property))
  }
  Object.assign(mirror.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, visibility: 'hidden', pointerEvents: 'none', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', borderStyle: 'solid' })
  mirror.textContent = textarea.value.slice(0, offset)
  const caret = document.createElement('span')
  caret.textContent = '\u200b'
  mirror.append(caret)
  document.body.append(mirror)
  const measured = caret.getBoundingClientRect()
  const result = new DOMRect(measured.left - textarea.scrollLeft, measured.top - textarea.scrollTop, measured.width, Number.parseFloat(style.lineHeight) || measured.height || 24)
  mirror.remove()
  return result
}
