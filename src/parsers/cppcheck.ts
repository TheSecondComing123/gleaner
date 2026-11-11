import type { Problem, Severity } from '../problem'

// `main.c:4:6: error: msg [arrayIndexOutOfBounds]`, then the source line and a caret.
// Notes (`util.cpp:6:22: note: Assuming that ...`) carry no id and explain the problem above.
// Only C and C++ files, so mypy's `x.py:3:5: error: msg  [assignment]` isn't read as cppcheck's.
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
  for (const line of lines) {
    const head = HEAD.exec(line)
    if (head) {
      const [, file, row, col, kind, message, code] = head
      last = { file, line: Number(row), col: Number(col), severity: SEVERITY[kind], message, code, source: 'cppcheck' }
      problems.push(last)
      continue
    }
    const note = NOTE.exec(line)
    if (note && last) {
      const [, file, row, col, message] = note
      last.related = [...(last.related ?? []), { file, line: Number(row), col: Number(col), message }]
    }
  }
  return problems
}
