import type { Problem, Severity } from '../problem'

// `main.c:5:9: error: msg [-Wint-conversion]`, shared by gcc, clang and swiftc.
// Column is optional (`file:3: error:`). Shape follows vscode-cpptools' $gcc matcher (MIT).
const HEAD = /^(.+?):(\d+):(?:(\d+):)? (fatal error|error|warning|note|remark): (.*?)(?: \[(-W[^\]]+)\])?$/

const OTHER_LANGUAGES = /\.(?:pyi?|java|[cm]?[jt]sx?|rs|go|cs)$/

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
    // javac, mypy and others print the same shape; their own parsers read it better.
    if (OTHER_LANGUAGES.test(file)) continue
    // A note explains the problem above it, so it rides along as related info.
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
