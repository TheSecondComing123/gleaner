import type { Problem, Severity } from '../problem'

// `error[E0308]: msg` then ` --> src/main.rs:4:18`. Headers with no `-->` after them
// (`error: could not compile`, `warning: \`x\` generated 2 warnings`) are summaries, not problems.
const HEAD = /^(error|warning)(?:\[(\w+)\])?: (.*)$/
// Unindented `note:`/`help:` after a problem; only the ones with their own `-->` become related info.
const SUB = /^(?:note|help): (.*)$/
const ARROW = /^\s*--> (.+):(\d+):(\d+)$/
// Lint name from `= note: \`#[warn(clippy::len_zero)]\` on by default`; rustc prints it once per lint.
const LINT = /^\s*= note: `#\[(?:warn|deny|forbid)\(([\w:]+)\)\]`/
// cargo test / cargo run: `thread 'tests::adds' (7997879) panicked at src/util.rs:13:9:`, message below.
const PANIC = /^thread '.*'(?: \(\d+\))? panicked at (.+):(\d+):(\d+):$/

export function rustc(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let pending: { severity: Severity; code?: string; message: string } | undefined
  let current: Problem | undefined
  let sub: string | undefined
  let panic: Problem | undefined

  for (const line of lines) {
    if (panic) {
      if (line && !line.startsWith('note: ')) {
        panic.message = panic.message ? `${panic.message}\n${line}` : line
        continue
      }
      panic = undefined
    }

    const head = HEAD.exec(line)
    if (head) {
      pending = { severity: head[1] as Severity, code: head[2], message: head[3] }
      current = undefined
      sub = undefined
      continue
    }

    const p = PANIC.exec(line)
    if (p) {
      panic = { file: p[1], line: Number(p[2]), col: Number(p[3]), severity: 'error', message: '', source: 'rustc' }
      problems.push(panic)
      current = undefined
      pending = undefined
      continue
    }

    const arrow = ARROW.exec(line)
    if (arrow) {
      const [, file, row, col] = arrow
      if (pending) {
        current = { file, line: Number(row), col: Number(col), ...pending, source: 'rustc' }
        problems.push(current)
        pending = undefined
      } else if (current && sub !== undefined) {
        current.related = [...(current.related ?? []), { file, line: Number(row), col: Number(col), message: sub }]
        sub = undefined
      }
      continue
    }
    if (!current) continue

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
