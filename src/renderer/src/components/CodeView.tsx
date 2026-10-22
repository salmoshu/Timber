// 源码文件树（资源视图侧栏「文件」tab 在关闭「过滤文档」时显示；
// v0.5.6 起数据由 store.loadCodeTree 托管，v0.5.9 起代码正文改由 CodeReader 经标签打开）
import { useMemo, useState } from 'react'
import type { DocNode } from '@shared/types'
import { useStore } from '../store'
import Chevron from './Chevron'

/** 扩展名 → 文件类型图标（与侧栏文档树同款，保证两棵树视觉一致；勿从 Sidebar 引入以免循环依赖） */
function extIcon(ext?: string): string {
  switch (ext) {
    case '.md':
    case '.markdown':
    case '.mdown':
    case '.mkd':
      return 'M↓'
    case '.html':
    case '.htm':
      return '<>'
    default:
      return '≡'
  }
}

function extClass(ext?: string): string {
  if (ext === '.md' || ext === '.markdown' || ext === '.mdown' || ext === '.mkd') return 'ext-md'
  if (ext === '.html' || ext === '.htm') return 'ext-html'
  return 'ext-txt'
}

/** 递归收集树中的文件节点（带搜索过滤；目录保留有命中的分支） */
function filterTree(node: DocNode, kw: string): DocNode | null {
  if (node.type === 'doc') {
    if (kw && !node.path.toLowerCase().includes(kw)) return null
    return node
  }
  const children = (node.children ?? [])
    .map((c) => filterTree(c, kw))
    .filter((c): c is DocNode => c !== null)
  if (children.length === 0 && kw && !node.name.toLowerCase().includes(kw)) return null
  if (children.length === 0 && node.type === 'dir') return node
  return { ...node, children }
}

function TreeNode({ node, depth }: { node: DocNode; depth: number }) {
  const activePath = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.path)
  const selectedDir = useStore((s) => s.selectedDir)
  // 目录默认折叠（0.5.2 起），点击目录名展开
  const [open, setOpen] = useState(false)
  // v0.5.7 起与文档树共用 tree-dir / tree-doc 结构（Chevron 箭头 + 类型图标列），样式完全一致
  if (node.type === 'doc') {
    return (
      <button
        className={`tree-doc ${activePath === node.path ? 'active' : ''}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => void useStore.getState().openDoc(node.path)}
        onDoubleClick={() => void useStore.getState().openTab(node.path, { pinned: true })}
        title={node.path}
      >
        <span className={`doc-icon ${extClass(node.ext)}`}>{extIcon(node.ext)}</span>
        <span className="doc-name">{node.name}</span>
      </button>
    )
  }
  return (
    <div>
      <button
        className={`tree-dir ${selectedDir === node.path ? 'sel' : ''}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => {
          setOpen(!open)
          useStore.getState().setSelectedDir(node.path)
        }}
      >
        <Chevron open={open} />
        <span className="dir-name">{node.name}</span>
      </button>
      {open && (node.children ?? []).map((c) => <TreeNode key={c.path} node={c} depth={depth + 1} />)}
    </div>
  )
}

/** 源码文件树（侧栏「文件」tab 使用，v0.5.6；数据由 store.loadCodeTree 托管，过滤条件本地维护） */
export function CodeTree() {
  const codeTree = useStore((s) => s.codeTree)
  const codeTreeLoading = useStore((s) => s.codeTreeLoading)
  const [filter, setFilter] = useState('')

  const shownTree = useMemo(() => {
    if (!codeTree) return null
    return filterTree(codeTree, filter.trim().toLowerCase())
  }, [codeTree, filter])

  return (
    <>
      <div className="sb-filter">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="搜索文件…"
          spellCheck={false}
        />
      </div>
      <div className="sb-tree">
        {codeTreeLoading && <div className="sb-empty">扫描中…</div>}
        {!codeTreeLoading && shownTree && (shownTree.children ?? []).length === 0 && (
          <div className="sb-empty">无匹配文件</div>
        )}
        {shownTree?.children?.map((c) => <TreeNode key={c.path} node={c} depth={0} />)}
      </div>
    </>
  )
}
