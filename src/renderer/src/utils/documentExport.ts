import Vditor from 'vditor'
import hljs from 'highlight.js/lib/common'
import { origProjectId, rawBaseFor, useStore } from '../store'
import { resolveDocLink, wrapSoftBreaks } from '../components/MarkdownView'
import { sanitizeRenderedHtml, upgradeInlineHtml } from './sanitizeHtml'
import { applyImageSizes } from './imageSizes'
import { askConfirm, askPath } from './dialogs'
import { htmlToDocxBase64 } from './docxExport'

export const EXPORT_PAGE_CSS = `
  @page { size: A4; margin: 16mm 15mm; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; padding: 0; background: #ffffff; color: #222222; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 16px; line-height: 1.65; word-break: break-word; }
  .prose h1, .prose h2, .prose h3, .prose h4, .prose h5, .prose h6 { color: #222; line-height: 1.45; font-weight: 700; break-after: avoid; }
  .prose h1 { font-size: 1.75em; margin: 0 0 20px; padding-bottom: 14px; letter-spacing: 0.3px; }
  .prose h2 { font-size: 1.45em; margin: 36px 0 12px; padding-top: 12px; }
  .prose h3 { font-size: 1.25em; margin: 28px 0 8px; }
  .prose h4 { font-size: 1.1em; margin: 22px 0 6px; }
  .prose h5 { font-size: 1em; margin: 18px 0 6px; }
  .prose h6 { font-size: 0.95em; margin: 16px 0 6px; color: #555; }
  .prose p { margin: 10px 0; }
  .prose ul, .prose ol { margin: 8px 0 12px; padding-left: 26px; }
  .prose li { margin: 4px 0; }
  .prose a { color: #1783ff; text-decoration: none; }
  .prose blockquote { margin: 14px 0; padding: 12px 18px; border-left: 3px solid #1783ff; background: #1783ff12; color: #555; }
  .prose blockquote p { margin: 3px 0; }
  .prose code { font-family: Consolas, monospace; font-size: 0.9em; background: #00000008; padding: 1.5px 6px; border-radius: 4px; color: #b83a32; }
  .prose pre { background: #f5f5f5; color: #222; padding: 16px 18px; border: 1px solid #ddd; border-radius: 10px; margin: 14px 0; font-size: 14px; line-height: 22px; white-space: pre-wrap; word-break: break-word; overflow: visible; }
  .prose pre code { background: none; color: inherit; padding: 0; font-size: inherit; }
  .prose table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14px; line-height: 1.6; }
  .prose th, .prose td { border: 1px solid #ccc; padding: 7px 11px; text-align: left; vertical-align: top; word-break: break-word; }
  .prose th { background: #f2f2f2; font-weight: 600; }
  .prose img { max-width: 100%; height: auto; border-radius: 8px; }
  .prose hr { border: none; border-top: 1px solid #bbb; margin: 28px 0; }
  .prose pre, .prose blockquote, .prose table, .prose img { break-inside: avoid; }
  .prose span[data-an-softbreak] { display: none; }
  .prose span[data-an-softbreak-br] { white-space: pre-wrap; }
  .page-break { break-before: page !important; page-break-before: always !important; }
  .hljs-keyword, .hljs-selector-tag, .hljs-built_in, .hljs-type, .hljs-class { color: #a626a4; }
  .hljs-string, .hljs-regexp, .hljs-addition { color: #50a14f; }
  .hljs-comment, .hljs-quote { color: #a1a1a1; font-style: italic; }
  .hljs-number, .hljs-literal { color: #986801; }
  .hljs-meta, .hljs-attr, .hljs-attribute, .hljs-selector-attr, .hljs-selector-class, .hljs-selector-id { color: #c18401; }
  .hljs-title, .hljs-section, .hljs-name, .hljs-selector-pseudo, .hljs-subst, .hljs-symbol, .hljs-bullet, .hljs-link, .hljs-deletion { color: #e45649; }
  .hljs-emphasis { font-style: italic; }
  .hljs-strong { font-weight: 700; }
`

export const PAGED_SCREEN_CSS = `
  .pagedjs_pages { width: 794px; margin: 0 auto; padding: 0; background: transparent; }
  .pagedjs_page { background: #fff; box-shadow: 0 8px 30px #00000018; border-radius: 4px; margin: 0 auto 22px; }
  .pagedjs_page:last-child { margin-bottom: 0; }
`

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export async function renderMarkdownForExport(markdown: string, docPath: string, projectId: string): Promise<string> {
  let body = await Vditor.md2html(markdown, {
    cdn: 'vditor-libs',
    mode: 'light',
    hljs: { enable: false },
    theme: { current: '' },
    markdown: {
      sanitize: false,
      mark: true,
      sub: true,
      sup: true,
      footnotes: true,
      gfmAutoLink: true,
      callout: true,
      mathBlockPreview: true,
      codeBlockPreview: true
    }
  })
  body = wrapSoftBreaks(body)
  const template = document.createElement('template')
  template.innerHTML = body
  sanitizeRenderedHtml(template.content)
  upgradeInlineHtml(template.content)
  applyImageSizes(template.content, projectId, docPath)
  template.content.querySelectorAll<HTMLElement>('pre code').forEach((code) => {
    const language = [...code.classList].find((name) => name.startsWith('language-'))?.slice(9)
    try {
      if (language && hljs.getLanguage(language)) hljs.highlightElement(code)
    } catch {
      /* 高亮失败保留纯文本 */
    }
  })
  const base = await rawBaseFor(projectId)
  const pid = origProjectId(projectId)
  template.content.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') ?? ''
    if (!src || /^(https?:|data:|blob:)/i.test(src)) return
    const resolved = resolveDocLink(docPath, src)
    if (!resolved) return
    img.setAttribute('src', `${base}/raw/${pid}/${resolved.split('/').map(encodeURIComponent).join('/')}`)
  })
  return `<div class="vditor-reset prose">${template.innerHTML}</div>`
}

