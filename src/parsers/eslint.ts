import type { Problem, Severity } from '../problem'

// stylish (default)
const FILE = /^(?:\/|[A-Za-z]:[\\/])\S.*$/
const ROW = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.*?)(?:\s{2,}(\S+))?$/
// compact
const COMPACT =
  /^(?<file>.+): line (?<line>\d+), col (?<col>\d+), (?<kind>Error|Warning) - (?<message>.*?)(?: \((?<code>\S+)\))?$/
// unix
const UNIX = /^(?<file>.+?):(?<line>\d+):(?<col>\d+): (?<message>.*) \[(?<kind>Error|Warning)(?:\/(?<code>\S+))?\]$/

const SEVERITY: Record<string, Severity> = { error: 'error', warning: 'warning' }

export function eslint(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let file: string | undefined

  for (const line of lines) {
    const flat = (COMPACT.exec(line) ?? UNIX.exec(line))?.groups
    if (flat) {
      problems.push({
        file: flat.file,
        line: Number(flat.line),
        col: Number(flat.col),
        severity: SEVERITY[flat.kind.toLowerCase()],
        message: flat.message,
        code: flat.code,
        source: 'eslint',
      })
      continue
    }
    if (FILE.test(line)) {
      file = line
      continue
    }
    const row = file && ROW.exec(line)
    if (!file || !row) continue
    problems.push({
      file,
      line: Number(row[1]),
      col: Number(row[2]),
      severity: SEVERITY[row[3]],
      message: row[4],
      code: row[5],
      source: 'eslint',
    })
  }
  return problems
}
