// 资源视图主体：文档类走 Reader；代码默认 Monaco，超大文件回退到轻量 CodeReader
import { lazy, Suspense } from 'react'
import { isReaderPath, useStore } from '../store'
import Reader from './Reader'
import CodeReader from './CodeReader'
import TabsBar from './TabsBar'

const CodeEditor = lazy(() => import('./CodeEditor'))
const MONACO_FALLBACK_BYTES = 2 * 1024 * 1024

export default function ResourceView() {
  const tab = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const content = useStore((s) => s.activeDoc?.path === tab?.path ? s.activeDoc?.content : undefined)
  if (tab && !isReaderPath(tab.path)) {
    if (content !== undefined && content.length > MONACO_FALLBACK_BYTES) return <CodeReader key={tab.id} path={tab.path} />
    return <Suspense fallback={<div className="reader"><TabsBar /><div className="hv-loading">加载代码编辑器…</div></div>}><CodeEditor key={tab.id} path={tab.path} /></Suspense>
  }
  return <Reader />
}
