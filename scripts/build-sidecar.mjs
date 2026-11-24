// Go sidecar 构建脚本（幂等）：优先使用项目内便携工具链 .toolchain/go，其次系统 PATH 中的 go。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'sidecar', 'bin')
const windows = process.platform === 'win32'

function findGo() {
  const local = join(root, '.toolchain', 'go', 'bin', windows ? 'go.exe' : 'go')
  if (existsSync(local)) return local
  try {
    execFileSync('go', ['version'], { stdio: 'pipe' })
    return 'go'
  } catch {
    return null
  }
}

const go = findGo()
if (!go) {
  throw new Error('[build-sidecar] 未找到 Go 工具链')
}

mkdirSync(outDir, { recursive: true })

// 本地服务和 WSL/SSH 使用的 Linux 部署包。
const goos = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform]
const goarch = { x64: 'amd64', arm64: 'arm64' }[process.arch]
if (!goos || !goarch) throw new Error(`Unsupported sidecar target: ${process.platform}/${process.arch}`)
const targets = [
  { out: windows ? 'timberd.exe' : 'timberd', env: { GOOS: goos, GOARCH: goarch } },
  { out: 'timberd-linux-amd64', env: { GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' } },
  { out: 'timberd-linux-arm64', env: { GOOS: 'linux', GOARCH: 'arm64', CGO_ENABLED: '0' } }
]

for (const t of targets) {
  console.log(`[build-sidecar] go build → sidecar/bin/${t.out}`)
  execFileSync(go, ['build', '-o', join(outDir, t.out), '.'], {
    cwd: join(root, 'sidecar'),
    stdio: 'inherit',
    env: { ...process.env, GOTOOLCHAIN: 'local', CGO_ENABLED: '0', ...t.env }
  })
}
console.log('[build-sidecar] 完成')
