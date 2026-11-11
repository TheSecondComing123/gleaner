import type { Problem, Severity } from '../problem'

// One line per problem, from ruff --output-format concise, flake8 and pylint:
// `x.py:3:5: F401 [*] msg`, `x.py:1:7: invalid-syntax: msg`, `x.py:3:5: E501 msg`,
// `x.py:3:0: C0114: msg (missing-module-docstring)`.
const LINE = /^(.+?):(\d+):(\d+): ([A-Z]+\d+|[a-z][\w-]*)(:?) (?:\[\*\] )?(.*)$/
// ruff's default full format puts `F401 [*] msg` above ` --> x.py:3:5`, then a code frame.
const HEADER = /^([A-Z]+\d+|[a-z][\w-]*):? (?:\[\*\] )?(.*)$/
const ARROW = /^\s*--> (.+?):(\d+):(\d+)$/
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
        // pylint columns are 0-based, except a syntax error's, which is Python's own 1-based offset.
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
