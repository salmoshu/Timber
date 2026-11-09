import { useEffect, useState } from 'react'
import { normalizeEditorWidth } from '@shared/fontFamilies'
import type { FontCatalog } from '@shared/types'
import { useStore } from '../store'
import { DEFAULT_SETTINGS } from '../utils/settings'
import FontFamilySelect from './FontFamilySelect'
import './TypographySettings.css'

function TypographyRange({ id, label, value, min, max, step = 1, unit = '', onChange }: {
  id: string; label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange(value: number): void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  return <div className="tp-range-row">
    <label htmlFor={id}>{label}</label>
    <div className="tp-range-controls">
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <div className="tp-number"><input id={`${id}-number`} type="number" aria-label={`${label}数值`} min={min} max={max} step={step} value={draft}
        onChange={(event) => { setDraft(event.target.value); const next = event.target.valueAsNumber; if (Number.isFinite(next) && next >= min && next <= max) onChange(next) }}
        onBlur={(event) => { const text = event.currentTarget.value; const next = text.trim() ? Number(text) : value; const valid = Number.isFinite(next) ? Math.min(max, Math.max(min, next)) : value; onChange(valid); setDraft(String(valid)) }} />{unit && <span>{unit}</span>}</div>
    </div>
  </div>
}

export default function TypographySettings() {
  const settings = useStore((state) => state.settings)
  const setSetting = useStore((state) => state.setSetting)
  const [catalog, setCatalog] = useState<FontCatalog>({ families: [] })
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [resetVersion, setResetVersion] = useState(0)
  const [width, setWidth] = useState(settings.editorLineWidth)
  const widthValid = !width.trim() || !!normalizeEditorWidth(width)
  useEffect(() => setWidth(settings.editorLineWidth), [settings.editorLineWidth])
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const request = window.timber?.listFontFamilies
      ? window.timber.listFontFamilies(reload > 0)
      : Promise.resolve({ families: [], error: '暂时无法读取本机字体，仍可使用内置字体。' })
    void request.then((next) => { if (!cancelled) setCatalog(next) })
      .catch(() => { if (!cancelled) setCatalog({ families: [], error: '读取本机字体失败，请刷新后重试。' }) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [reload])

  const reset = (): void => {
    for (const key of ['fontSize', 'editorFontFamily', 'lineHeight', 'codeFontSize', 'codeFontFamily', 'wrapCodeBlocks', 'editorLineWidth'] as const) setSetting(key, DEFAULT_SETTINGS[key])
    setWidth(DEFAULT_SETTINGS.editorLineWidth)
    setResetVersion((value) => value + 1)
  }
  const commitWidth = (next: string): void => { if (!next.trim() || normalizeEditorWidth(next)) setSetting('editorLineWidth', normalizeEditorWidth(next)) }

  return <div className="st-card typography-settings">
    <div className="tp-heading"><div><h2 className="st-card-title">字体与排版</h2><p>为正文和代码分别选择字体，按自己的阅读习惯调整。</p></div>
      <button className="tp-reset" type="button" onClick={reset}>恢复默认</button></div>
    <div className="tp-font-catalog" aria-live="polite"><span>{loading ? '正在读取本机字体…' : catalog.error || `本机 ${catalog.families.length} 种字体 · 内置 Open Sans / DejaVu Sans Mono`}</span>
      <button type="button" onClick={() => setReload((value) => value + 1)} disabled={loading}>刷新字体</button></div>
    <div className="tp-layout">
      <div className="tp-controls" key={resetVersion}>
        <section className="tp-section" aria-labelledby="tp-body-title"><h3 id="tp-body-title">正文</h3>
          <div className="tp-font-row"><label htmlFor="editor-font-family">字体系列</label><FontFamilySelect id="editor-font-family" label="正文字体" value={settings.editorFontFamily} fonts={catalog.families} onChange={(value) => setSetting('editorFontFamily', value)} /></div>
          <TypographyRange id="editor-font-size" label="正文字号" value={settings.fontSize} min={12} max={32} unit="px" onChange={(value) => setSetting('fontSize', value)} />
          <TypographyRange id="editor-line-height" label="正文行高" value={settings.lineHeight} min={1.2} max={2} step={0.05} unit="倍" onChange={(value) => setSetting('lineHeight', value)} />
          <div className="tp-width-row"><label htmlFor="editor-line-width">正文最大宽度</label>
            <div className="tp-width-presets" role="group" aria-label="正文宽度预设">{[['', '自适应'], ['800px', '舒适'], ['640px', '窄栏']].map(([value, label]) => <button key={label} type="button" aria-pressed={settings.editorLineWidth === value} onClick={() => setSetting('editorLineWidth', value)}>{label}</button>)}</div>
            <input id="editor-line-width" className="st-input" type="text" value={width} placeholder="例如 800px、80ch 或 80%" aria-invalid={!widthValid} aria-describedby="editor-line-width-hint"
              onChange={(event) => setWidth(event.target.value)} onBlur={(event) => commitWidth(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); commitWidth(event.currentTarget.value) } }} />
            <p id="editor-line-width-hint" className={widthValid ? 'tp-hint' : 'tp-hint error'}>{widthValid ? '留空跟随窗口宽度，也可使用 px、ch 或 %。' : '请输入有效宽度，例如 800px、80ch 或 80%。'}</p>
          </div>
        </section>
        <section className="tp-section" aria-labelledby="tp-code-title"><h3 id="tp-code-title">代码块与源码</h3>
          <div className="tp-font-row"><label htmlFor="code-font-family">代码字体</label><FontFamilySelect id="code-font-family" label="代码字体" value={settings.codeFontFamily} fonts={catalog.families} code onChange={(value) => setSetting('codeFontFamily', value)} /></div>
          <TypographyRange id="code-font-size" label="代码字号" value={settings.codeFontSize} min={12} max={28} unit="px" onChange={(value) => setSetting('codeFontSize', value)} />
          <div className="tp-check-row"><label htmlFor="code-wrap">长代码自动换行</label><input id="code-wrap" type="checkbox" checked={settings.wrapCodeBlocks} onChange={(event) => setSetting('wrapCodeBlocks', event.target.checked)} /></div>
          <p className="tp-hint">代码字体建议优先选择等宽字体，正文与代码的选择分别保存。</p>
        </section>
      </div>
      <aside className="tp-preview" aria-label="字体实时预览"><div className="tp-preview-heading">实时预览<span>正文 {settings.fontSize}px · 代码 {settings.codeFontSize}px</span></div>
        <div className="tp-preview-body"><h3>把想法写成文字</h3><p>清晨的光落在纸上，每一行文字都有自己的节奏。</p><p>The quick brown fox jumps over the lazy dog.</p><p>0123456789 · <strong>粗体 Bold</strong> · <em>斜体 Italic</em></p><p>中文、English、标点与符号：你好，世界！</p></div>
        <div className="tp-preview-code-label">代码与源码</div>
        <pre className={`tp-preview-code${settings.wrapCodeBlocks ? ' wrap' : ''}`}><code><span className="tp-code-comment">{'// 每一种字体，现场预览\n'}</span><span className="tp-code-keyword">const</span>{' message = '}<span className="tp-code-string">{'"Hello, Timber · 你好，世界"'}</span>{'\nconsole.log(message, 1234567890)\n'}</code></pre>
        <p className="tp-preview-note">内置字体可离线使用；中文优先使用你选择的本机字体。</p>
      </aside>
    </div>
  </div>
}
