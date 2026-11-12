import type { Problem, Severity } from '../problem'

// `src/a.ts:3:5 lint/x/y ━━━`
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
  let output: Problem['output']
  let head: RegExpExecArray | undefined
  let current: Problem | undefined

  for (const [index, line] of lines.entries()) {
    const match = HEAD.exec(line)
    if (match) {
      output = { start: index, end: index + 1 }
      head = match
      current = undefined
      continue
    }
    if (/^\S/.test(line)) {
      output = undefined
      head = undefined
      current = undefined
      continue
    }
    if (output) output.end = index + 1
    if (current) {
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
      output,
    }
    problems.push(current)
    head = undefined
  }
  return problems
}
