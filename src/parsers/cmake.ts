import type { Problem } from '../problem'

// `CMake Error at CMakeLists.txt:3 (add_executable):` with the message indented below it.
// Warnings can carry a kind: `(dev)`, or `(author)`/`(policy)`/`(deprecated)` since CMake 4.
// Parse errors have no command: `CMake Error at CMakeLists.txt:4:`.
const HEAD = /^CMake (Error|Warning|Deprecation Error|Deprecation Warning)(?: \(\w+\))? at (.+?):(\d+)(?: \(\w+\))?:$/
// Frames under `Call Stack (most recent call first):`, e.g. `  CMakeLists.txt:6 (check_thing)`.
const FRAME = /^ {2}(.+?):(\d+) \((\w+)\)$/

export function cmake(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let current: Problem | undefined
  let mode: 'message' | 'stack' | undefined
  let paragraph = false

  for (const line of lines) {
    const head = HEAD.exec(line)
    if (head) {
      const [, kind, file, row] = head
      current = {
        file,
        line: Number(row),
        severity: kind.endsWith('Error') ? 'error' : 'warning',
        message: '',
        source: 'cmake',
      }
      problems.push(current)
      mode = 'message'
      paragraph = false
      continue
    }
    if (!current) continue
    if (mode === 'message') {
      // CMake wraps long messages at about 77 columns; a blank line separates paragraphs.
      if (line.startsWith(' ')) {
        const text = line.trim()
        current.message += !current.message ? text : paragraph ? `\n${text}` : ` ${text}`
        paragraph = false
      } else if (!line) paragraph = true
      else mode = line === 'Call Stack (most recent call first):' ? 'stack' : undefined
      continue
    }
    const frame = mode === 'stack' && FRAME.exec(line)
    if (frame)
      current.related = [...(current.related ?? []), { file: frame[1], line: Number(frame[2]), message: frame[3] }]
    else mode = undefined
  }
  return problems
}
