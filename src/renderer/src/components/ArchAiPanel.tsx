// 固定架构助手：基于当前画布迭代或问答，成功校验后覆盖当前 spec。
// 链路：sidecar 探测 agent CLI（kimi 优先、codex 兜底）产出 archify spec
// → 前端基本校验 → window.timber.archRender 走既有渲染链路 → 主画布 iframe。
import { useEffect, useRef, useState } from 'react'
import type { ArchSpec } from '@shared/types'
import { archAiGenerate, type AiArchResult } from '../api'
import { apiCallFor } from '../store'

/** sidecar 错误码 → 面板状态文案 */
function aiErrorText(r: AiArchResult): string {
  switch (r.error) {
    case 'no-cli':
      return '未检测到 kimi / codex CLI，请先安装并登录其中一个后重试'
    case 'timeout':
      return r.message ?? '生成超时（180 秒），可简化描述后重试'
    case 'parse':
      return r.message ?? `未能解析 AI 输出${r.output ? `：${r.output.slice(0, 120)}` : ''}`
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

export interface ArchAiContext {
  spec?: ArchSpec
  mode: string
  ref: string
  baseSpec?: ArchSpec
  baseRef?: string
  sourceError?: string
}

export default function ArchAiPanel(props: {
  projectId: string
  getContext: () => Promise<ArchAiContext>
  onRendered: (html: string, spec: ArchSpec, prompt: string) => void
}) {
  const [prompt, setPrompt] = useState('')
  const [action, setAction] = useState<'edit' | 'ask'>('edit')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [answer, setAnswer] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => () => { abortRef.current?.abort() }, [])

  const generate = async (): Promise<void> => {
    const p = prompt.trim()
    if (!p || busy) return
    const ac = new AbortController()
    abortRef.current = ac
    setBusy(true)
    setStatus(action === 'ask' ? '正在阅读当前架构并分析问题…' : '正在基于当前架构调整，通常需要 1～3 分钟…')
    try {
      const context = await props.getContext()
      if (ac.signal.aborted) return
      const r = await archAiGenerate(props.projectId, p, ac.signal, apiCallFor(props.projectId), { action, context })
      if (ac.signal.aborted) return
      if (!r.ok) { setStatus(aiErrorText(r)); return }
      if (action === 'ask') {
        if (!r.answer) { setStatus('AI 未返回解释，请重试'); return }
        setAnswer(r.answer)
        setStatus(`已回答 · ${cliName(r.cli)}`)
        return
      }
      if (!r.spec) { setStatus('AI 未返回有效架构，当前画布已保留'); return }
      const b = window.timber
      if (!b) { setStatus('架构渲染需要 Electron 环境'); return }
      // 验证成功之后才覆盖当前架构；渲染中允许取消，失败保留上次成果。
      let spec = r.spec
      let rr = await b.archRender(JSON.stringify(spec), `current:${props.projectId}`)
      if (ac.signal.aborted) return
      if (!rr.ok && /validation failed/i.test(rr.error ?? '') && hasConnLabels(spec)) {
        spec = stripConnLabels(spec) as ArchSpec
        rr = await b.archRender(JSON.stringify(spec), `current:${props.projectId}`)
        if (ac.signal.aborted) return
      }
      if (!rr.ok || !rr.html) { setStatus(`架构未通过渲染校验：${rr.error ?? 'unknown'}。当前画布已保留`); return }
      props.onRendered(rr.html, spec, p)
      setStatus(`当前架构已更新 · ${cliName(r.cli)}`)
    } catch (e) {
      if (!ac.signal.aborted) setStatus(e instanceof Error ? e.message : String(e))
    } finally {
      if (abortRef.current === ac) { abortRef.current = null; setBusy(false) }
    }
  }
  return (
    <aside className="av-ai-panel" aria-label="架构 AI 助手">
      <div className="av-ai-title">AI 助手</div>
      <p className="av-ai-intro">围绕左侧当前内容，调整架构、优化表达或解释依赖关系。</p>
      <div className="seg av-ai-mode">
        <button disabled={busy} className={action === 'edit' ? 'active' : ''} onClick={() => setAction('edit')}>调整架构</button>
        <button disabled={busy} className={action === 'ask' ? 'active' : ''} onClick={() => setAction('ask')}>问答解释</button>
      </div>
      {answer && <div className="av-ai-answer" aria-label="AI 回答">{answer}</div>}
      <div className="av-ai-composer">
        <textarea className="av-ai-input" placeholder={action === 'ask' ? '例如：这些模块之间如何传递数据？' : '例如：突出数据流，将存储层分开展示'} value={prompt} rows={5} disabled={busy} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void generate() } }} />
        <div className="av-ai-actions">
          <span>Ctrl + Enter</span>
          {busy ? <button className="av-ai-btn" onClick={() => { abortRef.current?.abort(); setBusy(false); setStatus('已取消，当前架构已保留') }}>取消</button> : <button className="av-ai-btn primary" disabled={!prompt.trim()} onClick={() => void generate()}>{action === 'ask' ? '提问' : '更新架构'}</button>}
        </div>
      </div>
      {status && <div className="av-ai-status" role="status">{status}</div>}
      <p className="av-ai-footnote">成功更新后覆盖当前架构，重新打开项目仍可继续迭代。</p>
    </aside>
  )
}
