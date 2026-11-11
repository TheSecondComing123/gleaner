import type { Parser } from '../problem'
import { gcc } from './gcc'
import { tsc } from './tsc'

export const parsers: Record<string, Parser> = { tsc, gcc }

// Which parsers read the output of which command.
const COMMANDS: Record<string, string[]> = {
  tsc: ['tsc'],
  tsgo: ['tsc'],
  'vue-tsc': ['tsc'],
  gcc: ['gcc'],
  'g++': ['gcc'],
  cc: ['gcc'],
  'c++': ['gcc'],
  clang: ['gcc'],
  'clang++': ['gcc'],
  swiftc: ['gcc'],
}

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

export function commandName(segment: string): string | undefined {
  const tokens = segment.trim().split(/\s+/)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    // ponytail: a wrapper flag that takes a value (`uv run --with x pytest`) makes `x` look like the command
    if (!token || token.startsWith('-') || /^\w+=/.test(token) || WRAPPERS.has(token)) continue
    const name = token.split('/').pop()
    // `python -m pytest` runs pytest
    if (name && /^python[\d.]*$/.test(name) && tokens[i + 1] === '-m' && tokens[i + 2]) return tokens[i + 2]
    return name
  }
  return undefined
}

// Every parser for every known command in a chain like `cd app && tsc`.
export function pickParsers(commandLine: string): Parser[] {
  const names = commandLine.split(/&&|\|\||;|\|/).flatMap((segment) => COMMANDS[commandName(segment) ?? ''] ?? [])
  return [...new Set(names)].map((name) => parsers[name])
}
