import type { Problem } from '../problem'

// `error during build:` … `file: a.ts:1:9`
const START = /^error during build:$/
const FILE = /^file: (.+?)(?::(\d+):(\d+))?$/
// rollup's position prefix
const POSITION = /^.+? \(\d+:\d+\): /

export function vite(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let output: Problem['output']
  let message: string[] | undefined
  for (const [index, line] of lines.entries()) {
    if (START.test(line)) {
      output = { start: index, end: index + 1 }
      message = []
      continue
    }
    if (output) output.end = index + 1
    if (!message) continue
    const file = FILE.exec(line)
    if (file) {
      problems.push({
        file: file[1],
        line: file[2] ? Number(file[2]) : 1,
        // 0-based columns
        col: file[3] ? Number(file[3]) + 1 : undefined,
        severity: 'error',
        message: message.join('\n').replace(POSITION, ''),
        source: 'vite',
        output,
      })
      message = undefined
    } else if (line) message.push(line)
    // blank line: no location
    else message = undefined
  }
  return problems
}
