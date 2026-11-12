import { describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => ({}))

import { type CopyRun, copyMarkdown, restoredCopyRun } from '../src/copy'

const run = (overrides: Partial<CopyRun> = {}): CopyRun => ({
  id: 'run/1',
  command: 'tsc -p .',
  folder: '/repo',
  started: 100,
  updated: 200,
  state: 'final',
  exitCode: 1,
  incomplete: [],
  warnings: [],
  lineCount: 9,
  lines: Array.from({ length: 9 }, (_, number) => ({ number, text: `output ${number + 1}` })),
  problems: [
    {
      file: '/repo/a.ts',
      line: 7,
      col: 3,
      message: 'broken\nextra detail',
      code: 'TS2322',
      source: 'tsc',
      severity: 'error',
      output: { start: 2, end: 4 },
    },
  ],
  ...overrides,
})

describe('copy markdown', () => {
  it('includes exact metadata, full problem messages, and the relevant block with context', () => {
    const text = copyMarkdown(run())
    for (const want of [
      'tsc -p .',
      '/repo',
      'state: exit 1',
      'completeness: complete',
      '/repo/a.ts:7:3: error TS2322: broken\nextra detail',
      '1970-01-01T00:00:00.200Z',
    ])
      expect(text).toContain(want)
    expect(text).toContain('output 1\noutput 2\noutput 3\noutput 4\noutput 5\noutput 6')
    expect(text).not.toContain('output 7')
  })

  it('labels provisional, unknown exits, interrupted runs, and watch passes honestly', () => {
    expect(
      copyMarkdown(run({ state: 'provisional', incomplete: ['provisional result'], exitCode: undefined })),
    ).toContain('running (provisional)')
    expect(copyMarkdown(run({ exitCode: undefined, incomplete: ['exit code unknown'] }))).toContain(
      'state: exit unknown',
    )
    const pass = copyMarkdown(run({ state: 'pass', pass: 2, exitCode: undefined }))
    expect(pass).toContain('state: watch pass 2')
    expect(pass).not.toContain('exit 0')
    expect(copyMarkdown(run({ exitCode: 130, incomplete: ['run interrupted'] }))).toContain(
      'completeness: incomplete or unknown (run interrupted)',
    )
  })

  it('marks missing output within an error block and exposes capture warnings', () => {
    const text = copyMarkdown(
      run({
        lines: [
          { number: 0, text: 'head' },
          { number: 5, text: 'tail' },
        ],
        warnings: ['capture lost'],
        incomplete: ['capture lost'],
      }),
    )
    expect(text).toContain('output lines 2-5 unavailable')
    expect(text).toContain('[gleaner: capture lost]')
    expect(text).toContain('incomplete or unknown (capture lost)')
  })

  it('merges overlapping excerpts and cannot break markdown fences with captured output', () => {
    const original = run()
    original.lines[2].text = '```\n# a heading'
    original.problems.push({ ...original.problems[0], line: 10, output: { start: 3, end: 5 } })
    const text = copyMarkdown(original)
    expect(text.match(/output lines \d+-\d+:/g)).toHaveLength(1)
    expect(text).toContain('````text\noutput 1')
    expect(text).toContain('```\n# a heading')
    expect(copyMarkdown(run({ command: '` '.repeat(150_000) }))).toContain('` '.repeat(150_000))
  })

  it('exports all-fixed results and restored diagnostics without claiming saved output or freshness', () => {
    expect(copyMarkdown(run({ problems: [], exitCode: 0 }))).toContain('no problems found.')
    const restored = restoredCopyRun({
      key: '/repo\0tsc -p .',
      problems: [
        {
          file: '/repo/a.ts',
          range: { start: { line: 6, character: 2 }, end: { line: 6, character: 3 } },
          message: 'old',
          severity: 0,
          source: 'tsc (last session)',
        },
      ],
    })
    const text = copyMarkdown(restored)
    for (const want of [
      'tsc -p .',
      'last session',
      'completeness unknown',
      'output not retained',
      '/repo/a.ts:7:3: error: old',
      'output unavailable',
    ]) {
      expect(text).toContain(want)
    }
    expect(text).not.toContain('exit 0')
  })
})
