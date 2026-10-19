import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Vditor from 'vditor'
import hljs from 'highlight.js/lib/common'
import 'vditor/dist/index.css'
import 'vditor/dist/js/icons/ant.js'
import 'vditor/dist/js/i18n/zh_CN.js'
import luteUrl from 'vditor/dist/js/lute/lute.min.js?url'
import type { Annotation } from '@shared/types'
import { useStore, rawBaseFor, origProjectId } from '../store'
import { systemPrefersDark } from '../utils/settings'
import { collectText, findAnnotationRange, setTextHighlight } from '../utils/textRanges'

interface Props {
  annotations: Annotation[]
  onSelectAnn: (id: string) => void
}

/** 统一路径分隔符：文档链接 / 用户输入里可能混入 Windows 反斜杠 */
const normSlashes = (p: string): string => p.replace(/\\/g, '/')

/** 项目根的可接受书写变体（把文档里的绝对路径映射回项目内相对路径）：
 *  - 远程 WSL/SSH 项目：根本身就是 Linux 绝对路径（/home/...）
 *  - 本地 UNC WSL 项目：\\wsl.localhost\<distro>\home\... → 同时接受 /home/... 写法
 *  - Windows 本地项目：E:\foo 与 E:/foo 等价（比较时忽略大小写） */
function projectRootVariants(root: string): string[] {
  const r = normSlashes(root).replace(/\/+$/, '')
  const m = /^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+(\/.*)$/i.exec(r)
  return m ? [r, m[1]] : [r]
}

/** 文档相对链接解析为项目内路径；越界返回 null。
 *  支持：相对路径、Linux 绝对路径（/home/...）、Windows 盘符路径（E:/...）、
 *  WSL UNC 路径（\\wsl.localhost\...），以及混用反斜杠的写法。 */
export function resolveDocLink(fromPath: string, href: string, projectPath?: string): string | null {
  let path = normSlashes(href.split('#')[0].split('?')[0])
  try { path = decodeURIComponent(path) } catch { /* 保留原值 */ }
  if (!path) return null
  if (/^([a-z]+:)?\/\//i.test(path) && !/^\/\/(?:wsl\.localhost|wsl\$)\//i.test(path)) return null
  // 绝对路径：仅当落在项目根内时映射为相对路径，否则视为越界
  if (path.startsWith('/') || /^[a-zA-Z]:\//.test(path)) {
    if (!projectPath) return null
    const p = path.replace(/\/+$/, '')
    for (const root of projectRootVariants(projectPath)) {
      if (p.toLowerCase().startsWith(root.toLowerCase() + '/')) return p.slice(root.length + 1)
    }
    return null
  }
  const segments = [...fromPath.split('/').slice(0, -1), ...path.split('/')]
  const result: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!result.length) return null
      result.pop()
    } else result.push(segment)
  }
  return result.join('/')
}

/** 正文链接可打开的扩展名：文档 + 图片 + 尽可能全的文本类文件
 *  （json/yaml/源代码等以原始文本呈现；二进制媒体不在此列）。 */
const LINKABLE_EXTS = [
  // 文档
  '.md', '.markdown', '.mdown', '.mkd', '.mdx', '.rst', '.html', '.htm', '.txt',
  // 图片
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico',
  // 数据 / 配置（文本）
  '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.xml', '.log', '.csv', '.tsv', '.sql', '.graphql', '.gql', '.proto', '.properties',
  // 常见源代码（文本）
  '.py', '.pyi', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro',
  '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.dart', '.scala', '.clj', '.ex', '.exs',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.hh', '.cs', '.rb', '.php', '.lua', '.pl', '.r',
  '.css', '.scss', '.sass', '.less', '.sh', '.bash', '.zsh', '.bat', '.cmd', '.ps1',
  // 无扩展名的常见点文件
  '.gitignore', '.gitattributes', '.editorconfig'
]

function openLink(href: string): void {
  const state = useStore.getState()
  // GFM 自动链接可能把紧随 URL 的中文标点并入地址。
  if (/^https?:/i.test(href)) {
    let cleaned = href
    try { cleaned = decodeURIComponent(href) } catch { /* 保留原值 */ }
    cleaned = cleaned.split(/[\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef]/)[0]
      .replace(/[.,;:!?)\]}>～]+$/g, '')
    state.openExtPage(cleaned || href)
    return
  }
  // 协议地址（mailto: 等）不处理；Windows 盘符路径（E:/...）按本地绝对路径放行
  const isDrivePath = /^[a-zA-Z]:[\\/]/.test(href)
  if (!href || href.startsWith('#') || (/^[a-z][a-z0-9+.-]*:/i.test(href) && !isDrivePath) || !state.activeDoc) return
  const project = state.projects.find((p) => p.id === state.activeProjectId)
  const resolved = resolveDocLink(state.activeDoc.path, href, project?.path)
  if (!resolved) {
    state.toast('info', `无法解析链接目标：${href}（不在当前项目内）`)
  } else if (!LINKABLE_EXTS.some((ext) => resolved.toLowerCase().endsWith(ext))) {
    state.toast('info', '暂不支持预览该类型文件（文档 / 图片 / 常见文本文件可直接打开）')
  } else void state.openDoc(resolved)
}

