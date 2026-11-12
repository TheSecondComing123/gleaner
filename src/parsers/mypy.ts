import type { Problem, Related } from '../problem'

// `x.py:3: error: msg  [code]`
const HEAD = /^(.+?\.pyi?):(\d+):(?:(\d+):)? (error|note): (.*)$/
const CODE = / {2}\[([\w-]+)\]$/
// --pretty wraps messages
const STOP = /^(Found \d+ errors? in|Success: |.+?: (?:note|error): )/

export function mypy(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let target: Problem | Related | undefined

  for (const [index, line] of lines.entries()) {
    const head = HEAD.exec(line)
    if (!head) {
      const current = problems.at(-1)
      if (current?.output && line.startsWith(' ')) current.output.end = index + 1
      if (target && line && !line.startsWith(' ') && !STOP.test(line)) {
        target.message += ` ${line}`
        const last = problems.at(-1)
        if (last?.output) last.output.end = index + 1
      } else target = undefined
      continue
    }
    const [, file, row, col, kind, message] = head
    const at = { file, line: Number(row), col: col ? Number(col) : undefined }
    const last = problems.at(-1)
    // notes join their error
    if (kind === 'note' && last && last.file === at.file && last.line === at.line) {
      if (last.output) last.output.end = index + 1
      target = { ...at, message }
      last.related = [...(last.related ?? []), target]
      continue
    }
    const problem: Problem = {
      ...at,
      severity: kind === 'note' ? 'info' : 'error',
      message,
      source: 'mypy',
      output: { start: index, end: index + 1 },
    }
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
