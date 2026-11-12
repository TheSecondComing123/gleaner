import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clean } from '../src/clean'
import { LiveUpdates, Output } from '../src/output'
import { parseAll as parseOutput, parsers, pickParsers } from '../src/parsers'
import { lastPass } from '../src/watch'
import { diagnostics } from './diagnostics'

const error = (message: string) => `src/cart.ts(7,3): error TS2322: ${message}\n`
const output = () => new Output(pickParsers('perl slow.pl'))

describe('streamed output', () => {
  const fixtures = join(__dirname, 'fixtures')
  const captures = readdirSync(fixtures).flatMap((tool) =>
    readdirSync(join(fixtures, tool))
      .filter((file) => file.endsWith('.txt'))
      .map((file) => join(tool, file)),
  )
  it.each(captures)('preserves the full parse of %s with split deliveries', (capture) => {
    const raw = readFileSync(join(fixtures, capture), 'utf8')
    const stream = output()
    for (let i = 0; i < raw.length; i += 7) stream.append(raw.slice(i, i + 7))
    expect(diagnostics(stream.snapshot(true))).toEqual(parseAll(Object.values(parsers), clean(raw)))
  })

  it('finds an error after 5 MB of noise, even in one delivery', () => {
    const stream = output()
    stream.append(`${'x'.repeat(999)}\n`.repeat(5001) + error('late'))
    expect(diagnostics(stream.snapshot()).map((p) => p.message)).toEqual(['late'])
  })

  it.each(captures)('preserves %s across chunk boundaries', (capture) => {
    const lines = clean(readFileSync(join(fixtures, capture), 'utf8'))
    const expected = parseAll(Object.values(parsers), lines)
    const splits = new Set([1, 2, 3, 4, 5, Math.floor(lines.length / 2), lines.length - 1])
    for (const split of splits) {
      if (split < 1 || split >= lines.length) continue
      const stream = output()
      stream.append('progress\n'.repeat(1000 - split))
      stream.append(`${lines.slice(0, split).join('\n')}\n`)
      diagnostics(stream.snapshot())
      stream.append(`${lines.slice(split).join('\n')}\n`)
      expect(diagnostics(stream.snapshot(true)), `split at line ${split}`).toEqual(expected)
      stream.append(`\n${'progress\n'.repeat(1000)}`)
      expect(diagnostics(stream.snapshot(true)), `retired after line ${split}`).toEqual(expected)
    }
  })

  it('keeps early and late errors across 15,000 lines', () => {
    const stream = output()
    stream.append(error('early'))
    for (let i = 0; i < 15_001; i++) stream.append('progress\n')
    stream.append(error('late'))
    expect(diagnostics(stream.snapshot()).map((p) => p.message)).toEqual(['early', 'late'])
  })

  it('retains the start of a block when the overlap would split it', () => {
    const stream = new Output([parsers.jest])
    stream.append('progress\n'.repeat(690))
    stream.append('FAIL a.test.js\n  ● adds\n    wrong sum\n')
    stream.append('\n'.repeat(20))
    stream.append('    at add (a.test.js:9:4)\n')
    stream.append(`Test Suites: 1 failed\n${'progress\n'.repeat(1000)}`)
    expect(diagnostics(stream.snapshot(true))).toEqual([
      { file: 'a.test.js', line: 9, col: 4, severity: 'error', message: 'adds\nwrong sum', source: 'jest' },
    ])
  })

  it('parses a python traceback across a chunk edge without doubles', () => {
    const stream = output()
    stream.append('progress\n'.repeat(997))
    stream.append('Traceback (most recent call last):\n  File "main.py", line 4, in <module>\n    buy()\n')
    expect(diagnostics(stream.snapshot())).toEqual([])
    stream.append('  File "shop.py", line 9, in buy\n    raise ValueError("empty")\nValueError: empty\n')
    const expected = parseAll(
      [parsers.python],
      [
        'Traceback (most recent call last):',
        '  File "main.py", line 4, in <module>',
        '    buy()',
        '  File "shop.py", line 9, in buy',
        '    raise ValueError("empty")',
        'ValueError: empty',
      ],
    )
    expect(diagnostics(stream.snapshot())).toEqual(expected)
    stream.append('\nprogress\n'.repeat(1000))
    expect(diagnostics(stream.snapshot(true))).toEqual(expected)
  })

  it('publishes only complete lines and flushes the partial line at the end', () => {
    const stream = output()
    for (const char of error('first').trimEnd()) stream.append(char)
    expect(diagnostics(stream.snapshot())).toEqual([])
    expect(diagnostics(stream.snapshot(true)).map((p) => p.message)).toEqual(['first'])
    stream.append('\r\n')
    expect(diagnostics(stream.snapshot()).map((p) => p.message)).toEqual(['first'])
  })

  it('replaces a provisional multi-line message as it grows', () => {
    const stream = output()
    stream.append('Traceback (most recent call last):\n  File "shop.py", line 9, in buy\nValueError: empty\n')
    expect(diagnostics(stream.snapshot())[0].message).toBe('ValueError: empty')
    stream.append('more detail\n')
    expect(diagnostics(stream.snapshot())[0].message).toBe('ValueError: empty\nmore detail')
    stream.append('\n')
    expect(diagnostics(stream.snapshot(true))).toHaveLength(1)
  })

  it('handles split escapes, redraws and blank lines', () => {
    const stream = output()
    const raw = `\x1b[31m${error('first').trimEnd()}\x1b[0m\r\n\n10%\r20%\r\n`
    for (const char of raw) stream.append(char)
    expect(diagnostics(stream.snapshot()).map((p) => p.message)).toEqual(['first'])
    expect(stream.warnings).toEqual([])
  })

  it('bounds a huge unterminated line, reports truncation and reads later errors', () => {
    const stream = output()
    stream.append('x'.repeat(5_000_001))
    expect(diagnostics(stream.snapshot())).toEqual([])
    expect(stream.warnings).toContain('long lines truncated')
    stream.append(`\n${error('late')}`)
    expect(diagnostics(stream.snapshot()).map((p) => p.message)).toEqual(['late'])
  })

  it('reports the cleaned line limit too', () => {
    const stream = output()
    stream.append(`${'x'.repeat(4001)}\n`)
    expect(stream.warnings).toContain('long lines truncated')
  })

  it('keeps later problems when candidates overflow and reports the loss', () => {
    const stream = output()
    for (let i = 0; i < 2100; i++) stream.append(error(`error ${i}`))
    const found = diagnostics(stream.snapshot(true))
    expect(found).toHaveLength(2000)
    expect(found.at(-1)?.message).toBe('error 2099')
    expect(stream.warnings).toContain('older problems dropped (2000 candidate limit)')
  })

  it('resets accumulated problems at watch boundaries, including several in one chunk', () => {
    const stream = output()
    let latest = [] as ReturnType<Output['snapshot']>
    const pass = 'Watching for file changes.\n'
    stream.append(error('old') + 'progress\n'.repeat(2000) + pass + error('new') + pass, (line) => {
      if (!lastPass(`${line}\n`)) return
      latest = diagnostics(stream.snapshot())
      stream.reset()
    })
    expect(latest.map((p) => p.message)).toEqual(['new'])
    expect(diagnostics(stream.snapshot())).toEqual([])
    expect(stream.hasOutput).toBe(false)
    expect(stream.warnings).toEqual([])
  })
})

