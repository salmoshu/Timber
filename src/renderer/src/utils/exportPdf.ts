/** 导出 PDF（v0.5.7）：渲染器用 Vditor 内置 Lute 把当前文档渲染为独立 HTML
 * （复用 prose 排版的打印版样式，浅色纸张），交给主进程隐藏窗口 printToPDF。
 * 不走主窗口 webContents.printToPDF——那会连同应用外壳一起打进去。 */
import Vditor from 'vditor'
import hljs from 'highlight.js/lib/common'
import { origProjectId, rawBaseFor, useStore } from '../store'
import { resolveDocLink, wrapSoftBreaks } from '../components/MarkdownView'
import { sanitizeRenderedHtml, upgradeInlineHtml } from './sanitizeHtml'

/** PDF 打印样式：prose.css 的浅色实体化版本（PDF 永远是纸张，浅色唯一合理）。
 *  标题沿用 0.5.6 的 em 相对梯度；pre/table 撤销横向滚动（打印无滚动条，改换行防截断） */
const PRINT_CSS = `
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    margin: 0; padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
      Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "微软雅黑", sans-serif;
    font-size: 16px; line-height: 1.65; color: #000000e6;
    word-break: break-word;
  }
  .prose h1, .prose h2, .prose h3, .prose h4, .prose h5, .prose h6 { color: #000000e6; line-height: 1.45; font-weight: 700; }
  .prose h1 { font-size: 1.75em; line-height: 1.4; margin: 0 0 20px; padding-bottom: 14px; border-bottom: 1px solid #00000021; letter-spacing: 0.3px; }
  .prose h2 { font-size: 1.45em; line-height: 1.4; margin: 36px 0 12px; padding-top: 12px; border-top: 1px solid #00000021; }
  .prose h3 { font-size: 1.25em; margin: 28px 0 8px; }
  .prose h4 { font-size: 1.1em; margin: 22px 0 6px; }
  .prose h5 { font-size: 1em; margin: 18px 0 6px; }
  .prose h6 { font-size: 0.95em; margin: 16px 0 6px; color: #0009; }
  .prose p { margin: 10px 0; }
  .prose ul, .prose ol { margin: 8px 0 12px; padding-left: 26px; }
  .prose li { margin: 4px 0; }
  .prose strong { color: #000000e6; }
  .prose a { color: #1783ff; text-decoration: none; }
  .prose blockquote {
    margin: 14px 0; padding: 12px 18px; border-left: 3px solid #1783ff;
    background: #1783ff1a; border-radius: 0 10px 10px 0; color: #0009; font-size: 15px;
  }
  .prose blockquote p { margin: 3px 0; }
  .prose code {
    font-family: "Geist Mono", "SF Mono", Monaco, Inconsolata, "Fira Code", "Droid Sans Mono",
      "Source Code Pro", Consolas, "Courier New", monospace;
    font-size: 0.9em; background: #00000008; padding: 1.5px 6px; border-radius: 4px; color: #e45649;
  }
  .prose pre {
    background: #f5f5f5; color: #000000e6; padding: 16px 18px; border: 1px solid #00000021;
    border-radius: 10px; margin: 14px 0; font-size: 14px; line-height: 22px;
    white-space: pre-wrap; word-break: break-word; overflow: visible;
  }
  .prose pre code { background: none; color: inherit; padding: 0; font-size: inherit; }
  .prose table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14px; line-height: 1.6; }
  .prose th, .prose td { border: 1px solid #00000021; padding: 7px 11px; text-align: left; vertical-align: top; word-break: break-word; }
  .prose th { background: #00000008; font-weight: 600; }
  .prose img { max-width: 100%; border-radius: 10px; }
  .prose hr { border: none; border-top: 1px solid #00000021; margin: 28px 0; }
  .prose pre, .prose blockquote, .prose table, .prose img { break-inside: avoid; }
  .prose h1, .prose h2, .prose h3, .prose h4, .prose h5, .prose h6 { break-after: avoid; }
  .prose span[data-an-softbreak] { display: none; }
  .prose span[data-an-softbreak-br] { white-space: pre-wrap; }
  /* highlight.js One Light（与应用浅色主题同款） */
  .hljs-keyword, .hljs-selector-tag, .hljs-built_in, .hljs-type, .hljs-class { color: #a626a4; }
  .hljs-string, .hljs-regexp, .hljs-addition { color: #50a14f; }
  .hljs-comment, .hljs-quote { color: #a1a1a1; font-style: italic; }
  .hljs-number, .hljs-literal { color: #986801; }
  .hljs-meta, .hljs-attr, .hljs-attribute, .hljs-selector-attr, .hljs-selector-class, .hljs-selector-id { color: #c18401; }
  .hljs-title, .hljs-section, .hljs-name, .hljs-selector-pseudo, .hljs-subst { color: #e45649; }
  .hljs-symbol, .hljs-bullet, .hljs-link, .hljs-deletion { color: #e45649; }
  .hljs-emphasis { font-style: italic; }
  .hljs-strong { font-weight: 700; }
`

