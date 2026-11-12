import type { Problem, Severity } from '../problem'

// `error[E0308]: msg`, then `-->`
const HEAD = /^(error|warning)(?:\[(\w+)\])?: (.*)$/
// `note:`/`help:` with `-->`
const SUB = /^(?:note|help): (.*)$/
const ARROW = /^\s*--> (.+):(\d+):(\d+)$/
// lint name
const LINT = /^\s*= note: `#\[(?:warn|deny|forbid)\(([\w:]+)\)\]`/
// panics
const PANIC = /^thread '.*'(?: \(\d+\))? panicked at (.+):(\d+):(\d+):$/
// --message-format short
const SHORT = /^(.+\.rs):(\d+):(\d+): (error|warning)(?:\[(\w+)\])?: (.*)$/

export function rustc(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let start = 0
  let pending: { severity: Severity; code?: string; message: string } | undefined
  let current: Problem | undefined
  let sub: string | undefined
  let panic: Problem | undefined

  for (const [index, line] of lines.entries()) {
    if (panic) {
      if (panic.output) panic.output.end = index + 1
      if (line && !line.startsWith('note: ')) {
        panic.message = panic.message ? `${panic.message}\n${line}` : line
        continue
      }
      panic = undefined
    }

    const short = SHORT.exec(line)
    if (short) {
      const [, file, row, col, severity, code, message] = short
      problems.push({
        file,
        line: Number(row),
        col: Number(col),
        severity: severity as Severity,
        code,
        message,
        source: 'rustc',
        output: { start: index, end: index + 1 },
      })
      current = undefined
      pending = undefined
      continue
    }

    const head = HEAD.exec(line)
    if (head) {
      start = index
      pending = { severity: head[1] as Severity, code: head[2], message: head[3] }
      current = undefined
      sub = undefined
      continue
    }

    const p = PANIC.exec(line)
    if (p) {
      panic = {
        file: p[1],
        line: Number(p[2]),
        col: Number(p[3]),
        severity: 'error',
        message: '',
        source: 'rustc',
        output: { start: index, end: index + 1 },
      }
      problems.push(panic)
      current = undefined
      pending = undefined
      continue
    }

    const arrow = ARROW.exec(line)
    if (arrow) {
      if (current?.output) current.output.end = index + 1
      const [, file, row, col] = arrow
      if (pending) {
        current = {
          file,
          line: Number(row),
          col: Number(col),
          ...pending,
          source: 'rustc',
          output: { start, end: index + 1 },
        }
        problems.push(current)
        pending = undefined
      } else if (current && sub !== undefined) {
        current.related = [...(current.related ?? []), { file, line: Number(row), col: Number(col), message: sub }]
        sub = undefined
      }
      continue
    }
    if (!current) continue
    if (current.output) current.output.end = index + 1

    const s = SUB.exec(line)
    if (s) {
      sub = s[1]
      continue
    }
    const lint = LINT.exec(line)
    if (lint) current.code ??= lint[1]
  }
  return problems
}
