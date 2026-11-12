import { clean } from './clean'
import { parseAll } from './parsers'
import type { Parser, Problem } from './problem'

const CHUNK_LINES = 1000
const OVERLAP_LINES = 300
const MAX_RAW_LINE = 16_000
const MAX_CANDIDATES = 2000

const key = (p: Problem) =>
  JSON.stringify([p.file, p.line, p.col, p.source, p.code, p.severity, p.message.split('\n')[0]])

// parsed windows can go; the overlap lets a block finish in the next window.
export class Output {
  private partial = ''
  private lines: string[] = []
  private readonly saved = new Map<string, Problem>()
  private readonly losses = new Set<string>()

  constructor(private readonly chosen: Parser[]) {}

  append(chunk: string, lineReady?: (line: string) => void): void {
    let start = 0
    while (start < chunk.length) {
      const newline = chunk.indexOf('\n', start)
      const end = newline < 0 ? chunk.length : newline
      const room = MAX_RAW_LINE - this.partial.length
      this.partial += chunk.slice(start, Math.min(end, start + room))
      if (end - start > room) this.losses.add('long lines truncated')
      if (newline < 0) break
      const line = this.complete()
      lineReady?.(line)
      start = newline + 1
    }
  }

  private complete(): string {
    const line = clean(`${this.partial}\n`, 1, () => this.losses.add('long lines truncated'))[0] ?? ''
    this.partial = ''
    this.lines.push(line)
    if (this.lines.length >= CHUNK_LINES) {
      this.merge(this.saved, parseAll(this.chosen, this.lines))
      this.lines = this.lines.slice(-OVERLAP_LINES)
      this.losses.add(`older output context dropped (${OVERLAP_LINES} overlap lines retained)`)
    }
    return line
  }

  snapshot(final = false): Problem[] {
    const tail = final && this.partial ? clean(this.partial, 1, () => this.losses.add('long lines truncated')) : []
    const found = new Map(this.saved)
    this.merge(found, parseAll(this.chosen, [...this.lines, ...tail]))
    return [...found.values()]
  }

  private merge(into: Map<string, Problem>, found: Problem[]): void {
    for (const problem of found) {
      const id = key(problem)
      const previous = into.get(id)
      // a window starting inside a block must not replace its fuller copy.
      if (
        previous &&
        previous.message.length >= problem.message.length &&
        (previous.related?.length ?? 0) >= (problem.related?.length ?? 0)
      )
        continue
      into.delete(id)
      into.set(id, problem)
      if (into.size > MAX_CANDIDATES) {
        into.delete(into.keys().next().value as string)
        this.losses.add(`older problems dropped (${MAX_CANDIDATES} candidate limit)`)
      }
    }
  }

  get hasOutput(): boolean {
    return this.lines.length > 0 || this.partial.length > 0 || this.saved.size > 0
  }

  reset(): void {
    this.partial = ''
    this.lines = []
    this.saved.clear()
    this.losses.clear()
  }

  get warnings(): string[] {
    return [...this.losses]
  }
}

export class LiveUpdates {
  private quiet?: ReturnType<typeof setTimeout>
  private busy?: ReturnType<typeof setTimeout>

  constructor(private readonly publish: () => void) {}

  append(): void {
    clearTimeout(this.quiet)
    this.quiet = setTimeout(() => this.flush(), 1500)
    this.busy ??= setTimeout(() => this.flush(), 5000)
  }

  private flush(): void {
    this.stop()
    this.publish()
  }

  stop(): void {
    clearTimeout(this.quiet)
    clearTimeout(this.busy)
    this.quiet = undefined
    this.busy = undefined
  }
}