// Markdown 解析器也随应用内置。先完成加载，避免快速切换模式时销毁半初始化实例。
let luteReady: Promise<void> | undefined
function loadLute(): Promise<void> {
  if (!luteReady) {
    luteReady = new Promise<void>((resolve, reject) => {
      if (document.getElementById('vditorLuteScript')) { resolve(); return }
      const script = document.createElement('script')
      script.src = luteUrl
      script.onload = () => { script.id = 'vditorLuteScript'; resolve() }
      script.onerror = () => { script.remove(); reject(new Error('Markdown 解析器加载失败')) }
      document.head.appendChild(script)
    }).catch((error) => { luteReady = undefined; throw error })
  }
  return luteReady
}

/* KaTeX 行内公式：Vditor 所见即所得只渲染块级数学（$$…$$ 走预览面板），行内 $…$
 *  由这里兜底渲染。脚本 id 与 Vditor 内部不同（避免 Vditor addScript 见到占位 id
 *  提前 resolve 导致的加载竞态），多加载一份本地文件代价可忽略。 */
let katexReady: Promise<void> | undefined
function loadKatex(): Promise<void> {
  if (!katexReady) {
    katexReady = new Promise<void>((resolve, reject) => {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = 'vditor-libs/dist/js/katex/katex.min.css'
      document.head.appendChild(link)
      const script = document.createElement('script')
      script.src = 'vditor-libs/dist/js/katex/katex.min.js'
      script.onload = () => resolve()
      script.onerror = () => { script.remove(); reject(new Error('KaTeX 加载失败')) }
      document.head.appendChild(script)
    }).catch((error) => { katexReady = undefined; throw error })
  }
  return katexReady
}

/** 渲染 .prose 内尚未处理的行内公式；原文写入 data-math（序列化时由 Lute 还原为 $…$） */
function renderInlineMath(prose: HTMLElement): void {
  const katex = (window as unknown as { katex?: { renderToString(m: string, o: object): string } }).katex
  if (!katex) return
  prose.querySelectorAll<HTMLElement>('span.language-math:not([data-math])').forEach((el) => {
    const math = (el.textContent ?? '').trim()
    if (!math) return
    el.setAttribute('data-math', math)
    try {
      el.innerHTML = katex.renderToString(math, { displayMode: false, output: 'html' })
    } catch {
      el.classList.add('vditor-reset--error')
    }
  })
}

/**
 * 软换行连写：源码在段内手动换行（如长列表项折行）时，Lute 渲染出的 "\n"
 * 在 white-space:normal 下显示为空格，中文语境观感错误。渲染方向把与 CJK
 * 相邻的 "\n" 包进隐藏的占位 span（视觉上直接连写），西文之间保留折叠空格；
 * 序列化方向再还原为 "\n"，保证源码的换行结构在保存/撤销/复制时不丢失。
 * code/textarea 等预格式内容里的换行不动。
 * 例外：引用块（>）内的行内软换行是「摘要式分行」语义（每行一条），由
 * refresh() 里的 upgradeQuoteBreaks 按 DOM 祖先关系升级为可见换行占位
 * span（data-an-softbreak-br）——字符串补丁在编辑重渲染时拿到的是块片段，
 * 可能不含 <blockquote> 标签，深度跟踪不可靠。序列化时两种占位都还原为 "\n"。
 */
const SOFTBREAK_SPAN = '<span data-an-softbreak>\n</span>'
const SOFTBREAK_BR_SPAN = '<span data-an-softbreak-br>\n</span>'
const SOFTBREAK_SPAN_RE = /<span data-an-softbreak(?:-br)?(?:="")?>([^<]*)<\/span>/g

/** 序列化/Spin 前：占位 span 还原为 "\n" */
function unwrapSoftBreaks(html: string): string {
  return html.includes('data-an-softbreak') ? html.replace(SOFTBREAK_SPAN_RE, '$1') : html
}

/** 提取标签名（开闭都返回纯名字，如 </pre> → pre）。 */
function tagName(part: string): string {
  const m = /^<\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(part)
  return m ? m[1].toLowerCase() : ''
}

const PRELIKE = new Set(['pre', 'textarea', 'script'])
/** CJK 及全角标点：与中文相邻的软换行直接连写，不加空格 */
const CJK_CHAR = /[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\u3000-\u303f]/

