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
  let contextStart: number | undefined
  let current: Problem | undefined
  for (const [index, line] of lines.entries()) {
    const m = HEAD.exec(line)
    if (!m) {
      if (/^(In file included from |.+?: (?:In |At global scope)|\s+(?:from |required from ))/.test(line)) {
        contextStart ??= index
        current = undefined
      } else if (current?.output && (!line || /^\s/.test(line))) current.output.end = index + 1
      else current = undefined
      continue
    }
    const [, file, row, col, kind, message, flag] = m
    // javac, mypy: their parsers win
    if (OTHER_LANGUAGES.test(file) || OTHER_TOOLS.test(message)) {
      current = undefined
      contextStart = undefined
      continue
    }
    // notes become related info
    if (kind === 'note') {
      const last = current
      if (last?.output) last.output.end = index + 1
      if (last)
        last.related = [
          ...(last.related ?? []),
          { file, line: Number(row), col: col ? Number(col) : undefined, message },
        ]
      continue
    }
    current = {
      file,
      line: Number(row),
      col: col ? Number(col) : undefined,
      severity: SEVERITY[kind],
      message,
      code: flag,
      source: 'gcc',
      output: { start: contextStart ?? index, end: index + 1 },
    }
    problems.push(current)
    contextStart = undefined
  }
  return problems
}
