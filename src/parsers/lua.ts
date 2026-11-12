import type { Problem } from '../problem'

// `lua: a.lua:3: msg`
const HEAD = /^\S*?\blua(?:jit|c)?[\d.]*(?:\.exe)?: (.*)$/
const AT = /^(.+?):(\d+): (.*)$/
// traceback frames
const FRAME = /^\t(.+?):(\d+): (in .*)$/
// luarocks and non-file chunks
const LIBRARY = /[\\/]share[\\/]lua[\\/]|[\\/]luarocks[\\/]|^[[(]/

interface Frame {
  file: string
  line: number
  fn: string
}

export function lua(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let index = 0
  let start = 0
  let crash: { message: string; at?: Frame; frames: Frame[] } | undefined

  const finish = () => {
    if (!crash) return
    const user = crash.frames.filter((f) => !LIBRARY.test(f.file))
    // `error(msg, 2)` moves it
    const at = crash.at && !LIBRARY.test(crash.at.file) ? crash.at : user[0]
    if (at) {
      const problem: Problem = {
        file: at.file,
        line: at.line,
        severity: 'error',
        message: crash.message,
        source: 'lua',
        output: { start, end: index },
      }
      // recursion repeats frames
      const seen = new Set([`${at.file}:${at.line}`])
      for (const f of user) {
        const key = `${f.file}:${f.line}`
        if (seen.has(key)) continue
        seen.add(key)
        problem.related = [
          ...(problem.related ?? []),
          { file: f.file, line: f.line, message: `called from here, ${f.fn}` },
        ]
      }
      problems.push(problem)
    }
    crash = undefined
  }

  for (index = 0; index < lines.length; index++) {
    const line = lines[index]
    const head = HEAD.exec(line)
    if (head) {
      finish()
      start = index
      const at = AT.exec(head[1])
      crash = at
        ? { message: at[3], at: { file: at[1], line: Number(at[2]), fn: '' }, frames: [] }
        : { message: head[1], frames: [] }
      continue
    }
    if (!crash) continue
    const frame = FRAME.exec(line)
    if (frame) crash.frames.push({ file: frame[1], line: Number(frame[2]), fn: frame[3] })
    else if (line !== 'stack traceback:' && !line.startsWith('\t')) finish()
  }
  finish()
  return problems
}
