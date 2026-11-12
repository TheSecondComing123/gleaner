import { describe, expect, it } from 'vitest'
import {
  OutputHistory,
  outputDocument,
  PROBLEM_CONTEXT_BYTES,
  RetainedOutput,
  RUN_OUTPUT_BYTES,
  type RunOutput,
} from '../src/history'

const run = (id: string, overrides: Partial<RunOutput> = {}): RunOutput => ({
  id,
  command: 'node app.js',
  folder: '/repo',
  started: Number(id),
  updated: 100,
  state: 'final',
  exitCode: 1,
  lines: [
    { number: 0, text: 'TypeError: broken' },
    { number: 1, text: '    at main (app.js:7:3)' },
  ],
  lineCount: 2,
  warnings: [],
  problems: [],
  incomplete: [],
  ...overrides,
})

describe('retained run output', () => {
  it('bounds each growing problem excerpt and keeps its first diagnostic lines', () => {
    const output = new RetainedOutput()
    const line = (number: number) => ({ number, text: `${number}: ${'🔥'.repeat(500)}` })
    for (let i = 0; i < 500; i++) output.append(line(i).text)
    output.retain(
      150,
      Array.from({ length: 100 }, (_, i) => line(150 + i)),
    )
    output.retain(
      150,
      Array.from({ length: 100 }, (_, i) => line(250 + i)),
    )
    const retained = output.snapshot().lines.filter((line) => line.number >= 150 && line.number < 350)
    expect(retained[0].number).toBe(150)
    expect(retained.reduce((bytes, line) => bytes + Buffer.byteLength(line.text) + 32, 0)).toBeLessThanOrEqual(
      PROBLEM_CONTEXT_BYTES,
    )
  })

  it('marks evicted problem excerpts while retaining later context within the run budget', () => {
    const output = new RetainedOutput(512)
    for (let i = 0; i < 40; i++) output.append(`progress ${i}`)
    for (const number of [10, 20, 30]) output.retain(number, [{ number, text: `error ${number}: ${'x'.repeat(100)}` }])
    const snapshot = output.snapshot()
    expect(snapshot.lines.some((line) => line.number === 10)).toBe(false)
    expect(snapshot.lines.some((line) => line.number === 30 && line.text.startsWith('error 30'))).toBe(true)
    expect(snapshot.lines.reduce((bytes, line) => bytes + Buffer.byteLength(line.text) + 32, 0)).toBeLessThanOrEqual(
      512,
    )
    const view = outputDocument(run('1', snapshot), { start: 10, end: 11 })
    expect(view.text.split('\n').slice(view.selection.start, view.selection.end).join('\n')).toContain(
      'cut by retention limit',
    )
  })

  it('bounds utf8 output, preserves both ends, and marks the missing lines', () => {
    const output = new RetainedOutput(256)
    for (let i = 0; i < 30; i++) output.append(`${i}: 🔥🔥🔥`)
    const snapshot = output.snapshot()
    expect(snapshot.lines[0].number).toBe(0)
    expect(snapshot.lines.at(-1)?.number).toBe(29)
    expect(snapshot.lines.reduce((size, line) => size + Buffer.byteLength(line.text) + 32, 0)).toBeLessThanOrEqual(256)
    const view = outputDocument(run('1', snapshot), { start: 5, end: 25 })
    expect(view.text).toMatch(/\[gleaner: output lines \d+-\d+ cut by retention limit\]/)
    expect(view.text.split('\n').slice(view.selection.start, view.selection.end).join('\n')).toContain(
      'cut by retention limit',
    )
  })

  it('bounds the partial final line too, including after a gap', () => {
    const output = new RetainedOutput(256)
    for (let i = 0; i < 30; i++) output.append(`${i}: 🔥🔥🔥`)
    const snapshot = output.snapshot('last line')
    expect(snapshot.lineCount).toBe(31)
    expect(snapshot.lines.at(-1)).toEqual({ number: 30, text: 'last line' })
    expect(snapshot.lines.reduce((size, line) => size + Buffer.byteLength(line.text) + 32, 0)).toBeLessThanOrEqual(256)
    expect(output.snapshot().lineCount).toBe(30)
  })

  it('bounds empty lines and marks an oversized line that could not fit', () => {
    const output = new RetainedOutput(128)
    for (let i = 0; i < 100; i++) output.append('')
    expect(output.snapshot().lines).toHaveLength(4)
    output.append('x'.repeat(1000))
    expect(outputDocument(run('1', output.snapshot())).text).toContain('output lines 3-101 cut')
  })

  it('keeps output within the default per-run budget', () => {
    const output = new RetainedOutput()
    for (let i = 0; i < 1000; i++) output.append('🔥'.repeat(1000))
    expect(Buffer.byteLength(JSON.stringify(output.snapshot().lines))).toBeLessThanOrEqual(RUN_OUTPUT_BYTES)
  })

  it('evicts the oldest started run first, including out-of-order finishes and updates', () => {
    const size = Buffer.byteLength(JSON.stringify(run('1')))
    const history = new OutputHistory(size * 2 + 10)
    history.set(run('2'))
    history.set(run('1'))
    history.set(run('1', { updated: 900 }))
    history.set(run('3'))
    expect(history.recent().map((r) => r.id)).toEqual(['3', '2'])
    expect(history.get('1')).toBeUndefined()
    expect(Buffer.byteLength(JSON.stringify(history.recent()))).toBeLessThanOrEqual(size * 2 + 10)
    history.clear()
    expect(history.recent()).toEqual([])
  })

  it('bounds run count and drops a run larger than the total budget', () => {
    const history = new OutputHistory()
    for (let i = 0; i < 51; i++) history.set(run(`${i}`))
    expect(history.recent()).toHaveLength(50)
    expect(history.get('0')).toBeUndefined()
    const tiny = new OutputHistory(10)
    tiny.set(run('1'))
    expect(tiny.recent()).toEqual([])
  })

  it('renders metadata, distinguishes watch passes from exits, and selects the whole block', () => {
    const view = outputDocument(run('1'), { start: 0, end: 2 })
    expect(view.text).toContain('$ node app.js\nfolder: /repo\nstarted:')
    expect(view.text).toContain('exit 1:')
    expect(view.text.split('\n').slice(view.selection.start, view.selection.end)).toEqual([
      'TypeError: broken',
      '    at main (app.js:7:3)',
    ])
    const watch = outputDocument(run('1', { state: 'pass', pass: 2, exitCode: undefined }))
    expect(watch.text).toContain('watch pass 2:')
    expect(watch.text).not.toContain('exit')
    expect(outputDocument(run('1', { exitCode: undefined })).text).toContain('exit unknown:')
  })
})
