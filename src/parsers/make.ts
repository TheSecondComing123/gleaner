import type { Problem } from '../problem'

// make's own errors only
const LINE = /^((?:.*[\\/])?(?:GNUmakefile|[Mm]akefile)|.+\.mk):(\d+): (\*\*\* )?(.+?)(?:\.\s+Stop\.)?$/

export function make(lines: string[]): Problem[] {
  const problems: Problem[] = []
  for (const [index, line] of lines.entries()) {
    const m = LINE.exec(line)
    if (m)
      problems.push({
        file: m[1],
        line: Number(m[2]),
        severity: m[3] ? 'error' : 'warning',
        message: m[4],
        source: 'make',
        output: { start: index, end: index + 1 },
      })
  }
  return problems
}
