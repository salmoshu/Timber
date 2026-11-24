import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { codeLanguageForPath } from '@shared/code'

const clangdConfig = ['.clangd', 'compile_flags.txt', 'compile_commands.json', 'build/compile_commands.json']
const sourceFiles = /\.(c|cc|cp|cpp|cxx|c\+\+|ixx|cppm|ccm|cxxm|c\+\+m|m|mm)$/i
const moduleFiles = /\.(ixx|cppm|ccm|cxxm|c\+\+m)$/i
const skipDirectories = /^(build|cmake-build-.*|out|dist|node_modules|target|vendor)$/i

async function hasClangdConfig(root: string): Promise<boolean> {
  for (let dir = root; ; dir = dirname(dir)) {
    const files = await Promise.all(clangdConfig.map((file) =>
      stat(join(dir, file)).then((info) => info.isFile(), () => false)
    ))
    if (files.some(Boolean)) return true
    if (dirname(dir) === dir) return false
  }
}

/** Give loose source folders a background index without writing build files into the project. */
export async function temporaryCompilationDatabase(root: string): Promise<string | undefined> {
  if (await hasClangdConfig(root)) return undefined

  const sources: string[] = []
  const directories = [root]
  for (let index = 0; index < directories.length; index++) {
    const entries = await readdir(directories[index], { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(directories[index], entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !skipDirectories.test(entry.name)) directories.push(path)
      } else {
        // A nested configuration or database belongs to clangd's own discovery.
        if (clangdConfig.includes(entry.name.toLowerCase())) return undefined
        if (entry.isFile() && sourceFiles.test(entry.name)) sources.push(path)
      }
      if (sources.length > 256 || directories.length > 128) return undefined
    }
  }
  if (!sources.length) return undefined

  const commands = sources.map((file) => {
    const language = codeLanguageForPath(file)
    const variant = language === 'cpp' ? 'c++' : language === 'objective-cpp' ? 'objective-c++' : language
    return {
      directory: root,
      file,
      arguments: ['clang', '-x', variant, ...(moduleFiles.test(file) ? ['-std=c++20'] : []), '-I', root, '-I', join(root, 'include'), '-c', file]
    }
  })
  const directory = await mkdtemp(join(tmpdir(), 'timber-clangd-'))
  try {
    await writeFile(join(directory, 'compile_commands.json'), JSON.stringify(commands))
    return directory
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}
