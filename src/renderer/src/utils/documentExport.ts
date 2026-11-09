import { MarkdownToHtml, embeddedKatexCss } from '@muyajs/core'
import hljs from 'highlight.js/lib/common'
import { origProjectId, rawBaseFor, useStore } from '../store'
import { resolveDocLink, wrapSoftBreaks } from '../components/MarkdownView'
import { sanitizeRenderedHtml, upgradeInlineHtml } from './sanitizeHtml'
import { applyImageMetas } from './imageSizes'
import { askConfirm, askPath } from './dialogs'
import { htmlToDocxBase64 } from './docxExport'

export const A4_CONTENT_WIDTH = 680
const A4_MERMAID_MAX_HEIGHT = 900

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
  .prose pre, .prose blockquote, .prose table, .prose img, .prose .mermaid-doc { break-inside: avoid; }
  /* Mermaid 静态导出可位于 div 或 pre > code 中，统一按图卡排版。 */
  .prose .mermaid-doc { display: block; background: #ffffff; border: none; padding: 6px 0; text-align: center; white-space: normal; }
  .prose .mermaid-doc > code { background: none; color: inherit; display: block; }
  .prose .mermaid-doc svg { max-width: 100%; height: auto; }
  .prose [data-mermaid-error] { color: #b83a32; }
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

/** 分页预览（屏幕呈现）样式：纸面阴影等。超高 Mermaid 图按页内容高度限高、
 *  等比缩小到完整落进一页——否则 pagedjs 会把图块拆到多页、每份都被页缘裁掉
 *  （v0.6.11 修复分页渲染缺损）；导出 PDF 的打印样式里同步一份。 */
export const PAGED_SCREEN_CSS = `
  .pagedjs_pages { width: 794px; margin: 0 auto; padding: 0; background: transparent; }
  .pagedjs_page { background: #fff; box-shadow: 0 8px 30px #00000018; border-radius: 4px; margin: 0 auto 22px; }
  .pagedjs_page:last-child { margin-bottom: 0; }
  .pagedjs_page .mermaid-doc svg { max-height: ${A4_MERMAID_MAX_HEIGHT}px; }
  .prose .mermaid-page-break { break-before: page !important; page-break-before: always !important; }
`

/** PagedJS 会把超高的 SVG 连同前页剩余空间一起复制，单用 break-inside:avoid
 *  仍会在两页各出现一份。只让缩放后仍超页高的图从新页开始；普通图保持连续排版。 */
function markTallMermaidPageBreaks(root: ParentNode): void {
  root.querySelectorAll<SVGElement>('.mermaid-doc svg').forEach((svg) => {
    const viewBox = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
    const [, , naturalWidth, naturalHeight] = viewBox
    if (!(naturalWidth > 0 && naturalHeight > 0)) return
    const customWidth = Number.parseFloat(svg.style.width)
    const width = Number.isFinite(customWidth) && customWidth > 0
      ? customWidth
      : Math.min(naturalWidth, A4_CONTENT_WIDTH)
    if (naturalHeight * (width / naturalWidth) <= A4_MERMAID_MAX_HEIGHT) return
    const block = svg.closest('pre.mermaid-doc') ?? svg.closest('.mermaid-doc')
    block?.classList.add('mermaid-page-break')
  })
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export async function renderMarkdownForExport(markdown: string, docPath: string, projectId: string): Promise<string> {
  const project = useStore.getState().projects.find((item) => item.id === projectId)
  let body = await new MarkdownToHtml(markdown, undefined, {
    frontMatter: true,
    footnote: true,
    cjkEmphasis: true,
    superSubScript: true,
    texMathDollars: true,
    texMathGfm: true,
    highlightSyntax: true,
    githubAlerts: true,
    multilineBlockquote: true,
    fancyLists: true
  }).renderHtml()
  body = wrapSoftBreaks(body)
  const template = document.createElement('template')
  template.innerHTML = body
  sanitizeRenderedHtml(template.content)
  upgradeInlineHtml(template.content)
  // Muya 已将 Mermaid 和其他图表渲染为静态 SVG；补齐 Timber 的分页与尺寸元数据类名。
  template.content.querySelectorAll<HTMLElement>('.mermaid').forEach((element) => element.classList.add('mermaid-doc', 'language-mermaid'))
  applyImageMetas(template.content, projectId, docPath)
  markTallMermaidPageBreaks(template.content)
  template.content.querySelectorAll<HTMLElement>('pre code').forEach((code) => {
    if (code.querySelector('.token')) return
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
    const resolved = resolveDocLink(docPath, src, project?.path)
    if (!resolved) return
    img.setAttribute('src', `${base}/raw/${pid}/${resolved.split('/').map(encodeURIComponent).join('/')}`)
  })
  return `<div class="prose">${template.innerHTML}</div>`
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
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${EXPORT_PAGE_CSS}\n${embeddedKatexCss()}\n.export-document{width:794px;margin:0 auto;padding:42px 48px;background:#fff;}</style></head><body><main class="export-document">${body}</main></body></html>`
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
    .pagedjs_page .mermaid-doc svg { max-height: 900px; }
    .pagedjs_page .mermaid-page-break { break-before: auto !important; page-break-before: auto !important; }
  `
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${EXPORT_PAGE_CSS}\n${embeddedKatexCss()}\n${generatedCss}\n${printCss}</style></head><body>${pagesHtml}</body></html>`
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

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('导出资源读取失败'))
    reader.readAsDataURL(blob)
  })
}

/** Local assets must survive closing Timber or moving the exported HTML to another machine. */
export async function portableDocumentHtml(body: string, title: string, projectId: string): Promise<string> {
  const template = document.createElement('template')
  template.innerHTML = body
  const base = await rawBaseFor(projectId)
  await Promise.all([...template.content.querySelectorAll('img')].map(async (image) => {
    const src = image.getAttribute('src') ?? ''
    if (!src.startsWith(base + '/raw/')) return
    const response = await fetch(src)
    if (!response.ok) throw new Error('本地图片读取失败，请确认图片仍存在')
    image.src = await blobDataUrl(await response.blob())
    image.removeAttribute('data-an-orig-src')
    image.removeAttribute('data-an-display-src')
  }))
  const mathCss = template.content.querySelector('.katex') ? embeddedKatexCss() : ''
  // No application scripts, editor controls, token-bearing URLs or live diagram dependencies.
  template.content.querySelectorAll('script, .mu-copy-header-link, .mu-code-copy').forEach((element) => element.remove())
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${EXPORT_PAGE_CSS}\n${mathCss}\n.export-document{max-width:960px;margin:0 auto;padding:36px clamp(16px,5vw,60px)}pre{overflow-x:auto!important}table{max-width:100%}</style></head><body><main class="export-document">${template.innerHTML}</main></body></html>`
}

export type DocumentExportKind = 'pdf' | 'word' | 'image' | 'html'

export async function exportActiveDocument(kind: DocumentExportKind): Promise<void> {
  const state = useStore.getState()
  const doc = state.activeDoc
  const projectId = state.activeProjectId
  const bridge = window.timber
  const label = kind === 'pdf' ? 'PDF' : kind === 'word' ? 'Word' : kind === 'html' ? 'HTML' : '长图'
  if (!doc || !projectId) return
  if (!bridge) {
    state.toast('info', `纯 Web 预览模式不支持导出${label}`)
    return
  }
  if (exporting) return
  exporting = true
  try {
    const name = (doc.path.split('/').pop() ?? 'document').replace(/\.(md|markdown|mdown|mkd)$/i, '')
    const extension = kind === 'pdf' ? '.pdf' : kind === 'word' ? '.docx' : kind === 'html' ? '.html' : '.png'
    const path = await askPath('save', `${name}${extension}`, extension)
    if (!path) return
    const overwrite = await bridge.pathExists(path)
    if (overwrite && !await askConfirm(`「${path}」已存在。是否用导出的${label}覆盖？`, { title: '覆盖已有文件', confirmLabel: '覆盖' })) return
    const body = await renderMarkdownForExport(state.draft, doc.path, projectId)
    await waitForHtmlImages(body)
    if (kind === 'pdf') await ensurePagedPreview()
    const result = kind === 'html'
      ? await bridge.exportHtml({ html: await portableDocumentHtml(body, name, projectId), path, overwrite })
      : kind === 'pdf'
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
