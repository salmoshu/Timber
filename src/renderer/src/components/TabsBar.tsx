import { type ReactNode, useEffect, useRef, useState } from 'react'
import { isDocumentTabPath, useStore, type DocTab } from '../store'
import ContextMenu, { type MenuItem } from './ContextMenu'
import { filterDocsForProject } from '../utils/settings'
import { IconChevronRight, IconFocusLayout } from './icons'
import { markdownExportItems } from './markdownExportItems'

/** 文档标签栏（VSCode 语义：斜体 = 预览标签，随单击复用；双击固定）；
 *  children 渲染为行右端操作区（阅读模式|编辑模式 / 标签等）。
 *  多文档时仅 tab 区横向滚动（tab 先收缩到最小宽、再滚动），
 *  右端操作区固定在可视区，不被挤走；激活 tab 自动滚入可视范围。
 *  支持拖拽 tab 调整先后顺序（插入位置以强调色竖线提示）。
 *  右键 tab 弹出 VSCode 风格菜单（关闭 / 关闭其他 / 关闭右侧 / 复制路径等）。 */
export default function TabsBar({ children, afterFocus }: { children?: ReactNode; afterFocus?: ReactNode }) {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const focused = useStore((s) => s.resourceFocused)
  const setResourceFocus = useStore((s) => s.setResourceFocus)
  const activeProjectId = useStore((s) => s.activeProjectId)
  const projects = useStore((s) => s.projects)
  const settings = useStore((s) => s.settings)
  const project = projects.find((p) => p.id === activeProjectId)
  // 文档过滤（项目级设置）开启时，非文档标签暂时隐藏但不关闭；关闭过滤后按原位置恢复（v0.8.1）
  const docsOnly = project ? filterDocsForProject(settings, project) : false
  const visibleTabs = docsOnly ? tabs.filter((t) => isDocumentTabPath(t.path, settings)) : tabs
  const { activateTab, closeTab, closeOtherTabs, closeTabsToRight, closeAllTabs, pinTab, reorderTabs, toast } =
    useStore.getState()
  const scrollRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState({ left: false, right: false })
  const [drag, setDrag] = useState<{ from: string; over: string | null; pos: 'before' | 'after' } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; tabId: string } | null>(null)

  useEffect(() => {
    const el = scrollRef.current?.querySelector('.doc-tab.active')
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId, visibleTabs.length])

  useEffect(() => {
    const rail = scrollRef.current
    if (!rail) return
    const update = () => {
      const remaining = rail.scrollWidth - rail.clientWidth
      const room = (navRef.current?.offsetWidth ?? 0) + (navRef.current ? 1 : 0)
      const overflow = remaining > room + 1
      setScroll((state) => {
        const left = overflow && rail.scrollLeft > 1
        const right = overflow && remaining - rail.scrollLeft > 1
        return state.left === left && state.right === right ? state : { left, right }
      })
    }
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaX || !event.deltaY) return
      const remaining = rail.scrollWidth - rail.clientWidth
      if ((event.deltaY < 0 && rail.scrollLeft <= 0) || (event.deltaY > 0 && rail.scrollLeft >= remaining - 1)) return
      event.preventDefault()
      rail.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 24 : 1)
    }
    const observer = new ResizeObserver(update)
    observer.observe(rail)
    rail.addEventListener('scroll', update)
    rail.addEventListener('wheel', wheel, { passive: false })
    update()
    return () => {
      observer.disconnect()
      rail.removeEventListener('scroll', update)
      rail.removeEventListener('wheel', wheel)
    }
  }, [visibleTabs.length])

  const scrollByPage = (direction: -1 | 1) => {
    const rail = scrollRef.current
    if (!rail) return
    rail.scrollBy({
      left: direction * Math.max(96, rail.clientWidth * 0.75),
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
    })
  }

  /** tab 右键菜单项（VSCode 风格）；远程项目无本地文件路径，隐藏「在文件管理器中显示」 */
  const tabMenuItems = (t: DocTab): MenuItem[] => {
    const project = projects.find((p) => p.id === activeProjectId)
    const abs = project ? `${project.path}/${t.path}` : t.path
    const items: MenuItem[] = [
      { key: 'close', label: '关闭', onClick: () => closeTab(t.id) },
      { key: 'close-others', label: '关闭其他标签', onClick: () => closeOtherTabs(t.id) },
      { key: 'close-right', label: '关闭右侧标签', onClick: () => closeTabsToRight(t.id) },
      { key: 'close-all', label: '关闭所有标签', onClick: () => void closeAllTabs() },
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
    items.push(...markdownExportItems(t.path, () => activateTab(t.id)))
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
  const menuTab = menu ? visibleTabs.find((t) => t.id === menu.tabId) : undefined

  if (visibleTabs.length === 0) return null

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
          const last = visibleTabs[visibleTabs.length - 1]
          if (last && last.id !== drag.from) setDrag((d) => (d ? { ...d, over: last.id, pos: 'after' } : d))
        }}
        onDrop={(e) => {
          if (!drag) return
          e.preventDefault()
          if (drag.over) reorderTabs(drag.from, drag.over, drag.pos)
          setDrag(null)
        }}
      >
        {visibleTabs.map((t) => (
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
      {(scroll.left || scroll.right) && (
        <div className="tabs-overflow" ref={navRef} role="group" aria-label="滚动标签">
          <button type="button" aria-label="向左滚动标签" title="向左滚动标签" disabled={!scroll.left} onClick={() => scrollByPage(-1)}>
            <IconChevronRight />
          </button>
          <button type="button" aria-label="向右滚动标签" title="向右滚动标签" disabled={!scroll.right} onClick={() => scrollByPage(1)}>
            <IconChevronRight />
          </button>
        </div>
      )}
      <div className="tabs-actions">
        {children}
        <div className="rt-tool-group">
          <button
            type="button"
            className={`rt-btn resource-focus-button${focused ? ' active' : ''}`}
            aria-label="专注模式"
            aria-pressed={focused}
            title={focused ? '退出专注模式（Esc）' : '专注模式 · 隐藏侧栏并展开文档目录'}
            onClick={() => setResourceFocus(!focused)}
          >
            <IconFocusLayout exit={focused} />
            {focused && <span aria-hidden="true">退出专注</span>}
          </button>
        </div>
        {afterFocus}
      </div>
      {menu && menuTab && (
        <ContextMenu x={menu.x} y={menu.y} items={tabMenuItems(menuTab)} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
