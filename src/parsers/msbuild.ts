import type { Problem, Severity } from '../problem'

// shape from VS Code's $msCompile (MIT)
const HEAD =
  /^\s*(?:\d+>)?(\S.*?)\((\d+)(?:,(\d+)(?:,(\d+),(\d+))?)?\): (?:\S+ )?(error|warning|info)(?: (\w+))?\s*: (.*?)(?: \[[^\]]+\])?$/

// project errors, no position
const PROJECT =
  /^\s*(?:\d+>)?(\S.*?\.(?:csproj|fsproj|vbproj|sln|slnx|props|targets)) : (error|warning) (\w+): (.*?)(?: \[[^\]]+\])?$/

const SEVERITY: Record<string, Severity> = { error: 'error', warning: 'warning', info: 'info' }

export function msbuild(lines: string[]): Problem[] {
  const problems: Problem[] = []
  // summary repeats diagnostics
  const seen = new Set<string>()
  for (const line of lines) {
    const project = PROJECT.exec(line)
    const m = HEAD.exec(line) ?? (project && [line, project[1], '1', '', '', '', project[2], project[3], project[4]])
    if (!m) continue
    const [, file, row, col, endRow, endCol, kind, code, message] = m
    const problem: Problem = {
      file,
      line: Number(row),
      col: col ? Number(col) : undefined,
      endLine: endRow ? Number(endRow) : undefined,
      endCol: endCol ? Number(endCol) : undefined,
      severity: SEVERITY[kind],
      message,
      code,
      source: 'msbuild',
    }
    const key = JSON.stringify(problem)
    if (seen.has(key)) continue
    seen.add(key)
    problems.push(problem)
  }
  return problems
}
