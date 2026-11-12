import * as path from 'node:path'

export interface WorkspaceFolder {
  name: string
  path: string
}

export function mapPath(
  file: string,
  mappings: Record<string, string>,
  folders: WorkspaceFolder[],
): { path: string; target: string } | { error: string } | undefined {
  const printed = (file.startsWith('file://') ? fromFileUrl(file) : file).replace(/\\/g, '/')
  const match = Object.entries(mappings)
    .map(([prefix, target]) => ({
      prefix: prefix ? prefix.replace(/\\/g, '/').replace(/\/+$/, '') || '/' : '',
      target,
    }))
    .filter(
      ({ prefix }) =>
        prefix && (printed === prefix || printed.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)),
    )
    .sort((a, b) => b.prefix.length - a.prefix.length)[0]
  if (!match) return undefined
  const { prefix, target } = match
  const ignored = (reason: string) => ({ error: `ignored path mapping ${prefix} to ${target}: ${reason}` })
  let invalid = false
  const expanded = target.replace(/\$\{workspaceFolder(?::([^}]+))?\}/g, (_variable, name: string | undefined) => {
    const folder = name ? folders.find((folder) => folder.name === name) : folders.length === 1 ? folders[0] : undefined
    if (!folder) invalid = true
    return folder?.path ?? ''
  })
  if (invalid) return ignored(`workspace folder not found or ambiguous; use \${workspaceFolder:name}`)
  const native = expanded.replace(/\\/g, '/')
  const root = folders.length === 1 ? folders[0].path.replace(/\\/g, '/') : ''
  const absolute = path.posix.isAbsolute(native) || path.win32.isAbsolute(native)
  const style = absolute ? native : root
  const paths = /^[A-Za-z]:\//.test(style) || style.startsWith('//') ? path.win32 : path
  let base = native
  if (!paths.isAbsolute(base)) {
    if (folders.length !== 1) return ignored(`relative target needs one workspace folder; use \${workspaceFolder:name}`)
    base = paths.resolve(folders[0].path, base)
  }
  const suffix = printed.slice(prefix.length).replace(/^\/+/, '')
  return { path: paths.resolve(base, suffix), target: path.posix.join(target.replace(/\\/g, '/'), suffix) }
}

// first existing dir wins
export async function resolveFile(
  file: string,
  dirs: string[],
  exists: (p: string) => Promise<boolean>,
): Promise<string | undefined> {
  if (file.startsWith('file://')) file = path.normalize(fromFileUrl(file))
  if (path.isAbsolute(file)) return (await exists(file)) ? file : undefined
  for (const dir of dirs) {
    const candidate = path.resolve(dir, file)
    if (await exists(candidate)) return candidate
  }
  return undefined
}

// fileURLToPath throws cross-OS
export const fromFileUrl = (url: string): string =>
  decodeURIComponent(new URL(url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
