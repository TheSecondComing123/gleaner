import type { Problem, Severity } from '../problem'

// `src/a.ts:3:5 lint/suspicious/noDebugger  FIXABLE  ━━━━`, then `  × msg` after a blank line
// (`✖`, `⚠` and `ℹ` in color).
// Whole-file diagnostics like `src/a.ts format ━━━━` have no position.
const HEAD = /^(.+?)(?::(\d+):(\d+))? ([\w/]+)(?: {2}FIXABLE )? ━+$/
const MESSAGE = /^ {2}([×!i✖⚠ℹ]) (.*)$/

const SEVERITY: Record<string, Severity> = {
  '×': 'error',
  '✖': 'error',
  '!': 'warning',
  '⚠': 'warning',
  i: 'info',
  ℹ: 'info',
}

export function biome(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let head: RegExpExecArray | undefined
  let current: Problem | undefined

  for (const line of lines) {
    const match = HEAD.exec(line)
    if (match) {
      head = match
      current = undefined
      continue
    }
    if (current) {
      // The message runs until the blank `  ` line before its code frame.
      if (line.trim()) current.message += `\n${line.trim()}`
      else current = undefined
      continue
    }
    const message = head && MESSAGE.exec(line)
    if (!head || !message) continue
    current = {
      file: head[1],
      line: head[2] ? Number(head[2]) : 1,
      col: head[3] ? Number(head[3]) : undefined,
      severity: SEVERITY[message[1]],
      message: message[2],
      code: head[4],
      source: 'biome',
    }
    problems.push(current)
    head = undefined
  }
  return problems
}