/**
 * 文本片段内的软换行逐个判定：换行两侧任一侧是 CJK（含全角标点）则包进
 * 隐藏占位 span（视觉连写）；两侧都是西文时保留 "\n"，由 white-space
 * 折叠成一个空格，避免英文单词被硬拼在一起。
 */
function joinSoftBreaks(part: string): string {
  return part.replace(/\n/g, (_nl, offset: number, whole: string): string => {
    const prev = whole.slice(0, offset).replace(/\s+$/, '').slice(-1)
    const nextMatch = /\S/.exec(whole.slice(offset + 1))
    const next = nextMatch ? nextMatch[0] : ''
    const cjkSide = (c: string): boolean => !!c && CJK_CHAR.test(c)
    return cjkSide(prev) || cjkSide(next) ? SOFTBREAK_SPAN : '\n'
  })
}

/**
 * 引用块内的软换行升级为真实换行（refresh() 调用，DOM 祖先关系判定）：
 * 1) 字符串补丁包好的隐藏占位 span → 换成 data-an-softbreak-br（CSS pre-wrap 显示换行）；
 * 2) 两侧都是西文的裸 "\n" 文本节点 → 拆分并在行间插入 br 占位 span。
 * 两侧有一侧为空白的换行（段首/段尾、标签间结构换行）不动；序列化统一还原为 "\n"。
 */
function upgradeQuoteBreaks(prose: HTMLElement): void {
  prose.querySelectorAll('blockquote').forEach((bq) => {
    bq.querySelectorAll('span[data-an-softbreak]').forEach((span) => {
      span.removeAttribute('data-an-softbreak')
      span.setAttribute('data-an-softbreak-br', '')
    })
    const walker = document.createTreeWalker(bq, NodeFilter.SHOW_TEXT)
    const targets: Text[] = []
    let node = walker.nextNode()
    while (node) {
      const t = node as Text
      if (
        t.data.includes('\n') &&
        !t.parentElement?.closest(
          'span[data-an-softbreak], span[data-an-softbreak-br], pre, textarea, script'
        )
      ) {
        targets.push(t)
      }
      node = walker.nextNode()
    }
    for (const t of targets) {
      const parts = t.data.split('\n')
      if (parts.length < 2) continue
      const frag = document.createDocumentFragment()
      parts.forEach((seg, i) => {
        if (i > 0) {
          const before = parts.slice(0, i).join('\n').replace(/\s+$/, '').slice(-1)
          const after = /\S/.exec(parts.slice(i).join('\n'))?.[0] ?? ''
          if (before && after) {
            const br = document.createElement('span')
            br.setAttribute('data-an-softbreak-br', '')
            br.textContent = '\n'
            frag.appendChild(br)
          } else {
            frag.appendChild(document.createTextNode('\n'))
          }
        }
        if (seg) frag.appendChild(document.createTextNode(seg))
      })
      t.replaceWith(frag)
    }
  })
}

function wrapSoftBreaks(html: string): string {
  if (!html.includes('\n')) return html
  const parts = html.split(/(<[^>]*>)/)
  let preDepth = 0
  let out = ''
  for (const part of parts) {
    if (part.startsWith('<')) {
      // 闭合标签（</pre>）的 tag 名以 "/" 开头，必须先剥掉再比对；
      // 否则 preDepth 只增不减，第一个代码块之后的所有软换行都会漏包
      // （v0.4.4 修复：列表 / 引用块内换行渲染成空格的根因）。
      if (PRELIKE.has(tagName(part))) {
        preDepth = part[1] === '/' ? Math.max(0, preDepth - 1) : preDepth + 1
      }
      out += part
    } else if (preDepth === 0 && part.includes('\n')) {
      out += joinSoftBreaks(part)
    } else {
      out += part
    }
  }
  return out
}

/** 图片最大化查看（lightbox）浮层所需的信息 */
interface LightboxInfo {
  /** 展示地址（渲染后已重写为 sidecar /raw URL；外链 / data 图为原地址） */
  src: string
  /** 文档内原始引用路径（data-an-orig-src），信息条展示用 */
  origSrc: string
  alt: string
}

