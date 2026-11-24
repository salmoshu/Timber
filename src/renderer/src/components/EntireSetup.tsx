import { useEffect, useRef, useState } from 'react'
import type { EntireSetupStatus } from '@shared/types'
import { entireEnable, entireStatus } from '../api'
import { apiCallFor } from '../store'
import { IconClose, IconSettings } from './icons'
import './HistoryWorkspace.css'

const installGuide = 'https://docs.entire.com/installation'

function statusLabel(status: EntireSetupStatus): string {
  if (!status.repo) return '需要 Git 仓库'
  if (!status.cli) return '未找到 Entire CLI'
  if (status.probeError) return '配置状态不可用'
  if (status.enabled) return '已启用'
  return status.configured ? '已停用' : '未启用'
}

function EntireSetupDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [status, setStatus] = useState<EntireSetupStatus | null>(null)
  const [probe, setProbe] = useState(0)
  const [checking, setChecking] = useState(true)
  const [enabling, setEnabling] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => { element?.close() }
  }, [])

  useEffect(() => {
    const request = new AbortController()
    setChecking(true)
    void entireStatus(projectId, apiCallFor(projectId), request.signal).then((result) => {
      if (!request.signal.aborted) setStatus(result)
    }).catch((err: Error) => {
      if (!request.signal.aborted) setError(err.message)
    }).finally(() => {
      if (!request.signal.aborted) setChecking(false)
    })
    return () => request.abort()
  }, [projectId, probe])

  const hasCodex = status?.agents.some((agent) => agent.toLowerCase() === 'codex') ?? false
  const canEnable = status?.repo && status.cli && status.codexAvailable && !status.probeError && (!status.enabled || !hasCodex)
  const busy = checking || enabling

  async function enable(): Promise<void> {
    setEnabling(true)
    setError('')
    try {
      setStatus(await entireEnable(projectId, apiCallFor(projectId)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setProbe((count) => count + 1)
    } finally {
      setEnabling(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      className="entire-setup-dialog"
      aria-labelledby="entire-setup-heading"
      onCancel={(event) => { event.preventDefault(); onClose() }}
    >
      <div className="entire-setup-head">
        <h2 id="entire-setup-heading">配置 Entire</h2>
        <button type="button" className="history-icon" aria-label="关闭 Entire 配置" onClick={onClose}><IconClose /></button>
      </div>
      <div className="entire-setup-body" aria-busy={busy}>
        {busy && (
          <div className="history-progress" role="progressbar" aria-label={enabling ? '正在安装项目钩子' : '正在检查 Entire'}><span /></div>
        )}
        {!status && checking && <p role="status">正在检查项目环境…</p>}
        {status && (
          <>
            <div className="entire-setup-state" role="status">
              <strong>{statusLabel(status)}</strong>
              {status.version && <span>Entire CLI {status.version}</span>}
            </div>
            <code className="entire-setup-path">{status.root}</code>
            {!!status.checkpoints && <p>本地有 {status.checkpoints} 个 checkpoint，可在「历史 → AI 会话」查看。</p>}
            {status.probeError && <p className="entire-error" role="alert">{status.probeError}</p>}
            {status.repo && !status.cli && (
              <p>请在项目所在的系统安装 Entire CLI，再检查状态。 <a href={installGuide} target="_blank" rel="noreferrer">安装指南</a></p>
            )}
            {status.cli && !status.codexAvailable && !hasCodex && <p>此环境需要安装 Codex CLI 才能接入 Codex。</p>}
            {canEnable && <p>{status.enabled
              ? '为当前仓库添加 Codex 钩子。'
              : '为当前仓库安装 Codex 和 Git 钩子，会话记录默认保存在本机。'}</p>}
            {status.enabled && (
              <p>{status.agents.length > 0 && `已接入 ${status.agents.join('、')}。`}
                {status.pushDisabled ? '会话自动上传已关闭。' : '会话上传由项目的 Entire 配置决定。'}
              </p>
            )}
            {status.enabled && hasCodex && (
              <p>{status.codexNeedsApproval
                ? '请在 Codex 的 /hooks 中审核 Entire 钩子，再开始新会话。'
                : '新开一个 Codex 会话并提交它的文件改动，即可在历史中查看关联会话。'}</p>
            )}
            {status.codexHookWarning && <p className="entire-error">{status.codexHookWarning}</p>}
          </>
        )}
        {error && <p className="entire-error" role="alert">{error}</p>}
      </div>
      <div className="entire-setup-actions">
        <button type="button" className="btn-ghost sm" disabled={busy} onClick={() => { setError(''); setProbe((count) => count + 1) }}>检查状态</button>
        {canEnable && (
          <button type="button" className="btn-primary sm" disabled={busy} onClick={() => void enable()}>
            {enabling ? '正在配置…' : status.enabled ? '接入 Codex' : '启用 Entire'}
          </button>
        )}
      </div>
    </dialog>
  )
}

export default function EntireSetupButton({ projectId }: { projectId: string }) {
  const [openedProject, setOpenedProject] = useState<string | null>(null)
  return (
    <>
      <button type="button" className="btn-ghost sm entire-setup-trigger" onClick={() => setOpenedProject(projectId)}>
        <IconSettings size={13} /> 配置 Entire
      </button>
      {openedProject === projectId && <EntireSetupDialog projectId={projectId} onClose={() => setOpenedProject(null)} />}
    </>
  )
}
