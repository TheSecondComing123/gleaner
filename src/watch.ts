const COLOR = String.raw`(?:\x1b\[[\d;]*m)*`
const JEST_USAGE = String.raw`Watch Usage${COLOR}(?:\r?\n|: ${COLOR}Press ${COLOR}w${COLOR} to show more\.${COLOR})`
const JEST_COMPLETE = String.raw`(?:Ran all test suites[^\n]*|No tests found related to files changed since last commit\.[^\n]*)\n`
const OTHER_END = [
  String.raw`(?:Watching|Waiting) for file changes[^\n]*\n`,
  String.raw`\[nodemon\] (?:app crashed - waiting for file changes before starting\.\.\.|clean exit - waiting for changes before restart)[^\n]*\n`,
].join('|')
const usage = new RegExp(JEST_USAGE)
const complete = new RegExp(JEST_COMPLETE)
const other = new RegExp(OTHER_END)
const events = new RegExp([JEST_COMPLETE, JEST_USAGE, OTHER_END].join('|'), 'g')

export const isJestPrompt = (raw: string): boolean => usage.test(raw)

export class WatchPass {
  private jestFinished = false

  accept(raw: string): boolean {
    if (complete.test(raw)) this.jestFinished = true
    if (usage.test(raw)) {
      const finished = this.jestFinished
      this.jestFinished = false
      return finished
    }
    return other.test(raw)
  }
}

// the last finished pass; help can repeat without another jest run.
export function lastPass(raw: string, from = 0): { start: number; end: number } | undefined {
  const watch = new WatchPass()
  events.lastIndex = 0
  let start = 0
  let end = -1
  for (let match = events.exec(raw); match; match = events.exec(raw)) {
    if (!watch.accept(match[0]) || match.index < Math.max(0, from)) continue
    if (end >= 0) start = end
    end = match.index + match[0].length
  }
  return end < 0 ? undefined : { start, end }
}