/** 阅读模式图片点击放大浮层：点遮罩 / Esc / ✕ 关闭，再点图片在适应窗口与原始尺寸间切换 */
function ImageLightbox({ info, onClose }: { info: LightboxInfo; onClose: () => void }) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const [fit, setFit] = useState(true)
  const imgRef = useRef<HTMLImageElement>(null)

  // 打开期间：Esc 关闭、禁止背景滚动。Esc 在 capture 阶段拦截并 stopPropagation——
  // 浮层是最顶层，独占本次 Esc，避免 App.tsx 专注模式等 window 级处理同时触发
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // 点击正文图片后焦点留在编辑器里，浮层打开期间按键会直接改文档，先移走焦点
    ;(document.activeElement as HTMLElement | null)?.blur()
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  // 缓存命中的图片可能在 onLoad 绑定前就加载完成，挂载后补查一次
  useEffect(() => {
    const img = imgRef.current
    if (img?.complete && img.naturalWidth) setNatural({ w: img.naturalWidth, h: img.naturalHeight })
  }, [])

  // 文档内引用路径常带 URL 编码（空格等），信息条展示时还原
  let label = info.origSrc
  try { label = decodeURIComponent(info.origSrc) } catch { /* 保留原值 */ }

  return (
    <div className="img-lightbox" onClick={onClose}>
      <button className="img-lightbox-close" onClick={onClose} title="关闭 (Esc)">✕</button>
      <div className={`img-lightbox-stage${fit ? '' : ' orig'}`}>
        <img
          ref={imgRef}
          src={info.src}
          alt={info.alt}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={() => setFailed(true)}
          onClick={(e) => { e.stopPropagation(); setFit((v) => !v) }}
        />
      </div>
      {/* 信息条随浮层即显：路径先出，自然尺寸等 onLoad 后补上；加载失败给出提示 */}
      <div className="img-lightbox-meta">
        {label}{failed ? ' · 图片加载失败' : natural ? ` · ${natural.w} × ${natural.h}` : ''}
      </div>
    </div>
  )
}

