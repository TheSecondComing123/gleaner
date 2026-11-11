// `tsc --watch` and vitest's watch mode end every pass with one of these.
const PASS_END = /(?:Watching|Waiting) for file changes[^\n]*\n/g

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
