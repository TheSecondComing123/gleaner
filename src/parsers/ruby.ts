import type { Problem } from '../problem'

// `a.rb:3:in 'Object#greet': msg (NoMethodError)`, then `\tfrom a.rb:6:in '<main>'` frames.
// Ruby before 3.4 quotes the method as `greet'.
const HEAD = /^(.+?):(\d+):in [`']([^`']*)': (.*)$/
const FROM = /^\tfrom (.+?):(\d+):in [`'](.*)'$/
// `ruby -c` puts ruby's own path in front. Prism says `syntax errors found` and annotates the code
// below; parse.y prints one `a.rb:3: syntax error, unexpected 'end'` line per error.
const SYNTAX = /^(?:\S*ruby[\d.]*(?:\.exe)?: )?(.+?):(\d+): (syntax error.*?)(?: \(SyntaxError\))?$/
// Prism's snippet: `> 5 | end` marks a line with errors, `    | ^~~ unexpected 'end'` points into it.
const SOURCE = /^> +(\d+) \| /
const NOTE = /^ +\| ( *)\^~* (.+)$/
// Unix `/lib/ruby/3.4.0/`, Windows `C:\Ruby34-x64\lib\ruby\`, any installed gem, `<internal:kernel>`.
const LIBRARY = /[\\/]lib[\\/]ruby[\\/]|[\\/]gems[\\/]|^<internal:/

interface Frame {
  file: string
  line: number
  fn: string
}

export function ruby(lines: string[]): Problem[] {
  const problems: Problem[] = []
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
      }
      // A block and the iterator that ran it share a line, so keep each spot once.
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
    // Without a snippet to read, the header line is all prism gave us.
    if (syntax && !syntax.notes)
      problems.push({
        file: syntax.file,
        line: syntax.line,
        severity: 'error',
        message: syntax.message,
        source: 'ruby',
      })
    crash = undefined
    syntax = undefined
  }

  for (const line of lines) {
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
        })
      }
      if (src || note) continue
    }
    const head = HEAD.exec(line)
    const err = !head && SYNTAX.exec(line)
    if (head || err) finish()
    if (head) crash = { message: head[4], frames: [{ file: head[1], line: Number(head[2]), fn: head[3] }] }
    else if (err) {
      if (err[3].startsWith('syntax errors found'))
        syntax = { file: err[1], line: Number(err[2]), message: err[3], notes: 0 }
      else problems.push({ file: err[1], line: Number(err[2]), severity: 'error', message: err[3], source: 'ruby' })
    }
  }
  finish()
  return problems
}
