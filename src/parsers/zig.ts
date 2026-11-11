import type { Problem } from '../problem'

// Compile errors are gcc-shaped and go to the gcc parser. This reads the stack traces zig prints for
// panics, errors returned from main and failed tests: `/abs/main.zig:4:17: 0x100cd972b in get (app)`,
// then the source line and a caret. `zig build test` indents the whole trace.
const FRAME = /^\s*(.+?):(\d+):(\d+): 0x[\da-f]+ in (.+) \(.+\)$/
const CARET = /^\s*\^$/
// The standard library and test runner (`lib/zig/std` from a package manager, `lib/std` from a
// tarball) and fetched packages in the global cache (`zig/p/<hash>`).
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
    // The message is the block right above the trace: `thread 1 panic: msg`, `error: InvalidCharacter`,
    // or `error: 'main.test.x' failed:` with its indented `expected 4, found 6`.
    const start = Math.max(
      before.findLastIndex((l) => !/^\s/.test(l)),
      0,
    )
    const message = before
      .slice(start)
      .map((l) => l.trim())
      .join('\n')
      .replace(/^thread \d+ panic: /, 'panic: ')
    // Innermost frame first; the problem goes on the innermost one in user code.
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
    // A frame's source line and caret.
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
