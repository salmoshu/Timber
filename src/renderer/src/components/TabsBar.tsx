import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useStore, type DocTab } from '../store'
import ContextMenu, { type MenuItem } from './ContextMenu'
import { exportActiveDocPdf } from '../utils/exportPdf'

/** 文档标签栏（VSCode 语义：斜体 = 预览标签，随单击复用；双击固定）；
 *  children 渲染为行右端操作区（阅读模式|编辑模式 / 批注等）。
 *  多文档时仅 tab 区横向滚动（tab 先收缩到最小宽、再滚动），
 *  右端操作区固定在可视区，不被挤走；激活 tab 自动滚入可视范围。
 *  支持拖拽 tab 调整先后顺序（插入位置以强调色竖线提示）。
 *  右键 tab 弹出 VSCode 风格菜单（关闭 / 关闭其他 / 关闭右侧 / 复制路径等）。 */
export default function TabsBar({ children }: { children?: ReactNode }) {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const projects = useStore((s) => s.projects)
  const { activateTab, closeTab, closeOtherTabs, closeTabsToRight, pinTab, reorderTabs, toast } =
    useStore.getState()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ from: string; over: string | null; pos: 'before' | 'after' } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; tabId: string } | null>(null)

  useEffect(() => {
    const el = scrollRef.current?.querySelector('.doc-tab.active')
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId, tabs.length])

  /** tab 右键菜单项（VSCode 风格）；远程项目无本地文件路径，隐藏「在文件管理器中显示」 */
  const tabMenuItems = (t: DocTab): MenuItem[] => {
    const project = projects.find((p) => p.id === activeProjectId)
    const abs = project ? `${project.path}/${t.path}` : t.path
    const items: MenuItem[] = [
      { key: 'close', label: '关闭', onClick: () => closeTab(t.id) },
      { key: 'close-others', label: '关闭其他标签', onClick: () => closeOtherTabs(t.id) },
      { key: 'close-right', label: '关闭右侧标签', onClick: () => closeTabsToRight(t.id) },
      {
        key: 'copy-path',
        label: '复制路径',
        separatorBefore: true,
        onClick: () => {
          navigator.clipboard.writeText(t.path)
          toast('ok', '路径已复制')
        }
      },
      {
        key: 'copy-abs',
        label: '复制绝对路径',
        onClick: () => {
          navigator.clipboard.writeText(abs)
          toast('ok', '绝对路径已复制')
        }
      }
    ]
    if (window.timber && /\.(md|markdown|mdown|mkd)$/i.test(t.path)) {
      items.push({
        key: 'export-pdf',
        label: '导出 PDF…',
        separatorBefore: true,
        onClick: () => void (async () => {
          if (useStore.getState().activeTabId !== t.id) await activateTab(t.id)
          if (useStore.getState().activeDoc?.path === t.path) await exportActiveDocPdf()
        })()
      })
    }
    if (project && !project.remoteId) {
      items.push({
        key: 'reveal',
        label: '在文件管理器中显示',
        onClick: () => void window.timber?.revealPath(abs)
      })
    }
    return items
  }

  // 菜单打开期间目标 tab 可能被关闭：找不到则不渲染
  const menuTab = menu ? tabs.find((t) => t.id === menu.tabId) : undefined

  if (tabs.length === 0) return null

  return (
    <div className="tabs-bar">
      <div
        className="tabs-scroll"
        ref={scrollRef}
        onDragOver={(e) => {
          if (!drag) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          // 拖到 tab 区尾部空白：视为插入到最后一个标签之后
          const last = tabs[tabs.length - 1]
          if (last && last.id !== drag.from) setDrag((d) => (d ? { ...d, over: last.id, pos: 'after' } : d))
        }}
        onDrop={(e) => {
          if (!drag) return
          e.preventDefault()
          if (drag.over) reorderTabs(drag.from, drag.over, drag.pos)
          setDrag(null)
        }}
      >
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`doc-tab ${t.id === activeTabId ? 'active' : ''} ${t.pinned ? '' : 'preview'} ${
              drag?.over === t.id ? `drop-${drag.pos}` : ''
            } ${drag?.from === t.id ? 'dragging' : ''}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', t.id)
              setDrag({ from: t.id, over: null, pos: 'after' })
            }}
            onDragEnd={() => setDrag(null)}
            onDragOver={(e) => {
              if (!drag || drag.from === t.id) return
              e.preventDefault()
              e.stopPropagation()
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
              const pos = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
              setDrag((d) => (d && (d.over !== t.id || d.pos !== pos) ? { ...d, over: t.id, pos } : d))
            }}
            onDrop={(e) => {
              if (!drag || drag.from === t.id) return
              e.preventDefault()
              e.stopPropagation()
              reorderTabs(drag.from, t.id, drag.pos)
              setDrag(null)
            }}
            onClick={() => void activateTab(t.id)}
            onDoubleClick={() => pinTab(t.id)}
            onMouseDown={(e) => {
              // 中键关闭（VSCode 直觉）
              if (e.button === 1) {
                e.preventDefault()
                closeTab(t.id)
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, tabId: t.id })
            }}
            title={`${t.path}\n（双击固定标签，拖动调整顺序，右键更多操作）`}
          >
            <span className="tab-name">{t.path.split('/').pop()}</span>
            <button
              className={`tab-close ${t.dirty ? 'dirty' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                closeTab(t.id)
              }}
              title={t.dirty ? '未保存 · 点击关闭（丢弃需确认）' : '关闭 (Ctrl+W)'}
            >
              <span className="tc-dot">●</span>
              <span className="tc-x">✕</span>
            </button>
          </div>
        ))}
      </div>
      {children && <div className="tabs-actions">{children}</div>}
      {menu && menuTab && (
        <ContextMenu x={menu.x} y={menu.y} items={tabMenuItems(menuTab)} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
