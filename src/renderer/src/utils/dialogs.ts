import { useSyncExternalStore } from 'react'

export interface DialogRequest {
  id: number
  title: string
  message: string
  value?: string
  confirmLabel: string
  danger?: boolean
  pathKind?: 'folder' | 'save'
  resolve: (value: string | boolean | null) => void
}

let nextId = 0
let queue: DialogRequest[] = []
const listeners = new Set<() => void>()
const emit = (): void => { listeners.forEach((fn) => fn()) }
export const hasDialog = (): boolean => queue.length > 0
export function useDialog(): DialogRequest | undefined {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn) } }, () => queue[0])
}
export function finishDialog(value: string | boolean | null, requestId?: number): void {
  const current = queue[0]
  if (!current || (requestId !== undefined && current.id !== requestId)) return
  queue = queue.slice(1)
  current?.resolve(value)
  emit()
}
function request(options: Omit<DialogRequest, 'id' | 'resolve'>): Promise<string | boolean | null> {
  return new Promise((resolve) => {
    queue = [...queue, { ...options, id: ++nextId, resolve }]
    emit()
  })
}
export async function askConfirm(message: string, options: { title?: string; confirmLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  return await request({ title: options.title ?? '确认操作', message, confirmLabel: options.confirmLabel ?? '确认', danger: options.danger ?? true }) === true
}
export async function askInput(message: string, value = '', title = '输入内容'): Promise<string | null> {
  const result = await request({ title, message, value, confirmLabel: '确定' })
  return typeof result === 'string' ? result : null
}
export async function askPath(kind: 'folder' | 'save', defaultName = ''): Promise<string | null> {
  const result = await request({ title: kind === 'folder' ? '选择项目目录' : '导出 PDF', message: kind === 'folder' ? '选择要添加的项目文件夹' : '选择保存位置', pathKind: kind, value: defaultName, confirmLabel: kind === 'folder' ? '选择此目录' : '保存' })
  return typeof result === 'string' ? result : null
}
