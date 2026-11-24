import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'vendor/archify/bin/archify.mjs')

function fixture(overrides = {}) {
  return {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: { title: 'Boundary regression', quality_profile: 'showcase', output: 'architecture.html' },
    components: [{ id: 'api', type: 'backend', label: 'API', pos: [40, 28], size: [120, 60] }],
    boundaries: [{ kind: 'region', label: 'src', wraps: ['api'] }],
    connections: [],
    ...overrides,
  }
}

function invoke(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
}

function temporarySpec(t, spec) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'timber-architecture-'))
  const input = path.join(directory, 'input.json')
  fs.writeFileSync(input, JSON.stringify(spec))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return { directory, input }
}

function validate(input) {
  const result = invoke(['validate', 'architecture', input, '--layout-json', '--json'])
  return { ...result, report: JSON.parse(result.stdout) }
}

test('automatic canvas repairs the reported two-pixel boundary overflow', (t) => {
  const { directory, input } = temporarySpec(t, fixture())
  const rendered = invoke(['render', 'architecture', input, path.join(directory, 'output.html')])
  assert.equal(rendered.status, 0, rendered.stderr)
  const { report, stdout, status } = validate(input)
  assert.equal(status, 0, stdout)
  assert.equal(report.ok, true)
  assert.equal(report.components[0].y, 40)
  assert.equal(report.boundaries[0].y, 10)
  assert.ok(report.boundaries.every((boundary) => boundary.y >= 0))
})

test('grid origins receive the same automatic inset without changing membership', (t) => {
  const { input } = temporarySpec(t, fixture({
    layout: { mode: 'grid', origin: [40, 28], cols: 1 },
    components: [{ id: 'api', type: 'backend', label: 'API', row: 0, col: 0 }],
  }))
  const { report, status, stdout } = validate(input)
  assert.equal(status, 0, stdout)
  assert.deepEqual(report.boundaries[0].wraps, ['api'])
  assert.equal(report.components[0].y, 40)
  assert.equal(report.boundaries[0].y, 10)
})

test('authored via coordinates translate with their components', (t) => {
  const spec = fixture({
    components: [
      { id: 'api', type: 'backend', label: 'API', pos: [40, 28], size: [120, 60] },
      { id: 'db', type: 'database', label: 'DB', pos: [220, 128], size: [120, 60] },
    ],
    boundaries: [{ kind: 'region', label: 'src', wraps: ['api', 'db'] }],
    connections: [{ from: 'api', to: 'db', via: [[130, 48], [130, 108]] }],
  })
  const { input } = temporarySpec(t, spec)
  const { report, status, stdout } = validate(input)
  assert.equal(status, 0, stdout)
  assert.deepEqual(report.components.map((component) => component.y), [40, 140])
  assert.deepEqual(report.connections[0].points.slice(1, 3), [[130, 60], [130, 120]])
})

test('overlapping boundary title rails cannot push an automatic canvas above zero', (t) => {
  const spec = fixture({
    components: [
      { id: 'api', type: 'backend', label: 'API', pos: [40, 40], size: [120, 60] },
      { id: 'db', type: 'database', label: 'DB', pos: [250, 40], size: [120, 60] },
    ],
    boundaries: [
      { kind: 'region', label: 'include', wraps: ['api'] },
      { kind: 'region', label: 'src', wraps: ['api', 'db'] },
    ],
  })
  const { input } = temporarySpec(t, spec)
  const { report, status, stdout } = validate(input)
  assert.equal(status, 0, stdout)
  assert.ok(report.boundaries.every((boundary) => boundary.y >= 0))
  assert.deepEqual(report.components.map((component) => component.pos), [[40, 42], [250, 42]])
})

test('an authored viewBox keeps its strict top-boundary validation', (t) => {
  const spec = fixture()
  spec.meta.viewBox = [400, 240]
  const { input } = temporarySpec(t, spec)
  const { report, status } = validate(input)
  assert.notEqual(status, 0)
  assert.equal(report.ok, false)
  assert.equal(report.diagnostics[0].code, 'layout/boundary-out-of-bounds')
  assert.equal(report.diagnostics[0].evidence.overflow.top, 2)
})
