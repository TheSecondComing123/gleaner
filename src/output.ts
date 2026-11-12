import { clean } from './clean'
import { RetainedOutput } from './history'
import { parseAll } from './parsers'
import type { Parser, Problem } from './problem'
import { isJestPrompt } from './watch'

const CHUNK_LINES = 1000
const OVERLAP_LINES = 300
const MAX_RAW_LINE = 16_000
const MAX_CANDIDATES = 2000

const key = (p: Problem) =>
  JSON.stringify([p.file, p.line, p.col, p.source, p.code, p.severity, p.message.split('\n')[0]])

// parsed windows can go; the overlap lets a block finish in the next window.
export class Output {
  private retained = new RetainedOutput()
  private offset = 0
  private partialCut = false
  private partial = ''
  private lines: string[] = []
  private readonly saved = new Map<string, Problem>()
  private readonly openBlocks = new Map<string, { start: number; end?: number; source: string }>()
  private readonly losses = new Set<string>()

  constructor(private readonly chosen: Parser[]) {}

  append(chunk: string, lineReady?: (line: string) => void): void {
    let start = 0
    while (start < chunk.length) {
      const newline = chunk.indexOf('\n', start)
      const end = newline < 0 ? chunk.length : newline
      const room = MAX_RAW_LINE - this.partial.length
      this.partial += chunk.slice(start, Math.min(end, start + room))
      if (end - start > room) {
        this.losses.add('long lines truncated')
        this.partialCut = true
      }
      if (newline < 0) {
        // jest's compact watch prompt has no newline.
        if (lineReady && isJestPrompt(clean(this.partial, 1).join('\n'))) lineReady(this.complete())
        break
      }
      const line = this.complete()
      lineReady?.(line)
      start = newline + 1
    }
  }

  private complete(): string {
    const line =
      clean(`${this.partial}\n`, 1, () => {
        this.losses.add('long lines truncated')
        this.partialCut = true
      })[0] ?? ''
    this.retained.append(line + (this.partialCut ? ' [gleaner: line truncated]' : ''))
    this.partialCut = false
    this.partial = ''
    const index = this.offset + this.lines.length
    for (const block of this.openBlocks.values()) {
      if (
        block.source === 'gcc' &&
        block.end === undefined &&
        line &&
        !/^\s|^.+?:\d+:(?:\d+:)? (?:note|remark):|^In file included from /.test(line)
      )
        block.end = index
    }
    this.lines.push(line)
    if (this.lines.length >= CHUNK_LINES) {
      this.retire()
      this.losses.add(`parser context limited to ${OVERLAP_LINES} overlap lines`)
    }
    return line
  }

  private retire(): void {
    const full = parseAll(this.chosen, this.lines, this.offset)
    this.closeBlocks(full)
    const expected = new Set(full.map((p) => JSON.stringify(p)))
    for (let cut = this.lines.length - OVERLAP_LINES; cut > 0; cut -= OVERLAP_LINES) {
      const prefix = parseAll(this.chosen, this.lines.slice(0, cut), this.offset)
      const tail = parseAll(this.chosen, this.lines.slice(cut), this.offset + cut)
      const combined = new Map<string, Problem>()
      this.merge(combined, prefix)
      this.merge(combined, tail)
      // keep more context when cutting through a block changes its parse.
      if (combined.size !== expected.size || [...combined.values()].some((p) => !expected.has(JSON.stringify(p))))
        continue
      this.merge(
        this.saved,
        prefix.filter((p) => expected.has(JSON.stringify(p))),
      )
      this.offset += cut
      this.lines = this.lines.slice(cut)
      return
    }
    // blocks longer than the window exceed the retained context budget.
    const tail = this.lines.slice(-OVERLAP_LINES)
    const replaceable = new Set(parseAll(this.chosen, tail, this.offset + this.lines.length - tail.length).map(key))
    this.merge(
      this.saved,
      full.filter((p) => !replaceable.has(key(p))),
    )
    for (const p of this.saved.values()) {
      if (p.output?.end === this.offset + this.lines.length)
        this.openBlocks.set(key(p), { start: p.output.start, source: p.source })
    }
    this.offset += this.lines.length - tail.length
    this.lines = tail
  }

  snapshot(final = false): Problem[] {
    const tail = final && this.partial ? clean(this.partial, 1, () => this.losses.add('long lines truncated')) : []
    const found = new Map(this.saved)
    const parsed = parseAll(this.chosen, [...this.lines, ...tail], this.offset)
    this.closeBlocks(parsed)
    this.merge(found, parsed)
    return [...found.values()].map((p) => {
      const block = this.openBlocks.get(key(p))
      const output = p.output && { ...p.output }
      if (output && block?.start === output.start)
        output.end = block.end ?? this.offset + this.lines.length + tail.length
      return { ...p, output }
    })
  }

  // a block can outgrow parser context; keep its extent until the next problem.
  private closeBlocks(found: Problem[]): void {
    for (const [id, block] of this.openBlocks) {
      if (block.end !== undefined) continue
      const next = found.filter((p) => key(p) !== id && p.output && p.output.start > block.start)
      if (next.length) block.end = Math.min(...next.map((p) => p.output?.start ?? Infinity))
    }
  }

  retainedOutput(final = false): ReturnType<RetainedOutput['snapshot']> {
    const partial =
      final && this.partial
        ? (clean(this.partial, 1, () => {
            this.partialCut = true
          })[0] ?? '') + (this.partialCut ? ' [gleaner: line truncated]' : '')
        : undefined
    return this.retained.snapshot(partial)
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
      ) {
        if (previous.output && problem.output?.start === previous.output.start)
          previous.output.end = Math.max(previous.output.end, problem.output.end)
        continue
      }
      into.delete(id)
      into.set(id, problem)
      if (into.size > MAX_CANDIDATES) {
        const oldest = into.keys().next().value as string
        into.delete(oldest)
        this.openBlocks.delete(oldest)
        this.losses.add(`older problems dropped (${MAX_CANDIDATES} candidate limit)`)
      }
    }
  }

  get hasOutput(): boolean {
    return this.lines.length > 0 || this.partial.length > 0 || this.saved.size > 0
  }

  reset(): void {
    this.partial = ''
    this.partialCut = false
    this.offset = 0
    this.retained = new RetainedOutput()
    this.lines = []
    this.saved.clear()
    this.openBlocks.clear()
    this.losses.clear()
  }

  get warnings(): string[] {
    const retained = this.retained.snapshot()
    return [
      ...this.losses,
      ...(retained.lines.length < retained.lineCount ? ['retained output truncated (512 kib per-run limit)'] : []),
    ]
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
