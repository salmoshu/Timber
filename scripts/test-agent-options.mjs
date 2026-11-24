import assert from 'node:assert/strict'
import test from 'node:test'
import { archRuntimeOptionsForAgent, loadArchAgentPreferences } from '../src/renderer/src/utils/archAgentOptions.ts'

const options = {
  agent: 'auto',
  model: '  custom-model  ',
  effort: 'high',
  speed: 'priority',
  permission: 'workspace-write',
}

test('Codex receives its saved runtime options', () => {
  assert.deepEqual(archRuntimeOptionsForAgent(options, 'codex'), {
    model: 'custom-model', effort: 'high', speed: 'priority', permission: 'workspace-write',
  })
})

test('Kimi and API never receive unsupported Codex speed or permission options', () => {
  assert.deepEqual(archRuntimeOptionsForAgent(options, 'kimi'), {
    model: 'custom-model', effort: 'high', speed: 'default', permission: 'auto',
  })
  assert.deepEqual(archRuntimeOptionsForAgent(options, 'api'), {
    model: 'custom-model', effort: '', speed: 'default', permission: 'default',
  })
})

test('Legacy Kimi selection preserves its model and migrates separate Codex runtime defaults', (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const saved = { ...options, agent: 'kimi', effort: 'max' }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key) => key === 'timber-arch-agent-options-v1' ? JSON.stringify(saved) : null }
  })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else delete globalThis.localStorage
  })
  const prefs = loadArchAgentPreferences()
  assert.equal(prefs.agent, 'kimi')
  assert.equal(prefs.providers.kimi.model.trim(), 'custom-model')
  assert.equal(prefs.providers.kimi.effort, 'max')
  assert.equal(prefs.providers.codex.model, '')
  assert.equal(prefs.providers.codex.effort, '')
  assert.equal(prefs.providers.codex.speed, 'priority')
  assert.equal(prefs.providers.codex.permission, 'workspace-write')
})
