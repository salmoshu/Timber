// 图片 / Mermaid 图的显示元数据（宽度 + 对齐）：随应用按「项目:文档 → 元素键」
// 持久化在 localStorage，不改写 Markdown 源码；渲染补丁（rewriteImages）周期重放。
// v0.6.9 首版只存宽度（纯数字）；v0.6.10 起扩展为 { width?, align? }，读取时兼容旧值。
const STORAGE_KEY = 'timber-image-sizes'

export type ImageAlign = 'left' | 'center' | 'right'

export interface ImageMeta {
  width?: number
  align?: ImageAlign
}

type ImageMetaStore = Record<string, Record<string, number | ImageMeta>>

function readStore(): ImageMetaStore {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as ImageMetaStore
  } catch {
    return {}
  }
}

function docKey(projectId: string, docPath: string): string {
  return `${projectId}:${docPath}`
}

/** 旧版纯数字记录视为 { width } */
function normalize(raw: number | ImageMeta | undefined): ImageMeta | null {
  if (raw === undefined) return null
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? { width: raw } : null
  return raw
}

export function imageKey(index: number, src: string): string {
  return `${index}:${src}`
}

/** Mermaid 元素键：文档内序号 + 文字指纹（仅取 text 节点，主题重刷样式不影响；
 *  图内容编辑后指纹变化，记忆自然失效重置，符合预期） */
export function mermaidKey(index: number, svg: SVGElement): string {
  const fingerprint = [...svg.querySelectorAll('text')]
    .map((t) => t.textContent ?? '')
    .join('|')
    .slice(0, 120)
  return `m:${index}:${fingerprint}`
}

/** 合并写入一个元素的元数据（width / align 单独增量更新） */
export function saveImageMeta(
  projectId: string,
  docPath: string,
  key: string,
  patch: Partial<ImageMeta>
): void {
  const store = readStore()
  const key0 = docKey(projectId, docPath)
  const current = normalize(store[key0]?.[key]) ?? {}
  store[key0] = { ...store[key0], [key]: { ...current, ...patch } }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    /* 存储不可用时本次 DOM 调整仍保留 */
  }
}

export function getImageMeta(
  projectId: string,
  docPath: string,
  key: string
): ImageMeta | null {
  return normalize(readStore()[docKey(projectId, docPath)]?.[key])
}

/** 图片对齐落到所在段落（独立成段的图片即视觉居左/居中/居右）；left 清内联回默认 */
function applyImageAlign(image: HTMLImageElement, align: ImageAlign): void {
  const block = image.closest('p') ?? image.parentElement
  if (!block) return
  block.style.textAlign = align === 'left' ? '' : align
}

/** Mermaid 对齐落在 svg 的 margin（display:block 定宽下：0+auto=居左，
 *  auto+auto=居中=默认，auto+0=居右） */
function applyMermaidAlign(svg: SVGElement, align: ImageAlign): void {
  svg.style.marginLeft = align === 'left' ? '0' : 'auto'
  svg.style.marginRight = align === 'right' ? '0' : 'auto'
}

/** 读取元素当前生效的对齐（工具条高亮用） */
export function effectiveAlign(el: HTMLImageElement | SVGElement): ImageAlign {
  if (el instanceof SVGElement) {
    const style = getComputedStyle(el)
    return style.marginLeft === 'auto' && style.marginRight !== 'auto'
      ? 'right'
      : style.marginLeft !== 'auto' && style.marginRight === 'auto'
        ? 'left'
        : 'center'
  }
  const block = el.closest('p') ?? el.parentElement
  const align = block ? getComputedStyle(block).textAlign : 'left'
  if (align === 'center') return 'center'
  if (align === 'right' || align === 'end') return 'right'
  return 'left'
}

/** 渲染补丁：把保存的宽度与对齐重放到容器内全部图片与 Mermaid 图 */
export function applyImageMetas(root: ParentNode, projectId: string, docPath: string): void {
  const metas = readStore()[docKey(projectId, docPath)]
  if (!metas) return
  root.querySelectorAll<HTMLImageElement>('img').forEach((img, index) => {
    const meta = normalize(metas[imageKey(index, img.dataset.anOrigSrc ?? img.getAttribute('src') ?? '')])
    if (!meta) return
    if (meta.width) {
      img.setAttribute('width', String(meta.width))
      img.removeAttribute('height')
      img.style.height = 'auto'
    }
    if (meta.align) applyImageAlign(img, meta.align)
  })
  root.querySelectorAll<SVGElement>('.language-mermaid svg').forEach((svg, index) => {
    const meta = normalize(metas[mermaidKey(index, svg)])
    if (!meta) return
    if (meta.width) {
      svg.style.width = `${meta.width}px`
      svg.style.maxWidth = 'none'
      svg.style.height = 'auto'
    }
    if (meta.align) applyMermaidAlign(svg, meta.align)
  })
}
