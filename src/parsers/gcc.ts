import type { Problem, Severity } from '../problem'

// shape from cpptools' $gcc (MIT)
const HEAD = /^(.+?):(\d+):(?:(\d+):)? (fatal error|error|warning|note|remark): (.*?)(?: \[(-W[^\]]+)\])?$/

const OTHER_LANGUAGES = /\.(?:pyi?|java|[cm]?[jt]sx?|rs|go|cs)$/

// shellcheck/cppcheck ids, not `-W` flags
const OTHER_TOOLS = / \[\w+\]$/

const SEVERITY: Record<string, Severity> = {
  'fatal error': 'error',
  error: 'error',
  warning: 'warning',
  remark: 'info',
}

export function gcc(lines: string[]): Problem[] {
  const problems: Problem[] = []
  for (const line of lines) {
    const m = HEAD.exec(line)
    if (!m) continue
    const [, file, row, col, kind, message, flag] = m
    // javac, mypy: their parsers win
    if (OTHER_LANGUAGES.test(file) || OTHER_TOOLS.test(message)) continue
    // notes become related info
    if (kind === 'note') {
      const last = problems.at(-1)
      if (last)
        last.related = [
          ...(last.related ?? []),
          { file, line: Number(row), col: col ? Number(col) : undefined, message },
        ]
      continue
    }
    problems.push({
      file,
      line: Number(row),
      col: col ? Number(col) : undefined,
      severity: SEVERITY[kind],
      message,
      code: flag,
      source: 'gcc',
    })
  }
  return problems
}
