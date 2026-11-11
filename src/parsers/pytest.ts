import type { Problem } from '../problem'
import { FRAME, LIBRARY } from './python'

// `____ test_add ____`, `____ ERROR collecting tests/x.py ____`, `____ ERROR at setup of test_y ____`
const SECTION = /^_{3,} (?:ERROR collecting |ERROR at (?:setup|teardown) of )?(.+?) _{3,}$/
// `=== short test summary info ===` and the final tally close the last section.
const RULE = /^={3,}/
// `tests/x.py:5: AssertionError`, `calc.py:5: in div` (--tb=short), bare `tests/x.py:3` (fixture errors)
const LOCATION = /^(.+?):(\d+)(?::(.*))?$/
const ERROR_LINE = /^E( |$)/
// `FAILED tests/x.py::TestA::test_b - AssertionError: msg`, `ERROR tests/x.py`
const SUMMARY = /^(?:FAILED|ERROR) (.+?)(?: - (.*))?$/

interface Section {
  name: string
  locations: { file: string; line: number; rest: string }[]
  errors: string[]
  text: string[]
}

export function pytest(lines: string[]): Problem[] {
  const problems: Problem[] = []
  const seen = new Set<string>()
  // Sections with no location (an import file mismatch) lend their text to the summary line instead.
  const unlocated = new Map<string, string>()
  let section: Section | undefined
  let inErrors = false

  const finish = () => {
    if (!section) return
    const { name, locations, errors } = section
    const sectionText = section.text.join('\n')
    section = undefined
    const indent = Math.min(...errors.filter(Boolean).map((e) => e.search(/\S/)))
    let message = errors.filter((e) => e.trim()).map((e) => e.slice(indent))
    const user = locations.filter((l) => !LIBRARY.test(l.file))
    // A SyntaxError while collecting only shows its real spot inside the E lines,
    // as a `File` line, the code and a caret before the `SyntaxError:` line.
    const frame = message.map((m) => FRAME.exec(m)).find(Boolean)
    if (!user.length && frame) message = message.filter((m) => !m.startsWith(' '))
    const at = user.at(-1) ?? (frame ? { file: frame[1], line: Number(frame[2]), rest: '' } : undefined)
    if (!at) {
      unlocated.set(name, sectionText)
      return
    }
    seen.add(name)
    const problem: Problem = {
      file: at.file,
      line: at.line,
      severity: 'error',
      message: message.join('\n') || at.rest.trim() || `${name} failed`,
      source: 'pytest',
    }
    const callers = new Set([`${at.file}:${at.line}`])
    for (const l of user.reverse()) {
      if (callers.has(`${l.file}:${l.line}`)) continue
      callers.add(`${l.file}:${l.line}`)
      problem.related = [...(problem.related ?? []), { file: l.file, line: l.line, message: 'called from here' }]
    }
    problems.push(problem)
  }

  for (const line of lines) {
    const head = SECTION.exec(line)
    if (head) {
      finish()
      section = { name: head[1], locations: [], errors: [], text: [] }
      continue
    }
    if (RULE.test(line)) {
      finish()
      continue
    }
    if (!section) {
      // The summary only adds tests that had no traceback section, e.g. under --tb=no.
      const summary = SUMMARY.exec(line)
      if (!summary) continue
      const [file, ...test] = summary[1].split('::')
      const name = test.length ? test.join('.') : file
      if (seen.has(name)) continue
      seen.add(name)
      problems.push({
        file,
        line: 1,
        severity: 'error',
        message: test.length
          ? `${name}: ${summary[2] ?? 'failed'}`
          : (summary[2] ?? unlocated.get(name) ?? 'collection failed'),
        source: 'pytest',
      })
      continue
    }

    if (ERROR_LINE.test(line)) {
      // Only the last run of E lines is the error that ended the test.
      if (!inErrors) section.errors = []
      inErrors = true
      section.errors.push(line.slice(1))
      continue
    }
    inErrors = false
    const loc = /^[\s>]/.test(line) ? null : LOCATION.exec(line)
    if (loc) section.locations.push({ file: loc[1], line: Number(loc[2]), rest: loc[3] ?? '' })
    else if (line.trim()) section.text.push(line.trim())
  }
  finish()
  return problems
}
