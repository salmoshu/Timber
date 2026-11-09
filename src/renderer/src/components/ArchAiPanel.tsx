// 架构 AI 助手：基于当前画布迭代或问答，成功校验后覆盖当前 spec。
// 后端二选一（v0.6.3）：设置页配置的 OpenAI 兼容接口（优先），
// 或本机 agent CLI（kimi 优先、codex 兜底）产出 archify spec
// → 前端基本校验 → window.timber.archRender 走既有渲染链路 → 主画布 iframe。
import { useEffect, useRef, useState } from 'react'
import type { ArchSpec } from '@shared/types'
import { aiCliStatus, archAiGenerate, type AiArchProgress, type AiArchResult } from '../api'
import { apiCallFor, useStore } from '../store'

interface AiFailure {
  title: string
  detail: string
  hint: string
  output?: string
  showSettings: boolean
}

function apiFailure(r: AiArchResult): AiFailure {
  const detail = r.message ?? '接口未返回具体错误信息'
  const status = Number(/HTTP\s+(\d{3})/i.exec(detail)?.[1] ?? 0)
  let title = 'AI 接口调用失败'
  let hint = '检查 API 地址、密钥和模型名，在设置中测试连接后再重试。'
  if (status === 401 || status === 403) {
    title = 'API 密钥或访问权限验证失败'
    hint = '检查 API Key 是否有效、是否已过期，以及账户是否具备模型访问权限；修改后请先测试连接。'
  } else if (status === 404) {
    title = 'API 地址或模型不可用'
    hint = '确认 Base URL 是否正确（通常以 /v1 结尾），并核对服务商提供的模型名；不要重复拼接 /chat/completions。'
  } else if (status === 400) {
    title = 'AI 服务拒绝了请求'
    hint = '优先核对模型名和 Base URL 是否属于同一服务商，再根据下方接口返回的具体原因修正。'
  } else if (status === 429) {
    title = '请求受限或账户额度不足'
    hint = '稍后重试；如果接口返回配额或余额不足，请处理账户额度或更换可用密钥。'
  } else if (status >= 500) {
    title = 'AI 服务暂时不可用'
    hint = '稍后重试；持续失败时请检查服务商状态，或更换可用的 API 服务。'
  } else if (/dial tcp|connection refused|no such host|timeout|tls|certificate|network/i.test(detail)) {
    title = '无法连接 AI 服务'
    hint = '检查网络、代理和 Base URL；若服务部署在本机，请确认服务已经启动并监听相应端口。'
  }
  return { title, detail, hint, output: r.output, showSettings: true }
}

