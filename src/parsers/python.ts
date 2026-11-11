import type { Problem } from '../problem'

// `  File "x.py", line 4, in compute`. SyntaxError frames have no `, in fn`.
export const FRAME = /^ {2}File "(.+)", line (\d+)(?:, in (.+))?$/
const START = /^Traceback \(most recent call last\):$/
// Lines that end one traceback's exception message and lead into the next.
const BREAK =
  /^(Traceback \(most recent call last\):|During handling of the above exception|The above exception was the direct cause)/
// Unix `/lib/python3.x/`, Windows `C:\\Python313\\Lib\\`, any `site-packages`.
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

  for (const line of lines) {
    if (START.test(line)) {
      frames = []
      current = undefined
      continue
    }
    const frame = FRAME.exec(line)
    if (frame) {
      // A SyntaxError in the script itself prints a bare `File` line with no Traceback header.
      current = undefined
      frames.push({ file: frame[1], line: Number(frame[2]), fn: frame[3] })
      continue
    }
    if (current) {
      if (!line || BREAK.test(line)) current = undefined
      else current.message += `\n${line}`
      continue
    }
    // Code, carets and `[Previous line repeated N more times]` are all indented.
    if (!frames.length || !line || line.startsWith(' ')) continue

    const user = frames.filter((f) => !LIBRARY.test(f.file))
    const at = user.at(-1) ?? (frames.at(-1) as Frame)
    current = { file: at.file, line: at.line, severity: 'error', message: line, source: 'python' }
    // Innermost caller first; recursion repeats the same frame, so keep each spot once.
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
