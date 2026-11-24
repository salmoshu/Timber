import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const outputDir = resolve(root, 'sidecar/bin')
const output = resolve(outputDir, 'lsp/typescript-language-server.mjs')
await mkdir(outputDir, { recursive: true })
await build({
  entryPoints: [resolve(root, 'node_modules/typescript-language-server/lib/cli.mjs')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['typescript', 'typescript/*'],
  logLevel: 'warning'
})
await rm(resolve(outputDir, 'node_modules/typescript'), { recursive: true, force: true })
await cp(resolve(root, 'node_modules/typescript'), resolve(outputDir, 'node_modules/typescript'), { recursive: true, dereference: true })
await cp(resolve(root, 'node_modules/typescript-language-server/package.json'), resolve(outputDir, 'package.json'))
const info = await stat(output)
console.log(`TypeScript language server bundled: ${output} (${(info.size / 1024 / 1024).toFixed(1)} MB)`)

// Both archives include the clang resource headers and LLVM license.
const mac = process.platform === 'darwin'
const clangdPlatform = mac ? 'mac' : 'windows'
const clangdVersion = '22.1.6'
const clangdHash = mac ? '631aef462556cbd74e0ebaae1778a38d1997d0ba3371652ca54f82652a179e7d'
  : 'ce54f16e0b4fd76d450eeda9664420b195360b73febcfe40e661108fa57f2ce1'
const clangdAsset = `https://api.github.com/repos/clangd/clangd/releases/assets/${mac ? 432538229 : 432519407}`
const clangdRelease = `https://github.com/clangd/clangd/releases/download/${clangdVersion}/clangd-${clangdPlatform}-${clangdVersion}.zip`
const clangdDir = resolve(outputDir, 'clangd')
const clangdFiles = [mac ? 'bin/clangd' : 'bin/clangd.exe', 'lib/clang/22/include/stddef.h', 'LICENSE.TXT']

async function clangdInstalled() {
  try {
    const version = await readFile(resolve(clangdDir, '.timber-version'), 'utf8')
    return version === clangdVersion && (await Promise.all(clangdFiles.map((file) => stat(resolve(clangdDir, file))))).every((file) => file.isFile())
  } catch {
    return false
  }
}

async function downloadClangd(archive) {
  const errors = []
  // Use the Windows HTTP stack so the build honors system proxy settings.
  const download = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -UseBasicParsing -Uri $env:TIMBER_CLANGD_DOWNLOAD_URL -Headers @{ Accept = 'application/octet-stream' } -OutFile $env:TIMBER_CLANGD_DOWNLOAD_FILE -TimeoutSec 45
  `
  for (const url of [clangdRelease, clangdAsset]) {
    try {
      if (mac) {
        execFileSync('curl', ['-fsSL', '--retry', '2', '--max-time', '120', '-H', 'Accept: application/octet-stream', '-o', archive, url])
      } else {
        execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', download], {
          env: { ...process.env, TIMBER_CLANGD_DOWNLOAD_URL: url, TIMBER_CLANGD_DOWNLOAD_FILE: archive },
          timeout: 60_000,
          windowsHide: true
        })
      }
      const digest = createHash('sha256').update(await readFile(archive)).digest('hex')
      if (digest !== clangdHash) throw new Error('SHA-256 mismatch')
      return
    } catch (error) {
      errors.push(`${url}: ${error.message}`)
    }
  }
  throw new Error(`Could not download clangd ${clangdVersion}:\n${errors.join('\n')}`)
}

if ((process.platform === 'win32' || mac) && !await clangdInstalled()) {
  const toolchain = resolve(root, '.toolchain')
  await mkdir(toolchain, { recursive: true })
  const staging = await mkdtemp(resolve(toolchain, 'clangd-'))
  try {
    const archive = resolve(staging, 'clangd.zip')
    await downloadClangd(archive)
    if (mac) {
      execFileSync('/usr/bin/ditto', ['-x', '-k', archive, staging])
    } else {
      const tar = resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      execFileSync(tar, ['-xf', archive, '-C', staging], { stdio: 'inherit' })
    }
    const extracted = resolve(staging, `clangd_${clangdVersion}`)
    await Promise.all(clangdFiles.map((file) => stat(resolve(extracted, file))))
    await writeFile(resolve(extracted, '.timber-version'), clangdVersion)
    if (!await clangdInstalled()) {
      await rm(clangdDir, { recursive: true, force: true })
      try {
        await rename(extracted, clangdDir)
      } catch (error) {
        if (!await clangdInstalled()) throw error
      }
    }
    console.log(`clangd ${clangdVersion} bundled: ${clangdDir}`)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
