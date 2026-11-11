import type { Problem, Severity } from '../problem'

// ruff concise, flake8, pylint
// .py only
const LINE = /^(.+?\.pyi?):(\d+):(\d+): (?!(?:error|warning|note):)([A-Z]+\d+|[a-z][\w-]*)(:?) (?:\[\*\] )?(.*)$/
// ruff full format
const HEADER = /^([A-Z]+\d+|[a-z][\w-]*):? (?:\[\*\] )?(.*)$/
const ARROW = /^\s*--> (.+?\.pyi?):(\d+):(\d+)$/
const PYLINT_CODE = /^[CRWEFI]\d{4}$/
const PYLINT_SYMBOL = / \([a-z\d-]+\)$/
const SYNTAX = new Set(['invalid-syntax', 'E999'])
const PYLINT_SEVERITY: Record<string, Severity> = { E: 'error', F: 'error', W: 'warning' }

export function ruff(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let previous = ''

  for (const line of lines) {
    const arrow = ARROW.exec(line)
    const header = arrow && HEADER.exec(previous)
    previous = line
    if (arrow && header) {
      problems.push({
        file: arrow[1],
        line: Number(arrow[2]),
        col: Number(arrow[3]),
        severity: SYNTAX.has(header[1]) ? 'error' : 'warning',
        message: header[2],
        code: header[1],
        source: 'ruff',
      })
      continue
    }

    const m = LINE.exec(line)
    if (!m) continue
    const [, file, row, col, code, colon, message] = m
    if (colon && PYLINT_CODE.test(code)) {
      problems.push({
        file,
        line: Number(row),
        // pylint: 0-based, except syntax errors
        col: Number(col) + (code === 'E0001' ? 0 : 1),
        severity: PYLINT_SEVERITY[code[0]] ?? 'info',
        message: message.replace(PYLINT_SYMBOL, ''),
        code,
        source: 'ruff',
      })
      continue
    }
    problems.push({
      file,
      line: Number(row),
      col: Number(col),
      severity: SYNTAX.has(code) ? 'error' : 'warning',
      message,
      code,
      source: 'ruff',
    })
  }
  return problems
}
