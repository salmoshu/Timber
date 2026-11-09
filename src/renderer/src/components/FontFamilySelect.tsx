import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BUNDLED_FONT_FAMILIES, GENERIC_FONT_FAMILIES, parseFontFamilies, serializeFontFamilies, uniqueFontFamilies } from '@shared/fontFamilies'
import { IconChevronDown } from './icons'

interface Props {
  id: string
  label: string
  value: string
  fonts: string[]
  code?: boolean
  onChange(value: string): void
}

/** Searchable single-choice font dropdown, matching MarkText's editor settings. */
export default function FontFamilySelect({ id, label, value, fonts, code = false, onChange }: Props) {
  const saved = parseFontFamilies(value)
  const current = saved[0] || (code ? 'DejaVu Sans Mono' : 'Open Sans')
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(current)
  const [active, setActive] = useState(0)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 320, height: 360 })
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const catalog = useMemo(() => uniqueFontFamilies([
    ...(code ? [...BUNDLED_FONT_FAMILIES].reverse() : BUNDLED_FONT_FAMILIES),
    ...fonts, ...GENERIC_FONT_FAMILIES, ...parseFontFamilies(value)
  ]), [fonts, code, value])
  const nativeFonts = new Set(fonts.map((font) => font.toLowerCase()))
  const term = query.trim().toLocaleLowerCase()
  const available = catalog.filter((font) => term === current.toLocaleLowerCase() || font.toLocaleLowerCase().includes(term))
  const listId = `${id}-options`
  const close = (): void => { setOpen(false); setQuery(current) }
  const show = (): void => {
    setQuery(current)
    setActive(Math.max(0, catalog.indexOf(current)))
    setOpen(true)
  }
  const choose = (font: string): void => {
    onChange(serializeFontFamilies([font]))
    setQuery(font)
    setOpen(false)
    input.current?.focus()
  }

  useEffect(() => { if (!open) setQuery(current) }, [current, open])
  useEffect(() => {
    const matches = catalog.filter((font) => query.trim().toLocaleLowerCase() === current.toLocaleLowerCase() || font.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    setActive(query.trim().toLocaleLowerCase() === current.toLocaleLowerCase() ? Math.max(0, matches.indexOf(current)) : 0)
  }, [query, current, catalog])
  useEffect(() => {
    if (open) document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, id, open])
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const rect = root.current?.getBoundingClientRect()
      if (!rect) return
      if (rect.bottom < 0 || rect.top > window.innerHeight) { setOpen(false); return }
      const width = Math.min(Math.max(240, rect.width), window.innerWidth - 32)
      const below = window.innerHeight - rect.bottom - 20
      const above = rect.top - 20
      const upward = below < 250 && above > below
      const height = Math.min(410, Math.max(160, upward ? above : below))
      setPosition({ width, height, left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)), top: upward ? Math.max(16, rect.top - height - 6) : rect.bottom + 6 })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => {
      const node = event.target as Node
      if (!root.current?.contains(node) && !popup.current?.contains(node)) close()
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, current])

  return <div className="font-family-field">
    <div className={`font-family-select${open ? ' open' : ''}`} ref={root}>
      <input ref={input} id={id} type="text" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={open}
        aria-controls={open ? listId : undefined} aria-activedescendant={open && available[active] ? `${id}-option-${active}` : undefined}
        aria-label={label} aria-describedby={`${id}-hint`} autoComplete="off" spellCheck={false}
        value={open ? query : current} placeholder="选择字体"
        onFocus={() => { if (!open) show() }} onClick={() => { if (!open) show() }}
        onChange={(event) => { if (!open) setOpen(true); setQuery(event.target.value) }}
        onBlur={(event) => { if (!popup.current?.contains(event.relatedTarget as Node) && !root.current?.contains(event.relatedTarget as Node)) close() }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close() }
          else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!open) show()
            else setActive((index) => available.length ? (index + (event.key === 'ArrowDown' ? 1 : available.length - 1)) % available.length : 0)
          } else if (event.key === 'Enter' && open && available[active]) { event.preventDefault(); choose(available[active]) }
          else if (event.key === 'Tab') close()
        }} />
      <button type="button" className="font-family-arrow" tabIndex={-1} aria-label={`选择${label}`} aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()} onClick={() => { if (open) close(); else { input.current?.focus(); show(); input.current?.select() } }}><IconChevronDown size={15} /></button>
    </div>
    <p id={`${id}-hint`} className="font-family-hint">{code ? '适用于行内代码、代码块与源码编辑器。' : '缺少的字符会自动使用备用字体显示。'}{saved.length > 1 ? ' 已保留原有字体回退偏好。' : ''}</p>
    {open && createPortal(<div ref={popup} className="font-picker-popup" style={{ left: position.left, top: position.top, width: position.width, height: position.height }}>
      <div className="font-picker-meta" aria-live="polite">{available.length} 种可选字体<span>输入字体名称可搜索</span></div>
      <div id={listId} className="font-picker-options" role="listbox" aria-label={`${label}可选字体`}>
        {available.map((font, index) => <button type="button" key={font} data-font-family={font} id={`${id}-option-${index}`} role="option"
          aria-selected={font.toLowerCase() === current.toLowerCase()} tabIndex={-1} className={`font-picker-option${active === index ? ' active' : ''}`}
          onPointerMove={() => setActive(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(font)}>
          <span className="font-picker-option-name">{font}<small>{(BUNDLED_FONT_FAMILIES as readonly string[]).includes(font) ? '内置' : (GENERIC_FONT_FAMILIES as readonly string[]).includes(font) ? '通用' : nativeFonts.has(font.toLowerCase()) ? '本机' : '已保存'}</small></span>
          <span className="font-picker-sample" aria-hidden="true" style={{ fontFamily: serializeFontFamilies([font, code ? 'monospace' : 'sans-serif']) }}>Aa 字 0123</span>
          {font.toLowerCase() === current.toLowerCase() && <svg className="font-picker-check" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>}
        </button>)}
        {!available.length && <div className="font-picker-empty">没有匹配的字体</div>}
      </div>
    </div>, document.body)}
  </div>
}
