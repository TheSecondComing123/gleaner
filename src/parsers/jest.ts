import type { Problem } from '../problem'

// Jest: `FAIL src/a.test.js`, then a `● suite › test` block per failure.
const SUITE = /^\s*(?:FAIL|PASS)\s+(.+)$/
const JEST_TEST = /^\s+● (.+)$/
// Vitest: `FAIL  src/a.test.ts > suite > test`, or `FAIL  src/a.test.ts [ src/a.test.ts ]` when the file fails to load.
const VITEST_TEST = /^\s*FAIL\s+(.+?) > (.+)$/
const VITEST_SUITE = /^\s*FAIL\s+(.+?) \[ .+ \]$/
// Stack frames: `at fn (src/a.js:5:15)` (jest) and `❯ fn src/a.ts:5:15` (vitest).
const AT = /^\s*at (?:.+? \()?(.+?):(\d+):(\d+)\)?$/
const ARROW = /^\s*❯ (?:\S+ )?(.+?):(\d+):(\d+)$/
// Vitest's parse error box: `╭─[ src/a.ts:2:6 ]`
const BOX = /─\[ (.+):(\d+):(\d+) \]$/
// Babel's syntax error, which jest prints when a file fails to parse: `SyntaxError: /abs/a.js: msg (2:5)`
const BABEL = /^\s*(\w*Error): (.+?): (.+) \((\d+):(\d+)\)$/
// Code frames: `> 5 | code`, `    |   ^` (jest) and `5| code` (vitest).
const FRAME = /^\s*>?\s*\d*\s?\|/
// End of the failures: section separators and the final summary.
const END = /^(?:⎯|\s*Test (?:Suites|Files)|Summary of all failing tests)/

interface Block {
  source: string
  titles: { file: string; title?: string }[]
  lines: string[]
  at?: { file: string; line: number; col: number }
  inTrace: boolean
}

export function jest(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let suite: string | undefined
  let block: Block | undefined

  const finish = () => {
    if (!block) return
    for (const { file, title } of block.titles) {
      problems.push({
        file: block.at?.file ?? file,
        line: block.at?.line ?? 1,
        col: block.at?.col,
        severity: 'error',
        message: [title, ...block.lines].filter(Boolean).join('\n'),
        source: block.source,
      })
    }
    block = undefined
  }

  for (const line of lines) {
    const vitest = VITEST_TEST.exec(line) ?? VITEST_SUITE.exec(line)
    if (vitest) {
      const failure = { file: vitest[1], title: vitest[2] }
      // Vitest prints one error under several FAIL lines when the tests failed the same way.
      if (block?.source === 'vitest' && !block.lines.length && !block.inTrace) block.titles.push(failure)
      else {
        finish()
        block = { source: 'vitest', titles: [failure], lines: [], inTrace: false }
      }
      continue
    }
    const suiteLine = SUITE.exec(line)
    if (suiteLine) {
      finish()
      suite = suiteLine[1]
      continue
    }
    const jestTest = JEST_TEST.exec(line)
    if (jestTest && suite) {
      finish()
      block = { source: 'jest', titles: [{ file: suite, title: jestTest[1] }], lines: [], inTrace: false }
      continue
    }
    if (END.test(line)) {
      finish()
      if (line.includes('Summary of all failing tests')) break
      continue
    }
    if (!block) continue

    const babel = !block.inTrace && BABEL.exec(line)
    if (babel) {
      block.lines = [`${babel[1]}: ${babel[3]}`]
      block.at = { file: babel[2], line: Number(babel[4]), col: Number(babel[5]) }
      block.inTrace = true
      continue
    }
    const frame = AT.exec(line) ?? ARROW.exec(line) ?? BOX.exec(line)
    if (frame || FRAME.test(line)) block.inTrace = true
    if (!block.inTrace) {
      if (line.trim()) block.lines.push(block.source === 'jest' ? line.replace(/^ {4}/, '') : line)
      continue
    }
    // The first frame in the user's own code, not in a dependency.
    if (frame && !block.at && !/node_modules|^node:/.test(frame[1])) {
      block.at = { file: frame[1], line: Number(frame[2]), col: Number(frame[3]) }
    }
  }
  finish()
  return problems
}
