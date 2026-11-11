import type { Problem } from '../problem'

// `vite build` failing in its bundler: `error during build:`, the message, then `file: /abs/a.ts:1:9`.
const START = /^error during build:$/
const FILE = /^file: (.+?)(?::(\d+):(\d+))?$/
// Rollup puts the position in front of its message too: `src/main.ts (1:9): "x" is not exported by ...`
const POSITION = /^.+? \(\d+:\d+\): /

export function vite(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let message: string[] | undefined
  for (const line of lines) {
    if (START.test(line)) {
      message = []
      continue
    }
    if (!message) continue
    const file = FILE.exec(line)
    if (file) {
      problems.push({
        file: file[1],
        line: file[2] ? Number(file[2]) : 1,
        // Rollup counts columns from 0.
        col: file[3] ? Number(file[3]) + 1 : undefined,
        severity: 'error',
        message: message.join('\n').replace(POSITION, ''),
        source: 'vite',
      })
      message = undefined
    } else if (line) message.push(line)
    // The `file:` line comes right after the message; a blank line means this error has none.
    else message = undefined
  }
  return problems
}
