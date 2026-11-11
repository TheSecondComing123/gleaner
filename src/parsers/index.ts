import type { Parser } from '../problem'

const byCommand: Record<string, Parser> = {}

// Words that sit in front of the real command: `npx tsc`, `pnpm exec tsc`, `uv run pytest`.
const WRAPPERS = new Set([
  'npx',
  'pnpx',
  'bunx',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'exec',
  'dlx',
  'x',
  'run',
  'uv',
  'poetry',
  'time',
  'env',
  'sudo',
])

function commandName(segment: string): string | undefined {
  for (const token of segment.trim().split(/\s+/)) {
    // ponytail: a wrapper flag that takes a value (`uv run --with x pytest`) makes `x` look like the command
    if (!token || token.startsWith('-') || /^\w+=/.test(token) || WRAPPERS.has(token)) continue
    return token.split('/').pop()
  }
  return undefined
}

// Every known command in a chain like `cd app && tsc`.
export function pickParsers(commandLine: string): Parser[] {
  const found = commandLine
    .split(/&&|\|\||;|\|/)
    .map((segment) => byCommand[commandName(segment) ?? ''])
    .filter((parser): parser is Parser => parser !== undefined)
  return [...new Set(found)]
}
