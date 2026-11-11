const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const ESC = /\x1b[@-_]/g

// Terminal bytes → plain lines. A `\r` without `\n` means the line was redrawn,
// so only the text after the last one is what the user saw. This also drops
// zsh's "%" partial-line marker, which ends in `\r`.
export function clean(raw: string, maxLines = 10_000): string[] {
  const text = raw.replace(OSC, '').replace(CSI, '').replace(ESC, '')
  const lines = text.split(/\r?\n/).map((line) => line.slice(line.lastIndexOf('\r') + 1).trimEnd())
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  // ponytail: keeps the first maxLines; a huge log loses errors printed after that
  return lines.slice(0, maxLines)
}