/** 阅读模式：保留渲染排版，正文始终可编辑，双击仅执行正常的文字选择。 */
export default function MarkdownView({ annotations, onSelectAnn }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const themeSetting = useStore((state) => state.settings.theme)
  const [sysDark, setSysDark] = useState(systemPrefersDark())
  const theme = themeSetting === 'dark' || (themeSetting === 'system' && sysDark) ? 'dark' : 'light'
  const docPath = useStore((state) => state.activeDoc?.path)
  const projectId = useStore((state) => state.activeProjectId)
  const tabId = useStore((state) => state.activeTabId)
  const annotationsRef = useRef(annotations)
  const selectRef = useRef(onSelectAnn)
  const refreshRef = useRef<(() => void) | null>(null)
  // 图片最大化查看浮层（本地状态，不进全局 store）
  const [lightbox, setLightbox] = useState<LightboxInfo | null>(null)
  // 代码块悬浮「复制」按钮（v0.5.6，参考飞书/Notion）：portal + fixed 定位于块右上角，
  // 不插入 Vditor DOM（避免污染序列化），滚动时随块重算位置
  const [codeCopy, setCodeCopy] = useState<{ top: number; right: number } | null>(null)
  const [codeCopied, setCodeCopied] = useState(false)
  const codeCopyPreRef = useRef<HTMLElement | null>(null)
  // 关闭浮层后偶发回到文档顶部（诱因不稳定，疑似滚动锚定/布局重置的竞争）：打开时记录
  // 正文滚动位置，关闭后按 立即/下一帧/120ms/350ms 多次恢复，覆盖同步与异步两种时机（v0.5.4）
  const scrollGuardRef = useRef<{ pos: number; docPath: string } | null>(null)
  const closeLightbox = useCallback(() => {
    setLightbox(null)
    const guard = scrollGuardRef.current
    scrollGuardRef.current = null
    if (!guard) return
    const restore = (): void => {
      if (useStore.getState().activeDoc?.path !== guard.docPath) return
      const body = document.querySelector('.reader-body')
      if (body && Math.abs(body.scrollTop - guard.pos) > 2) body.scrollTop = guard.pos
    }
    restore()
    requestAnimationFrame(restore)
    window.setTimeout(restore, 120)
    window.setTimeout(restore, 350)
  }, [])
  annotationsRef.current = annotations
  selectRef.current = onSelectAnn

  // 跟随系统时，系统主题切换需重建编辑器配色
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => setSysDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => { refreshRef.current?.() }, [annotations])

  useEffect(() => {
    const container = ref.current
    if (!container || !docPath || !projectId) return
    let disposed = false
    let ready = false
    let editor: Vditor | undefined
    let rawBase = ''
    let lastValue = ''
    let lastDraft = useStore.getState().draft
    let syncingFromEditor = false
    let frame = 0
    let unsubscribe: (() => void) | undefined
    let annotationRanges: { annotation: Annotation; range: Range }[] = []
    let popObserver: MutationObserver | undefined

    /** 块悬浮工具栏定位：
     *  - 纯按钮弹层（段落等，上移/下移/删除）：移到行左侧留白区，并与块垂直居中；
     *  - 含输入框的弹层（标题 ID / 表格行列 / 代码块语言）：弹层较宽，左侧留白放不下
     *    （会被 reader-body 左缘截断），垂直居中又会盖住块内容（v0.5.6 表格遮挡投诉）——
     *    改为悬浮在块的上方、左缘对齐正文起始，顶部空间不足时改到块下方。 */
    const centerBlockToolbar = (): void => {
      const popover = container.querySelector<HTMLElement>('.vditor-wysiwyg > div.vditor-panel--none')
      if (!popover || popover.style.display === 'none' || disposed) return
      // 只处理块工具栏（含删除钮）；链接/图片等输入弹层保持原位
      if (!popover.querySelector('[data-type="remove"]')) return
      const blockTop = Number(popover.getAttribute('data-top')) + 21
      if (!Number.isFinite(blockTop)) return
      const proseEl = container.querySelector<HTMLElement>('.vditor-wysiwyg > .vditor-reset')
      if (!proseEl) return
      const block = [...proseEl.querySelectorAll<HTMLElement>(':scope > *, li, table')]
        .find((el) => el.offsetTop === blockTop)
      if (!block) return
      if (popover.querySelector('.vditor-input')) {
        popover.classList.add('an-above')
        const ph = popover.offsetHeight
        const above = blockTop - ph - 6
        const nextTop = `${above >= 2 ? above : blockTop + block.offsetHeight + 6}px`
        if (popover.style.top !== nextTop) popover.style.top = nextTop
        const want = proseEl.offsetLeft + 88
        const maxLeft = proseEl.offsetLeft + proseEl.offsetWidth - popover.offsetWidth - 8
        const nextLeft = `${Math.max(4, Math.min(want, maxLeft))}px`
        if (popover.style.left !== nextLeft) popover.style.left = nextLeft
        return
      }
      popover.classList.remove('an-above')
      const next = `${Math.max(-8, blockTop + block.offsetHeight / 2 - popover.offsetHeight / 2)}px`
      if (popover.style.top !== next) popover.style.top = next
      popover.classList.add('an-vcenter')
    }

    const rewriteImages = (): void => {
      if (!rawBase) return
      container.querySelectorAll('img').forEach((image) => {
        const src = image.getAttribute('src') ?? ''
        if (!src || src === image.dataset.anDisplaySrc) return
        if (/^(https?:|data:|blob:)/i.test(src)) {
          delete image.dataset.anOrigSrc
          delete image.dataset.anDisplaySrc
          return
        }
        const resolved = resolveDocLink(docPath, src)
        if (!resolved) return
        image.dataset.anOrigSrc = src
        image.src = `${rawBase}/raw/${origProjectId(projectId)}/${resolved.split('/').map(encodeURIComponent).join('/')}`
        image.dataset.anDisplaySrc = image.getAttribute('src')!
      })
    }
    const refresh = (): void => {
      const prose = container.querySelector<HTMLElement>('.prose')
      if (!prose || disposed) return
      // 块悬浮工具栏（上移/下移/删除）左移到正文左侧空白区所需的位置变量
      const wysiwyg = container.querySelector<HTMLElement>('.vditor-wysiwyg')
      wysiwyg?.style.setProperty('--prose-left', `${prose.offsetLeft}px`)
      // 快捷键提示改为悬浮提醒：输入框常驻 placeholder（如「ID<⌥Enter>」）去掉 <…> 后缀，
      // 完整提示仍保留在外层 aria-label 的悬浮气泡里（observer 不监听 attributes，不会循环）
      container.querySelectorAll<HTMLInputElement>('.vditor-input[placeholder*="<"]').forEach((input) => {
        input.placeholder = input.placeholder.replace(/<[^>]*>$/, '')
      })
      rewriteImages()
      // 引用块（> 摘要式分行）内的行内软换行升级为真实换行；幂等，重复执行无副作用
      upgradeQuoteBreaks(prose)
      prose.querySelectorAll<HTMLElement>('.vditor-wysiwyg__preview code:not([data-highlighted])').forEach((code) => {
        const language = [...code.classList].find((name) => name.startsWith('language-'))?.slice(9)
        if (language && hljs.getLanguage(language)) hljs.highlightElement(code)
      })
      // 行内数学公式（$…$）：所见即所得模式上游不渲染，这里兜底（块级 $$…$$ 由 Vditor 预览面板渲染）
      if (prose.querySelector('span.language-math:not([data-math])')) {
        void loadKatex().then(() => { if (!disposed) renderInlineMath(prose) }).catch(() => {})
      }
      annotationRanges = annotationsRef.current.flatMap((annotation) => {
        const range = findAnnotationRange(prose, annotation)
        return range ? [{ annotation, range }] : []
      })
      for (const status of ['open', 'done'] as const) {
        setTextHighlight(`ann-${status}`, annotationRanges.filter((item) => item.annotation.status === status).map((item) => item.range))
      }
      window.dispatchEvent(new Event('markdown-rendered'))
    }
    refreshRef.current = refresh
    // rAF 在窗口被系统判定为隐藏/完全遮挡时（Windows 遮挡冻结、最小化）不再触发，
    // 用 setTimeout 兜底，保证渲染补丁在任何窗口状态下最终都会执行；
    // 可见时 rAF 先到（约一帧），兜底计时器被清除，不会重复执行
    let refreshFallback = 0
    const scheduleRefresh = (): void => {
      cancelAnimationFrame(frame)
      clearTimeout(refreshFallback)
      frame = requestAnimationFrame(() => {
        clearTimeout(refreshFallback)
        refresh()
      })
      refreshFallback = window.setTimeout(refresh, 160)
    }
    const observer = new MutationObserver(scheduleRefresh)
    // 侧栏/批注面板开合、窗口缩放都会改版式；--prose-left 需同步刷新
    const resizeObserver = new ResizeObserver(() => refresh())
    resizeObserver.observe(container)

    // ---- 代码块悬浮「复制」按钮：mouseover/mouseout 事件委托，不改动 Vditor 的 pre DOM ----
    const hideCodeCopy = (): void => {
      if (codeCopyPreRef.current) {
        codeCopyPreRef.current = null
        setCodeCopy(null)
      }
    }
    const positionCodeCopy = (): void => {
      const pre = codeCopyPreRef.current
      if (!pre || disposed) return
      // 代码块进入/退出编辑态时，编辑 pre 与预览 pre 的可见性会互换，隐藏的一副本 rect 为 0
      if (!pre.isConnected || pre.getBoundingClientRect().width === 0) {
        hideCodeCopy()
        return
      }
      const rect = pre.getBoundingClientRect()
      // 块滚出视口后按钮没有附着意义，直接隐藏
      if (rect.bottom < -8 || rect.top > window.innerHeight + 8) {
        hideCodeCopy()
        return
      }
      const next = { top: Math.round(rect.top + 6), right: Math.round(window.innerWidth - rect.right + 8) }
      setCodeCopy((cur) => (cur && cur.top === next.top && cur.right === next.right ? cur : next))
    }
    const onCodeOver = (event: MouseEvent): void => {
      const pre = (event.target as HTMLElement).closest?.('pre')
      if (!pre || !(pre as HTMLElement).closest('.prose')) return
      // wysiwyg 代码块含「编辑 pre + 预览 pre」双副本，未编辑时编辑副本隐藏（rect 为 0），跳过
      const rect = (pre as HTMLElement).getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      if (codeCopyPreRef.current === pre) return
      codeCopyPreRef.current = pre as HTMLElement
      setCodeCopied(false)
      positionCodeCopy()
    }
    const onCodeOut = (event: MouseEvent): void => {
      const pre = codeCopyPreRef.current
      if (!pre) return
      const to = event.relatedTarget as HTMLElement | null
      // 在块内子元素间移动、或移到悬浮按钮本身，都不算离开
      if (to && (pre.contains(to) || to.closest('.code-copy-btn'))) return
      hideCodeCopy()
    }
    const onCodeScroll = (): void => positionCodeCopy()
    container.addEventListener('mouseover', onCodeOver)
    container.addEventListener('mouseout', onCodeOut)
    window.addEventListener('scroll', onCodeScroll, true)
    window.addEventListener('resize', onCodeScroll)

    const syncDraft = (): void => {
      const state = useStore.getState()
      if (!ready || !editor || disposed || state.activeTabId !== tabId || state.activeProjectId !== projectId) return
      const value = editor.getValue()
      rewriteImages()
      // 初始化的格式规范化不算编辑，只有正文实际变化才更新原文草稿。
      if (value === lastValue) return
      lastValue = value
      lastDraft = value
      // 标记「本次 store 变更来自编辑器自身」：订阅回调据此跳过回写，
      // 避免任何中间态触发 setValue 整体重渲染（光标会被重置到文首）。
      syncingFromEditor = true
      try {
        state.setDraft(value)
      } finally {
        syncingFromEditor = false
      }
    }
    const onInput = (event: Event): void => {
      if (!(event as InputEvent).isComposing) syncDraft()
    }
    const onClick = (event: MouseEvent): void => {
      const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('.prose a')
      if (link) {
        event.preventDefault()
        event.stopPropagation()
        openLink(link.getAttribute('href') ?? '')
        return
      }
      // 正文图片点击打开最大化查看浮层（事件委托，不逐图绑定）；
      // 源码模式本组件不挂载，这里读 store 的 mode 再挡一层
      const image = (event.target as HTMLElement).closest<HTMLImageElement>('.prose img')
      if (image && useStore.getState().mode === 'read') {
        // 拦截本次点击，避免 Vditor 的图片气泡在浮层背后弹出（与上面链接分支同理）
        event.preventDefault()
        event.stopPropagation()
        // 记录当前滚动位置，供 closeLightbox 恢复（防偶发回顶）
        scrollGuardRef.current = {
          pos: document.querySelector('.reader-body')?.scrollTop ?? 0,
          docPath
        }
        setLightbox({
          src: image.src,
          origSrc: image.dataset.anOrigSrc ?? image.getAttribute('src') ?? '',
          alt: image.alt
        })
        return
      }
      const hit = annotationRanges.find(({ range }) => [...range.getClientRects()].some((rect) =>
        event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom))
      if (hit) selectRef.current(hit.annotation.id)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        syncDraft()
        void useStore.getState().saveDoc()
      }
    }

    void loadLute().then(() => {
      if (disposed) return
      editor = new Vditor(container, {
        mode: 'wysiwyg',
        theme: theme === 'dark' ? 'dark' : 'classic',
        i18n: (window as unknown as { VditorI18n: IOptions['i18n'] }).VditorI18n,
        icon: undefined,
        _lutePath: luteUrl,
        // 图表/数学渲染库随应用内置（scripts/copy-vditor-libs.mjs → public/vditor-libs），
        // 离线可用，不再走 unpkg CDN
        cdn: 'vditor-libs',
        value: useStore.getState().draft,
        height: 'auto',
        cache: { enable: false },
        toolbar: [
          'headings', 'bold', 'italic', 'strike', 'quote', '|',
          'list', 'ordered-list', 'check', 'code', 'inline-code', '|',
          'link', 'table', 'line', '|', 'undo', 'redo'
        ],
        toolbarConfig: { pin: true },
        link: { isOpen: false },
        upload: { handler: () => '暂不支持粘贴图片：请先把图片放入项目目录，再引用相对路径' },
        preview: {
          theme: { current: '' },
          hljs: { enable: false },
          markdown: {
            // sanitize:false 放行 Markdown 内嵌 HTML 渲染（本地文档为可信内容）
            sanitize: false,
            mark: true,
            sub: true,
            sup: true,
            footnotes: true,
            mathBlockPreview: true,
            codeBlockPreview: true,
            gfmAutoLink: true,
            callout: true
          }
        },
        after() {
          if (disposed || !editor) return
          // Vditor 内部的保存/撤销也会序列化 DOM。统一从副本还原图片地址，
          // 避免展示用的 /raw URL 进入 Markdown 或撤销历史。
          const lute = editor.vditor.lute
          const serialize = lute.VditorDOM2Md.bind(lute)
          lute.VditorDOM2Md = (html: string): string => {
            // 软换行占位 span 还原为 "\n"（见 wrapSoftBreaks），源码换行结构不丢失
            const src = unwrapSoftBreaks(html)
            if (!src.includes('data-an-orig-src=')) return serialize(src)
            const template = document.createElement('template')
            template.innerHTML = src
            template.content.querySelectorAll<HTMLImageElement>('img[data-an-orig-src]').forEach((image) => {
              if (image.getAttribute('src') === image.dataset.anDisplaySrc) {
                image.setAttribute('src', image.dataset.anOrigSrc!)
              }
              delete image.dataset.anOrigSrc
              delete image.dataset.anDisplaySrc
            })
            return serialize(template.innerHTML)
          }
          // 整篇渲染方向（setValue/初始渲染/粘贴）：软换行 "\n" 包进隐藏占位 span
          const renderDom = lute.Md2VditorDOM.bind(lute)
          lute.Md2VditorDOM = (markdown: string): string => wrapSoftBreaks(renderDom(markdown))
          // 块级重渲染方向（输入后的 DOM→DOM spin）：先还原占位再重新包裹
          const spin = lute.SpinVditorDOM.bind(lute)
          lute.SpinVditorDOM = (html: string): string => wrapSoftBreaks(spin(unwrapSoftBreaks(html)))
          const prose = container.querySelector<HTMLElement>('.vditor-wysiwyg > .vditor-reset')
          prose?.classList.add('prose')
          prose?.setAttribute('aria-label', '阅读模式编辑器')
          lastValue = editor.getValue()
          // 初次渲染发生在上面的补丁安装之前，重渲染一次让软换行占位生效
          editor.setValue(lastValue, true)
          lastValue = editor.getValue()
          ready = true
          observer.observe(container, { childList: true, characterData: true, subtree: true })
          // 块工具栏垂直居中：Vditor 每次悬停块都会重写弹层 inline top，跟随重算
          const popoverEl = container.querySelector('.vditor-wysiwyg > div.vditor-panel--none')
          if (popoverEl) {
            popObserver = new MutationObserver(centerBlockToolbar)
            popObserver.observe(popoverEl, { attributes: true, attributeFilter: ['style'], childList: true })
          }
          container.addEventListener('input', onInput)
          container.addEventListener('compositionend', syncDraft)
          container.addEventListener('focusout', syncDraft)
          container.addEventListener('keydown', onKeyDown)
          container.addEventListener('click', onClick, true)
          unsubscribe = useStore.subscribe((state) => {
            if (
              disposed ||
              !editor ||
              syncingFromEditor ||
              state.activeTabId !== tabId ||
              state.activeProjectId !== projectId ||
              state.draft === lastDraft
            ) return
            lastDraft = state.draft
            editor.setValue(state.draft, true)
            lastValue = editor.getValue()
            refresh()
          })
          void rawBaseFor(projectId).then((base) => {
            if (disposed) return
            rawBase = base
            refresh()
          }).catch(() => {})
          refresh()
        },
        input: syncDraft,
        blur: syncDraft
      })
    }).catch((error) => {
      if (!disposed) useStore.getState().toast('err', `阅读编辑器初始化失败：${error}`)
    })

    return () => {
      syncDraft()
      disposed = true
      refreshRef.current = null
      // 切换文档/标签时关掉可能开着的图片浮层
      setLightbox(null)
      unsubscribe?.()
      observer.disconnect()
      popObserver?.disconnect()
      resizeObserver.disconnect()
      cancelAnimationFrame(frame)
      clearTimeout(refreshFallback)
      container.removeEventListener('input', onInput)
      container.removeEventListener('compositionend', syncDraft)
      container.removeEventListener('focusout', syncDraft)
      container.removeEventListener('keydown', onKeyDown)
      container.removeEventListener('click', onClick, true)
      container.removeEventListener('mouseover', onCodeOver)
      container.removeEventListener('mouseout', onCodeOut)
      window.removeEventListener('scroll', onCodeScroll, true)
      window.removeEventListener('resize', onCodeScroll)
      codeCopyPreRef.current = null
      setCodeCopy(null)
      setTextHighlight('ann-open', [])
      setTextHighlight('ann-done', [])
      setTextHighlight('ann-flash', [])
      try { editor?.destroy() } catch { /* 半初始化实例不能影响应用卸载 */ }
    }
  }, [docPath, projectId, tabId, theme])

  return (
    <>
      <div className="markdown-editor" ref={ref} />
      {/* 浮层 portal 到 body：容器上的原生点击委托（链接/图片/批注）不会拦截浮层内点击，
          也不会被 Vditor 对容器 innerHTML 的重写波及 */}
      {lightbox && createPortal(<ImageLightbox info={lightbox} onClose={closeLightbox} />, document.body)}
      {/* 代码块悬浮复制钮：fixed 定位于代码块右上角内侧；mousedown 拦截避免改变光标/选区 */}
      {codeCopy &&
        createPortal(
          <button
            className={`code-copy-btn${codeCopied ? ' copied' : ''}`}
            style={{ top: codeCopy.top, right: codeCopy.right }}
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              const text = codeCopyPreRef.current?.innerText.replace(/\n+$/, '') ?? ''
              if (!text) return
              void navigator.clipboard
                .writeText(text)
                .then(() => {
                  setCodeCopied(true)
                  window.setTimeout(() => setCodeCopied(false), 1200)
                })
                .catch(() => {})
            }}
            onMouseLeave={() => {
              codeCopyPreRef.current = null
              setCodeCopy(null)
            }}
          >
            {codeCopied ? '✓ 已复制' : '复制'}
          </button>,
          document.body
        )}
    </>
  )
}

/** 计算选区在渲染全文中的 quote/prefix/suffix。 */
export function selectionAnchor(container: HTMLElement): { quote: string; prefix: string; suffix: string } | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !container.contains(selection.anchorNode) || !container.contains(selection.focusNode)) return null
  const range = selection.getRangeAt(0)
  const text = collectText(container)
  const offsetAt = (atStart: boolean): number => {
    const point = range.cloneRange()
    point.collapse(atStart)
    let offset = 0
    for (const node of text.nodes) {
      if (point.comparePoint(node, node.length) <= 0) offset += node.length
      else {
        if (node === point.startContainer) offset += point.startOffset
        break
      }
    }
    return offset
  }
  const start = offsetAt(true)
  const end = offsetAt(false)
  const quote = text.full.slice(start, end)
  if (!quote.trim()) return null
  return { quote, prefix: text.full.slice(Math.max(0, start - 40), start), suffix: text.full.slice(end, end + 40) }
}