/** sidecar 错误码 → 可操作的错误卡片；CLI 的 stderr/stdout 不再被丢弃。 */
function aiFailure(r: AiArchResult): AiFailure {
  switch (r.error) {
    case 'no-cli':
      return {
        title: 'AI 尚未配置',
        detail: r.message ?? '未检测到可用的 API 配置或本机 agent CLI',
        hint: '打开 AI 设置填写地址、密钥和模型，或安装并登录 Kimi / Codex CLI 后重试。',
        showSettings: true
      }
    case 'api':
      return apiFailure(r)
    case 'timeout':
      return {
        title: 'AI 生成超时',
        detail: r.message ?? '本次生成超过 180 秒',
        hint: '简化描述、减少需要分析的模块后重试；也可以检查网络或更换响应更快的模型。',
        output: r.output,
        showSettings: true
      }
    case 'parse':
      return {
        title: '无法解析 AI 返回内容',
        detail: r.message ?? 'AI 未返回有效的架构 JSON 或回答',
        hint: '当前画布已保留。请重试，或更换能够稳定按要求输出 JSON 的模型。',
        output: r.output,
        showSettings: true
      }
    case 'exec': {
      const output = r.output?.trim()
      const auth = /login|log in|unauthori[sz]ed|authentication|credential|登录|认证/i.test(output ?? '')
      const command = r.cli === 'codex' ? 'codex login' : 'kimi login'
      return {
        title: auth ? `${cliName(r.cli)} CLI 未登录或登录已过期` : `${cliName(r.cli)} CLI 执行失败`,
        detail: r.message ?? 'CLI 进程异常退出',
        hint: auth
          ? `请在终端运行 ${command} 完成登录，然后回来重试；也可以在 AI 设置中改用 API。`
          : '请根据下方错误详情检查 CLI 登录状态、网络和权限；也可以在 AI 设置中改用 API。',
        output: r.output,
        showSettings: true
      }
    }
    default:
      return {
        title: 'AI 请求失败',
        detail: r.message ?? r.error ?? '未知错误',
        hint: '请根据错误详情修正后重试；当前画布已保留。',
        output: r.output,
        showSettings: true
      }
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

/** 结果回执的后端标签：API 模式显示模型名，CLI 模式显示 agent 名 */
function backendLabel(r: AiArchResult): string {
  if (r.backend === 'api') return r.model ? `API · ${r.model}` : 'API'
  return cliName(r.cli)
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

  // AI 后端就绪状态：设置页 API 配置（三项齐全）或本机 agent CLI（挂载时探测一次）
  const ai = useStore((s) => s.settings.ai)
  const hasApi = !!(ai.baseUrl && ai.apiKey && ai.model)
  const [cliReady, setCliReady] = useState<'kimi' | 'codex' | null | undefined>(undefined)
  useEffect(() => {
    let dead = false
    setCliReady(undefined)
    aiCliStatus(props.projectId, apiCallFor(props.projectId))
      .then((r) => { if (!dead) setCliReady(r.cli === 'kimi' || r.cli === 'codex' ? r.cli : null) })
      .catch(() => { if (!dead) setCliReady(null) })
    return () => { dead = true }
  }, [props.projectId])

  const [failure, setFailure] = useState<AiFailure | null>(null)
  const [steps, setSteps] = useState<Array<AiArchProgress & { key: string }>>([])
  const [stepsOpen, setStepsOpen] = useState(true)
  const appendProgress = (event: AiArchProgress): void => {
    const key = event.toolId || event.stage
    setSteps((current) => {
      const index = current.findIndex((step) => step.key === key)
      if (index < 0) return [...current, { ...event, key }].slice(-40)
      const next = [...current]
      const previous = current[index]
      next[index] = {
        ...previous,
        ...event,
        label: event.label === '工具执行完成' ? previous.label : event.label,
        key
      }
      return next
    })
  }
  const markStepsFailed = (): void => {
    setSteps((current) => current.map((step) => step.status === 'running' ? { ...step, status: 'error' } : step))
  }

  const generate = async (): Promise<void> => {
    const p = prompt.trim()
    if (!p || busy) return
    const ac = new AbortController()
    abortRef.current = ac
    setBusy(true)
    setFailure(null)
    setAnswer(null)
    setSteps([])
    setStepsOpen(true)
    setStatus(action === 'ask' ? '正在阅读当前架构并分析问题…' : '正在基于当前架构调整，通常需要 1～3 分钟…')
    try {
      const context = await props.getContext()
      if (ac.signal.aborted) return
      if (context.sourceError) {
        setStatus(null)
        setFailure({
          title: '当前架构无法用于 AI 对话',
          detail: context.sourceError,
          hint: '先重新生成可用的架构图，或切换到有源码和提交的版本后重试。',
          showSettings: false
        })
        return
      }
      const r = await archAiGenerate(props.projectId, p, ac.signal, apiCallFor(props.projectId), {
        action,
        context,
        ai: hasApi ? ai : undefined,
        onProgress: appendProgress
      })
      if (ac.signal.aborted) return
      if (!r.ok) { setStatus(null); markStepsFailed(); setFailure(aiFailure(r)); return }
      if (action === 'ask') {
        if (!r.answer) {
          setStatus(null)
          setFailure({ title: 'AI 未返回解释', detail: '接口调用完成，但回答内容为空', hint: '请重试或更换模型。', showSettings: true })
          return
        }
        setAnswer(r.answer)
        setStatus(`已回答 · ${backendLabel(r)}`)
        return
      }
      if (!r.spec) {
        setStatus(null)
        setFailure({ title: 'AI 未返回有效架构', detail: '响应中没有可用的架构数据', hint: '当前画布已保留，请重试或更换模型。', showSettings: true })
        return
      }
      const b = window.timber
      if (!b) {
        setStatus(null)
        setFailure({ title: '当前环境无法渲染架构', detail: '架构渲染需要 Electron 环境', hint: '请在 Timber 桌面应用中重试。', showSettings: false })
        return
      }
      // 验证成功之后才覆盖当前架构；渲染中允许取消，失败保留上次成果。
      let spec = r.spec
      let rr = await b.archRender(JSON.stringify(spec), `current:${props.projectId}`)
      if (ac.signal.aborted) return
      if (!rr.ok && /validation failed/i.test(rr.error ?? '') && hasConnLabels(spec)) {
        spec = stripConnLabels(spec) as ArchSpec
        rr = await b.archRender(JSON.stringify(spec), `current:${props.projectId}`)
        if (ac.signal.aborted) return
      }
      if (!rr.ok || !rr.html) {
        setStatus(null)
        setFailure({
          title: '架构未通过渲染校验',
          detail: rr.error ?? '渲染器未返回具体错误信息',
          hint: '当前画布已保留。请简化描述、减少组件和连线后重试。',
          showSettings: false
        })
        return
      }
      props.onRendered(rr.html, spec, p)
      setStatus(`当前架构已更新 · ${backendLabel(r)}`)
    } catch (e) {
      if (!ac.signal.aborted) {
        setStatus(null)
        markStepsFailed()
        setFailure({
          title: '无法完成 AI 请求',
          detail: e instanceof Error ? e.message : String(e),
          hint: hasApi ? '检查本地服务和网络后重试，或在 AI 设置中测试连接。' : '检查本地服务和 CLI 状态后重试。',
          showSettings: hasApi
        })
      }
    } finally {
      if (abortRef.current === ac) { abortRef.current = null; setBusy(false) }
    }
  }
  return (
    <aside className="av-ai-panel" aria-label="架构 AI 助手">
      <div className="av-ai-title">AI 助手</div>
      <p className="av-ai-intro">围绕左侧当前内容，调整架构、优化表达或解释依赖关系。</p>
      {/* 后端就绪提示：两项都不可用时给出可操作的指引（v0.6.3） */}
      {hasApi ? (
        <div className="av-ai-backend api" title="在 设置 → AI 中修改">接口：{ai.model}</div>
      ) : cliReady === 'kimi' || cliReady === 'codex' ? (
        <div className="av-ai-backend cli" title="本机检测到的 agent CLI；配置 设置 → AI 后优先走接口">{cliName(cliReady)} CLI</div>
      ) : cliReady === null ? (
        <div className="av-ai-backend none">
          AI 未配置 —— 在
          <button className="av-ai-link" onClick={() => useStore.getState().openSettings('ai')}>设置 → AI</button>
          填写 API 信息，或安装 kimi / codex CLI
        </div>
      ) : null}
      <div className="seg av-ai-mode">
        <button disabled={busy} className={action === 'edit' ? 'active' : ''} onClick={() => setAction('edit')}>调整架构</button>
        <button disabled={busy} className={action === 'ask' ? 'active' : ''} onClick={() => setAction('ask')}>问答解释</button>
      </div>
      {answer && <div className="av-ai-answer" aria-label="AI 回答">{answer}</div>}
      {steps.length > 0 && (
        <div className="av-ai-steps" data-busy={busy}>
          <button className="av-ai-steps-header" aria-expanded={stepsOpen} onClick={() => setStepsOpen((open) => !open)}>
            <span className={`av-ai-steps-summary ${busy ? 'running' : ''}`}>{busy ? '◌' : '✓'}</span>
            <span>{busy ? '执行过程' : '查看步骤'} · {steps.length}</span>
            <span className={`av-ai-steps-chevron ${stepsOpen ? 'open' : ''}`}>›</span>
          </button>
          {stepsOpen && (
            <div className="av-ai-steps-list">
              {steps.map((step) => (
                <div className="av-ai-step" data-status={step.status ?? 'done'} key={step.key}>
                  <span className="av-ai-step-mark" aria-hidden="true">{step.status === 'running' ? '◌' : step.status === 'error' ? '!' : '✓'}</span>
                  <div className="av-ai-step-content">
                    <div className="av-ai-step-label">{step.label}</div>
                    {step.detail && <pre className="av-ai-step-detail">{step.detail}</pre>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="av-ai-composer">
        <textarea className="av-ai-input" placeholder={action === 'ask' ? '例如：这些模块之间如何传递数据？' : '例如：突出数据流，将存储层分开展示'} value={prompt} rows={5} disabled={busy} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void generate() } }} />
        <div className="av-ai-actions">
          <span>Ctrl + Enter</span>
          {busy ? <button className="av-ai-btn" onClick={() => { abortRef.current?.abort(); setBusy(false); setFailure(null); setStatus('已取消，当前架构已保留') }}>取消</button> : <button className="av-ai-btn primary" disabled={!prompt.trim()} onClick={() => void generate()}>{action === 'ask' ? '提问' : '更新架构'}</button>}
        </div>
      </div>
      {failure && (
        <div className="av-ai-error" role="alert">
          <strong>{failure.title}</strong>
          <div className="av-ai-error-detail">{failure.detail}</div>
          <p className="av-ai-error-hint">{failure.hint}</p>
          {failure.output && <pre className="av-ai-error-output">{failure.output}</pre>}
          <div className="av-ai-error-actions">
            {failure.showSettings && <button className="av-ai-btn" onClick={() => useStore.getState().openSettings('ai')}>打开 AI 设置</button>}
            <button className="av-ai-btn primary" onClick={() => void generate()}>重试</button>
          </div>
        </div>
      )}
      {status && <div className="av-ai-status" role="status">{status}</div>}
      <p className="av-ai-footnote">成功更新后覆盖当前架构，重新打开项目仍可继续迭代。</p>
    </aside>
  )
}
