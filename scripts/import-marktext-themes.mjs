// Palette values are derived from MarkText's MIT-licensed themes. See vendor/marktext-muya/UPSTREAM.md.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const directory = resolve(process.argv[2] || 'tmp/marktext/packages/desktop/src/renderer/src/assets/themes')
const darkThemes = new Set(['dark', 'material-dark', 'dracula', 'nord', 'catppuccin-mocha', 'gruvbox-dark', 'tokyo-night', 'tokyo-night-storm', 'solarized-dark', 'ayu-dark', 'ayu-mirage', 'everforest-dark', 'rose-pine', 'rose-pine-moon', 'monokai-pro', 'synthwave-84', 'horizon-dark', 'palenight', 'oxocarbon-dark', 'kanagawa', 'nightfox', 'cyberdream', 'one-dark'])
const palettes = { light: { label: '浅色', dark: false, background: '#ffffff', sidebar: '#f5f5f5', panel: '#ffffff', text: '#24292e', accent: '#1783ff', code: '#f5f5f5', keyword: '#a626a4', string: '#50a14f', number: '#986801', comment: '#6a737d', mark: '#526fff', punctuation: '#e45649' } }
for (const file of readdirSync(directory).filter(name => name.endsWith('.theme.css'))) {
  const id = file.replace('.theme.css', '')
  const css = readFileSync(join(directory, file), 'utf8')
  const variables = Object.fromEntries([...css.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]))
  const color = (name, fallback) => {
    let value = variables[name] || fallback
    for (let count = 0; count < 8 && value.includes('var('); count++) value = value.replace(/var\(--([\w-]+)\)/g, (_, key) => variables[key] || fallback)
    return value
  }
  let prism = ''
  try { prism = readFileSync(join(directory, 'prismjs', file), 'utf8') } catch {}
  const syntax = (name, fallback) => {
    for (const match of prism.matchAll(/([^{}]+)\{([^}]+)\}/g)) {
      if (new RegExp('\\.token\\.' + name + '(?![\\w-])').test(match[1])) {
        const value = /(?:^|;)\s*color:\s*([^;]+)/.exec(match[2])?.[1].trim()
        if (value && !value.includes('var(')) return value
      }
    }
    return fallback
  }
  palettes[id] = {
    label: id === 'dark' ? '深色' : id.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' '),
    dark: darkThemes.has(id),
    background: color('editorBgColor', '#ffffff'), sidebar: color('sideBarBgColor', '#f5f5f5'), panel: color('floatBgColor', '#ffffff'),
    text: color('editorColor', '#24292e'), accent: color('themeColor', '#1783ff'), code: color('codeBlockBgColor', '#f5f5f5'),
    keyword: syntax('keyword', color('themeColor', '#1783ff')), string: syntax('string', color('linkColor', '#1783ff')),
    number: syntax('number', color('themeColor', '#1783ff')), comment: syntax('comment', color('editorColor50', '#808080')),
    mark: syntax('function', color('themeColor', '#1783ff')), punctuation: syntax('punctuation', color('editorColor', '#24292e'))
  }
}
writeFileSync(resolve('src/renderer/src/utils/themePalettes.ts'), `// Derived from MarkText themes (MIT); see vendor/marktext-muya/UPSTREAM.md.\n// Regenerate with: node scripts/import-marktext-themes.mjs <MarkText themes directory>\nexport const THEME_PALETTES = ${JSON.stringify(palettes, null, 2)} as const\n\nexport type ThemeId = keyof typeof THEME_PALETTES\n`)
console.log(`Imported ${Object.keys(palettes).length} palettes`)
