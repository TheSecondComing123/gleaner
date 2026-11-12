import { describe, expect, it } from 'vitest'
import type { Diagnostic } from 'vscode'
import { MAX_PROBLEMS, restoreSession, serializeSession } from '../src/session'

const range = { start: { line: 6, character: 2 }, end: { line: 7, character: 12 } }
const diagnostic = {
  range,
  message: 'bad\nmore detail',
  severity: 1,
  source: 'tsc',
  code: 'TS2322',
  relatedInformation: [{ location: { uri: { fsPath: '/repo/types.ts' }, range }, message: 'declared here' }],
}
const runs = (d: Partial<typeof diagnostic> = {}) =>
  new Map([['/repo\0tsc', new Map([['/repo/app.ts', [{ ...diagnostic, ...d }]]])]])
const stored = () => JSON.parse(JSON.stringify(serializeSession(runs())))

describe('last session', () => {
  it('round trips paths, ranges, messages, severity, code, source and related info through json', () => {
    const saved = stored()
    expect(saved).toEqual([
      {
        key: '/repo\0tsc',
        problems: [
          {
            file: '/repo/app.ts',
            range,
            message: diagnostic.message,
            severity: 1,
            source: 'tsc',
            code: 'TS2322',
            related: [{ file: '/repo/types.ts', range, message: 'declared here' }],
          },
        ],
      },
    ])
    const restored = restoreSession(saved, new Set())
    expect(restored[0].problems[0]).toEqual({ ...saved[0].problems[0], source: 'tsc (last session)' })
    expect(restoreSession(restored, new Set())).toEqual(restored)
    expect(saved[0].problems[0].source).toBe('tsc')
  })

  it('keeps numeric codes and serializes code links as strings', () => {
    const files = new Map([
      [
        '/repo/app.ts',
        [
          { ...diagnostic, code: 0 },
          {
            ...diagnostic,
            code: { value: 'E1', target: { toString: () => 'https://example.com/E1' } } as Diagnostic['code'],
          },
        ],
      ],
    ])
    const saved = JSON.parse(JSON.stringify(serializeSession(new Map([['lint', files]]))))
    expect(saved[0].problems.map((p: { code: unknown }) => p.code)).toEqual([
      0,
      { value: 'E1', target: 'https://example.com/E1' },
    ])
  })

  it('skips dirty owners and related locations without dropping other files', () => {
    const saved = serializeSession(
      new Map([
        [
          'tsc',
          new Map([
            ['/repo/app.ts', [diagnostic]],
            ['/repo/other.ts', [diagnostic]],
          ]),
        ],
      ]),
    )
    const restored = restoreSession(saved, new Set(['/repo/app.ts', '/repo/types.ts']))
    expect(restored[0].problems).toHaveLength(1)
    expect(restored[0].problems[0].file).toBe('/repo/other.ts')
    expect(restored[0].problems[0].related).toEqual([])
    expect(restoreSession(saved, new Set(['/repo/app.ts', '/repo/other.ts']))).toEqual([])
  })

  it('handles missing optional fields', () => {
    const saved = serializeSession(
      runs({ ...diagnostic, source: undefined, code: undefined, relatedInformation: undefined }),
    )
    expect(restoreSession(saved, new Set())[0].problems[0].source).toBe('gleaner (last session)')
    expect(serializeSession(new Map())).toEqual([])
  })

  it('keeps the newest 500 problems per run and 50 run keys', () => {
    const files = new Map([
      ['/repo/app.ts', Array.from({ length: 501 }, (_, i) => ({ ...diagnostic, message: `${i}` }))],
    ])
    const capped = serializeSession(new Map([['tsc', files]]))[0].problems
    expect(capped).toHaveLength(MAX_PROBLEMS)
    expect(capped[0].message).toBe('1')
    expect(capped.at(-1)?.message).toBe('500')
    const one = new Map([['/repo/app.ts', [diagnostic]]])
    const saved = serializeSession(new Map(Array.from({ length: 51 }, (_, i) => [`run ${i}`, one])))
    expect(saved).toHaveLength(50)
    expect(saved[0].key).toBe('run 1')
    expect(saved.at(-1)?.key).toBe('run 50')
  })

  it('bounds total utf8 bytes, including large messages and command keys', () => {
    const files = new Map([['/repo/app.ts', [{ ...diagnostic, message: '🔥'.repeat(10_000) }]]])
    const input = new Map(Array.from({ length: 51 }, (_, i) => [`run ${i}`, files]))
    input.set('x'.repeat(1_000_000), files)
    const saved = serializeSession(input)
    expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThanOrEqual(1_000_000)
    expect(saved.length).toBeGreaterThan(0)
    expect(saved.length).toBeLessThan(50)
    expect(saved.at(-1)?.key).toBe('run 50')
  })
})
