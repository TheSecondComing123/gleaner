import type { Problem } from '../problem'

// `Exception in thread "main" java.lang.IllegalStateException: msg` or `Caused by: ...`, then
// `\tat Main.load(Main.java:10)` frames, innermost first. Each exception in the chain is one problem.
const HEAD = /^(?:Exception in thread "[^"]*" |Caused by: )(.+)$/
// Only the file name, no path; `(Native Method)` and `(Unknown Source)` have no line.
const FRAME = /^\s+at (.+)\(([^():/\\]+):(\d+)\)$/
// `java.base/java.lang.Integer.parseInt`, `jdk.compiler/com.sun...`, and Java 8's unprefixed `java.lang...`.
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
      // Recursion repeats the same frame, so keep each spot once.
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
    // `... 1 more` points back at the frames of the exception above.
    if (/^\s+\.\.\. \d+ more$/.test(line)) continue
    // Before the first frame, more lines belong to a multi-line exception message.
    if (!frames.length) message += `\n${line}`
    else flush()
  }
  flush()
  return problems
}
