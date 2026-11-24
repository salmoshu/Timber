import { agentEffortChoices, type ArchAgentBackend, type ArchAgentOptions } from '../utils/archAgentOptions'

export default function AgentOptionFields({ agent, options, apiModel, modelLabel = '模型', onChange }:
  {
    agent: ArchAgentBackend
    options: ArchAgentOptions
    apiModel?: string
    modelLabel?: string
    onChange: (patch: Partial<ArchAgentOptions>) => void
  }) {
  return (
    <div className="ai-option-fields">
      <label className="ai-option-model">
        <span>{modelLabel}</span>
        <input
          aria-label={modelLabel} value={options.model} spellCheck={false} autoComplete="off"
          placeholder={agent === 'api' ? apiModel : '跟随 CLI 默认模型'}
          onChange={(event) => onChange({ model: event.target.value })}
        />
      </label>
      {agent !== 'api' && (
        <label>
          <span>思考强度</span>
          <select aria-label="思考强度" value={options.effort} onChange={(event) => onChange({ effort: event.target.value })}>
            {agentEffortChoices(agent).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
      )}
      {agent === 'codex' && (
        <>
          <label>
            <span>速度</span>
            <select aria-label="速度" value={options.speed} onChange={(event) => onChange({ speed: event.target.value as ArchAgentOptions['speed'] })}>
              <option value="default">跟随 CLI</option>
              <option value="priority">优先</option>
            </select>
          </label>
          <label>
            <span>权限</span>
            <select aria-label="权限" value={options.permission} onChange={(event) => onChange({ permission: event.target.value as ArchAgentOptions['permission'] })}>
              <option value="read-only">只读</option>
              <option value="workspace-write">工作区可写</option>
              <option value="danger-full-access">完全访问</option>
            </select>
          </label>
        </>
      )}
    </div>
  )
}
