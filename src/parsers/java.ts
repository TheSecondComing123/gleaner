import type { Problem } from '../problem'

// `Exception in thread`, `Caused by:`
const HEAD = /^(?:Exception in thread "[^"]*" |Caused by: )(.+)$/
// `(Native Method)` has no line
const FRAME = /^\s+at (.+)\(([^():/\\]+):(\d+)\)$/
// JDK frames
const LIBRARY = /^(?:[^/]*\/)*(?:java|javax|jdk|sun|com\.sun)\./
const TEST_LIBRARY = /^org\.(?:junit|opentest4j|gradle|apache\.maven)\./
const SUREFIRE = /^\[ERROR\] (\S+) -- Time elapsed: .* <<< (?:FAILURE|ERROR)!$/
const GRADLE = /^(\S.* > .+) FAILED$/
const GRADLE_FRAME = /^\s+(.+) at ([^():/\\]+\.java):(\d+)$/

interface Frame {
  file: string
  line: number
  fn: string
}

export function java(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let message: string | undefined
  let frames: Frame[] = []
  let test: string | undefined
  let gradle = false

  const flush = () => {
    const user = frames.filter((f) => !LIBRARY.test(f.fn) && (!test || !TEST_LIBRARY.test(f.fn)))
    const at = user[0] ?? frames[0]
    if (message !== undefined && at) {
      const problem: Problem = {
        file: at.file,
        line: at.line,
        severity: 'error',
        message: test ? `${test}\n${message}` : message,
        source: 'java',
      }
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
    test = undefined
    gradle = false
  }

  for (const line of lines) {
    const surefire = SUREFIRE.exec(line)
    const failure = GRADLE.exec(line)
    const title = surefire?.[1] ?? failure?.[1]
    if (title) {
      flush()
      test = title
      gradle = Boolean(failure)
      message = ''
      continue
    }
    if (gradle) {
      const location = GRADLE_FRAME.exec(line)
      if (location && test) {
        message = location[1]
        frames.push({ fn: test, file: location[2], line: Number(location[3]) })
      }
      flush()
      continue
    }
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
    if (!frames.length && (!test || (!/^\[(?:INFO|ERROR|WARNING)\]/.test(line) && line.trim())))
      message += `${message ? '\n' : ''}${line}`
    else flush()
  }
  flush()
  return problems
}
