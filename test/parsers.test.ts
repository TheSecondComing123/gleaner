import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clean } from '../src/clean'
import { parsers } from '../src/parsers'
import { diagnostics } from './diagnostics'

// real output → expected .json
const root = join(__dirname, 'fixtures')

for (const name of readdirSync(root)) {
  describe(name, () => {
    for (const file of readdirSync(join(root, name)).filter((f) => f.endsWith('.txt'))) {
      it(file, () => {
        const parse = parsers[name]
        expect(parse, `no parser named ${name}`).toBeDefined()
        const lines = clean(readFileSync(join(root, name, file), 'utf8'))
        const expected = JSON.parse(readFileSync(join(root, name, file.replace(/\.txt$/, '.json')), 'utf8'))
        const found = parse(lines)
        expect(diagnostics(found)).toEqual(expected)
        for (const problem of found) {
          if (!problem.output) throw new Error('missing output span')
          expect(problem.output.start).toBeGreaterThanOrEqual(0)
          expect(problem.output.end).toBeGreaterThan(problem.output.start)
          expect(problem.output.end).toBeLessThanOrEqual(lines.length)
        }
      })
    }
  })
}

describe('java build tools', () => {
  it('keeps distinct columns while dropping repeated maven diagnostics', () => {
    const lines = [
      '[ERROR] /repo/Price.java:[8,23] cannot find symbol',
      '[ERROR] /repo/Price.java:[8,40] cannot find symbol',
      '[ERROR] /repo/Price.java:[8,23] cannot find symbol',
    ]
    expect(parsers.javac(lines).map((p) => p.col)).toEqual([23, 40])
  })

  it('requires source locations for test failures and clears unfinished blocks', () => {
    expect(
      parsers.java([
        '[ERROR] shop.PriceTest.missing -- Time elapsed: 0.01 s <<< FAILURE!',
        'java.lang.AssertionError: no frame',
        '[INFO] Results:',
        '[ERROR] Failures:',
        'PriceTest > missing() FAILED',
        '> Task :test FAILED',
        '    java.lang.AssertionError at PriceTest.java:9',
      ]),
    ).toEqual([])
  })
})
