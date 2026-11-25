import type { MenuItem } from './ContextMenu'
import { useStore } from '../store'
import { exportActiveDocument, type DocumentExportKind } from '../utils/documentExport'

const FORMATS: [DocumentExportKind, string][] = [
  ['pdf', '导出 PDF…'],
  ['word', '导出 Word (.docx)…'],
  ['html', '导出 HTML（含本地图片）…'],
  ['image', '导出长图 (.png)…']
]

/** The tree, recent files and tabs expose the same actions for the clicked Markdown file. */
export function markdownExportItems(path: string, activate: () => Promise<void>): MenuItem[] {
  if (!window.timber || !/\.(md|markdown|mdown|mkd)$/i.test(path)) return []
  const projectId = useStore.getState().activeProjectId
  return FORMATS.map(([kind, label], index) => ({
    key: `export-${kind}`,
    label,
    separatorBefore: index === 0,
    onClick: async () => {
      if (!projectId || useStore.getState().activeProjectId !== projectId) return
      await activate()
      const state = useStore.getState()
      if (state.activeProjectId === projectId && state.activeDoc?.path === path) await exportActiveDocument(kind)
    }
  }))
}
