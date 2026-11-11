import type { Parser } from '../problem'
import { eslint } from './eslint'
import { gcc } from './gcc'
import { go } from './go'
import { javac } from './javac'
import { jest } from './jest'
import { msbuild } from './msbuild'
import { mypy } from './mypy'
import { node } from './node'
import { pyright } from './pyright'
import { pytest } from './pytest'
import { python } from './python'
import { ruff } from './ruff'
import { rustc } from './rustc'
import { tsc } from './tsc'

export const parsers: Record<string, Parser> = {
  tsc,
  gcc,
  rustc,
  go,
  python,
  pytest,
  pyright,
  mypy,
  ruff,
  javac,
  msbuild,
  node,
  eslint,
  jest,
}

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
  swift: ['gcc'],
  cargo: ['rustc'],
  rustc: ['rustc'],
  go: ['go'],
  python: ['python'],
  python3: ['python'],
  pytest: ['pytest'],
  pyright: ['pyright'],
  basedpyright: ['pyright'],
  mypy: ['mypy'],
  dmypy: ['mypy'],
  ruff: ['ruff'],
  flake8: ['ruff'],
  pylint: ['ruff'],
  javac: ['javac'],
  dotnet: ['msbuild'],
  msbuild: ['msbuild'],
  node: ['node'],
  tsx: ['node'],
  'ts-node': ['node'],
  eslint: ['eslint'],
  jest: ['jest'],
  vitest: ['jest'],
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

// Commands whose output looks like errors but isn't (`grep -n` prints `file:12:...`).
export const DEFAULT_IGNORED = [
  'cd',
  'ls',
  'cat',
  'bat',
  'less',
  'more',
  'head',
  'tail',
  'grep',
  'rg',
  'ag',
  'find',
  'fd',
  'git',
  'echo',
  'printf',
  'man',
  'which',
  'diff',
  'jq',
  'tree',
  'code',
  'vim',
  'nvim',
  'nano',
  'ssh',
  'curl',
  'wget',
  'brew',
]

// The parsers for every known command in a chain like `cd app && tsc`. A command we
// don't know (`make`, `npm run build`) gets every parser; a match only becomes a
// problem if its file exists, which keeps that from guessing wildly.
export function pickParsers(commandLine: string, ignored: string[] = DEFAULT_IGNORED): Parser[] {
  const commands = commandLine
    .split(/&&|\|\||;|\|/)
    .map(commandName)
    .filter((name): name is string => name !== undefined)
  const names = commands.flatMap((command) => COMMANDS[command] ?? [])
  if (names.length) return [...new Set(names)].map((name) => parsers[name])
  if (!commands.length || ignored.includes(commands[0])) return []
  return Object.values(parsers)
}
