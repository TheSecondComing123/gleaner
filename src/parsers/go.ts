import type { Problem } from '../problem'

// Build and vet: `./main.go:5:2: msg`, paths relative to where `go` ran, under `# pkg` headers.
// Continuation lines (`have`/`want`) are tab-indented.
const BUILD = /^(.+?\.go):(\d+)(?::(\d+))?: (.*)$/
// Test logs: `    util_test.go:7: msg`, path relative to the package dir; continuations indent 4 more.
const LOG = /^(\s+)(\S+\.go):(\d+): (.*)$/
const RESULT = /^\s*--- (PASS|FAIL|SKIP): /
const RUN = /^=== (?:RUN|PAUSE|CONT|NAME) /
const PANIC = /^panic: (.*)$/
const FRAME = /^\t(.+\.go):(\d+)(?: \+0x[\da-f]+)?$/
// ponytail: guesses the panic site as the first frame outside these; a panic inside another stdlib package lands there
const RUNTIME = /^(?:runtime\.|testing\.|panic\(|created by )/

export function go(lines: string[]): Problem[] {
  const problems: Problem[] = []
  // `go test -v` prints a test's logs before its `--- PASS/FAIL`, so hold them until we know.
  let held: Problem[] = []
  let failing = false
  let last: { problem: Problem; prefix: string } | undefined
  let panic: string | undefined
  let caller = ''

  const add = (problem: Problem) => {
    if (failing) problems.push(problem)
    else held.push(problem)
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
      if (failing) problems.push(...held)
      held = []
      continue
    }
    if (RUN.test(line)) {
      failing = false
      held = []
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
    if (build) {
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

    const p = PANIC.exec(line)
    if (p) {
      panic = p[1]
      caller = ''
    }
  }
  return problems
}
