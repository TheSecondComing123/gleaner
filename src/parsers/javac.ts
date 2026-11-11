import type { Problem, Severity } from '../problem'

// `Main.java:5: error: msg`, then the source line, a caret line, and indented detail lines.
// Lint warnings carry their category: `warning: [unchecked] msg`.
const HEAD = /^(.+\.java):(\d+): (error|warning): (?:\[([\w-]+)\] )?(.*)$/
const CARET = /^\s*\^$/

const SEVERITY: Record<string, Severity> = { error: 'error', warning: 'warning' }

export function javac(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let current: Problem | undefined
  let state: 'source' | 'caret' | 'detail' = 'detail'

  for (const line of lines) {
    const head = HEAD.exec(line)
    if (head) {
      current = {
        file: head[1],
        line: Number(head[2]),
        severity: SEVERITY[head[3]],
        code: head[4],
        message: head[5],
        source: 'javac',
      }
      problems.push(current)
      state = 'source'
      continue
    }
    if (!current) continue

    if (state === 'source') {
      state = 'caret'
      continue
    }
    // javac prints no column, but the caret line keeps the source line's tabs, so its index is the column.
    if (state === 'caret' && CARET.test(line)) {
      current.col = line.indexOf('^') + 1
      state = 'detail'
      continue
    }
    state = 'detail'
    if (line.startsWith('  ')) current.message += `\n${line.slice(2)}`
    else current = undefined
  }
  return problems
}