describe('output spans', () => {
  it.each([
    ['tsc --watch', 'tsc-watch.txt'],
    ['jest --watchAll', 'jest-watch.txt'],
    ['vitest watch', 'vitest-watch.txt'],
    ['nodemon app.js', 'nodemon.txt'],
  ])('keeps captured %s spans closed after watch output ends', (command, capture) => {
    const stream = new Output(pickParsers(command))
    stream.append(readFileSync(join(__dirname, 'watch', capture), 'utf8'))
    const before = stream.snapshot(true)
    expect(before.length).toBeGreaterThan(0)
    stream.append('other tool output\n\nmore progress\n\n    unrelated detail\n')
    expect(stream.snapshot(true)).toEqual(before)
  })

  it('retains problem excerpts after their parser window and surrounding output are retired', () => {
    const stream = new Output([parsers.tsc])
    const noise = `${'x'.repeat(1000)}\n`
    stream.append(`${noise.repeat(400)}${error('middle failure')}  original detail\n${noise.repeat(4000)}`)
    const problem = stream.snapshot(true)[0]
    expect(problem.output).toEqual({ start: 400, end: 402 })
    const retained = stream.retainedOutput(true)
    expect(retained.lines.filter((line) => line.number >= 400 && line.number < 402).map((line) => line.text)).toEqual([
      error('middle failure').trimEnd(),
      '  original detail',
    ])
    expect(retained.lines.reduce((bytes, line) => bytes + Buffer.byteLength(line.text) + 32, 0)).toBeLessThanOrEqual(
      512 * 1024,
    )
    stream.reset()
    expect(stream.retainedOutput()).toEqual({ lines: [], lineCount: 0 })
  })

  it.each(['tsc', 'gcc'])('closes %s spans before unrelated output and later whitespace', (tool) => {
    const head = tool === 'tsc' ? error('broken').trimEnd() : 'src/main.c:7:3: error: broken'
    const lines = [head, 'other tool output', '', 'more progress', '', '    unrelated detail']
    expect(parsers[tool](lines)[0].output).toEqual({ start: 0, end: 1 })
    const stream = new Output([parsers[tool]])
    stream.append(`${lines.join('\n')}\n${'progress\n'.repeat(1200)}`)
    expect(stream.snapshot(true)[0].output).toEqual({ start: 0, end: 1 })
  })

  it('closes a typescript block that outgrows the parser window before later progress', () => {
    const stream = new Output([parsers.tsc])
    stream.append('progress\n'.repeat(950) + error('long block') + '  detail\n'.repeat(1380))
    stream.append('other tool output\n\nmore progress\n\n')
    expect(stream.snapshot(true)[0].output).toEqual({ start: 950, end: 2331 })
  })

  it.each([
    ['javac', ['Main.java:3: error: broken', '  missing();', '  ^']],
    ['rustc', ['error[E0308]: broken', ' --> src/main.rs:3:2', '  |', '3 | missing', '  | ^^^^^^^']],
    ['ruff', ['F821 Undefined name', ' --> main.py:3:2', '  |', '3 | missing', '  | ^^^^^^^']],
    ['esbuild', ['✘ [ERROR] broken', '', '    main.ts:3:2:', '      3 │ missing', '        ╵ ^^^^^^^']],
  ] as const)('closes %s before an unrelated line immediately after its block', (tool, block) => {
    const lines = [...block, 'other tool output', '', 'more progress', '', '    unrelated detail']
    expect(parsers[tool](lines)[0].output).toEqual({ start: 0, end: block.length })
  })

  it.each([
    ['javac', 'gradle-compile.txt'],
    ['rustc', 'errors-color.txt'],
    ['ruff', 'ruff-full-color.txt'],
    ['biome', 'lint-color.txt'],
    ['esbuild', 'note-plain.txt'],
    ['cmake', 'call-stack-color.txt'],
    ['deno', 'lint-color.txt'],
    ['vite', 'missing-export-plain.txt'],
    ['go', 'test.txt'],
    ['mypy', 'pretty.txt'],
    ['ruby', 'crash.txt'],
  ])('does not extend captured %s blocks into subsequent tool output', (tool, capture) => {
    const lines = clean(readFileSync(join(__dirname, 'fixtures', tool, capture), 'utf8'))
    const before = parsers[tool](lines)
    expect(before.length).toBeGreaterThan(0)
    expect(parsers[tool]([...lines, 'other tool output', '', 'more progress', '', '    unrelated detail'])).toEqual(
      before,
    )
  })

  it('keeps repeated message occurrences tied to their blocks across a chunk edge', () => {
    const lines = Array.from({ length: 1800 }, () => 'progress')
    lines[690] = 'src/cart.ts(7,3): error TS2322: repeated'
    lines[691] = '  more detail'
    lines[999] = 'src/cart.ts(9,3): error TS2322: repeated'
    lines[1000] = '  more detail'
    const raw = `${lines.join('\n')}\n`
    for (const size of [1, 7, raw.length]) {
      const stream = new Output([parsers.tsc])
      for (let i = 0; i < raw.length; i += size) stream.append(raw.slice(i, i + size))
      expect(stream.snapshot(true).map((p) => [p.line, p.message, p.output])).toEqual([
        [7, 'repeated\nmore detail', { start: 690, end: 692 }],
        [9, 'repeated\nmore detail', { start: 999, end: 1001 }],
      ])
    }
  })

  it('dedupes an identical repeated problem without moving its provenance to the later copy', () => {
    const stream = new Output([parsers.tsc])
    stream.append('progress\n'.repeat(690) + error('same') + 'progress\n'.repeat(308))
    stream.append(error('same'))
    stream.append('progress\n'.repeat(1000))
    expect(stream.snapshot(true).map((p) => p.output)).toEqual([{ start: 690, end: 691 }])
  })

  it.each([380, 1380])('retains a complete compiler block with %i detail lines across parser windows', (length) => {
    const stream = new Output([parsers.gcc])
    const block = [
      'src/main.cpp:7:3: error: no matching function',
      ...Array.from({ length }, (_, i) => `    template detail ${i}`),
      'src/types.h:4:1: note: candidate declared here',
    ]
    stream.append('progress\n'.repeat(950))
    stream.append(`${block.join('\n')}\n`)
    stream.append('progress\n'.repeat(1000))
    const problem = stream.snapshot(true)[0]
    const span = problem.output
    if (!span) throw new Error('missing output span')
    expect(problem.output).toEqual({ start: 950, end: 950 + block.length })
    expect(
      stream
        .retainedOutput(true)
        .lines.filter((line) => line.number >= span.start && line.number < span.end)
        .map((line) => line.text),
    ).toEqual(block)
  })

  it('marks clipped lines in the retained log and preserves a final partial line', () => {
    const stream = new Output([parsers.tsc])
    stream.append(`${'x'.repeat(20_000)}\n${error('last').trimEnd()}`)
    expect(stream.retainedOutput(true).lines[0].text).toContain('[gleaner: line truncated]')
    expect(stream.retainedOutput(true).lines[1].text).toContain('error TS2322: last')
    expect(stream.snapshot(true)[0].output).toEqual({ start: 1, end: 2 })
  })
})

