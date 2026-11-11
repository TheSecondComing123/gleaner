import type { Problem } from '../problem'

// stack traces; errors go to gcc
const FRAME = /^\s*(.+?):(\d+):(\d+): 0x[\da-f]+ in (.+) \(.+\)$/
const CARET = /^\s*\^$/
// stdlib and package cache
const LIBRARY = /[\\/]lib[\\/](?:zig[\\/])?(?:std|compiler)[\\/]|[\\/]zig[\\/]p[\\/]/

interface Frame {
  file: string
  line: number
  col: number
  fn: string
}

export function zig(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let before: string[] = []
  let frames: Frame[] = []

  const flush = () => {
    // message: block above the trace
    const start = Math.max(
      before.findLastIndex((l) => !/^\s/.test(l)),
      0,
    )
    const message = before
      .slice(start)
      .map((l) => l.trim())
      .join('\n')
      .replace(/^thread \d+ panic: /, 'panic: ')
    // innermost user frame
    const user = frames.filter((f) => !LIBRARY.test(f.file))
    const at = user[0] ?? frames[0]
    const problem: Problem = { file: at.file, line: at.line, col: at.col, severity: 'error', message, source: 'zig' }
    const seen = new Set([`${at.file}:${at.line}`])
    for (const f of user) {
      const key = `${f.file}:${f.line}`
      if (seen.has(key)) continue
      seen.add(key)
      problem.related = [
        ...(problem.related ?? []),
        { file: f.file, line: f.line, col: f.col, message: `called from here, in ${f.fn}` },
      ]
    }
    problems.push(problem)
    frames = []
    before = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const frame = FRAME.exec(line)
    if (frame) {
      frames.push({ file: frame[1], line: Number(frame[2]), col: Number(frame[3]), fn: frame[4] })
      continue
    }
    // source line and caret
    if (frames.length && CARET.test(lines[i + 1] ?? '')) {
      i++
      continue
    }
    if (frames.length) flush()
    if (line.trim()) before.push(line)
  }
  if (frames.length) flush()
  return problems
}