let exporting = false

/** 导出当前文档为 PDF：渲染为独立 HTML → 主进程隐藏窗口打印 → 保存对话框 */
export async function exportActiveDocPdf(): Promise<void> {
  const state = useStore.getState()
  const doc = state.activeDoc
  const projectId = state.activeProjectId
  const bridge = window.timber
  if (!doc || !projectId) return
  if (!bridge) {
    state.toast('info', '纯 Web 预览模式不支持导出 PDF')
    return
  }
  if (exporting) return
  exporting = true
  try {
    // 导出当前草稿（所见即所得）：编辑器持续同步 draft，未保存的修改也进 PDF
    const md = state.draft
    let body = await Vditor.md2html(md, {
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
    // CJK 软换行连写与应用内阅读一致
    body = wrapSoftBreaks(body)
    const tpl = document.createElement('template')
    tpl.innerHTML = body
    // 与阅读视图一致的安全收口：剥 script/on*，行内 <img> 升级为真实图片（src 在下方统一重写）
    sanitizeRenderedHtml(tpl.content)
    upgradeInlineHtml(tpl.content)
    // 代码块高亮（与应用内同款 hljs；md2html 关闭自带高亮避免加载主题脚本）
    tpl.content.querySelectorAll<HTMLElement>('pre code').forEach((code) => {
      const language = [...code.classList].find((name) => name.startsWith('language-'))?.slice(9)
      try {
        if (language && hljs.getLanguage(language)) hljs.highlightElement(code)
      } catch {
        /* 高亮失败保留纯文本 */
      }
    })
    // 相对路径图片 → sidecar /raw 绝对 URL（隐藏窗口可直接加载）
    const base = await rawBaseFor(projectId)
    const pid = origProjectId(projectId)
    tpl.content.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') ?? ''
      if (!src || /^(https?:|data:|blob:)/i.test(src)) return
      const resolved = resolveDocLink(doc.path, src)
      if (!resolved) return
      img.setAttribute('src', `${base}/raw/${pid}/${resolved.split('/').map(encodeURIComponent).join('/')}`)
    })
    const name = (doc.path.split('/').pop() ?? 'document').replace(/\.(md|markdown|mdown|mkd|txt)$/i, '')
    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${name}</title>` +
      `<style>${PRINT_CSS}</style></head><body><div class="vditor-reset prose">${tpl.innerHTML}</div></body></html>`
    const r = await bridge.exportPdf({ html, defaultName: `${name}.pdf` })
    if (r.ok) state.toast('ok', `已导出 PDF：${r.path}`)
    else if (!r.canceled) state.toast('err', `导出 PDF 失败：${r.error ?? '未知错误'}`)
  } catch (err) {
    state.toast('err', `导出 PDF 失败：${err instanceof Error ? err.message : err}`)
  } finally {
    exporting = false
  }
}
