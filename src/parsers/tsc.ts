import type { Problem, Severity } from '../problem'

// `src/a.ts(4,7): error TS2322: msg` (plain) or `src/a.ts:4:7 - error TS2322: msg` (pretty).
// Shape follows VS Code's $tsc problem matcher (MIT).
const HEAD = /^(\S.*?)(?:\((\d+),(\d+)\): |:(\d+):(\d+) - )(error|warning|message) (TS\d+): (.*)$/
// Pretty mode prints related locations as `  src/a.ts:6:32`, then a code frame, then the message.
const RELATED = /^ {2}(\S.*?):(\d+):(\d+)$/
const FRAME = /^\s*(\d+ |~|$)/

const SEVERITY: Record<string, Severity> = { error: 'error', warning: 'warning', message: 'info' }

export function tsc(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let current: Problem | undefined
  let state: 'message' | 'frame' | 'related' = 'frame'

  for (const line of lines) {
    const head = HEAD.exec(line)
    if (head) {
      current = {
        file: head[1],
        line: Number(head[2] ?? head[4]),
        col: Number(head[3] ?? head[5]),
        severity: SEVERITY[head[6]],
        code: head[7],
        message: head[8],
        source: 'tsc',
      }
      problems.push(current)
      state = 'message'
      continue
    }
    if (!current) continue

    if (state === 'message' && line.startsWith('  ')) {
      current.message += `\n${line.slice(2)}`
      continue
    }
    if (state === 'message') state = 'frame'

    const related = RELATED.exec(line)
    if (related) {
      current.related = [
        ...(current.related ?? []),
        { file: related[1], line: Number(related[2]), col: Number(related[3]), message: '' },
      ]
      state = 'related'
      continue
    }
    if (state === 'related' && !FRAME.test(line)) {
      const last = current.related?.at(-1)
      if (last && !last.message) last.message = line.trim()
    }
  }
  return problems
}