describe('live cadence', () => {
  afterEach(() => vi.useRealTimers())

  it('publishes after 1.5 seconds of quiet, then waits for new output', () => {
    vi.useFakeTimers()
    const publish = vi.fn()
    const live = new LiveUpdates(publish)
    live.append()
    vi.advanceTimersByTime(1000)
    live.append()
    vi.advanceTimersByTime(1499)
    expect(publish).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(publish).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_000)
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('publishes every five seconds while output keeps coming', () => {
    vi.useFakeTimers()
    const publish = vi.fn()
    const live = new LiveUpdates(publish)
    for (let i = 0; i < 20; i++) {
      live.append()
      vi.advanceTimersByTime(500)
    }
    expect(publish).toHaveBeenCalledTimes(2)
    live.stop()
    vi.advanceTimersByTime(10_000)
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('cancels both pending deadlines on stop', () => {
    vi.useFakeTimers()
    const publish = vi.fn()
    const live = new LiveUpdates(publish)
    live.append()
    live.stop()
    vi.advanceTimersByTime(10_000)
    expect(publish).not.toHaveBeenCalled()
    live.append()
    vi.advanceTimersByTime(1500)
    expect(publish).toHaveBeenCalledTimes(1)
  })
})

function parseAll(...args: Parameters<typeof parseOutput>) {
  return diagnostics(parseOutput(...args))
}
