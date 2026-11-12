import type { Problem, Severity } from '../problem'

// `Main.java:5: error: msg`
const HEAD = /^(.+\.java):(\d+): (error|warning): (?:\[([\w-]+)\] )?(.*)$/
const MAVEN = /^\[(ERROR|WARNING)\] (.+\.java):\[(\d+),(\d+)\] (.*)$/
const CARET = /^\s*\^$/

const SEVERITY: Record<string, Severity> = { error: 'error', warning: 'warning' }

export function javac(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let current: Problem | undefined
  let state: 'source' | 'caret' | 'detail' = 'detail'
  let indent = 0

  for (const [index, raw] of lines.entries()) {
    const maven = MAVEN.exec(raw)
    if (maven) {
      problems.push({
        file: maven[2],
        line: Number(maven[3]),
        col: Number(maven[4]),
        severity: maven[1] === 'ERROR' ? 'error' : 'warning',
        message: maven[5],
        source: 'javac',
        output: { start: index, end: index + 1 },
      })
      current = undefined
      continue
    }
    let line = raw.trimStart()
    const head = HEAD.exec(line)
    if (head) {
      indent = raw.length - line.length
      current = {
        file: head[1],
        line: Number(head[2]),
        severity: SEVERITY[head[3]],
        code: head[4],
        message: head[5],
        source: 'javac',
        output: { start: index, end: index + 1 },
      }
      problems.push(current)
      state = 'source'
      continue
    }
    if (!current) continue
    line = raw.slice(indent)
    if (current.output) current.output.end = index + 1

    if (state === 'source') {
      state = 'caret'
      continue
    }
    // caret index is the column
    if (state === 'caret' && CARET.test(line)) {
      current.col = line.indexOf('^') + 1
      state = 'detail'
      continue
    }
    state = 'detail'
    if (line.startsWith('  ')) current.message += `\n${line.slice(2)}`
    else current = undefined
  }
  // build tools repeat diagnostics in their failure summaries
  const seen = new Set<string>()
  return problems.filter((p) => {
    const key = JSON.stringify([p.file, p.line, p.col, p.severity, p.code, p.message])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
