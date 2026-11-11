import type { Problem } from '../problem'

// make's own errors, not its recipes': `Makefile:2: *** missing separator.  Stop.` and
// `$(warning ...)` lines like `rules.mk:2: X is 1`. Only makefile names count, so a compiler's
// `main.c:3: ...` is left to its parser.
const LINE = /^((?:.*[\\/])?(?:GNUmakefile|[Mm]akefile)|.+\.mk):(\d+): (\*\*\* )?(.+?)(?:\.\s+Stop\.)?$/

export function make(lines: string[]): Problem[] {
  const problems: Problem[] = []
  for (const line of lines) {
    const m = LINE.exec(line)
    if (m)
      problems.push({
        file: m[1],
        line: Number(m[2]),
        severity: m[3] ? 'error' : 'warning',
        message: m[4],
        source: 'make',
      })
  }
  return problems
}
