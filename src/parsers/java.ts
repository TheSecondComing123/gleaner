import type { Problem } from '../problem'

// `Exception in thread`, `Caused by:`
const HEAD = /^(?:Exception in thread "[^"]*" |Caused by: )(.+)$/
// `(Native Method)` has no line
const FRAME = /^\s+at (.+)\(([^():/\\]+):(\d+)\)$/
// JDK frames
const LIBRARY = /^(?:[^/]*\/)*(?:java|javax|jdk|sun|com\.sun)\./

interface Frame {
  file: string
  line: number
  fn: string
}

export function java(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let message: string | undefined
  let frames: Frame[] = []

  const flush = () => {
    const user = frames.filter((f) => !LIBRARY.test(f.fn))
    const at = user[0] ?? frames[0]
    if (message !== undefined && at) {
      const problem: Problem = { file: at.file, line: at.line, severity: 'error', message, source: 'java' }
      // recursion repeats frames
      const seen = new Set([`${at.file}:${at.line}`])
      for (const f of user) {
        const key = `${f.file}:${f.line}`
        if (seen.has(key)) continue
        seen.add(key)
        problem.related = [
          ...(problem.related ?? []),
          { file: f.file, line: f.line, message: `called from here, in ${f.fn}` },
        ]
      }
      problems.push(problem)
    }
    message = undefined
    frames = []
  }

  for (const line of lines) {
    const head = HEAD.exec(line)
    if (head) {
      flush()
      message = head[1]
      continue
    }
    if (message === undefined) continue
    const frame = FRAME.exec(line)
    if (frame) {
      frames.push({ fn: frame[1], file: frame[2], line: Number(frame[3]) })
      continue
    }
    if (/^\s+\.\.\. \d+ more$/.test(line)) continue
    // multi-line message
    if (!frames.length) message += `\n${line}`
    else flush()
  }
  flush()
  return problems
}
