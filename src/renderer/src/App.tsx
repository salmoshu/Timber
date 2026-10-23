import { useEffect } from 'react'
import { useStore } from './store'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import ResourceView from './components/ResourceView'
import AppDialog from './components/AppDialog'
import { hasDialog } from './utils/dialogs'
import HistoryView from './components/HistoryView'
import ArchitectureView from './components/ArchitectureView'
import Toasts from './components/Toasts'
import UpdateCard from './components/UpdateCard'
import SettingsView from './components/SettingsView'
import ExternalPage from './components/ExternalPage'
import AddProjectDialog from './components/AddProjectDialog'
import Logo from './components/Logo'

export default function App() {
  const { init, ready, fatalError, annPanelOpen, extPageUrl, closeExtPage, settingsOpen, view, activeProjectId } = useStore()

  useEffect(() => {
    void init()
  }, [init])

  // 主进程拦截到的外链（导航 / window.open）转应用内浮层；浮层未挂载也能收到
  useEffect(() => window.timber?.onOpenExternalPage((url) => useStore.getState().openExtPage(url)), [])

  // 标签快捷键（主进程 before-input-event 拦截后转发）：Ctrl+W 关闭、Ctrl+Tab 切换
  useEffect(
    () =>
      window.timber?.onTabShortcut((kind) => {
        if (hasDialog()) return
        const s = useStore.getState()
        if (kind === 'close' && s.activeTabId) s.closeTab(s.activeTabId)
        else if (kind === 'next' && s.tabs.length > 1) {
          const idx = s.tabs.findIndex((t) => t.id === s.activeTabId)
          void s.activateTab(s.tabs[(idx + 1) % s.tabs.length].id)
        }
      }),
    []
  )

  if (!ready) {
    return (
      <div className="boot">
        <Logo size={56} />
        <div className="boot-text">Timber 正在启动…</div>
      </div>
    )
  }

  if (fatalError) {
    return (
      <div className="app">
      <TitleBar />
      <div className="boot">
        <Logo size={56} />
        <div className="boot-text">sidecar 服务连接失败</div>
        <div className="boot-err">{fatalError}</div>
        <div className="boot-hint">
          {window.timber ? '请重新启动 Timber 后重试。' : <>纯 Web 预览模式需先手动启动 sidecar：
          <code>sidecar/bin/timberd.exe -addr 127.0.0.1:37123 -token dev-token -data ./sidecar/data</code>
          </>}
        </div>
      </div>
      </div>
    )
  }

  return (
    <div className="app">
      <div className="app-surface">
        <TitleBar />
        <div className="app-body">
          {settingsOpen ? <SettingsView /> : (
            <>
              <Sidebar />
              <main className="reader-wrap">
                {view === 'history' ? <HistoryView /> : view === 'architecture' ? <ArchitectureView key={activeProjectId} /> : <ResourceView />}
              </main>
              {view === 'resources' && annPanelOpen && <Sidebar section="files" />}
            </>
          )}
        </div>
        <AddProjectDialog />
        {extPageUrl && <ExternalPage url={extPageUrl} onClose={closeExtPage} />}
      </div>
      <AppDialog />
      <Toasts />
      <UpdateCard />
    </div>
  )
}
