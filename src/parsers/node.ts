import type { Problem, Related } from '../problem'
import { fromFileUrl } from '../resolve'

// `    at fn (/abs/app.js:12:5)`
const FRAME = /^\s+at (?:async )?(?:(.+?) \()?(?:(.+?):(\d+):(\d+)|<anonymous>)\)?(?: \{)?$/
const CARET = /^\s*\^+$/
// crash header `/abs/app.js:12`
const HEADER = /^((?:\/|file:\/\/|[A-Za-z]:\\).+):(\d+)$/
const VERSION = /^Node\.js v\d/
const HINT = /^\(Use `node --trace-/
// last line naming an error
const ERROR_LINE = /^(?:Uncaught )?\[?\w*(?:Error|Exception)\b/

function location(path: string): string | undefined {
  if (path.startsWith('node:') || path.includes('node_modules')) return undefined
  return path.startsWith('file://') ? fromFileUrl(path) : path
}

export function node(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let text: string[] = []
  let afterCaret = false
  let header: { file: string; line: number } | undefined
  let crash: { message: string; frames: Related[] } | undefined

  const errorText = (): string => {
    const body = text.filter((line) => !HINT.test(line))
    if (afterCaret) return body.join('\n')
    const start = body.findLastIndex((line) => ERROR_LINE.test(line))
    return start >= 0 ? body.slice(start).join('\n') : ''
  }

  const finish = () => {
    const [first, ...rest] = crash?.frames ?? []
    // no user frame: use the header
    const at = first ?? (header && afterCaret ? { ...header, col: undefined } : undefined)
    const message = crash?.message ?? errorText()
    // no message: skip
    if (at && message)
      problems.push({
        file: at.file,
        line: at.line,
        col: at.col,
        severity: 'error',
        message,
        source: 'node',
        related: first && rest.length ? rest : undefined,
      })
    crash = undefined
    header = undefined
    text = []
    afterCaret = false
  }

  for (const line of lines) {
    const frame = FRAME.exec(line)
    if (frame) {
      crash ??= { message: errorText(), frames: [] }
      const file = frame[2] && location(frame[2])
      const at = { file, line: Number(frame[3]), col: Number(frame[4]) }
      // `[cause]` repeats frames
      if (file && !crash.frames.some((f) => f.file === at.file && f.line === at.line && f.col === at.col))
        crash.frames.push({ file, line: at.line, col: at.col, message: frame[1] ?? '' })
      continue
    }
    // still part of the crash
    if (crash && (/^\s/.test(line) || line === '}')) continue
    if (crash) finish()
    if (header && afterCaret && VERSION.test(line)) {
      finish()
      continue
    }

    const head = HEADER.exec(line)
    if (head) {
      const file = location(head[1])
      header = file ? { file, line: Number(head[2]) } : undefined
      text = []
      afterCaret = false
    } else if (CARET.test(line)) {
      text = []
      afterCaret = true
    } else if (line === '') {
      if (!afterCaret) text = []
    } else text.push(line)
  }
  finish()
  return problems
}
