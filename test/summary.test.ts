import { describe, expect, it } from 'vitest'
import type { Problem } from '../src/problem'
import { compareRuns, comparison } from '../src/summary'

const problem = (line = 1, message = 'broken', file = '/repo/app.ts', code = 'TS2322'): Problem => ({
  file,
  line,
  col: 3,
  message,
  code,
  source: 'tsc',
  severity: 'error',
})
const snapshot = (problems: Problem[], complete = true, command = 'tsc -p .', scope = true) =>
  comparison(command, problems, complete, scope)

describe('run comparison', () => {
  it('counts identical occurrences instead of collapsing their fingerprints', () => {
    const previous = snapshot([problem(2), problem(10)])
    expect(compareRuns(previous, snapshot([problem(2)]))).toEqual({ fixed: 1, added: 0 })
    expect(compareRuns(snapshot([problem(2)]), previous)).toEqual({ fixed: 0, added: 1 })
    expect(compareRuns(previous, snapshot([problem(2), problem(10)]))).toEqual({ fixed: 0, added: 0 })
  })

  it('ignores line and column moves, detail changes, and equivalent code spellings', () => {
    expect(
      compareRuns(snapshot([problem(2)]), snapshot([{ ...problem(50, 'broken\nnew detail'), col: 20, code: '2322' }])),
    ).toEqual({ fixed: 0, added: 0 })
  })

  it('keeps files, codes, and first message lines distinct, including delimiter characters', () => {
    const previous = snapshot([problem(1, 'a|b', '/repo/a.ts'), problem(2, 'broken', '/repo/b.ts')])
    expect(
      compareRuns(previous, snapshot([problem(3, 'a|b', '/repo/a.ts'), problem(2, 'broken', '/repo/b.ts', 'TS2345')])),
    ).toEqual({ fixed: 1, added: 1 })
  })

  it('suppresses comparisons when either result is incomplete or scope is unknown', () => {
    for (const previous of [snapshot([problem()], false), snapshot([problem()], true, 'tsc -p .', false)])
      expect(compareRuns(previous, snapshot([]))).toBeUndefined()
    for (const current of [snapshot([], false), snapshot([], true, 'tsc -p .', false)])
      expect(compareRuns(snapshot([problem()]), current)).toBeUndefined()
  })

  it('requires an exact command line, even when run keys trim whitespace', () => {
    expect(compareRuns(snapshot([problem()]), snapshot([], true, 'tsc -p . '))).toBeUndefined()
    expect(compareRuns(snapshot([problem()]), snapshot([], true, 'tsc -p . --only other'))).toBeUndefined()
  })

  it('reports all fixed, a clean baseline, and no first-run summary', () => {
    expect(compareRuns(snapshot([problem(1), problem(2)]), snapshot([]))).toEqual({ fixed: 2, added: 0 })
    expect(compareRuns(snapshot([]), snapshot([problem()]))).toEqual({ fixed: 0, added: 1 })
    expect(compareRuns(undefined, snapshot([]))).toBeUndefined()
  })

  it('freezes comparison data before diagnostics can move or disappear', () => {
    const problems = [problem(2), problem(10)]
    const previous = snapshot(problems)
    problems[0].message = 'edited'
    problems.splice(1)
    expect(compareRuns(previous, snapshot([]))).toEqual({ fixed: 2, added: 0 })
    expect(Object.isFrozen(previous)).toBe(true)
    expect(Object.isFrozen(previous.fingerprints)).toBe(true)
  })
})