export async function waitForHtmlImages(html: string): Promise<void> {
  const template = document.createElement('template')
  template.innerHTML = html
  await Promise.all([...template.content.querySelectorAll('img')].map((source) => {
    const img = new Image()
    img.src = source.getAttribute('src') ?? ''
    return img.decode().catch(() => {})
  }))
}

function continuousHtml(body: string, title: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${EXPORT_PAGE_CSS}.export-document{width:794px;margin:0 auto;padding:42px 48px;background:#fff;}</style></head><body><main class="export-document">${body}</main></body></html>`
}

function staticPagedDocument(pagesHtml: string, title: string): string {
  const generatedCss = [...document.querySelectorAll('style[data-pagedjs-inserted-styles]')]
    .map((style) => style.textContent ?? '')
    .join('\n')
  const printCss = `
    @page { size: A4; margin: 0; }
    .pagedjs_pages { display: block !important; width: auto !important; height: auto !important; overflow: visible !important; transform: none !important; }
    .pagedjs_page { break-after: page; page-break-after: always; margin: 0 !important; box-shadow: none !important; }
    .pagedjs_page:last-child { break-after: auto; page-break-after: auto; }
  `
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${EXPORT_PAGE_CSS}\n${generatedCss}\n${printCss}</style></head><body>${pagesHtml}</body></html>`
}

async function ensurePagedPreview(): Promise<void> {
  if (!document.querySelector('.paged-preview')) window.dispatchEvent(new Event('timber:paged-preview'))
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const pages = document.querySelectorAll('.paged-preview .pagedjs_page').length
    const loading = document.querySelector('.paged-preview-meta')?.textContent?.includes('正在分页') ?? false
    if (pages > 0 && !loading) return
    const error = document.querySelector('.paged-preview .re-error-desc')?.textContent
    if (error) throw new Error(error)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('分页预览超时，请重试')
}

function pagedHtml(title: string): string {
  const existing = document.querySelector('.paged-preview .pagedjs_pages')
  if (!existing) throw new Error('分页预览尚未就绪')
  return staticPagedDocument(existing.outerHTML, title)
}

let exporting = false

export type DocumentExportKind = 'pdf' | 'word' | 'image'

export async function exportActiveDocument(kind: DocumentExportKind): Promise<void> {
  const state = useStore.getState()
  const doc = state.activeDoc
  const projectId = state.activeProjectId
  const bridge = window.timber
  const label = kind === 'pdf' ? 'PDF' : kind === 'word' ? 'Word' : '长图'
  if (!doc || !projectId) return
  if (!bridge) {
    state.toast('info', `纯 Web 预览模式不支持导出${label}`)
    return
  }
  if (exporting) return
  exporting = true
  try {
    const name = (doc.path.split('/').pop() ?? 'document').replace(/\.(md|markdown|mdown|mkd)$/i, '')
    const extension = kind === 'pdf' ? '.pdf' : kind === 'word' ? '.docx' : '.png'
    const path = await askPath('save', `${name}${extension}`, extension)
    if (!path) return
    const overwrite = await bridge.pathExists(path)
    if (overwrite && !await askConfirm(`「${path}」已存在。是否用导出的${label}覆盖？`, { title: '覆盖已有文件', confirmLabel: '覆盖' })) return
    const body = await renderMarkdownForExport(state.draft, doc.path, projectId)
    await waitForHtmlImages(body)
    if (kind === 'pdf') await ensurePagedPreview()
    const result = kind === 'pdf'
      ? await bridge.exportPdf({ html: pagedHtml(name), path, overwrite })
      : kind === 'image'
        ? await bridge.exportImage({ html: continuousHtml(body, name), path, overwrite })
        : await bridge.exportBinary({ data: await htmlToDocxBase64(body, name), path, overwrite })
    if (result.ok) state.toast('ok', `已导出${label}：${result.path}`)
    else state.toast('err', `导出${label}失败：${result.error ?? '未知错误'}`)
  } catch (err) {
    state.toast('err', `导出${label}失败：${err instanceof Error ? err.message : err}`)
  } finally {
    exporting = false
  }
}
