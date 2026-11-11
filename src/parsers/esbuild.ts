import type { Problem } from '../problem'

// `✘ [ERROR] msg`, then location
const HEAD = /^[✘▲] \[(ERROR|WARNING)\] (.*?)(?: \[([\w-]+)\])?$/
const LOCATION = /^ {4}(\S.*?):(\d+):(\d+):$/
const NOTE = /^ {2}(\S.*)$/

export function esbuild(lines: string[]): Problem[] {
  const problems: Problem[] = []
  let current: Problem | undefined
  let note: string | undefined

  const flushNote = () => {
    if (current && note) current.message += `\n${note}`
    note = undefined
  }

  for (const line of lines) {
    const head = HEAD.exec(line)
    if (head) {
      flushNote()
      current = {
        file: '',
        line: 0,
        col: 0,
        severity: head[1] === 'ERROR' ? 'error' : 'warning',
        message: head[2],
        code: head[3],
        source: 'esbuild',
      }
      continue
    }
    if (!current) continue

    const location = LOCATION.exec(line)
    if (location) {
      // 0-based columns
      const at = { file: location[1], line: Number(location[2]), col: Number(location[3]) + 1 }
      if (!current.file && !note) {
        Object.assign(current, at)
        problems.push(current)
      } else if (note) {
        current.related = [...(current.related ?? []), { ...at, message: note.replace(/:$/, '') }]
        note = undefined
      }
      continue
    }
    const text = NOTE.exec(line)
    if (text) {
      flushNote()
      note = text[1]
    } else if (/^\S/.test(line)) {
      // end of log
      flushNote()
      current = undefined
    }
  }
  flushNote()
  return problems
}
