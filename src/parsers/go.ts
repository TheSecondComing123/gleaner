import type { Problem } from '../problem'

// `./main.go:5:2: msg`
// no column: only under `# pkg`
const BUILD = /^(.+?\.go):(\d+)(?::(\d+))?: (.*)$/
const PKG = /^# \S/
// test logs
const LOG = /^(\s+)(\S+\.go):(\d+): (.*)$/
const RESULT = /^\s*--- (PASS|FAIL|SKIP): (\S+)/
const RUN = /^=== (?:RUN|PAUSE|CONT|NAME)\s+(\S+)/
const PANIC = /^panic: (.*)$/
const FRAME = /^\t(.+\.go):(\d+)(?: \+0x[\da-f]+)?$/
const RUNTIME = /^(?:runtime\.|testing\.|panic\(|created by )/

export function go(lines: string[]): Problem[] {
  const problems: Problem[] = []
  // hold logs until the test's result
  const held = new Map<string, Problem[]>()
  let current = ''
  let failing = false
  let inPkg = false
  let last: { problem: Problem; prefix: string } | undefined
  let panic: string | undefined
  let caller = ''

  const add = (problem: Problem) => {
    if (failing) problems.push(problem)
    else held.set(current, [...(held.get(current) ?? []), problem])
  }

  for (const line of lines) {
    if (panic !== undefined) {
      const frame = FRAME.exec(line)
      if (frame && !RUNTIME.test(caller)) {
        problems.push({ file: frame[1], line: Number(frame[2]), severity: 'error', message: panic, source: 'go' })
        panic = undefined
      }
      caller = line
      continue
    }

    if (last && line.startsWith(last.prefix)) {
      last.problem.message += `\n${line.trim()}`
      continue
    }
    last = undefined

    const result = RESULT.exec(line)
    if (result) {
      failing = result[1] === 'FAIL'
      if (failing) problems.push(...(held.get(result[2]) ?? []))
      held.delete(result[2])
      continue
    }
    const run = RUN.exec(line)
    if (run) {
      current = run[1]
      failing = false
      continue
    }
    if (PKG.test(line)) {
      inPkg = true
      continue
    }

    const log = LOG.exec(line)
    if (log) {
      const problem: Problem = {
        file: log[2],
        line: Number(log[3]),
        severity: 'error',
        message: log[4],
        source: 'go',
      }
      add(problem)
      last = { problem, prefix: `${log[1]}    ` }
      continue
    }

    const build = BUILD.exec(line)
    if (build && (build[3] || inPkg)) {
      const problem: Problem = {
        file: build[1],
        line: Number(build[2]),
        col: build[3] ? Number(build[3]) : undefined,
        severity: 'error',
        message: build[4],
        source: 'go',
      }
      problems.push(problem)
      last = { problem, prefix: '\t' }
      continue
    }

    inPkg = false
    const p = PANIC.exec(line)
    if (p) {
      panic = p[1]
      caller = ''
    }
  }
  return problems
}
