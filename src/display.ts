export interface Position {
  line: number
  character: number
}

export interface Shown {
  range: { start: Position }
  message: string
  code?: string | number | { value: string | number }
}

export interface Change {
  range: { start: Position; end: Position }
  text: string
}

// `TS2322`, `2322` and `{ value: 2322 }` are the same code: tsc prints the prefix, the typescript
// extension reports the number. Other prefixes mean something (`E0611` isn't `W0611`).
export function normalizeCode(code: Shown['code']): string | undefined {
  if (code === undefined) return undefined
  const value = String(typeof code === 'object' ? code.value : code)
  return value.replace(/^TS(?=\d+$)/i, '').toLowerCase()
}

const at = (d: Shown) => `${d.range.start.line}:${d.range.start.character}`
const firstLine = (d: Shown) => d.message.split('\n')[0]

function sameProblem(a: Shown, b: Shown): boolean {
  if (at(a) !== at(b)) return false
  const [codeA, codeB] = [normalizeCode(a.code), normalizeCode(b.code)]
  return codeA !== undefined && codeB !== undefined ? codeA === codeB : firstLine(a) === firstLine(b)
}

// What to show for one file: every run's problems once, minus what another source already reports.
export function display<T extends Shown>(runs: T[][], others: Shown[]): T[] {
  const seen = new Set<string>()
  const shown: T[] = []
  for (const problems of runs) {
    for (const problem of problems) {
      const key = `${at(problem)}|${normalizeCode(problem.code)}|${problem.message}`
      if (seen.has(key)) continue
      seen.add(key)
      if (!others.some((other) => sameProblem(other, problem))) shown.push(problem)
    }
  }
  return shown
}

const compare = (a: Position, b: Position) => a.line - b.line || a.character - b.character

// Where `p` ends up after one edit; undefined when the edit replaced its text.
export function mapPosition(p: Position, change: Change): Position | undefined {
  const { start, end } = change.range
  if (compare(p, start) < 0) return p
  if (compare(p, end) < 0) return undefined
  const lines = change.text.split('\n')
  const last = lines[lines.length - 1]
  const newEnd =
    lines.length === 1
      ? { line: start.line, character: start.character + last.length }
      : { line: start.line + lines.length - 1, character: last.length }
  return p.line === end.line
    ? { line: newEnd.line, character: newEnd.character + p.character - end.character }
    : { line: p.line + newEnd.line - end.line, character: p.character }
}
