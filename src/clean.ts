const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
// incl. charset escapes (mypy)
const ESC = /\x1b[ -/]*[0-~]/g
// minified bundles stall regexes
const MAX_LINE = 4000

// last `\r` redraw wins
export function clean(raw: string, maxLines = 10_000, onDrop?: () => void): string[] {
  const text = raw.replace(OSC, '').replace(CSI, '').replace(ESC, '')
  const lines = text.split(/\r?\n/).map((line) => {
    const start = line.lastIndexOf('\r') + 1
    if (line.length - start > MAX_LINE) onDrop?.()
    return line.slice(start, start + MAX_LINE).trimEnd()
  })
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  if (lines.length > maxLines) onDrop?.()
  return lines.slice(0, maxLines)
}
