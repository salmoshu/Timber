const STORAGE_KEY = 'timber-image-sizes'

type ImageSizeStore = Record<string, Record<string, number>>

function readStore(): ImageSizeStore {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as ImageSizeStore
  } catch {
    return {}
  }
}

function docKey(projectId: string, docPath: string): string {
  return `${projectId}:${docPath}`
}

function imageKey(index: number, src: string): string {
  return `${index}:${src}`
}

export function saveImageSize(projectId: string, docPath: string, index: number, src: string, width: number): void {
  const store = readStore()
  const key = docKey(projectId, docPath)
  store[key] = { ...store[key], [imageKey(index, src)]: Math.round(width) }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    /* 存储不可用时本次 DOM 尺寸仍保留 */
  }
}

export function applyImageSizes(root: ParentNode, projectId: string, docPath: string): void {
  const sizes = readStore()[docKey(projectId, docPath)]
  if (!sizes) return
  root.querySelectorAll<HTMLImageElement>('img').forEach((img, index) => {
    const src = img.dataset.anOrigSrc ?? img.getAttribute('src') ?? ''
    const width = sizes[imageKey(index, src)]
    if (!width) return
    img.setAttribute('width', String(width))
    img.removeAttribute('height')
    img.style.height = 'auto'
  })
}
