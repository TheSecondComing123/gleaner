import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clean } from '../src/clean'
import { LiveUpdates, Output } from '../src/output'
import { parseAll, parsers, pickParsers } from '../src/parsers'
import { lastPass } from '../src/watch'

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
    expect(stream.snapshot(true)).toEqual(parseAll(Object.values(parsers), clean(raw)))
  })

  it('finds an error after 5 MB of noise, even in one delivery', () => {
    const stream = output()
    stream.append(`${'x'.repeat(999)}\n`.repeat(5001) + error('late'))
    expect(stream.snapshot().map((p) => p.message)).toEqual(['late'])
  })

  it('keeps early and late errors across 15,000 lines', () => {
    const stream = output()
    stream.append(error('early'))
    for (let i = 0; i < 15_001; i++) stream.append('progress\n')
    stream.append(error('late'))
    expect(stream.snapshot().map((p) => p.message)).toEqual(['early', 'late'])
  })

  it('parses a python traceback across a chunk edge without doubles', () => {
    const stream = output()
    stream.append('progress\n'.repeat(997))
    stream.append('Traceback (most recent call last):\n  File "main.py", line 4, in <module>\n    buy()\n')
    expect(stream.snapshot()).toEqual([])
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
    expect(stream.snapshot()).toEqual(expected)
    stream.append('\nprogress\n'.repeat(1000))
    expect(stream.snapshot(true)).toEqual(expected)
  })

  it('publishes only complete lines and flushes the partial line at the end', () => {
    const stream = output()
    for (const char of error('first').trimEnd()) stream.append(char)
    expect(stream.snapshot()).toEqual([])
    expect(stream.snapshot(true).map((p) => p.message)).toEqual(['first'])
    stream.append('\r\n')
    expect(stream.snapshot().map((p) => p.message)).toEqual(['first'])
  })

  it('replaces a provisional multi-line message as it grows', () => {
    const stream = output()
    stream.append('Traceback (most recent call last):\n  File "shop.py", line 9, in buy\nValueError: empty\n')
    expect(stream.snapshot()[0].message).toBe('ValueError: empty')
    stream.append('more detail\n')
    expect(stream.snapshot()[0].message).toBe('ValueError: empty\nmore detail')
    stream.append('\n')
    expect(stream.snapshot(true)).toHaveLength(1)
  })

  it('handles split escapes, redraws and blank lines', () => {
    const stream = output()
    const raw = `\x1b[31m${error('first').trimEnd()}\x1b[0m\r\n\n10%\r20%\r\n`
    for (const char of raw) stream.append(char)
    expect(stream.snapshot().map((p) => p.message)).toEqual(['first'])
    expect(stream.warnings).toEqual([])
  })

  it('bounds a huge unterminated line, reports truncation and reads later errors', () => {
    const stream = output()
    stream.append('x'.repeat(5_000_001))
    expect(stream.snapshot()).toEqual([])
    expect(stream.warnings).toContain('long lines truncated')
    stream.append(`\n${error('late')}`)
    expect(stream.snapshot().map((p) => p.message)).toEqual(['late'])
  })

  it('reports the cleaned line limit too', () => {
    const stream = output()
    stream.append(`${'x'.repeat(4001)}\n`)
    expect(stream.warnings).toContain('long lines truncated')
  })

  it('keeps later problems when candidates overflow and reports the loss', () => {
    const stream = output()
    for (let i = 0; i < 2100; i++) stream.append(error(`error ${i}`))
    const found = stream.snapshot(true)
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
      latest = stream.snapshot()
      stream.reset()
    })
    expect(latest.map((p) => p.message)).toEqual(['new'])
    expect(stream.snapshot()).toEqual([])
    expect(stream.hasOutput).toBe(false)
    expect(stream.warnings).toEqual([])
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
