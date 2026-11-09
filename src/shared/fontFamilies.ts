// Font-stack parsing and serialization adapted from MarkText (MIT).
// Source: packages/desktop/src/renderer/src/prefComponents/common/fontTextBox/fontFamilies.ts.
// The upstream license is preserved in vendor/marktext-muya/LICENSE.
export const GENERIC_FONT_FAMILIES = [
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong'
] as const
const genericFamilies = new Set<string>(GENERIC_FONT_FAMILIES)
export const BUNDLED_FONT_FAMILIES = ['Open Sans', 'DejaVu Sans Mono'] as const

export function parseFontFamilies(value: string): string[] {
  const families: string[] = []
  let family = ''
  let quote = ''
  let escaped = false
  for (const char of value) {
    if (escaped) { family += char; escaped = false }
    else if (char === '\\') escaped = true
    else if (quote) {
      if (char === quote) quote = ''
      else family += char
    } else if (char === '"' || char === "'") quote = char
    else if (char === ',') { if (family.trim()) families.push(family.trim()); family = '' }
    else family += char
  }
  if (escaped) family += '\\'
  if (family.trim()) families.push(family.trim())
  return families
}

export function uniqueFontFamilies(families: readonly string[]): string[] {
  const seen = new Set<string>()
  return families.map((font) => font.replace(/[\u0000-\u001f\u007f]/g, '').trim()).filter((font) => {
    const key = font.toLocaleLowerCase()
    if (!font || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function serializeFontFamilies(families: readonly string[]): string {
  return uniqueFontFamilies(families).map((font) => genericFamilies.has(font.toLowerCase())
    ? font.toLowerCase() : JSON.stringify(font)).join(', ')
}

export function normalizeFontStack(value: string): string {
  return serializeFontFamilies(parseFontFamilies(value))
}

export function resolveFontStack(value: string, code = false): string {
  const fallback = code
    ? ['DejaVu Sans Mono', 'Source Code Pro', 'Droid Sans Mono', 'Consolas', 'monospace']
    : ['Open Sans', 'Clear Sans', 'Helvetica Neue', 'Helvetica', 'Arial', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', 'sans-serif', 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji']
  return serializeFontFamilies([...parseFontFamilies(value), ...fallback])
}

export function normalizeEditorWidth(value: unknown): string {
  if (typeof value !== 'string') return ''
  const width = value.trim().toLowerCase()
  return /^(?:\d+(?:\.\d+)?)(?:px|ch|%)$/.test(width) && parseFloat(width) > 0 ? width : ''
}
