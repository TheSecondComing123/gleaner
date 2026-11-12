import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clean } from '../src/clean'
import { display, mapPosition, type Shown } from '../src/display'
import { compileMatchers } from '../src/matchers'
import { Output } from '../src/output'
import { commandName, parseAll, parsers, pickParsers } from '../src/parsers'
import { resolveFile } from '../src/resolve'
import { lastPass, WatchPass } from '../src/watch'

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
  it("selects the watcher's parser", () => {
    expect(pickParsers('jest --watch')).toEqual([parsers.jest])
    expect(pickParsers('jest --watchAll')).toEqual([parsers.jest])
  })

  it('keeps fallback parsing for nodemon child tools', () => {
    const lines = clean(readFileSync(join(__dirname, 'fixtures/python/chained.txt'), 'utf8'))
    expect(parseAll(pickParsers('nodemon app.py'), lines)).toEqual(parsers.python(lines))
    expect(pickParsers('nodemon app.py')).toEqual(Object.values(parsers))
    expect(pickParsers('nodemon app.js')).toEqual(Object.values(parsers))
  })

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

describe('extension matchers', () => {
  const contributions = JSON.parse(readFileSync(join(__dirname, 'matchers', 'contributes.json'), 'utf8'))
  const compiled = compileMatchers(Object.values(contributions), {
    cwd: resolve('/repo'),
    workspaceFolders: [{ name: 'app', path: resolve('/repo') }],
  })
  const fixture = (name: string) => clean(readFileSync(join(__dirname, 'matchers', name), 'utf8'))

  it.each(['stylelint-unix.txt', 'stylelint-compact.txt'])('reads the real %s capture', (name) => {
    expect(parseAll(compiled, fixture(name))).toEqual(
      [
        { line: 1, col: 12, message: 'Expected "#fff" to be "#ffffff"', code: 'color-hex-length' },
        { line: 1, col: 18, message: 'Unexpected unknown property "colr"', code: 'property-no-unknown' },
        { line: 4, col: 3, message: 'Unexpected empty block', code: 'block-no-empty' },
      ].map((p) => ({
        ...p,
        file: '/private/tmp/claude-501/gl-matchers/a.css',
        severity: 'error',
        source: 'Stylelint',
      })),
    )
  })

  it('reads the real markdownlint capture even though its severity capture is a rule name', () => {
    expect(parseAll(compiled, fixture('markdownlint.txt'))).toEqual(
      [
        {
          line: 1,
          message: 'should be surrounded by blank lines [Expected: 1; Actual: 0; Below] [Context: "# Title"]',
        },
        {
          line: 2,
          message: 'should be surrounded by blank lines [Expected: 1; Actual: 0; Above] [Context: "## skipped level"]',
        },
        {
          line: 2,
          message: 'should be surrounded by blank lines [Expected: 1; Actual: 0; Below] [Context: "## skipped level"]',
        },
        { line: 5, message: 'consecutive blank lines [Expected: 1; Actual: 2]', code: 'Multiple' },
      ].map((p) => ({
        file: resolve('/repo/doc.md'),
        col: undefined,
        severity: 'error',
        source: 'markdownlint',
        code: 'Headings',
        ...p,
      })),
    )
  })

  // hand-written samples, no elixir installed
  it('reads elixir location, capture 0 and multi-line messages', () => {
    expect(
      parseAll(compiled, [
        '** (CompileError) lib/shop.ex:7: undefined function buy/0',
        'warning: variable "cart" is unused',
        '  lib/shop.ex:9: Shop.buy/0',
        '  1) test buys tea (ShopTest)',
        '     test/shop_test.exs:12',
      ]),
    ).toEqual([
      {
        file: resolve('/repo/lib/shop.ex'),
        line: 7,
        severity: 'error',
        message: '** (CompileError) lib/shop.ex:7: undefined function buy/0',
        source: 'elixir',
      },
      {
        file: resolve('/repo/lib/shop.ex'),
        line: 9,
        severity: 'warning',
        message: 'variable "cart" is unused\n: Shop.buy/0',
        source: 'elixir',
      },
      {
        file: resolve('/repo/test/shop_test.exs'),
        line: 12,
        severity: 'warning',
        message: 'test buys tea (ShopTest)',
        source: 'elixir',
      },
    ])
  })

  const row = {
    regexp: '^(.+):(\\d+):(\\d+): (\\S+) (\\S+) (.*)$',
    file: 1,
    line: 2,
    column: 3,
    severity: 4,
    code: 5,
    message: 6,
  }

  it('resolves contributed bases and patterns across extensions, with child overrides', () => {
    const chosen = compileMatchers([
      { problemMatchers: [{ name: 'child', base: '$parent', source: 'child', severity: 'warning' }] },
      {
        problemMatchers: [{ name: 'parent', owner: 'parent', pattern: '$row' }],
        problemPatterns: [{ name: 'row', ...row }],
      },
    ])
    const lines = ['src/a.css:2:3: strange C1 bad']
    expect(parseAll(chosen, lines)).toEqual([
      { file: 'src/a.css', line: 2, col: 3, severity: 'warning', code: 'C1', message: 'bad', source: 'child' },
    ])
    expect(parseAll([...chosen, ...compiled], ['src/a.css:2:3: W C2 bad'])[0].severity).toBe('warning')
  })

  it('resolves relative matcher paths before generic lookup using the real stylelint capture', async () => {
    const matcher = contributions.stylelint
    const chosen = compileMatchers(
      [
        {
          ...matcher,
          problemMatchers: matcher.problemMatchers.map((m: object) => ({
            ...m,
            fileLocation: ['relative', `\${workspaceFolder}/src`],
          })),
        },
      ],
      { cwd: resolve('/repo'), workspaceFolders: [{ name: 'app', path: resolve('/repo') }] },
    )
    const lines = fixture('stylelint-unix.txt').map((line) => line.replace('/private/tmp/claude-501/gl-matchers/', ''))
    const found = parseAll(chosen, lines)
    expect(found).toHaveLength(3)
    const files = new Set([resolve('/repo/a.css'), resolve('/repo/src/a.css')])
    expect(await resolveFile(found[0].file, [resolve('/repo')], async (file) => files.has(file))).toBe(
      resolve('/repo/src/a.css'),
    )
  })

  it.each([
    ['relative', 'a.css', '/repo/a.css'],
    [['relative', `\${cwd}/styles`], 'a.css', '/repo/packages/app/styles/a.css'],
    [['relative', `\${workspaceRoot}/src`], 'a.css', '/repo/src/a.css'],
    [['relative', `\${workspaceFolder:shared}/src`], 'a.css', '/shared/src/a.css'],
    ['autoDetect', 'a.css', '/repo/a.css'],
    ['autoDetect', resolve('/elsewhere/a.css'), '/elsewhere/a.css'],
    ['absolute', resolve('/elsewhere/a.css'), '/elsewhere/a.css'],
    ['absolute', 'a.css', undefined],
    [['relative', `\${workspaceFolder:missing}`], 'a.css', undefined],
  ])('applies fileLocation %j to %s', (fileLocation, file, expected) => {
    const chosen = compileMatchers([{ problemMatchers: [{ owner: 'lint', fileLocation, pattern: row }] }], {
      cwd: resolve('/repo/packages/app'),
      workspaceFolders: [
        { name: 'app', path: resolve('/repo') },
        { name: 'shared', path: resolve('/shared') },
      ],
    })
    expect(parseAll(chosen, [`${file}:2:3: I C1 bad`]).map((p) => p.file)).toEqual(expected ? [resolve(expected)] : [])
  })

  it.each([
    ['4', { line: 4 }],
    ['4,2', { line: 4, col: 2 }],
    ['4,2,6,8', { line: 4, col: 2, endLine: 6, endCol: 8 }],
  ])('reads location %s', (location, expected) => {
    const chosen = compileMatchers([
      {
        problemMatchers: [
          { owner: 'lint', pattern: { regexp: '^(.*)@([^:]+): (.*)$', file: 1, location: 2, message: 3 } },
        ],
      },
    ])
    expect(parseAll(chosen, [`a.css@${location}: bad`])).toEqual([
      { file: 'a.css', ...expected, severity: 'error', message: 'bad', source: 'lint' },
    ])
    expect(parseAll(chosen, ['a.css@nope: bad', 'a.css@1,2,3: bad', 'a.css@99999999999999999999: bad'])).toEqual([])
  })

  it('reads separate range captures and endColumn on the same line', () => {
    const chosen = compileMatchers([
      {
        problemMatchers: [
          {
            owner: 'lint',
            pattern: {
              regexp: '^(.*):(\\d+):(\\d+)-(\\d+),(\\d+): (.*)$',
              file: 1,
              line: 2,
              column: 3,
              endLine: 4,
              endColumn: 5,
              message: 6,
            },
          },
        ],
      },
    ])
    expect(parseAll(chosen, ['a.css:2:3-4,5: bad'])).toEqual([
      { file: 'a.css', line: 2, col: 3, endLine: 4, endCol: 5, severity: 'error', message: 'bad', source: 'lint' },
    ])
    const sameLine = compileMatchers([
      {
        problemMatchers: [
          {
            pattern: {
              regexp: '^(.*):(\\d+):(\\d+)-(\\d+): (.*)$',
              file: 1,
              line: 2,
              column: 3,
              endColumn: 4,
              message: 5,
            },
          },
        ],
      },
    ])
    expect(parseAll(sameLine, ['a.css:2:3-5: bad'])[0]).toMatchObject({ line: 2, col: 3, endLine: 2, endCol: 5 })
  })

  it('loops the last pattern without leaking captures, then retries the next header', () => {
    const chosen = compileMatchers([
      {
        problemPatterns: [
          {
            name: 'rows',
            patterns: [
              { regexp: '^file (.+)$', file: 1 },
              {
                regexp: '^  (\\d+):(\\d+) (.*?)(?: \\[(.*)\\])?$',
                line: 1,
                column: 2,
                message: 3,
                code: 4,
                loop: true,
              },
            ],
          },
        ],
        problemMatchers: [{ owner: 'lint', pattern: '$rows' }],
      },
    ])
    const lines = ['file a.css', '  2:3 first [C1]', '  4:5 second', 'file b.css', '  6:7 third']
    const expected = [
      { file: 'a.css', line: 2, col: 3, code: 'C1', message: 'first', severity: 'error', source: 'lint' },
      { file: 'a.css', line: 4, col: 5, message: 'second', severity: 'error', source: 'lint' },
      { file: 'b.css', line: 6, col: 7, message: 'third', severity: 'error', source: 'lint' },
    ]
    expect(parseAll(chosen, lines)).toEqual(expected)
    expect(parseAll(chosen, lines)).toEqual(expected)
    expect(parseAll(chosen, ['file incomplete', 'file b.css', '  6:7 third'])).toEqual([expected[2]])
  })

  it('skips missing references, built-in bases, cycles, invalid regexes, background and unlocated patterns', () => {
    expect(
      compileMatchers([
        {
          problemMatchers: [
            { pattern: '$missing' },
            ...['$tsc', '$gcc', '$msCompile'].map((base) => ({ base, pattern: row })),
            { name: 'a', base: '$b', pattern: row },
            { name: 'b', base: '$a', pattern: row },
            { pattern: { regexp: '[', file: 1, line: 2 } },
            { pattern: row, background: {} },
            { pattern: { regexp: '^FAILURE: (.*)$', message: 1 } },
            { pattern: { regexp: '^(.*)$', file: 1 } },
            { pattern: [] },
          ],
        },
      ]),
    ).toEqual([])
    expect(compileMatchers([null, false, {}, { problemMatchers: [null, {}, { pattern: 3 }] }])).toEqual([])
  })

  it('ignores garbage and incomplete multi-line input', () => {
    expect(parseAll(compiled, ['', 'garbage', ':NaN:Infinity: strange', 'warning: unfinished'])).toEqual([])
  })

  it('keeps gleaner first through the existing dedupe', () => {
    const lines = fixture('stylelint-compact.txt').map((line) => line.replace('error -', 'Error -'))
    const ours = parseAll(Object.values(parsers), lines)
    expect(ours).toHaveLength(3)
    expect(parseAll([...Object.values(parsers), ...compiled], lines)).toEqual(ours)
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

  it.each([1, 7, 64])('splits jest and nodemon into their passes, %i bytes at a time', (size) => {
    expect(problemsPerPass('jest --watchAll', split(capture('jest-watch.txt'), size))).toEqual([1, 0, 1])
    expect(problemsPerPass('nodemon app.js', split(capture('nodemon.txt'), size))).toEqual([1, 0, 1])
  })

  it.each([
    ['jest --watchAll', 'jest-watch.txt'],
    ['nodemon app.js', 'nodemon.txt'],
  ])('streams each pass of %s from its real capture', (command, name) => {
    const raw = capture(name)
    for (const size of [1, 7, 512, raw.length]) {
      const stream = new Output(pickParsers(command))
      const counts: number[] = []
      const watch = new WatchPass()
      for (let i = 0; i < raw.length; i += size) {
        stream.append(raw.slice(i, i + size), (line) => {
          if (!watch.accept(`${line}\n`)) return
          counts.push(stream.snapshot().length)
          stream.reset()
        })
      }
      expect(counts, `${size} bytes at a time`).toEqual([1, 0, 1])
    }
  })

  it.each([1, 7, 512])('ignores repeated jest help without another completed run, %i bytes at a time', (size) => {
    const raw = capture('jest-watch.txt')
    const help = '\nWatch Usage\n › Press q to quit watch mode.\n'
    expect(problemsPerPass('jest --watchAll', split(raw + help + help, size))).toEqual([1, 0, 1])
  })

  it('keeps only the newest pass when several arrive at once', () => {
    expect(problemsPerPass('tsc --watch -p .', split(capture('tsc-watch.txt'), 1 << 20))).toEqual([2])
    expect(problemsPerPass('vitest watch', split(capture('vitest-watch.txt'), 1 << 20))).toEqual([1])
    expect(problemsPerPass('jest --watchAll', split(capture('jest-watch.txt'), 1 << 20))).toEqual([1])
    expect(problemsPerPass('nodemon app.js', split(capture('nodemon.txt'), 1 << 20))).toEqual([1])
  })

  it('finds nothing in output that never waits', () => {
    expect(lastPass('src/a.ts(1,1): error TS2322: x\nFound 1 error.\n')).toBeUndefined()
  })

  it('requires a completed jest run before accepting either help format', () => {
    const watch = new WatchPass()
    expect(watch.accept('Watch Usage\n')).toBe(false)
    expect(watch.accept('No tests found\n')).toBe(false)
    expect(watch.accept('Watch Usage: Press w to show more.')).toBe(false)
    expect(watch.accept('Ran all test suites matching app.\n')).toBe(false)
    expect(watch.accept('Watch Usage: Press w to show more.')).toBe(true)
    expect(watch.accept('Watch Usage\n')).toBe(false)
    expect(watch.accept('No tests found related to files changed since last commit.\n')).toBe(false)
    expect(watch.accept('Watch Usage\n')).toBe(true)
  })
})

describe('display', () => {
  const p = (line: number, character: number, message: string, code?: Shown['code']) => ({
    range: { start: { line, character } },
    message,
    code,
  })

  it('shows a problem once when two runs report it', () => {
    const a = p(6, 2, 'bad', 'TS2322')
    expect(display([[a], [p(6, 2, 'bad', 'TS2322')]], [])).toEqual([a])
  })

  it('keeps two different errors on one line', () => {
    const first = p(6, 2, 'bad', 'TS2322')
    const second = p(6, 30, 'bad', 'TS2322')
    expect(display([[first, second]], [p(6, 2, 'bad', 2322)])).toEqual([second])
  })

  it('hides what another source reports, whatever shape its code has', () => {
    const mine = p(6, 2, 'bad', 'TS2322')
    expect(display([[mine]], [p(6, 2, 'other words', 2322)])).toEqual([])
    expect(display([[mine]], [p(6, 2, 'other words', { value: '2322' })])).toEqual([])
    expect(display([[mine]], [p(6, 2, 'bad', 'TS2551')])).toEqual([mine])
    const pylint = p(6, 2, 'unused import', 'W0611')
    expect(display([[pylint]], [p(6, 2, 'other', 'E0611')])).toEqual([pylint])
  })

  it('compares messages when a side has no code', () => {
    const mine = p(3, 0, 'TypeError: x is undefined\n    at main', undefined)
    expect(display([[mine]], [p(3, 0, 'TypeError: x is undefined', 'E1')])).toEqual([])
    expect(display([[mine]], [p(3, 0, 'something else')])).toEqual([mine])
  })
})

describe('mapPosition', () => {
  const pos = (line: number, character: number) => ({ line, character })
  const edit = (from: [number, number], to: [number, number], text: string) => ({
    range: { start: pos(...from), end: pos(...to) },
    text,
  })

  it('leaves what comes before the edit alone', () => {
    expect(mapPosition(pos(2, 4), edit([5, 0], [5, 0], 'x\n'))).toEqual(pos(2, 4))
  })

  it('moves lines below an inserted line', () => {
    expect(mapPosition(pos(9, 43), edit([0, 0], [0, 0], '\n\n'))).toEqual(pos(11, 43))
  })

  it('moves the column when typing before it on its line', () => {
    expect(mapPosition(pos(6, 2), edit([6, 2], [6, 2], 'x '))).toEqual(pos(6, 4))
  })

  it('pulls lines up when lines are deleted', () => {
    expect(mapPosition(pos(9, 5), edit([3, 0], [5, 0], ''))).toEqual(pos(7, 5))
  })

  it('joins a line onto the one above', () => {
    expect(mapPosition(pos(4, 6), edit([3, 10], [4, 0], ''))).toEqual(pos(3, 16))
  })

  it('drops a position whose text was replaced', () => {
    expect(mapPosition(pos(6, 4), edit([6, 2], [6, 9], 'y'))).toBeUndefined()
  })
})
