import type { Problem, Severity } from '../problem'

// `Program.cs(5,13): error CS0103: msg [app.csproj]`, also `(5,13,5,20)` ranges and an `N>` node prefix.
// The terminal logger indents it and drops the project. Shape follows VS Code's $msCompile matcher (MIT).
const HEAD =
  /^\s*(?:\d+>)?(\S.*?)\((\d+)(?:,(\d+)(?:,(\d+),(\d+))?)?\): (?:\S+ )?(error|warning|info)(?: (\w+))?\s*: (.*?)(?: \[[^\]]+\])?$/

// Restore and project errors name the project file with no position: `/abs/app.csproj : error NU1101: msg`.
const PROJECT =
  /^\s*(?:\d+>)?(\S.*?\.(?:csproj|fsproj|vbproj|sln|slnx|props|targets)) : (error|warning) (\w+): (.*?)(?: \[[^\]]+\])?$/

const SEVERITY: Record<string, Severity> = { error: 'error', warning: 'warning', info: 'info' }

export function msbuild(lines: string[]): Problem[] {
  const problems: Problem[] = []
  // dotnet build repeats every diagnostic in its summary.
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
