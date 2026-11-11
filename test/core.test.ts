import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clean } from '../src/clean'
import { commandName, parseAll, parsers, pickParsers } from '../src/parsers'
import { resolveFile } from '../src/resolve'
import { lastPass } from '../src/watch'

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

  it('caps line length', () => {
    expect(clean(`${'x'.repeat(5000)}\n`)[0]).toHaveLength(4000)
  })

  it('caps the number of lines', () => {
    expect(clean('a\nb\nc\n', 2)).toEqual(['a', 'b'])
  })
})

describe('resolveFile', () => {
  // OS-native paths
  const files = new Set(['/repo/app/src/a.ts', '/repo/src/a.ts', '/abs/x.c'].map((p) => resolve(p)))
  const exists = async (p: string) => files.has(p)

  it('tries dirs in order', async () => {
    expect(await resolveFile('src/a.ts', ['/repo/app', '/repo'], exists)).toBe(resolve('/repo/app/src/a.ts'))
    expect(await resolveFile('src/a.ts', ['/elsewhere', '/repo'], exists)).toBe(resolve('/repo/src/a.ts'))
  })

  it('checks absolute paths as they are', async () => {
    expect(await resolveFile(resolve('/abs/x.c'), ['/repo'], exists)).toBe(resolve('/abs/x.c'))
    expect(await resolveFile('/abs/missing.c', ['/repo'], exists)).toBeUndefined()
  })

  it('reads file URLs', async () => {
    expect(
      await resolveFile(
        `file://${resolve('/abs/x.c')
          .replace(/\\/g, '/')
          .replace(/^(?=[A-Za-z]:)/, '/')}`,
        [],
        exists,
      ),
    ).toBe(resolve('/abs/x.c'))
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
    expect(pickParsers('cd web && npm run build')).toEqual(Object.values(parsers))
    expect(pickParsers('echo hi && make')).toEqual(Object.values(parsers))
    expect(pickParsers('tsc && make native')).toEqual(Object.values(parsers))
  })

  it('reads package scripts through to their commands', () => {
    const scripts = {
      build: 'tsc -p . && vite build',
      test: 'vitest run',
      lint: 'NODE_ENV=ci eslint .',
      prelint: 'tsc --noEmit',
      check: 'pnpm lint',
      loop: 'npm run loop',
    }
    expect(pickParsers('npm run build', undefined, scripts)).toEqual([parsers.tsc, parsers.esbuild, parsers.vite])
    expect(pickParsers('pnpm test', undefined, scripts)).toEqual([parsers.jest])
    expect(pickParsers('yarn test --watch=false', undefined, scripts)).toEqual([parsers.jest])
    expect(pickParsers('cd web && bun run check', undefined, scripts)).toEqual([parsers.tsc, parsers.eslint])
    expect(pickParsers('npm run loop', undefined, scripts)).toEqual(Object.values(parsers))
    expect(pickParsers('npm run missing', undefined, scripts)).toEqual(Object.values(parsers))
    expect(pickParsers('npm run build', undefined, { build: 'tsc' })).toEqual([parsers.tsc])
  })

  it('keeps quoted separators inside their command', () => {
    expect(pickParsers('cat "logs;old.txt"')).toEqual([])
    expect(pickParsers("grep -E 'a|b' src && tsc")).toEqual([parsers.tsc])
    expect(pickParsers('cd C:\\repo\\; tsc')).toEqual([parsers.tsc])
    expect(pickParsers('echo \\" && tsc && echo "done"')).toEqual([parsers.tsc])
  })

  it('reads compiler output from cmake --build', () => {
    expect(pickParsers('cmake --build build')).toEqual([parsers.msbuild, parsers.cmake, parsers.gcc])
  })

  it('reads only the first command of a pipeline', () => {
    expect(pickParsers('grep -n x src | wc -l')).toEqual([])
    expect(pickParsers('cargo build 2>&1 | tee log')).toEqual([parsers.rustc])
  })
})

describe('python on Windows', () => {
  // hand-written, no Windows capture
  it('skips the standard library under C:\\PythonXY\\Lib', () => {
    const lines = [
      'Traceback (most recent call last):',
      '  File "C:\\repo\\app.py", line 4, in <module>',
      '    json.loads(text)',
      '  File "C:\\Python313\\Lib\\json\\__init__.py", line 346, in loads',
      '    return _default_decoder.decode(s)',
      '  File "C:\\Python313\\Lib\\json\\decoder.py", line 355, in raw_decode',
      '    raise JSONDecodeError("Expecting value", s, err.value) from None',
      'json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)',
    ]
    expect(parsers.python(lines).map((p) => `${p.file}:${p.line}`)).toEqual(['C:\\repo\\app.py:4'])
  })
})

describe('node file URLs', () => {
  // hand-written
  it('decodes a Windows file URL on any OS', () => {
    const lines = ['Error: boom', '    at main (file:///C:/my%20app/app.mjs:3:7)']
    expect(parsers.node(lines).map((p) => `${p.file}:${p.line}`)).toEqual(['C:/my app/app.mjs:3'])
  })
})

