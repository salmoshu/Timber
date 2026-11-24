const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

// An ad-hoc signature covers the packaged helpers and Mach-O resources.
module.exports = ({ app }) => {
  const resources = join(app, 'Contents', 'Resources', 'sidecar')
  for (const binary of [join(resources, 'timberd'), join(resources, 'clangd', 'bin', 'clangd')]) {
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', binary], { stdio: 'inherit' })
  }
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
}
