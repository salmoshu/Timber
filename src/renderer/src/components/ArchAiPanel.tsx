// AI 架构绘制面板（架构视图右侧栏，0.6.0）：描述输入 + 生成/取消 + 会话内历史。
// 链路：sidecar 探测 agent CLI（kimi 优先、codex 兜底）产出 archify spec
// → 前端基本校验 → window.timber.archRender 走既有渲染链路 → 主画布 iframe。
import { useRef, useState } from 'react'
import { archAiGenerate, type AiArchResult } from '../api'
import { apiCallFor } from '../store'

export interface AiHistoryItem {
  id: number
  prompt: string
  html?: string
  cli?: string
  error?: string
  ts: number
}

/** sidecar 错误码 → 面板状态文案 */
function aiErrorText(r: AiArchResult): string {
  switch (r.error) {
    case 'no-cli':
      return '未检测到 kimi / codex CLI，请先安装并登录其中一个后重试'
    case 'timeout':
      return r.message ?? '生成超时（180 秒），可简化描述后重试'
    case 'parse':
      return `未能从 AI 输出解析出架构 JSON${r.output ? `：${r.output.slice(0, 120)}` : ''}`
    case 'exec':
      return r.message ?? 'AI CLI 执行失败'
    default:
      return r.message ?? r.error ?? '生成失败'
  }
}

/** spec 里是否有连线文字（触发布局重叠校验的常见来源） */
function hasConnLabels(spec: unknown): boolean {
  const conns = (spec as { connections?: unknown })?.connections
  return (
    Array.isArray(conns) &&
    conns.some((c) => typeof (c as { label?: unknown })?.label === 'string' && (c as { label: string }).label)
  )
}

/** 删除所有 connections 的 label 字段（不可变拷贝，供降级重试） */
function stripConnLabels(spec: unknown): unknown {
  const clone = JSON.parse(JSON.stringify(spec)) as { connections?: Record<string, unknown>[] }
  for (const c of clone.connections ?? []) delete c.label
  return clone
}

function cliName(cli?: string): string {
  return cli === 'codex' ? 'Codex' : 'Kimi'
}

export default function ArchAiPanel(props: {
  projectId: string
  /** 历史列表由父组件持有：切换模式（快照/AI）面板卸载后仍保留（会话内） */
  history: AiHistoryItem[]
  onPush: (item: AiHistoryItem) => void
  onRendered: (html: string, prompt: string) => void
}) {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const push = props.onPush
  const history = props.history

  const generate = async (): Promise<void> => {
    const p = prompt.trim()
    if (!p || busy) return
    const ac = new AbortController()
    abortRef.current = ac
    setBusy(true)
    setStatus('生成中：AI 正在阅读项目代码（通常需要 1~3 分钟）…')
    const id = Date.now()
    try {
      const r = await archAiGenerate(props.projectId, p, ac.signal, apiCallFor(props.projectId))
      if (ac.signal.aborted) return
      if (!r.ok || !r.spec) {
        const msg = aiErrorText(r)
        setStatus(msg)
        push({ id, prompt: p, error: msg, cli: r.cli, ts: id })
        return
      }
      const b = window.timber
      if (!b) {
        setStatus('架构渲染需要 Electron 环境')
        return
      }
      let rr = await b.archRender(JSON.stringify(r.spec), `ai:${props.projectId}:${id}`)
      if (ac.signal.aborted) return
      // 自动布线下连线文字极易与组件重叠：校验失败时剥掉 connections[].label 降级重试一次
      if (!rr.ok && /validation failed/i.test(rr.error ?? '') && hasConnLabels(r.spec)) {
        rr = await b.archRender(JSON.stringify(stripConnLabels(r.spec)), `ai:${props.projectId}:${id}:s`)
        if (ac.signal.aborted) return
      }
      if (!rr.ok || !rr.html) {
        const msg = `AI 产出的 spec 未通过渲染校验：${rr.error ?? 'unknown'}`
        setStatus(msg)
        push({ id, prompt: p, error: msg, cli: r.cli, ts: id })
        return
      }
      props.onRendered(rr.html, p)
      setStatus(`已生成（${cliName(r.cli)}），可调整描述再次生成`)
      push({ id, prompt: p, html: rr.html, cli: r.cli, ts: id })
    } catch (e) {
      if (ac.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
        setStatus('已取消')
      } else {
        const msg = e instanceof Error ? e.message : String(e)
        setStatus(msg)
        push({ id, prompt: p, error: msg, ts: id })
      }
    } finally {
      if (abortRef.current === ac) {
        abortRef.current = null
        setBusy(false)
      }
    }
  }

  const cancel = (): void => {
    abortRef.current?.abort()
  }

  return (
    <div className="av-ai-panel">
      <div className="av-ai-title">AI 绘制</div>
      <textarea
        className="av-ai-input"
        placeholder="描述要绘制的架构，如：画出项目的主要模块与数据流向"
        value={prompt}
        rows={4}
        disabled={busy}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div className="av-ai-actions">
        {busy ? (
          <button className="av-ai-btn" onClick={cancel}>
            取消
          </button>
        ) : (
          <button
            className="av-ai-btn primary"
            disabled={!prompt.trim()}
            onClick={() => void generate()}
          >
            生成
          </button>
        )}
      </div>
      {status && <div className="av-ai-status">{status}</div>}
      {history.length > 0 && (
        <div className="av-ai-history">
          {history.map((h) => (
            <button
              key={h.id}
              className={`av-ai-item${h.error ? ' err' : ''}`}
              disabled={!h.html}
              title={h.error ?? h.prompt}
              onClick={() => h.html && props.onRendered(h.html, h.prompt)}
            >
              <span className="av-ai-item-prompt">{h.prompt}</span>
              <span className="av-ai-item-meta">
                {h.error ? '失败' : cliName(h.cli)} ·{' '}
                {new Date(h.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
