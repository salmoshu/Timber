// Entire AI 会话卡片：提交详情与搜索结果内联共用。
// 数据存于本仓库 git 对象（refs/entire/checkpoints/*），只读展示，不依赖 entire 二进制；
// commit 有 trailer 但 ref 未同步（clone 默认不带）时提供「同步」按钮。
import { useEffect, useState } from 'react'
import type {
  EntireCheckpointDetail,
  EntireSessionInfo,
  EntireTranscriptLine,
  EntireTokenUsage
} from '@shared/types'
import { entireCheckpoint, entireSync, entireTranscript } from '../api'
import { apiCallFor, useStore } from '../store'

interface Props {
  projectId: string
  checkpointId: string
  /** 初始即展开（搜索结果内联时） */
  defaultOpen?: boolean
  sessionIndex?: number
}

type CardState =
  | { st: 'loading' }
  | { st: 'ok'; data: EntireCheckpointDetail }
  | { st: 'not-synced' }
  | { st: 'error'; msg: string }

/** token 数缩写：1234 → 1.2k */
function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** token 用量一行：in/out/cache/API 次数 */
function TokenLine({ usage }: { usage: EntireTokenUsage }) {
  return (
    <span className="ec-tokens">
      token in {fmtTokens(usage.inputTokens)} · out {fmtTokens(usage.outputTokens)}
      {usage.cacheReadTokens > 0 && ` · cache ${fmtTokens(usage.cacheReadTokens)}`}
      {usage.apiCallCount > 0 && ` · API ×${usage.apiCallCount}`}
    </span>
  )
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function transcriptMessage(line: EntireTranscriptLine) {
  const root = objectRecord(line) ?? {}
  const payload = root.type === 'response_item' ? objectRecord(root.payload) : undefined
  const record = payload ?? objectRecord(root.message) ?? root
  const role = record.role ?? root.type
  const contents = Array.isArray(record.content) ? record.content.map(objectRecord) : []
  const text = role === 'user' || role === 'assistant'
    ? typeof record.content === 'string'
      ? record.content
      : contents.flatMap((block) => typeof block?.text === 'string' && ['text', 'input_text', 'output_text'].includes(String(block.type ?? 'text')) ? [block.text] : []).join('\n')
    : ''
  const tools = [record, ...contents].flatMap((block) => {
    if (typeof block?.name !== 'string' || !['tool_use', 'tool_call', 'function_call', 'custom_tool_call'].includes(String(block.type))) return []
    return [block.name]
  })
  return { role: role === 'user' ? '用户' : 'AI', text, tools }
}

/** 单条 transcript 消息 */
function TranscriptMsg({ line }: { line: EntireTranscriptLine }) {
  const { role, text, tools } = transcriptMessage(line)
  if (!text && tools.length === 0) return null
  return (
    <div className={`ec-msg ${role === '用户' ? 'ec-msg-user' : ''}`}>
      {text && <>
        <div className="ec-msg-role">{role}</div>
        <div className="ec-msg-text">{text}</div>
      </>}
      {!!tools.length && <div className="ec-tool-events">{tools.map((tool, index) => <code key={index}>{tool}</code>)}</div>}
    </div>
  )
}

/** 单个会话块：元信息 + prompt + files + 按需加载的完整对话 */
function SessionBlock({
  projectId,
  checkpointId,
  session
}: {
  projectId: string
  checkpointId: string
  session: EntireSessionInfo
}) {
  const toast = useStore((s) => s.toast)
  const [showTranscript, setShowTranscript] = useState(false)
  const [lines, setLines] = useState<EntireTranscriptLine[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)

  const toggle = async (): Promise<void> => {
    if (showTranscript) {
      setShowTranscript(false)
      return
    }
    setShowTranscript(true)
    if (lines !== null) return
    setLoading(true)
    try {
      const r = await entireTranscript(projectId, checkpointId, session.index, apiCallFor(projectId))
      if (r.ok) {
        setLines(r.lines)
        setTruncated(r.truncated)
      } else {
        toast('err', `会话记录读取失败：${r.error}`)
        setShowTranscript(false)
      }
    } catch (e) {
      toast('err', `会话记录读取失败：${e}`)
      setShowTranscript(false)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="ec-session">
      <div className="ec-meta">
        {session.agent && <span className="ec-badge">{session.agent}</span>}
        {session.model && <span className="ec-badge ec-badge-model">{session.model}</span>}
        {session.createdAt && <span>{fmtTime(session.createdAt)}</span>}
        {session.turnCount > 0 && <span>{session.turnCount} 轮</span>}
        {session.tokenUsage && <TokenLine usage={session.tokenUsage} />}
      </div>
      {session.prompt && <pre className="ec-prompt">{session.prompt}</pre>}
      {session.filesTouched.length > 0 && (
        <div className="ec-files">
          {session.filesTouched.map((f) => (
            <span key={f} className="ec-file">{f}</span>
          ))}
        </div>
      )}
      <button className="ec-transcript-btn" onClick={() => void toggle()}>
        {showTranscript ? '收起对话 ▴' : '查看对话 ▾'}
      </button>
      {showTranscript && (
        <div className="ec-transcript">
          {loading && <div className="hv-loading">对话加载中…</div>}
          {!loading && lines && !lines.some((line) => {
            const message = transcriptMessage(line)
            return message.text || message.tools.length
          }) && <div className="ai-none">无可显示的会话消息</div>}
          {!loading && lines?.map((ln, i) => <TranscriptMsg key={i} line={ln} />)}
          {truncated && <div className="ec-truncated">对话过长，仅显示前 200KB</div>}
        </div>
      )}
    </div>
  )
}

export default function EntireCard({ projectId, checkpointId, defaultOpen, sessionIndex }: Props) {
  const toast = useStore((s) => s.toast)
  const [open, setOpen] = useState(defaultOpen ?? false)
  const [state, setState] = useState<CardState | null>(null)
  const [syncing, setSyncing] = useState(false)
  const sessions = state?.st === 'ok'
    ? state.data.sessions.filter((session) => sessionIndex === undefined || session.index === sessionIndex)
    : []

  const load = async (): Promise<void> => {
    setState({ st: 'loading' })
    try {
      const r = await entireCheckpoint(projectId, checkpointId, apiCallFor(projectId))
      if (r.ok) setState({ st: 'ok', data: r })
      else if (r.error === 'not-synced') setState({ st: 'not-synced' })
      else setState({ st: 'error', msg: r.error })
    } catch (e) {
      setState({ st: 'error', msg: String(e) })
    }
  }

  // 展开时懒加载（仅首次）
  useEffect(() => {
    if (open && state === null) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const doSync = async (): Promise<void> => {
    setSyncing(true)
    try {
      const r = await entireSync(projectId, apiCallFor(projectId))
      if (r.ok) {
        toast('ok', `已同步 ${r.synced} 个 AI 会话 checkpoint`)
        await load()
      } else if (r.error === 'no-remote') {
        toast('err', '该仓库没有配置远端，无法同步会话数据')
      } else {
        toast('err', `同步失败：${r.detail ?? r.error}`)
      }
    } catch (e) {
      toast('err', `同步失败：${e}`)
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="entire-card">
      <button className="ec-head" onClick={() => setOpen(!open)}>
        <span className="ec-spark">✨</span>
        <span className="ec-title">AI 会话</span>
        <span className="ec-id">{checkpointId.slice(0, 8)}</span>
        {sessions[0]?.agent && (
          <span className="ec-head-meta">{sessions[0].agent}</span>
        )}
        <span className="ec-chevron">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="ec-body">
          {(!state || state.st === 'loading') && <div className="hv-loading">会话加载中…</div>}
          {state?.st === 'not-synced' && (
            <div className="ec-notsynced">
              <span>会话数据未同步到本地（clone 默认不含 checkpoint refs）</span>
              <button className="ec-sync-btn" disabled={syncing} onClick={() => void doSync()}>
                {syncing ? '同步中…' : '同步'}
              </button>
            </div>
          )}
          {state?.st === 'error' && <div className="ai-none">会话数据读取失败：{state.msg}</div>}
          {state?.st === 'ok' && (
            <>
            {sessions.map((sess) => (
              <SessionBlock
                key={sess.index}
                projectId={projectId}
                checkpointId={checkpointId}
                session={sess}
              />
            ))}
            {sessions.length === 0 && <div className="ai-none">checkpoint 内无会话</div>}
            </>
          )}
          <div className="ec-privacy">
            AI 会话保存在 Git checkpoint 中，上传到公开仓库的记录可被读取。
          </div>
        </div>
      )}
    </div>
  )
}
