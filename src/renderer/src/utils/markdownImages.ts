import { apiFor } from '../store'

export const MAX_PASTED_IMAGE_BYTES = 8 * 1024 * 1024

export function clipboardImageFiles(data: DataTransfer | null): File[] {
  if (!data) return []
  return Array.from(data.items).filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile()).filter((file): file is File => !!file)
}

export async function saveMarkdownImages(files: File[], projectId: string, docPath: string): Promise<string> {
  if (files.length > 20) throw new Error('一次最多插入 20 张图片')
  for (const file of files) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error('支持 PNG、JPEG、GIF、WebP 图片')
    if (file.size > MAX_PASTED_IMAGE_BYTES) throw new Error(`「${file.name}」超过 8 MB`)
  }
  const result: string[] = []
  for (const file of files) {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',')[1])
      reader.onerror = () => reject(new Error('图片读取失败'))
      reader.readAsDataURL(file)
    })
    const asset = await apiFor<{ markdownPath: string }>(projectId)('POST', `/api/projects/${projectId}/images`, { docPath, data })
    const label = file.name.replace(/\.[^.]+$/, '').replace(/[\[\]\\\r\n]/g, '') || '图片'
    result.push(`![${label}](${asset.markdownPath})`)
  }
  return result.join('\n\n') + '\n'
}

function dataUrlToFile(src: string, alt: string): File {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/i.exec(src)
  if (!match) throw new Error('仅支持 PNG、JPEG、GIF、WebP 图片数据')
  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const extension = match[1].toLowerCase() === 'image/jpeg' ? 'jpg' : match[1].split('/')[1]
  const name = (alt.replace(/[\\/:*?"<>|\r\n]/g, '').trim() || 'pasted-image') + `.${extension}`
  return new File([bytes], name, { type: match[1].toLowerCase() })
}

/** Muya imageAction hook: serialize only the project-relative asset path. */
export async function saveMarkdownImageSource(src: string, alt: string, projectId: string, docPath: string): Promise<string> {
  if (!src.startsWith('data:')) return src
  const markdown = await saveMarkdownImages([dataUrlToFile(src, alt)], projectId, docPath)
  const path = /\]\(([^)]+)\)/.exec(markdown)?.[1]
  if (!path) throw new Error('图片保存后未返回有效的相对路径')
  return path
}
