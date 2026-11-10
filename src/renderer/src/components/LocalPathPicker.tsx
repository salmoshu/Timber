import { useEffect, useRef, useState } from 'react'
import type { TimberBridge } from '@shared/types'
import { IconChevronRight, IconFolder } from './icons'

export default function LocalPathPicker({ kind, defaultName, extension = '.pdf', onFinish }: { kind: 'folder' | 'save'; defaultName: string; extension?: string; onFinish: (path: string | null) => void }) {
  const [listing, setListing] = useState<Awaited<ReturnType<TimberBridge['browseLocal']>> | null>(null)
  const [directory, setDirectory] = useState('')
  const [name, setName] = useState(defaultName)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)
  const load = async (path?: string): Promise<void> => {
    const id = ++seq.current
    setBusy(true); setError('')
    try {
      const result = await window.timber!.browseLocal(path)
      if (id !== seq.current) return
      setListing(result); setDirectory(result.path)
    } catch (e) { if (id === seq.current) setError(String(e instanceof Error ? e.message : e)) }
    finally { if (id === seq.current) setBusy(false) }
  }
  useEffect(() => { void load(); return () => { ++seq.current } }, [])
  const submit = async (): Promise<void> => {
    setBusy(true); setError('')
    try {
      const result = await window.timber!.browseLocal(directory)
      if (kind === 'folder') { onFinish(result.path); return }
      const filename = name.trim()
      if (!filename || /[\\/:*?"<>|]/.test(filename) || /[. ]$/.test(filename) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(filename)) throw new Error(`请输入有效的 ${extension.slice(1).toUpperCase()} 文件名`)
      onFinish(`${result.path}${result.path.endsWith('\\') || result.path.endsWith('/') ? '' : '/'}${filename.toLowerCase().endsWith(extension) ? filename : filename + extension}`)
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); setBusy(false) }
  }
  return <div className="local-path-picker">
    <form onSubmit={(e) => { e.preventDefault(); void load(directory) }} className="path-address">
      <button type="button" className="path-up" aria-label="上级目录" title="上级目录" disabled={busy || !listing || listing.path === listing.parent} onClick={() => void load(listing!.parent)}>↑</button>
      <input aria-label="目录路径" spellCheck={false} value={directory} onChange={(e) => setDirectory(e.target.value)} placeholder="输入目录路径" />
      <button type="submit" className="path-go" disabled={busy}>前往</button>
    </form>
    <div className="path-shortcuts" aria-label="快速位置">
      <span className="path-shortcut-label">快速位置</span>
      <button className="path-shortcut" disabled={busy} onClick={() => void load(listing?.home)}>主目录</button>
      {listing?.roots.map((root) => <button className="path-shortcut" key={root} disabled={busy} onClick={() => void load(root)}>{root}</button>)}
    </div>
    <div className="path-folders" aria-label="文件夹" aria-busy={busy}>
      <div className="path-list-head"><span>子文件夹</span><span>{listing?.folders.length ?? 0} 项</span></div>
      <div className="path-folder-list">
        {busy ? <p className="path-list-empty">正在读取目录…</p> : listing?.folders.map((folder) => <button className="path-folder" key={folder.path} onClick={() => void load(folder.path)} title={folder.path}><span className="path-folder-icon" aria-hidden="true"><IconFolder /></span><span className="path-folder-name">{folder.name}</span><span className="path-folder-arrow" aria-hidden="true"><IconChevronRight /></span></button>)}
        {!busy && listing?.folders.length === 0 && <p className="path-list-empty">此目录没有子文件夹，可直接选择当前目录</p>}
      </div>
    </div>
    {kind === 'folder' && <div className="path-selection">
      <span className="path-selection-label">当前选择</span>
      <span className="path-selection-path" title={directory}>{directory || '尚未选择目录'}</span>
      <span className="path-selection-meta">{listing?.folders.length ?? 0} 个子文件夹</span>
    </div>}
    {kind === 'save' && <label className="path-filename">文件名<input aria-label="PDF 文件名" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit() } }} /></label>}
    {error && <p role="alert" className="path-error">{error}</p>}
    <div className="app-dialog-actions"><button data-cancel className="btn-ghost" onClick={() => onFinish(null)}>取消</button><button className="btn-primary" disabled={busy || !directory.trim()} onClick={() => void submit()}>{kind === 'folder' ? '选择此目录' : '保存'}</button></div>
  </div>
}
