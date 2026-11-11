import type { Problem, Severity } from '../problem'

// default tty format
const HEAD = /^In (.+) line (\d+):$/
const CARET = /^( *)\^-*\^? (SC\d+) \((error|warning|info|style)\): (.*)$/
// `-f gcc`
const GCC = /^(.+?):(\d+):(\d+): (error|warning|note): (.*) \[(SC\d+)\]$/

const SEVERITY: Record<string, Severity> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
  style: 'info',
  note: 'info',
}

// tabs expand to 8
function column(source: string, caret: number): number {
  let visual = 0
  for (let i = 0; i < source.length; i++) {
    if (visual >= caret) return i + 1
    visual = source[i] === '\t' ? visual - (visual % 8) + 8 : visual + 1
  }
  return source.length + 1
}

export function shellcheck(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let at: { file: string; line: number; source?: string } | undefined

  for (const line of lines) {
    const gcc = GCC.exec(line)
    if (gcc) {
      const [, file, row, col, kind, message, code] = gcc
      problems.push({
        file,
        line: Number(row),
        col: Number(col),
        severity: SEVERITY[kind],
        message,
        code,
        source: 'shellcheck',
      })
      continue
    }
    const head = HEAD.exec(line)
    if (head) {
      at = { file: head[1], line: Number(head[2]) }
      continue
    }
    if (!at) continue
    if (at.source === undefined) {
      at.source = line
      continue
    }
    const caret = CARET.exec(line)
    if (!caret) {
      at = undefined
      continue
    }
    const [, indent, code, kind, message] = caret
    problems.push({
      file: at.file,
      line: at.line,
      col: column(at.source, indent.length),
      severity: SEVERITY[kind],
      message,
      code,
      source: 'shellcheck',
    })
  }
  return problems
}
