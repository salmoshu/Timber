// 资源视图主体：按活动标签文件类型分发——文档类走 Reader（可编辑），其余源码文件走 CodeReader（只读）
import { isReaderPath, useStore } from '../store'
import Reader from './Reader'
import CodeReader from './CodeReader'

export default function ResourceView() {
  const tab = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  if (tab && !isReaderPath(tab.path)) return <CodeReader key={tab.id} path={tab.path} />
  return <Reader />
}
