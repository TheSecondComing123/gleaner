const COLOR = String.raw`(?:\x1b\[[\d;]*m)*`
const PASS_END = new RegExp(
  [
    String.raw`(?:Watching|Waiting) for file changes[^\n]*\n`,
    String.raw`Watch Usage${COLOR}(?:\r?\n|: ${COLOR}Press ${COLOR}w${COLOR} to show more\.${COLOR})`,
    String.raw`\[nodemon\] (?:app crashed - waiting for file changes before starting\.\.\.|clean exit - waiting for changes before restart)[^\n]*\n`,
  ].join('|'),
  'g',
)

// The last finished pass in `raw`, searching from `from`. Earlier passes in the same output are stale.
export function lastPass(raw: string, from = 0): { start: number; end: number } | undefined {
  PASS_END.lastIndex = Math.max(0, from)
  let start = 0
  let end = -1
  for (let match = PASS_END.exec(raw); match; match = PASS_END.exec(raw)) {
    if (end >= 0) start = end
    end = match.index + match[0].length
  }
  return end < 0 ? undefined : { start, end }
}
