import { getFonts } from 'font-list'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { uniqueFontFamilies } from '@shared/fontFamilies'
import type { FontCatalog } from '@shared/types'

let cached: Promise<FontCatalog> | null = null
const execFileAsync = promisify(execFile)

async function installedFamilies(): Promise<string[]> {
  if (process.platform !== 'win32') return getFonts({ disableQuoting: true })
  // Use the same WPF font catalog as font-list/MarkText, with a hidden console,
  // a bounded lifetime and explicit UTF-8 output for Chinese family names.
  const script = `
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName PresentationCore
    $names = foreach ($family in [Windows.Media.Fonts]::SystemFontFamilies) {
      $name = ''
      if (!$family.FamilyNames.TryGetValue([Windows.Markup.XmlLanguage]::GetLanguage('zh-cn'), [ref]$name)) {
        $name = $family.FamilyNames[[Windows.Markup.XmlLanguage]::GetLanguage('en-us')]
      }
      if (!$name) { $name = $family.Source }
      $name
    }
    ConvertTo-Json -InputObject @($names) -Compress
  `
  const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 15000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8'
  })
  const names: unknown = JSON.parse(stdout.replace(/^\uFEFF/, '').trim())
  if (!Array.isArray(names)) throw new Error('Invalid system font catalog')
  return names.filter((name): name is string => typeof name === 'string')
}

/** Enumerate installed fonts in the main process, as MarkText does. */
export function listFontFamilies(refresh = false): Promise<FontCatalog> {
  if (!cached || refresh) {
    cached = (async () => {
      try {
        const families = uniqueFontFamilies(await installedFamilies())
          .sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }))
        if (!families.length) throw new Error('The system font catalog was empty')
        return { families }
      } catch (error) {
        console.warn('[fonts] Unable to read installed fonts:', error)
        return { families: [], error: '读取本机字体失败，请刷新后重试；内置字体仍可使用。' }
      }
    })()
  }
  return cached
}
