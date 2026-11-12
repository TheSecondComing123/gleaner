import type { Problem, Severity } from '../problem'

// `main.c:4:6: error: msg [id]`
// C/C++ only
const FILE = String.raw`(.+?\.(?:c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+|ipp|ixx|tpp|txx|inl))`
const HEAD = new RegExp(
  String.raw`^${FILE}:(\d+):(\d+): (error|warning|style|performance|portability|information): (.*) \[(\w+)\]$`,
)
const NOTE = new RegExp(String.raw`^${FILE}:(\d+):(\d+): note: (.*)$`)

const SEVERITY: Record<string, Severity> = {
  error: 'error',
  warning: 'warning',
  style: 'info',
  performance: 'info',
  portability: 'info',
  information: 'info',
}

export function cppcheck(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let last: Problem | undefined
  for (const [index, line] of lines.entries()) {
    const head = HEAD.exec(line)
    if (head) {
      const [, file, row, col, kind, message, code] = head
      last = {
        file,
        line: Number(row),
        col: Number(col),
        severity: SEVERITY[kind],
        message,
        code,
        source: 'cppcheck',
        output: { start: index, end: index + 1 },
      }
      problems.push(last)
      continue
    }
    const note = NOTE.exec(line)
    if (note && last) {
      if (last.output) last.output.end = index + 1
      const [, file, row, col, message] = note
      last.related = [...(last.related ?? []), { file, line: Number(row), col: Number(col), message }]
    }
  }
  return problems
}
