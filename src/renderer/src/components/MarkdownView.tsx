import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { sanitizeRenderedHtml, upgradeInlineHtml } from '../utils/sanitizeHtml'
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

export function wrapSoftBreaks(html: string): string {
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

/** 从 mermaid SVG 字符串解析自然尺寸与规范化后的标记（lightbox 展示用） */
function parseMermaidSvg(svg: string): { w: number; h: number; html: string } | null {
  const template = document.createElement('template')
  template.innerHTML = svg.trim()
  const el = template.content.firstElementChild as SVGElement | null
  if (!el) return null
  const vb = /viewBox\s*=\s*"([\d.eE+-]+)[\s,]+([\d.eE+-]+)[\s,]+([\d.eE+-]+)[\s,]+([\d.eE+-]+)"/.exec(svg)
  if (vb) {
    const w = parseFloat(vb[3])
    const h = parseFloat(vb[4])
    if (w > 0 && h > 0) return { w, h, html: el.outerHTML }
  }
  const w = parseFloat(el.getAttribute('width') ?? '')
  const h = parseFloat(el.getAttribute('height') ?? '')
  return w > 0 && h > 0 ? { w, h, html: el.outerHTML } : null
}

const clampZoom = (v: number): number => Math.min(8, Math.max(0.1, v))

/** Mermaid 全屏查看浮层（v0.6.3，图片交互看齐正文图片 lightbox）：
 *  滚轮缩放（指向光标锚定）、拖拽平移、双击/底部按钮在「适应窗口」与 100% 间切换。 */
function MermaidLightbox({ svg, onClose }: { svg: string; onClose: () => void }) {
  const parsed = useMemo(() => parseMermaidSvg(svg), [svg])
  const stageRef = useRef<HTMLDivElement>(null)
  const [stage, setStage] = useState({ w: 0, h: 0 })
  const [fit, setFit] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null)
  const movedRef = useRef(false)
  const [dragging, setDragging] = useState(false)

  // Esc 关闭、禁背景滚动、移走焦点（与图片 lightbox 同一套约定）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    ;(document.activeElement as HTMLElement | null)?.blur()
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  // 舞台尺寸（fit 缩放比依据）：挂载 + 窗口变化时重测
  useEffect(() => {
    const measure = (): void => {
      const el = stageRef.current
      if (el) setStage({ w: el.clientWidth, h: el.clientHeight })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  // 切回适应模式时清平移
  useEffect(() => { if (fit) setPan({ x: 0, y: 0 }) }, [fit])

  const fitScale = parsed && stage.w > 0
    ? Math.min(1.6, Math.max(0.05, Math.min((stage.w - 56) / parsed.w, (stage.h - 56) / parsed.h)))
    : 1
  const scale = fit ? fitScale : zoom

  /** 以 (cx, cy)（舞台中心坐标系）为锚点缩放到 next */
  const zoomAt = (next: number, cx = 0, cy = 0): void => {
    const cur = fit ? fitScale : zoom
    const basePan = fit ? { x: 0, y: 0 } : pan
    setFit(false)
    setZoom(next)
    setPan({ x: cx - ((cx - basePan.x) / cur) * next, y: cy - ((cy - basePan.y) / cur) * next })
  }

  // 滚轮缩放要走原生非被动监听（React onWheel 是被动的，preventDefault 无效）
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      zoomAt(clampZoom(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)), e.clientX - rect.left - rect.width / 2, e.clientY - rect.top - rect.height / 2)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  if (!parsed) return null
  return (
    <div className="mm-lightbox">
      <div
        ref={stageRef}
        className={`mm-stage${dragging ? ' dragging' : ''}`}
        onMouseDown={(e) => {
          if (e.button !== 0) return
          movedRef.current = false
          dragRef.current = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y }
          setDragging(true)
        }}
        onMouseMove={(e) => {
          const d = dragRef.current
          if (!d) return
          if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) movedRef.current = true
          setPan({ x: d.px + e.clientX - d.sx, y: d.py + e.clientY - d.sy })
        }}
        onMouseUp={() => { dragRef.current = null; setDragging(false) }}
        onMouseLeave={() => { dragRef.current = null; setDragging(false) }}
        onClick={() => { if (!movedRef.current) onClose() }}
        onDoubleClick={() => {
          if (fit) { setFit(false); setZoom(1); setPan({ x: 0, y: 0 }) } else setFit(true)
        }}
      >
        <div
          className="mm-canvas"
          style={{
            width: parsed.w,
            height: parsed.h,
            marginLeft: -parsed.w / 2,
            marginTop: -parsed.h / 2,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`
          }}
          dangerouslySetInnerHTML={{ __html: parsed.html }}
        />
      </div>
      <button className="img-lightbox-close" onClick={onClose} title="关闭 (Esc)">✕</button>
      <div
        className="mm-bar"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button title="缩小" onClick={() => zoomAt(clampZoom(scale / 1.25))}>−</button>
        <button className="mm-pct" title="切换 适应窗口 / 100%" onClick={() => { if (fit) { setFit(false); setZoom(1); setPan({ x: 0, y: 0 }) } else setFit(true) }}>
          {Math.round(scale * 100)}%
        </button>
        <button title="放大" onClick={() => zoomAt(clampZoom(scale * 1.25))}>＋</button>
        <span className="mm-size">{parsed.w} × {parsed.h}</span>
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
  // Mermaid 全屏查看浮层（v0.6.3）：存 SVG outerHTML
  const [mermaid, setMermaid] = useState<string | null>(null)
  // 代码块悬浮「复制」按钮（v0.5.6，参考飞书/Notion）：portal + fixed 定位于块右上角，
  // 不插入 Vditor DOM（避免污染序列化），滚动时随块重算位置
  const [codeCopy, setCodeCopy] = useState<{ top: number; right: number } | null>(null)
  const [codeCopied, setCodeCopied] = useState(false)
  const codeCopyPreRef = useRef<HTMLElement | null>(null)
  // 关闭浮层后偶发回到文档顶部（诱因不稳定，疑似滚动锚定/布局重置的竞争）：打开时记录
  // 正文滚动位置，关闭后按 立即/下一帧/120ms/350ms 多次恢复，覆盖同步与异步两种时机（v0.5.4）
  const scrollGuardRef = useRef<{ pos: number; docPath: string } | null>(null)
  const closeOverlays = useCallback(() => {
    setLightbox(null)
    setMermaid(null)
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
    // Mermaid 外观重刷（v0.6.3，GitHub 风格）：白底卡片节点 + 石板灰边线 +
    // 系统字体 + 轻投影，深色模式镜像。只改颜色/圆角/投影不动布局；
    // pie/甘特等按颜色表意的图形不覆盖填充色，仅统一文字。
    const styleMermaidDiagrams = (prose: HTMLElement): void => {
      const c = theme === 'dark'
        ? {
            node: '#1c2635', nodeStroke: '#4a6488', edge: '#8199b4', ink: '#e6edf3',
            paper: '#141b24', cluster: '#111823', clusterStroke: '#33445a', labelBg: '#141b24',
            note: '#3d3213', noteStroke: '#a08420', actor: '#132a44', actorStroke: '#3f7fc2',
            shadow: 'drop-shadow(0 2px 6px rgba(0,0,0,.5))'
          }
        : {
            node: '#ffffff', nodeStroke: '#8296b0', edge: '#71809a', ink: '#1f2b3d',
            paper: '#ffffff', cluster: '#f4f6f9', clusterStroke: '#d5dde6', labelBg: '#ffffff',
            note: '#fdf6d8', noteStroke: '#d6a72c', actor: '#e8f3ff', actorStroke: '#54a3ff',
            shadow: 'drop-shadow(0 2px 6px rgba(31,43,61,.16))'
          }
      const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"
      prose.querySelectorAll<SVGElement>('.language-mermaid svg').forEach((svg) => {
        const paint = (selector: string, styles: Record<string, string>): void => {
          svg.querySelectorAll<SVGElement | HTMLElement>(selector).forEach((el) => {
            Object.entries(styles).forEach(([property, value]) => el.style.setProperty(property, value, 'important'))
          })
        }
        // 节点形状（流程图 / 状态图 / 类图 / ER / 旅程 / 思维导图）
        paint(
          '.node rect, .node circle, .node ellipse, .node polygon, .node path, g.classGroup rect, g.stateGroup rect, g.stateGroup circle, g.entityBox rect, rect.actor, g.actor rect',
          { fill: c.node, stroke: c.nodeStroke, 'stroke-width': '1.3px', filter: c.shadow }
        )
        // 时序图参与者与激活条：淡蓝底区分
        paint('rect.actor, g.actor rect, rect.activation0, rect.activation1, rect.activation2', { fill: c.actor, stroke: c.actorStroke, 'stroke-width': '1.2px' })
        // 分组框：浅灰底弱边
        paint('.cluster rect, g.cluster rect', { fill: c.cluster, stroke: c.clusterStroke, 'stroke-width': '1.2px' })
        // 边线 / 生命线 / 消息线 / 循环框 / 类图分隔线 / 思维导图连线
        paint(
          '.edgePath path, path.flowchart-link, .actor-line, .signal, .messageLine0, .messageLine1, .loopLine, g.classGroup line, .er.relationshipLine, .transition path, .mindmap-edges path',
          { stroke: c.edge, 'stroke-width': '1.5px' }
        )
        paint('marker path, marker polygon, .arrowheadPath, .arrowMarkerPath', { fill: c.edge, stroke: c.edge })
        // 边标签：与画布同底，避免文字压线
        paint('.edgeLabel rect, g.edgeLabel rect', { fill: c.labelBg, stroke: 'none' })
        paint('.edgeLabel, span.edgeLabel', { 'background-color': c.labelBg, color: c.ink, 'font-family': font })
        // 注释便签
        paint('.note, rect.note, g.note rect', { fill: c.note, stroke: c.noteStroke, 'stroke-width': '1.2px' })
        // 文字统一（含标题 / 图例 / 甘特分区）
        paint(
          'text, .nodeLabel, .edgeLabel, .label, .messageText, .noteText, .loopText, .cluster-label, .pieTitle, .legend, .sectionTitle, .taskText, .titleText',
          { color: c.ink, fill: c.ink, 'font-family': font }
        )
        // 圆角：矩形节点与分组框
        svg.querySelectorAll<SVGElement>('.node rect, g.classGroup rect, g.stateGroup rect, rect.actor, g.actor rect, .cluster rect, g.cluster rect, rect.note, g.note rect').forEach((el) => {
          el.setAttribute('rx', '8')
          el.setAttribute('ry', '8')
        })
        svg.style.setProperty('background', c.paper, 'important')
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
      // 内嵌 HTML 安全收口：剥 script/on*（sanitize:false 的代价），并把行内 <img> 升级为真实图片；
      // 须在 rewriteImages 之前，新 img 的相对 src 才会被重写为 sidecar /raw
      sanitizeRenderedHtml(prose)
      upgradeInlineHtml(prose)
      rewriteImages()
      styleMermaidDiagrams(prose)
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
      if (pre.matches('.vditor-wysiwyg__pre:has(> code.language-mermaid)')) {
        hideCodeCopy()
        return
      }
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

    // ---- 表格列宽拖拽（v0.6.4）：悬停列边界出现 col-resize 光标，拖动调整列宽。
    //      列宽写在首行单元格的 style.width 上（table-layout:fixed 以首行为准）；
    //      不能用 colgroup——Lute 序列化带 colgroup 的表格会把整表丢掉。
    //      单元格 style 属性序列化时被剥掉，不会污染 Markdown 源码；表格内容再编辑
    //      触发 Spin 重建 DOM 后恢复自适应布局。
    const tableColEdge = (event: MouseEvent): { table: HTMLTableElement; index: number } | null => {
      const cell = (event.target as HTMLElement).closest?.('td,th')
      const table = cell?.closest('table')
      const prose = container.querySelector('.prose')
      if (!cell || !table || !prose?.contains(table)) return null
      const row = table.querySelector('tr')
      if (!row || row.children.length < 2) return null
      const cells = [...row.children]
      // 最后一列的右缘是表格边框，不作为调宽把手
      for (let i = 0; i < cells.length - 1; i++) {
        if (Math.abs(event.clientX - cells[i].getBoundingClientRect().right) < 6) {
          return { table: table as HTMLTableElement, index: i }
        }
      }
      return null
    }
    const onTableMouseDown = (event: MouseEvent): void => {
      if (event.button !== 0) return
      const hit = tableColEdge(event)
      if (!hit) return
      const { table, index } = hit
      const cells = [...table.querySelector('tr')!.children] as HTMLElement[]
      // 首次拖拽：先量好自适应列宽，再切固定布局应用——顺序反了会让 fixed
      // 布局先把列压成均分，把均分值误固化成初始宽度
      if (!table.classList.contains('an-col-resized')) {
        const autoWidths = cells.map((cell) => Math.round(cell.getBoundingClientRect().width))
        table.classList.add('an-col-resized')
        cells.forEach((cell, i) => { cell.style.width = `${autoWidths[i]}px` })
      }
      event.preventDefault()
      const startX = event.clientX
      const startW = cells[index].getBoundingClientRect().width
      const nextCell = cells[index + 1]
      const startNextW = nextCell.getBoundingClientRect().width
      // 与右邻列此消彼长：总宽不变，拖动量 1:1 生效（fixed 布局会把指定的列宽
      // 按比例缩放到表格总宽，只改一列时增量会被稀释）
      const onMove = (ev: MouseEvent): void => {
        const delta = Math.max(36 - startW, Math.min(startNextW - 36, ev.clientX - startX))
        cells[index].style.width = `${Math.round(startW + delta)}px`
        nextCell.style.width = `${Math.round(startNextW - delta)}px`
      }
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        document.body.classList.remove('col-resizing')
      }
      document.body.classList.add('col-resizing')
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp, { once: true })
    }
    const onTableHover = (event: MouseEvent): void => {
      const want = tableColEdge(event) ? 'col-resize' : ''
      if (container.style.cursor !== want) container.style.cursor = want
    }
    const onTableLeave = (): void => { container.style.cursor = '' }
    container.addEventListener('mousedown', onTableMouseDown)
    container.addEventListener('mousemove', onTableHover)
    container.addEventListener('mouseleave', onTableLeave)

    /** 回车接管（v0.6.4）：Chromium 对 contenteditable <pre> 根节点的回车默认行为
     *  不可靠（实测在正文段末回车不产生新段，光标跳到下一块行首）。这里按
     *  Typora/Word 语义手动拆块：光标后内容移入新块，光标落到拆分点后的行首；
     *  块首回车产生上方空行，标题中段拆出同级标题、末尾拆出普通段落。
     *  列表/表格/代码块/脚注等结构块仍交给 Vditor 原生处理。
     *  走 capture 阶段拦截：先于 Vditor 挂在编辑器元素上的 keydown。 */
    const onEnterKeydown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      if (!ready || !editor || disposed) return
      const hint = container.querySelector<HTMLElement>('.vditor-hint')
      if (hint && hint.style.display === 'block') return // 补全面板开着：回车用于选中候选
      const prose = container.querySelector<HTMLElement>('.prose')
      const selection = window.getSelection()
      if (!prose || !selection || selection.rangeCount === 0) return
      const range = selection.getRangeAt(0)
      if (!range.collapsed || !prose.contains(range.startContainer)) return
      const anchorEl = (range.startContainer.nodeType === Node.TEXT_NODE
        ? range.startContainer.parentElement
        : range.startContainer) as HTMLElement | null
      const block = anchorEl?.closest('p, h1, h2, h3, h4, h5, h6')
      if (!block || !prose.contains(block)) return
      if (block.closest('li, td, th, .vditor-wysiwyg__block, [data-type="footnotes-block"], [data-type="link-ref-defs-block"]')) return
      // 引用块内空段回车 = 逐层跳出（Vditor 原生语义）
      const blockEmpty = !(block.textContent ?? '').replace(/\u200b/g, '').trim() && !block.querySelector('img')
      if (block.closest('blockquote') && blockEmpty) return
      event.preventDefault()
      event.stopPropagation()
      // 拆块：光标后内容 → 新块
      const trailing = range.cloneRange()
      trailing.setEnd(block, block.childNodes.length)
      const fragment = trailing.extractContents()
      const trailingHasContent = !!fragment.textContent?.trim() || !!fragment.querySelector('img, code, span[data-type]')
      const newBlock = document.createElement(trailingHasContent && block.tagName !== 'P' ? block.tagName : 'p')
      newBlock.setAttribute('data-block', '0')
      const marker = block.getAttribute('data-marker')
      if (marker && newBlock.tagName !== 'P') newBlock.setAttribute('data-marker', marker)
      if (fragment.childNodes.length > 0) newBlock.appendChild(fragment)
      else newBlock.innerHTML = '<br>'
      block.insertAdjacentElement('afterend', newBlock)
      // 光标落位：块首回车（原块剩余为空且有后继内容）留在原块，否则到新块行首
      const restEmpty = !(block.textContent ?? '').replace(/\u200b/g, '').trim() && !block.querySelector('img')
      const caretRange = document.createRange()
      caretRange.selectNodeContents(restEmpty && trailingHasContent ? block : newBlock)
      caretRange.collapse(true)
      selection.removeAllRanges()
      selection.addRange(caretRange)
      // 交回 Vditor 输入链路：Spin 重渲染、撤销入栈、草稿同步
      prose.dispatchEvent(new InputEvent('input', { inputType: 'insertParagraph', bubbles: true }))
    }
    container.addEventListener('keydown', onEnterKeydown, true)

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
        // 记录当前滚动位置，供 closeOverlays 恢复（防偶发回顶）
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
      // Mermaid 图点击进入全屏查看（缩放/平移，v0.6.3）：与图片浮层同一套
      // 滚动位置守卫；拦截点击避免 Vditor 把代码块切到编辑态
      const mermaidSvg = (event.target as Element).closest?.('svg')
      if (mermaidSvg && mermaidSvg.closest('.language-mermaid') && useStore.getState().mode === 'read') {
        event.preventDefault()
        event.stopPropagation()
        scrollGuardRef.current = {
          pos: document.querySelector('.reader-body')?.scrollTop ?? 0,
          docPath
        }
        setMermaid(mermaidSvg.outerHTML)
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
      // 切换文档/标签时关掉可能开着的图片/Mermaid 浮层
      setLightbox(null)
      setMermaid(null)
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
      container.removeEventListener('mousedown', onTableMouseDown)
      container.removeEventListener('mousemove', onTableHover)
      container.removeEventListener('mouseleave', onTableLeave)
      container.removeEventListener('keydown', onEnterKeydown, true)
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
      {lightbox && createPortal(<ImageLightbox info={lightbox} onClose={closeOverlays} />, document.body)}
      {mermaid && createPortal(<MermaidLightbox svg={mermaid} onClose={closeOverlays} />, document.body)}
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
