import { fileURLToPath } from 'node:url'
import type { Problem, Related } from '../problem'

// `    at fn (/abs/app.js:12:5)`, `    at /abs/app.js:12:5`, `    at async file:///abs/app.mjs:12:5`.
// Native frames like `at JSON.parse (<anonymous>)` have no location. The last frame before an
// error's properties ends in ` {`.
const FRAME = /^\s+at (?:async )?(?:(.+?) \()?(?:(.+?):(\d+):(\d+)|<anonymous>)\)?(?: \{)?$/
const CARET = /^\s*\^+$/

function location(path: string): string | undefined {
  if (path.startsWith('node:') || path.includes('node_modules')) return undefined
  return path.startsWith('file://') ? fileURLToPath(path) : path
}

export function node(lines: string[]): Problem[] {
  const problems: Problem[] = []
  // The error text since the crash header's caret line, or since the last blank line without one.
  let text: string[] = []
  let afterCaret = false
  let crash: { message: string; frames: Related[] } | undefined

  const finish = () => {
    const [first, ...rest] = crash?.frames ?? []
    if (crash && first)
      problems.push({
        file: first.file,
        line: first.line,
        col: first.col,
        severity: 'error',
        message: crash.message,
        source: 'node',
        related: rest.length ? rest : undefined,
      })
    crash = undefined
    text = []
    afterCaret = false
  }

  for (const line of lines) {
    const frame = FRAME.exec(line)
    if (frame) {
      crash ??= { message: text.join('\n'), frames: [] }
      const file = frame[2] && location(frame[2])
      const at = { file, line: Number(frame[3]), col: Number(frame[4]) }
      // A `[cause]` stack repeats the frames it shares with the outer one.
      if (file && !crash.frames.some((f) => f.file === at.file && f.line === at.line && f.col === at.col))
        crash.frames.push({ file, line: at.line, col: at.col, message: frame[1] ?? '' })
      continue
    }
    // Error properties, `[cause]` stacks and `... N lines matching ...` stay part of the crash.
    if (crash && (/^\s/.test(line) || line === '}')) continue
    if (crash) finish()

    if (CARET.test(line)) {
      text = []
      afterCaret = true
    } else if (line === '') {
      if (!afterCaret) text = []
    } else text.push(line)
  }
  finish()
  return problems
}
