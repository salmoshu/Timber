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
