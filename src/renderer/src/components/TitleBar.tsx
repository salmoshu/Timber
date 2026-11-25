import { useEffect, useRef, useState } from 'react'
import { useStore, type AppView } from '../store'
import Logo from './Logo'
import { IconChevronDown, IconClose, IconMaximize, IconMinimize, IconPanelLeft, IconPanelRight, IconRestore, IconSettings, WorkspaceIcon } from './icons'

const VIEWS: { key: AppView; label: string; description: string }[] = [
  { key: 'resources', label: '资源', description: '文件、代码与文档' },
  { key: 'architecture', label: '架构', description: '项目结构与依赖' },
  { key: 'history', label: '历史', description: '提交、分支与 AI 会话' }
]

export default function TitleBar() {
  const b = window.timber
  const mac = b?.platform === 'darwin'
  const openSettings = useStore((s) => s.openSettings)
  const closeSettings = useStore((s) => s.closeSettings)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const annPanelOpen = useStore((s) => s.annPanelOpen)
  const toggleAnnPanel = useStore((s) => s.toggleAnnPanel)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const resourceFocused = useStore((s) => s.resourceFocused && !!s.activeTabId && s.view === 'resources' && !s.settingsOpen)
  const setResourceFocus = useStore((s) => s.setResourceFocus)
  const folderProject = useStore((s) => s.projects.some((p) => p.id === s.activeProjectId && p.kind !== 'file'))
  const [version, setVersion] = useState('')
  const [maximized, setMaximized] = useState(false)
  const [viewMenuOpen, setViewMenuOpen] = useState(false)
  const viewNav = useRef<HTMLElement>(null)
  const viewTrigger = useRef<HTMLButtonElement>(null)
  const currentView = VIEWS.find((item) => item.key === view) ?? VIEWS[0]

  useEffect(() => {
    if (!viewMenuOpen) return
    viewNav.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)')?.focus()
    const closeOutside = (event: PointerEvent): void => {
      if (!viewNav.current?.contains(event.target as Node)) setViewMenuOpen(false)
    }
    const closeOnBlur = (): void => setViewMenuOpen(false)
    document.addEventListener('pointerdown', closeOutside, true)
    window.addEventListener('blur', closeOnBlur)
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true)
      window.removeEventListener('blur', closeOnBlur)
    }
  }, [viewMenuOpen])

  // 标题区版本号（Electron 环境从主进程取；纯 Web 预览不显示）
  useEffect(() => {
    let mounted = true
    b?.appVersion()
      .then((v) => {
        if (mounted) setVersion(v)
      })
      .catch(() => {})
    return () => {
      mounted = false
    }
  }, [b])

  // 最大化状态：初始化查询一次，随后跟随主进程推送（图标在单矩形/重叠矩形间切换）
  useEffect(() => {
    if (!b || mac) return
    let mounted = true
    b.winIsMaximized()
      .then((m) => {
        if (mounted) setMaximized(m)
      })
      .catch(() => {})
    const off = b.onWindowMaximized(setMaximized)
    return () => {
      mounted = false
      off()
    }
  }, [b, mac])

  return (
    <header className={`titlebar${mac ? ' mac-titlebar' : ''}`} data-view-menu-open={viewMenuOpen || undefined}>
      <div className="tb-drag">
        <Logo size={20} animated={false} />
        <span className="tb-name">Timber</span>
        {version && <span className="tb-version">{`v${version}`}</span>}
        <nav
          ref={viewNav}
          className="tb-views"
          aria-label="工作区导航"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setViewMenuOpen(false)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && viewMenuOpen) {
              event.preventDefault()
              setViewMenuOpen(false)
              viewTrigger.current?.focus()
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || (viewMenuOpen && ['Home', 'End'].includes(event.key))) {
              event.preventDefault()
              if (!viewMenuOpen) {
                setViewMenuOpen(true)
                return
              }
              const items = Array.from(viewNav.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)') ?? [])
              const current = items.indexOf(document.activeElement as HTMLButtonElement)
              const step = event.key === 'ArrowUp' ? -1 : 1
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + step + items.length) % items.length
              items[next]?.focus()
            }
          }}
        >
          <button
            ref={viewTrigger}
            type="button"
            className="tb-view-trigger"
            aria-label={`工作区视图 · ${currentView.label}`}
            aria-haspopup="menu"
            aria-expanded={viewMenuOpen}
            aria-controls={viewMenuOpen ? 'tb-view-menu' : undefined}
            data-view={view}
            onClick={() => setViewMenuOpen((open) => !open)}
          >
            <WorkspaceIcon view={view} />
            <span>{currentView.label}</span>
            <IconChevronDown />
          </button>
          {viewMenuOpen && (
            <div className="tb-view-menu" id="tb-view-menu" role="menu" aria-label="切换工作区">
              {VIEWS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={item.key === view}
                  data-view={item.key}
                  tabIndex={-1}
                  disabled={item.key !== 'resources' && !folderProject}
                  onClick={() => {
                    setViewMenuOpen(false)
                    viewTrigger.current?.focus()
                    setView(item.key)
                    if (settingsOpen) closeSettings()
                  }}
                >
                  <span className="tb-view-option-icon"><WorkspaceIcon view={item.key} size={16} /></span>
                  <span className="tb-view-option-text"><strong>{item.label}</strong><small>{item.description}</small></span>
                  {item.key === view && <span className="tb-view-check" aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
          )}
        </nav>
      </div>
      <div className="tb-btns">
        <button
          className={`tb-set ${sidebarCollapsed || resourceFocused ? '' : 'on'}`}
          onClick={() => {
            if (resourceFocused) setResourceFocus(false)
            if (!resourceFocused || sidebarCollapsed) toggleSidebar()
          }}
          title={resourceFocused ? '退出专注并显示左侧边栏' : sidebarCollapsed ? '展开左侧边栏' : '折叠左侧边栏'}
        >
          <IconPanelLeft />
        </button>
        <button
          className={`tb-set ${annPanelOpen && !resourceFocused ? 'on' : ''}`}
          onClick={() => {
            if (resourceFocused) setResourceFocus(false)
            if (!resourceFocused || !annPanelOpen) toggleAnnPanel()
          }}
          title={resourceFocused ? '退出专注并显示右侧边栏' : view === 'history' ? '历史记录侧栏' : view === 'architecture' ? 'AI 对话侧栏' : '右侧边栏（文件 / 搜索 / Git）'}
          disabled={settingsOpen}
        >
          <IconPanelRight />
        </button>
        <button
          className={`tb-set ${settingsOpen ? 'on' : ''}`}
          onClick={() => (settingsOpen ? closeSettings() : openSettings())}
          title={settingsOpen ? '返回主界面' : '设置'}
        >
          <IconSettings />
        </button>
        {b && !mac && (
          <>
            <button className="tb-window" onClick={() => b.winMinimize()} title="最小化"><IconMinimize /></button>
            <button className="tb-window" onClick={() => b.winToggleMaximize()} title={maximized ? '还原' : '最大化'}>
              {maximized ? <IconRestore /> : <IconMaximize />}
            </button>
            <button className="tb-window tb-close" onClick={() => b.winClose()} title="关闭"><IconClose /></button>
          </>
        )}
      </div>
    </header>
  )
}
