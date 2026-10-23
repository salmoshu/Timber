import { useEffect, useRef, useState } from 'react'
import { finishDialog, useDialog } from '../utils/dialogs'
import LocalPathPicker from './LocalPathPicker'

export default function AppDialog() {
  const request = useDialog()
  return request ? <Dialog key={request.id} request={request} /> : null
}

function Dialog({ request }: { request: NonNullable<ReturnType<typeof useDialog>> }) {
  const [value, setValue] = useState(request.value ?? '')
  const ref = useRef<HTMLDivElement>(null)
  const finish = (value: string | boolean | null): void => finishDialog(value, request.id)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const root = document.querySelector<HTMLElement>('.app-surface')
    if (root) root.inert = true
    ref.current?.querySelector<HTMLElement>(request.value === undefined ? '[data-cancel]' : 'input')?.focus()
    return () => { if (root) root.inert = false; previous?.focus() }
  }, [request])
  return (
    <div className="app-dialog-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) finish(null) }}>
      <div className="app-dialog" ref={ref} role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-description"
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.stopPropagation(); finish(null) }
          if (e.key === 'Tab') {
            const elements = [...ref.current!.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)')]
            const index = elements.indexOf(document.activeElement as HTMLElement)
            e.preventDefault()
            elements[(index + (e.shiftKey ? -1 : 1) + elements.length) % elements.length]?.focus()
          }
        }}>
        <h2 id="dialog-title">{request.title}</h2>
        <p id="dialog-description">{request.message}</p>
        {request.pathKind ? <LocalPathPicker kind={request.pathKind} defaultName={request.value ?? ''} onFinish={finish} /> : <form onSubmit={(e) => { e.preventDefault(); finish(request.value === undefined ? true : value) }}>
          {request.value !== undefined && <input aria-label={request.message} value={value} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} />}
          <div className="app-dialog-actions">
            <button type="button" data-cancel className="btn-ghost" onClick={() => finish(null)}>取消</button>
            <button type="submit" className={request.danger ? 'btn-danger' : 'btn-primary'}>{request.confirmLabel}</button>
          </div>
        </form>}
      </div>
    </div>
  )
}
