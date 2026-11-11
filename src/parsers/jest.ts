import type { Problem } from '../problem'

// jest
const SUITE = /^\s*(?:FAIL|PASS)\s+(.+)$/
const JEST_TEST = /^\s+● (.+)$/
// vitest
const VITEST_TEST = /^\s*FAIL\s+(.+?) > (.+)$/
const VITEST_SUITE = /^\s*FAIL\s+(.+?) \[ .+ \]$/
// stack frames
const AT = /^\s*at (?:.+? \()?(.+?):(\d+):(\d+)\)?$/
const ARROW = /^\s*❯ (?:\S+ )?(.+?):(\d+):(\d+)$/
// vitest parse error box
const BOX = /─\[ (.+):(\d+):(\d+) \]$/
// babel syntax error
const BABEL = /^\s*(\w*Error): (.+?): (.+) \((\d+):(\d+)\)$/
// code frames
const FRAME = /^\s*>?\s*\d*\s?\|/
// end of failures
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
      // one error, several FAIL lines
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
      // 0-based columns
      block.at = { file: babel[2], line: Number(babel[4]), col: Number(babel[5]) + 1 }
      block.inTrace = true
      continue
    }
    const frame = AT.exec(line) ?? ARROW.exec(line) ?? BOX.exec(line)
    if (frame || FRAME.test(line)) block.inTrace = true
    if (!block.inTrace) {
      if (line.trim()) block.lines.push(block.source === 'jest' ? line.replace(/^ {4}/, '') : line)
      continue
    }
    // first user frame
    if (frame && !block.at && !/node_modules|^node:/.test(frame[1])) {
      block.at = { file: frame[1], line: Number(frame[2]), col: Number(frame[3]) }
    }
  }
  finish()
  return problems
}
