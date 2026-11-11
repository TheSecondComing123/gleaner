import * as path from 'node:path'

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
