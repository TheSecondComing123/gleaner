import type { OutputSpan } from './problem'

export const RUN_OUTPUT_BYTES = 512 * 1024
export const TOTAL_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_RUNS = 50

export interface OutputLine {
  number: number
  text: string
}

export interface OutputReference {
  id: string
  span?: OutputSpan
}

export interface RunOutput {
  id: string
  command: string
  folder: string
  started: number
  updated: number
  state: 'provisional' | 'pass' | 'final'
  pass?: number
  exitCode?: number
  lines: OutputLine[]
  lineCount: number
  warnings: string[]
  focus?: OutputSpan
}

const lineBytes = (line: OutputLine): number => Buffer.byteLength(line.text, 'utf8') + 32

// keep the beginning and end, with original line numbers across the gap.
export class RetainedOutput {
  private head: OutputLine[] = []
  private tail: OutputLine[] = []
  private headBytes = 0
  private tailBytes = 0
  private count = 0

  constructor(private readonly budget = RUN_OUTPUT_BYTES) {}

  append(text: string): void {
    const line = { number: this.count++, text }
    const bytes = lineBytes(line)
    if (!this.tail.length && this.headBytes + bytes <= this.budget / 2) {
      this.head.push(line)
      this.headBytes += bytes
    } else {
      this.tail.push(line)
      this.tailBytes += bytes
      while (this.tailBytes > this.budget / 2 && this.tail.length) {
        this.tailBytes -= lineBytes(this.tail.shift() as OutputLine)
      }
    }
  }

  snapshot(partial?: string): { lines: OutputLine[]; lineCount: number } {
    const tail = [...this.tail]
    let bytes = this.tailBytes
    if (partial !== undefined) {
      const line = { number: this.count, text: partial }
      tail.push(line)
      bytes += lineBytes(line)
      while (bytes > this.budget / 2 && tail.length) bytes -= lineBytes(tail.shift() as OutputLine)
    }
    return { lines: [...this.head, ...tail], lineCount: this.count + (partial === undefined ? 0 : 1) }
  }
}

export class OutputHistory {
  private readonly runs = new Map<string, RunOutput>()

  constructor(private readonly budget = TOTAL_OUTPUT_BYTES) {}

  set(run: RunOutput): void {
    this.runs.set(run.id, run)
    let bytes = [...this.runs.values()].reduce((sum, r) => sum + Buffer.byteLength(JSON.stringify(r)), 0)
    while (bytes > this.budget || this.runs.size > MAX_RUNS) {
      const oldest = [...this.runs.values()].sort((a, b) => a.started - b.started)[0]?.id
      if (oldest === undefined) break
      bytes -= Buffer.byteLength(JSON.stringify(this.runs.get(oldest)))
      this.runs.delete(oldest)
    }
  }

  get(id: string): RunOutput | undefined {
    return this.runs.get(id)
  }

  recent(): RunOutput[] {
    return [...this.runs.values()].reverse().sort((a, b) => b.started - a.started)
  }

  clear(): void {
    this.runs.clear()
  }
}

export function outputDocument(run: RunOutput, span?: OutputSpan): { text: string; selection: OutputSpan } {
  const state =
    run.state === 'pass'
      ? `watch pass ${run.pass}`
      : run.state === 'provisional'
        ? 'running'
        : `exit ${run.exitCode ?? 'unknown'}`
  const lines = [
    `$ ${run.command}`,
    `folder: ${run.folder || 'unknown'}`,
    `started: ${new Date(run.started).toISOString()}`,
    `${state}: ${new Date(run.updated).toISOString()}`,
    ...run.warnings.map((warning) => `[gleaner: ${warning}]`),
    '',
  ]
  const selected: number[] = []
  let next = 0
  const dropped = (end: number): void => {
    if (end <= next) return
    if (span && span.start < end && span.end > next) selected.push(lines.length)
    lines.push(`[gleaner: output lines ${next + 1}-${end} cut by retention limit]`)
  }
  for (const line of run.lines) {
    dropped(line.number)
    if (span && line.number >= span.start && line.number < span.end) selected.push(lines.length)
    lines.push(line.text)
    next = line.number + 1
  }
  dropped(run.lineCount)
  return {
    text: lines.join('\n'),
    selection: { start: selected[0] ?? 0, end: selected.length ? (selected.at(-1) as number) + 1 : 1 },
  }
}