describe('ruby on Windows', () => {
  // hand-written, no Windows capture
  it('skips the standard library under lib\\ruby', () => {
    const lines = [
      "C:/Ruby26-x64/lib/ruby/2.6.0/json/common.rb:156:in `parse': 767: unexpected token at '{nope' (JSON::ParserError)",
      "\tfrom C:\\Ruby33-x64\\lib\\ruby\\3.3.0\\json\\common.rb:219:in `parse'",
      "\tfrom C:\\repo\\app.rb:4:in `<main>'",
    ]
    expect(parsers.ruby(lines).map((p) => `${p.file}:${p.line}`)).toEqual(['C:\\repo\\app.rb:4'])
  })
})

describe('lua on Windows', () => {
  // hand-written, no Windows capture
  it('skips luarocks modules', () => {
    const lines = [
      'lua: C:\\Users\\me\\AppData\\Roaming\\luarocks\\share\\lua\\5.4\\json.lua:12: bad json',
      'stack traceback:',
      "\t[C]: in function 'error'",
      "\tC:\\Users\\me\\AppData\\Roaming\\luarocks\\share\\lua\\5.4\\json.lua:12: in function 'json.decode'",
      '\tC:\\repo\\main.lua:4: in main chunk',
      '\t[C]: in ?',
    ]
    expect(parsers.lua(lines).map((p) => `${p.file}:${p.line}`)).toEqual(['C:\\repo\\main.lua:4'])
  })
})

describe('zig on Windows', () => {
  // hand-written, no Windows capture
  it('skips the standard library under C:\\zig\\lib\\std', () => {
    const lines = [
      'error: InvalidCharacter',
      'C:\\zig\\lib\\std\\fmt.zig:583:24: 0x7ff6a1b2c3d4 in charToDigit (app.exe)',
      '    if (value >= base) return error.InvalidCharacter;',
      '                       ^',
      'C:\\repo\\src\\main.zig:4:5: 0x7ff6a1b2c4e5 in parse (app.exe)',
      '    return std.fmt.parseInt(u32, s, 10);',
      '    ^',
    ]
    expect(parsers.zig(lines).map((p) => `${p.file}:${p.line}:${p.col}`)).toEqual(['C:\\repo\\src\\main.zig:4:5'])
  })
})

describe('parseAll', () => {
  const fixture = (path: string) => clean(readFileSync(join(__dirname, 'fixtures', path), 'utf8'))
  const expected = (path: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', path), 'utf8'))

  // no doubles, no drops
  const all = readdirSync(join(__dirname, 'fixtures')).flatMap((tool) =>
    readdirSync(join(__dirname, 'fixtures', tool))
      .filter((f) => f.endsWith('.txt'))
      .map((f) => `${tool}/${f.slice(0, -4)}`),
  )
  it.each(all)('every parser on %s matches the specific parser alone', (name) => {
    expect(parseAll(Object.values(parsers), fixture(`${name}.txt`))).toEqual(expected(`${name}.json`))
  })
})

describe('watch passes', () => {
  const capture = (name: string) => readFileSync(join(__dirname, 'watch', name), 'utf8')
  const problemsPerPass = (command: string, passes: string[]) =>
    passes.map((pass) => parseAll(pickParsers(command), clean(pass)).length)

  // the same loop the extension runs: search a little before where the last chunk ended
  const split = (raw: string, chunkSize: number) => {
    const passes: string[] = []
    let buffer = ''
    let scanned = 0
    for (let i = 0; i < raw.length; i += chunkSize) {
      buffer += raw.slice(i, i + chunkSize)
      const pass = lastPass(buffer, scanned - 100)
      scanned = buffer.length
      if (!pass) continue
      passes.push(buffer.slice(pass.start, pass.end))
      buffer = buffer.slice(pass.end)
      scanned = buffer.length
    }
    return passes
  }

  it.each([1, 7, 512])('splits tsc --watch into its passes, %i bytes at a time', (size) => {
    expect(problemsPerPass('tsc --watch -p .', split(capture('tsc-watch.txt'), size))).toEqual([1, 0, 2])
  })

  it.each([1, 7, 512])('splits vitest watch into its passes, %i bytes at a time', (size) => {
    expect(problemsPerPass('vitest watch', split(capture('vitest-watch.txt'), size))).toEqual([1, 0, 1])
  })

  it('keeps only the newest pass when several arrive at once', () => {
    expect(problemsPerPass('tsc --watch -p .', split(capture('tsc-watch.txt'), 1 << 20))).toEqual([2])
    expect(problemsPerPass('vitest watch', split(capture('vitest-watch.txt'), 1 << 20))).toEqual([1])
  })

  it('finds nothing in output that never waits', () => {
    expect(lastPass('src/a.ts(1,1): error TS2322: x\nFound 1 error.\n')).toBeUndefined()
  })
})
