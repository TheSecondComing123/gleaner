import type { Problem } from '../problem'

// `CMake Error at CMakeLists.txt:3 (cmd):`
const HEAD = /^CMake (Error|Warning|Deprecation Error|Deprecation Warning)(?: \(\w+\))? at (.+?):(\d+)(?: \(\w+\))?:$/
// call stack frames
const FRAME = /^ {2}(.+?):(\d+) \((\w+)\)$/

export function cmake(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let current: Problem | undefined
  let mode: 'message' | 'stack' | undefined
  let paragraph = false

  for (const [index, line] of lines.entries()) {
    const head = HEAD.exec(line)
    if (head) {
      const [, kind, file, row] = head
      current = {
        file,
        line: Number(row),
        severity: kind.endsWith('Error') ? 'error' : 'warning',
        message: '',
        source: 'cmake',
        output: { start: index, end: index + 1 },
      }
      problems.push(current)
      mode = 'message'
      paragraph = false
      continue
    }
    if (!current) continue
    if (/^\S/.test(line) && line !== 'Call Stack (most recent call first):') {
      current = undefined
      mode = undefined
      continue
    }
    if (current.output) current.output.end = index + 1
    if (mode === 'message') {
      // wrapped at ~77 columns
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
    else if (line.trim()) {
      mode = undefined
      current = undefined
    }
  }
  return problems
}
