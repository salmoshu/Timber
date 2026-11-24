// 打包入口：sidecar 构建 → 渲染层构建 → 版本标记校验 → electron-builder。
// 自包含设计（v0.2.2/v0.2.3 事故教训：绕过 vite build 直接打包，把陈旧 out/ 流出）：
//   1. 本脚本自己执行完整构建，不存在"忘记 build"的路径；
//   2. 构建后校验最新 bundle 含当前版本号标记（__APP_VERSION__），陈旧产物直接中止。
// 用法：node scripts/run-electron-builder.cjs [--publish]   （OUTPUT_DIR 环境变量可改输出目录）
const { spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { dirname, join } = require('node:path')

function run(args) {
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`[dist] 失败：node ${args.join(' ')}`)
    if (r.error) console.error(r.error)
    process.exit(1)
  }
}

function verifyBuildStamp() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf-8'))
  const rendererDir = 'out/renderer'
  const html = readFileSync(join(rendererDir, 'index.html'), 'utf-8')
  const entryTag = (html.match(/<script\b[^>]*>/g) ?? [])
    .find((tag) => /\btype=["']module["']/.test(tag))
  const entrySrc = entryTag?.match(/\bsrc=["']([^"']+)["']/)?.[1]
  if (!entrySrc) {
    console.error('[dist] 校验失败：out/renderer/index.html 没有应用入口脚本')
    process.exit(1)
  }
  // 解析器等独立资源不带应用版本；校验 HTML 实际引用的入口，不能按修改时间选 JS。
  const entryFile = entrySrc.replace(/^(?:\.\/|\/)/, '')
  const content = readFileSync(join(rendererDir, entryFile), 'utf-8')
  if (!content.includes(pkg.version)) {
    console.error(
      `[dist] 校验失败：渲染层 bundle（${entryFile}）不含当前版本号 ${pkg.version}，` +
        '疑似陈旧构建产物，拒绝打包。请先执行 pnpm run build 排查。'
    )
    process.exit(1)
  }
  console.log(`[dist] 版本标记校验通过：${entryFile} 含 ${pkg.version}`)
}

if (process.platform !== 'win32' && process.platform !== 'darwin') {
  throw new Error('Timber installers are built on Windows and macOS hosts')
}
run(['scripts/build-sidecar.mjs'])
run(['scripts/build-code-tools.mjs'])
const vitePackage = require.resolve('electron-vite/package.json')
const viteCli = join(dirname(vitePackage), require(vitePackage).bin['electron-vite'])
run(['--max-old-space-size=4096', viteCli, 'build'])
verifyBuildStamp()

const { Arch, build, Platform } = require('electron-builder')
const publish = process.argv.includes('--publish') ? 'always' : 'never'
const override = process.env.OUTPUT_DIR
  ? { config: { directories: { output: process.env.OUTPUT_DIR } } }
  : {}

const arch = process.arch === 'arm64' ? Arch.arm64 : Arch.x64
const targets = process.platform === 'darwin'
  ? Platform.MAC.createTarget(['dmg'], arch)
  : Platform.WINDOWS.createTarget(['nsis'], arch)
build({ targets, publish, ...override })
  .then((artifacts) => {
    console.log('构建完成，产物：')
    for (const a of artifacts) console.log('  ' + a)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
