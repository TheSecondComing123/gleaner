import type { Parser, Problem } from '../problem'
import { eslint } from './eslint'
import { gcc } from './gcc'
import { go } from './go'
import { javac } from './javac'
import { jest } from './jest'
import { make } from './make'
import { msbuild } from './msbuild'
import { mypy } from './mypy'
import { node } from './node'
import { pyright } from './pyright'
import { pytest } from './pytest'
import { python } from './python'
import { ruff } from './ruff'
import { rustc } from './rustc'
import { tsc } from './tsc'

// Order matters when several parsers match the same line: the specific ones come first
// so their richer result wins (javac over gcc for `Main.java:5: error:`, tsc over msbuild
// for `a.ts(4,7): error TS2322`, jest over node for jest's stack frames).
export const parsers: Record<string, Parser> = {
  tsc,
  javac,
  rustc,
  go,
  python,
  pytest,
  pyright,
  mypy,
  ruff,
  eslint,
  jest,
  msbuild,
  node,
  make,
  gcc,
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

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])

// `npm run build`, `pnpm build`, `yarn test` → `build`/`test`, when package.json has that script.
function scriptName(segment: string, scripts: Record<string, string>): string | undefined {
  const tokens = segment
    .trim()
    .split(/\s+/)
    .filter((token) => token && !/^\w+=/.test(token))
  if (!PACKAGE_MANAGERS.has(tokens[0] ?? '')) return undefined
  // ponytail: a flag that takes a value (`npm --prefix web run build`) hides the script; it runs every parser
  const words = tokens.slice(1).filter((token) => !token.startsWith('-'))
  const name = words[0] === 'run' || words[0] === 'run-script' ? words[1] : words[0]
  return name && Object.hasOwn(scripts, name) ? name : undefined
}

// The parsers for every known command in a chain like `cd app && tsc`. A package script is read
// through to the commands it runs. A command we don't know (`make`) gets every parser; a match
// only becomes a problem if its file exists, which keeps that from guessing wildly.
export function pickParsers(
  commandLine: string,
  ignored: string[] = DEFAULT_IGNORED,
  scripts: Record<string, string> = {},
): Parser[] {
  const chosen = choose(commandLine, ignored, scripts, 0)
  return Object.keys(parsers)
    .filter((name) => chosen.has(name))
    .map((name) => parsers[name])
}

function choose(commandLine: string, ignored: string[], scripts: Record<string, string>, depth: number): Set<string> {
  // Each step of `tsc && make` picks its own parsers; a pipe's later commands can name the tool
  // (`npx tsc | tee`) but only its first one decides whether an unknown step is ignored.
  const chosen = new Set<string>()
  for (const step of commandLine.split(/&&|\|\||;/)) {
    const script = scriptName(step.split('|')[0], scripts)
    // A script that runs itself, or a long chain of them, stops here and gets every parser.
    if (script && depth < 5) {
      for (const name of [`pre${script}`, script, `post${script}`].filter((n) => Object.hasOwn(scripts, n)))
        for (const parser of choose(scripts[name], ignored, scripts, depth + 1)) chosen.add(parser)
      continue
    }
    const pipes = step.split('|').map(commandName)
    const names = pipes.flatMap((command) => COMMANDS[command ?? ''] ?? [])
    if (names.length) for (const name of names) chosen.add(name)
    else if (pipes[0] && !ignored.includes(pipes[0])) for (const name of Object.keys(parsers)) chosen.add(name)
  }
  return chosen
}

const firstLine = (p: Problem) => p.message.split('\n')[0]

// Runs the parsers in order and drops a problem an earlier parser already reported:
// same file, line and first message line, and the same column when both have one.
export function parseAll(chosen: Parser[], lines: string[]): Problem[] {
  const kept: Problem[] = []
  const seen = new Map<string, Problem[]>()
  for (const parse of chosen) {
    for (const problem of parse(lines)) {
      const key = `${problem.file}:${problem.line}:${firstLine(problem)}`
      const twins = seen.get(key) ?? []
      if (twins.some((t) => t.col === undefined || problem.col === undefined || t.col === problem.col)) continue
      seen.set(key, [...twins, problem])
      kept.push(problem)
    }
  }
  return kept
}
