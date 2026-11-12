import type { Problem, Related } from '../problem'
import { fromFileUrl } from '../resolve'

// `deno check`
const TS_HEAD = /^(TS\d+) \[(ERROR|WARNING)\]: (.*)$/
// `deno run`
const ERROR_HEAD = /^error: (?:Uncaught (?:\(in promise\) )?)?(.*)$/
const FRAME = /^\s+at (?:async )?(?:(.+?) \()?(\S+?):(\d+):(\d+)\)?$/
const UNDERLINE = /^\s*[~^]+$/
// `deno lint`
const LINT_HEAD = /^error\[([a-z][a-z-]*)\]: (.*)$/
const ARROW = /^\s*--> (.+):(\d+):(\d+)$/

export function deno(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let output: Problem['output']
  let current: Problem | undefined
  let body: string[] = []
  let note: string | undefined

  for (const [index, line] of lines.entries()) {
    const ts = TS_HEAD.exec(line)
    const error = !ts && ERROR_HEAD.exec(line)
    const lint = !ts && !error && LINT_HEAD.exec(line)
    const head: Pick<Problem, 'severity' | 'message' | 'code'> | undefined = ts
      ? { severity: ts[2] === 'ERROR' ? 'error' : 'warning', message: ts[3], code: ts[1] }
      : error
        ? { severity: 'error', message: error[1] }
        : lint
          ? { severity: 'error', message: lint[2], code: lint[1] }
          : undefined
    if (head) {
      output = { start: index, end: index + 1 }
      current = { file: '', line: 0, col: 0, ...head, source: 'deno', output }
      body = []
      note = undefined
      continue
    }
    if (/^\S/.test(line) && (!current || current.file)) {
      current = undefined
      output = undefined
      continue
    }
    if (output) output.end = index + 1
    if (!current) continue

    const arrow = ARROW.exec(line)
    if (arrow && current.code && !current.file) {
      Object.assign(current, { file: arrow[1], line: Number(arrow[2]), col: Number(arrow[3]) })
      problems.push(current)
      current = undefined
      continue
    }

    const frame = FRAME.exec(line)
    if (frame) {
      const at = frame[2].startsWith('file://')
        ? { file: fromFileUrl(frame[2]), line: Number(frame[3]), col: Number(frame[4]) }
        : undefined
      if (at && !current.file) {
        Object.assign(current, at)
        if (current.code) {
          const extra = UNDERLINE.test(body.at(-1) ?? '') ? body.slice(0, -2) : body
          current.message = [current.message, ...extra.map((l) => l.slice(2))].join('\n')
        }
        problems.push(current)
      } else if (at && current.file) {
        const related: Related = { ...at, message: note ?? (current.code ? '' : (frame[1] ?? '')) }
        current.related = [...(current.related ?? []), related]
      }
      note = undefined
      continue
    }
    if (!current.file) body.push(line)
    else if (/^\S/.test(line)) current = undefined
    else if (line.trim() && note === undefined && current.code) note = line.trim()
  }
  return problems
}
