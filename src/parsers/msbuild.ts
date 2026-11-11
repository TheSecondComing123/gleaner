import type { Problem, Severity } from '../problem'

// `Program.cs(5,13): error CS0103: msg [app.csproj]`, also `(5,13,5,20)` ranges and an `N>` node prefix.
// The terminal logger indents it and drops the project. Shape follows VS Code's $msCompile matcher (MIT).
const HEAD =
  /^\s*(?:\d+>)?(\S.*?)\((\d+)(?:,(\d+)(?:,(\d+),(\d+))?)?\): (?:\S+ )?(error|warning|info)(?: (\w+))?\s*: (.*?)(?: \[[^\]]+\])?$/

const SEVERITY: Record<string, Severity> = { error: 'error', warning: 'warning', info: 'info' }

export function msbuild(lines: string[]): Problem[] {
  const problems: Problem[] = []
  // dotnet build repeats every diagnostic in its summary.
  const seen = new Set<string>()
  for (const line of lines) {
    const m = HEAD.exec(line)
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
