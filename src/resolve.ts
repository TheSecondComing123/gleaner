import * as path from 'node:path'

// First existing match wins. `dirs` is in priority order: the newest cwd the shell
// reported during the run, the cwd the command started in, then workspace folders.
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

// file:///C:/a.ts → C:/a.ts, file:///a.ts → /a.ts. Not fileURLToPath: it throws on another OS's URL
// (a macOS path read on Windows), which would end the whole parse.
export const fromFileUrl = (url: string): string =>
  decodeURIComponent(new URL(url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
