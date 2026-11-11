import type { Problem, Related } from '../problem'

// `x.py:3: error: msg  [code]`, with `x.py:3:5:` under --show-column-numbers.
const HEAD = /^(.+?):(\d+):(?:(\d+):)? (error|note): (.*)$/
const CODE = / {2}\[([\w-]+)\]$/
// --pretty wraps long messages onto unindented lines, then prints the code and caret indented.
// These unindented lines are not part of a wrapped message: the tally and
// --show-error-context's `x.py: note: In function "f":`.
const STOP = /^(Found \d+ errors? in|Success: |.+?: (?:note|error): )/

export function mypy(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let target: Problem | Related | undefined

  for (const line of lines) {
    const head = HEAD.exec(line)
    if (!head) {
      if (target && line && !line.startsWith(' ') && !STOP.test(line)) target.message += ` ${line}`
      else target = undefined
      continue
    }
    const [, file, row, col, kind, message] = head
    const at = { file, line: Number(row), col: col ? Number(col) : undefined }
    const last = problems.at(-1)
    // Notes about an error share its line. A note on its own line (reveal_type) stands alone.
    if (kind === 'note' && last && last.file === at.file && last.line === at.line) {
      target = { ...at, message }
      last.related = [...(last.related ?? []), target]
      continue
    }
    const problem: Problem = { ...at, severity: kind === 'note' ? 'info' : 'error', message, source: 'mypy' }
    problems.push(problem)
    target = problem
  }

  for (const problem of problems) {
    const code = CODE.exec(problem.message)
    if (!code) continue
    problem.message = problem.message.slice(0, code.index)
    problem.code = code[1]
  }
  return problems
}
