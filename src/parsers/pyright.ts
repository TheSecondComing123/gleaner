import type { Problem, Severity } from '../problem'

// `  /abs/x.py:3:5 - error: msg (reportAssignmentType)`, under a bare `/abs/x.py` file header.
const HEAD = /^ {2}(\S.*?\.pyi?):(\d+):(\d+) - (error|warning|information): (.*)$/
// The rule name trails the last line of a message, which may be a continuation line.
const RULE = / \((report\w+)\)$/
// Continuation lines are indented with two spaces, then two no-break spaces per level.
const MORE = /^ {2}[\u00a0 ]{2}([\u00a0 ]*)(.*)$/

const SEVERITY: Record<string, Severity> = { error: 'error', warning: 'warning', information: 'info' }

export function pyright(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let current: Problem | undefined

  for (const line of lines) {
    const head = HEAD.exec(line)
    if (head) {
      current = {
        file: head[1],
        line: Number(head[2]),
        col: Number(head[3]),
        severity: SEVERITY[head[4]],
        message: head[5],
        source: 'pyright',
      }
      problems.push(current)
      continue
    }
    const more = MORE.exec(line)
    if (current && more) current.message += `\n${' '.repeat(more[1].length)}${more[2]}`
    else current = undefined
  }

  for (const problem of problems) {
    const rule = RULE.exec(problem.message)
    if (!rule) continue
    problem.message = problem.message.slice(0, rule.index)
    problem.code = rule[1]
  }
  return problems
}
