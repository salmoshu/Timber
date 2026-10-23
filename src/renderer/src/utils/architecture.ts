import type { ArchSpec } from '@shared/types'

export interface CurrentArchitecture {
  spec: ArchSpec
  prompt: string
  updatedAt: string
}

/** 每个项目只保留当前 spec；HTML 可重新渲染，不把历次画布塞进存储。 */
export function readCurrentArchitecture(projectKey: string): CurrentArchitecture | null {
  try {
    const value = JSON.parse(localStorage.getItem(`timber-current-architecture:${projectKey}`) ?? 'null') as CurrentArchitecture | null
    return value?.spec?.diagram_type === 'architecture' && Array.isArray(value.spec.components) ? value : null
  } catch { return null }
}

export function saveCurrentArchitecture(projectKey: string, current: CurrentArchitecture): void {
  localStorage.setItem(`timber-current-architecture:${projectKey}`, JSON.stringify(current))
}
