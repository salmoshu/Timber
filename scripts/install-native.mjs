// pnpm skips Electron's dependency lifecycle. Run its installer explicitly.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
execFileSync(process.execPath, [require.resolve('electron/install.js')], { stdio: 'inherit' })
