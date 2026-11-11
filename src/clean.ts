const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
// Two-byte escapes, plus ones with intermediate bytes like `ESC ( B` (charset reset,
// which mypy prints through curses).
const ESC = /\x1b[ -/]*[0-~]/g
// Parser regexes with two lazy groups get slow on huge single lines (a minified bundle
// echoed to the terminal); no real error line is this long.
const MAX_LINE = 4000

// Terminal bytes → plain lines. A `\r` without `\n` means the line was redrawn,
// so only the text after the last one is what the user saw. This also drops
// zsh's "%" partial-line marker, which ends in `\r`.
export function clean(raw: string, maxLines = 10_000): string[] {
  const text = raw.replace(OSC, '').replace(CSI, '').replace(ESC, '')
  const lines = text.split(/\r?\n/).map((line) => {
    const start = line.lastIndexOf('\r') + 1
    return line.slice(start, start + MAX_LINE).trimEnd()
  })
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  // ponytail: keeps the first maxLines; a huge log loses errors printed after that
  return lines.slice(0, maxLines)
}
