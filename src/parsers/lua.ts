import type { Problem } from '../problem'

// `lua: a.lua:3: attempt to index a nil value`. The prefix is how it was run: `luajit:`, `luac:`, `/usr/bin/lua5.4:`.
const HEAD = /^\S*?\blua(?:jit|c)?[\d.]*(?:\.exe)?: (.*)$/
const AT = /^(.+?):(\d+): (.*)$/
// `\ta.lua:6: in local 'run'`, after `stack traceback:`. C frames (`[C]: in ?`) have no line.
const FRAME = /^\t(.+?):(\d+): (in .*)$/
// luarocks trees (`/usr/local/share/lua/5.4/`, `C:\luarocks\...`), and chunks that aren't files:
// `[string "x = 1"]`, `(command line)`.
const LIBRARY = /[\\/]share[\\/]lua[\\/]|[\\/]luarocks[\\/]|^[[(]/

interface Frame {
  file: string
  line: number
  fn: string
}

export function lua(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let crash: { message: string; at?: Frame; frames: Frame[] } | undefined

  const finish = () => {
    if (!crash) return
    const user = crash.frames.filter((f) => !LIBRARY.test(f.file))
    // The message names where the error was raised, which `error(msg, 2)` moves to the caller.
    const at = crash.at && !LIBRARY.test(crash.at.file) ? crash.at : user[0]
    if (at) {
      const problem: Problem = {
        file: at.file,
        line: at.line,
        severity: 'error',
        message: crash.message,
        source: 'lua',
      }
      // Recursion repeats the same frame, so keep each spot once.
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

  for (const line of lines) {
    const head = HEAD.exec(line)
    if (head) {
      finish()
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
