import { describe, expect, it } from 'vitest'
import { clean } from '../src/clean'
import { commandName, parsers, pickParsers } from '../src/parsers'
import { resolveFile } from '../src/resolve'

describe('clean', () => {
  it('strips colors and shell integration markers', () => {
    const raw = '\x1b]633;C\x07\x1b[96msrc/app.ts\x1b[0m:\x1b[93m12\x1b[0m:5 - \x1b[91merror\x1b[0m TS2322: bad\r\n'
    expect(clean(raw)).toEqual(['src/app.ts:12:5 - error TS2322: bad'])
  })

  it('strips charset escapes', () => {
    expect(clean('a.py:7: \x1b[1m\x1b[31merror:\x1b(B\x1b[m bad\n')).toEqual(['a.py:7: error: bad'])
  })

  it('keeps only the last redraw of a line', () => {
    expect(clean('building 10%\rbuilding 50%\rbuilding 100%\r\ndone\r\n')).toEqual(['building 100%', 'done'])
  })

  it("drops zsh's partial-line marker", () => {
    const raw = 'sub\r\n\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m                    \r \r'
    expect(clean(raw)).toEqual(['sub'])
  })

  it('caps the number of lines', () => {
    expect(clean('a\nb\nc\n', 2)).toEqual(['a', 'b'])
  })
})

describe('resolveFile', () => {
  const files = new Set(['/repo/app/src/a.ts', '/repo/src/a.ts', '/abs/x.c'])
  const exists = async (p: string) => files.has(p)

  it('tries dirs in order', async () => {
    expect(await resolveFile('src/a.ts', ['/repo/app', '/repo'], exists)).toBe('/repo/app/src/a.ts')
    expect(await resolveFile('src/a.ts', ['/elsewhere', '/repo'], exists)).toBe('/repo/src/a.ts')
  })

  it('checks absolute paths as they are', async () => {
    expect(await resolveFile('/abs/x.c', ['/repo'], exists)).toBe('/abs/x.c')
    expect(await resolveFile('/abs/missing.c', ['/repo'], exists)).toBeUndefined()
  })

  it('gives up when nothing exists', async () => {
    expect(await resolveFile('nope.ts', ['/repo'], exists)).toBeUndefined()
  })
})

describe('commandName', () => {
  it.each([
    ['tsc -p .', 'tsc'],
    ['npx tsc --noEmit', 'tsc'],
    ['pnpm exec tsc', 'tsc'],
    ['./node_modules/.bin/tsc', 'tsc'],
    ['NODE_ENV=test tsc', 'tsc'],
    ['uv run pytest -x', 'pytest'],
    ['python3 -m pytest', 'pytest'],
    ['python app.py', 'python'],
  ])('%s → %s', (line, name) => {
    expect(commandName(line)).toBe(name)
  })
})

describe('pickParsers', () => {
  it('finds commands inside a chain', () => {
    expect(pickParsers('cd app && tsc')).toEqual([parsers.tsc])
    expect(pickParsers('tsc; clang -c main.c')).toEqual([parsers.tsc, parsers.gcc])
  })

  it('skips ignored commands', () => {
    expect(pickParsers('ls -la')).toEqual([])
    expect(pickParsers('git diff | grep -n foo')).toEqual([])
    expect(pickParsers('make', ['make'])).toEqual([])
  })

  it('tries every parser on a command it does not know', () => {
    expect(pickParsers('make all')).toEqual(Object.values(parsers))
  })
})
