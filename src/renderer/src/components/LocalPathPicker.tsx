import { useEffect, useRef, useState } from 'react'
import type { TimberBridge } from '@shared/types'

export default function LocalPathPicker({ kind, defaultName, onFinish }: { kind: 'folder' | 'save'; defaultName: string; onFinish: (path: string | null) => void }) {
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
      if (!filename || /[\\/:*?"<>|]/.test(filename) || /[. ]$/.test(filename) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(filename)) throw new Error('请输入有效的 PDF 文件名')
      onFinish(`${result.path}${result.path.endsWith('\\') || result.path.endsWith('/') ? '' : '/'}${/\.pdf$/i.test(filename) ? filename : filename + '.pdf'}`)
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); setBusy(false) }
  }
  return <div className="local-path-picker">
    <form onSubmit={(e) => { e.preventDefault(); void load(directory) }} className="path-address">
      <button type="button" className="btn-ghost" aria-label="上级目录" disabled={busy || !listing || listing.path === listing.parent} onClick={() => void load(listing!.parent)}>↑</button>
      <input aria-label="目录路径" spellCheck={false} value={directory} onChange={(e) => setDirectory(e.target.value)} placeholder="输入目录路径" />
      <button type="submit" className="btn-ghost" disabled={busy}>前往</button>
    </form>
    <div className="path-shortcuts">
      <button className="btn-ghost sm" disabled={busy} onClick={() => void load(listing?.home)}>主目录</button>
      {listing?.roots.map((root) => <button className="btn-ghost sm" key={root} disabled={busy} onClick={() => void load(root)}>{root}</button>)}
    </div>
    <div className="path-folders" aria-label="文件夹" aria-busy={busy}>
      {busy ? <p>加载中…</p> : listing?.folders.map((folder) => <button className="path-folder" key={folder.path} onClick={() => void load(folder.path)}><span aria-hidden="true">▱</span>{folder.name}<span aria-hidden="true">›</span></button>)}
      {!busy && listing?.folders.length === 0 && <p>此目录没有子文件夹</p>}
    </div>
    {kind === 'save' && <label className="path-filename">文件名<input aria-label="PDF 文件名" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit() } }} /></label>}
    {error && <p role="alert" className="path-error">{error}</p>}
    <div className="app-dialog-actions"><button data-cancel className="btn-ghost" onClick={() => onFinish(null)}>取消</button><button className="btn-primary" disabled={busy || !directory.trim()} onClick={() => void submit()}>{kind === 'folder' ? '选择此目录' : '保存'}</button></div>
  </div>
}
