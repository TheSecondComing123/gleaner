import type { Problem } from '../problem'

// `a.rb:3:in 'greet': msg (Error)`
const HEAD = /^(.+?):(\d+):in [`']([^`']*)': (.*)$/
const FROM = /^\tfrom (.+?):(\d+):in [`'](.*)'$/
// `ruby -c`: prism or parse.y
const SYNTAX = /^(?:\S*ruby[\d.]*(?:\.exe)?: )?(.+?):(\d+): (syntax error.*?)(?: \(SyntaxError\))?$/
// prism snippet
const SOURCE = /^> +(\d+) \| /
const NOTE = /^ +\| ( *)\^~* (.+)$/
// stdlib and gems
const LIBRARY = /[\\/]lib[\\/]ruby[\\/]|[\\/]gems[\\/]|^<internal:/

interface Frame {
  file: string
  line: number
  fn: string
}

export function ruby(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let index = 0
  let start = 0
  let crash: { message: string; frames: Frame[] } | undefined
  let syntax: { file: string; line: number; message: string; notes: number } | undefined
  let source = 0

  const finish = () => {
    if (crash) {
      const user = crash.frames.filter((f) => !LIBRARY.test(f.file))
      const at = user[0] ?? crash.frames[0]
      const problem: Problem = {
        file: at.file,
        line: at.line,
        severity: 'error',
        message: crash.message,
        source: 'ruby',
        output: { start, end: index },
      }
      // block and iterator share a line
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
    // no snippet: header only
    if (syntax && !syntax.notes)
      problems.push({
        file: syntax.file,
        line: syntax.line,
        severity: 'error',
        message: syntax.message,
        source: 'ruby',
        output: { start, end: index },
      })
    crash = undefined
    syntax = undefined
  }

  for (index = 0; index < lines.length; index++) {
    const line = lines[index]
    const from = FROM.exec(line)
    if (from) {
      crash?.frames.push({ file: from[1], line: Number(from[2]), fn: from[3] })
      continue
    }
    if (syntax) {
      const src = SOURCE.exec(line)
      const note = NOTE.exec(line)
      if (src) source = Number(src[1])
      else if (note) {
        syntax.notes++
        problems.push({
          file: syntax.file,
          line: source,
          col: note[1].length + 1,
          severity: 'error',
          message: note[2],
          source: 'ruby',
          output: { start, end: index + 1 },
        })
      }
      if (src || note) continue
    }
    const head = HEAD.exec(line)
    const err = !head && SYNTAX.exec(line)
    if (head || err) {
      finish()
      start = index
    }
    if (head) crash = { message: head[4], frames: [{ file: head[1], line: Number(head[2]), fn: head[3] }] }
    else if (err) {
      if (err[3].startsWith('syntax errors found'))
        syntax = { file: err[1], line: Number(err[2]), message: err[3], notes: 0 }
      else
        problems.push({
          file: err[1],
          line: Number(err[2]),
          severity: 'error',
          message: err[3],
          source: 'ruby',
          output: { start, end: index + 1 },
        })
    }
  }
  finish()
  return problems
}
