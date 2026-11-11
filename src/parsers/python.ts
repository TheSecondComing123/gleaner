import type { Problem } from '../problem'

// `  File "x.py", line 4, in fn`
export const FRAME = /^ {2}File "(.+)", line (\d+)(?:, in (.+))?$/
const START = /^(?:Exception Group )?Traceback \(most recent call last\):$/
// starts the next traceback
const BREAK =
  /^((?:Exception Group )?Traceback \(most recent call last\):|During handling of the above exception|The above exception was the direct cause)/
// ExceptionGroup tree
const GROUP_START = /^ *\+ Exception Group Traceback/
const GROUP_PREFIX = /^ *[+|](?: |$)/
const GROUP_RULE = /^ *\+-/
// stdlib and site-packages
export const LIBRARY = /\/lib\/python|[\\/]Lib[\\/]|site-packages|^<frozen |^<string>$/

interface Frame {
  file: string
  line: number
  fn?: string
}

export function python(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let frames: Frame[] = []
  let current: Problem | undefined
  let group = false

  for (const raw of lines) {
    // `+ ` is decoration only in a group
    if (GROUP_START.test(raw)) group = true
    else if (group && !GROUP_PREFIX.test(raw) && !GROUP_RULE.test(raw)) group = false
    const line = !group ? raw : GROUP_RULE.test(raw) ? '' : raw.replace(GROUP_PREFIX, '')
    if (START.test(line)) {
      frames = []
      current = undefined
      continue
    }
    const frame = FRAME.exec(line)
    if (frame) {
      // bare SyntaxError frame
      current = undefined
      frames.push({ file: frame[1], line: Number(frame[2]), fn: frame[3] })
      continue
    }
    if (current) {
      if (!line || BREAK.test(line)) current = undefined
      else current.message += `\n${line}`
      continue
    }
    if (!frames.length || !line || line.startsWith(' ')) continue

    const user = frames.filter((f) => !LIBRARY.test(f.file))
    const at = user.at(-1) ?? (frames.at(-1) as Frame)
    current = { file: at.file, line: at.line, severity: 'error', message: line, source: 'python' }
    // recursion repeats frames
    const seen = new Set([`${at.file}:${at.line}`])
    for (const f of user.reverse()) {
      const key = `${f.file}:${f.line}`
      if (seen.has(key)) continue
      seen.add(key)
      current.related = [
        ...(current.related ?? []),
        { file: f.file, line: f.line, message: `called from here, in ${f.fn}` },
      ]
    }
    problems.push(current)
    frames = []
  }
  return problems
}
