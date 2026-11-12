import type { OutputSpan, Problem } from './problem'

export const RUN_OUTPUT_BYTES = 512 * 1024
export const TOTAL_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_RUNS = 50
export const PROBLEM_CONTEXT_BYTES = 8 * 1024

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
  problems: Problem[]
  incomplete: string[]
}

export const runState = (run: Pick<RunOutput, 'state' | 'pass' | 'exitCode'>): string =>
  run.state === 'pass'
    ? `watch pass ${run.pass}`
    : run.state === 'provisional'
      ? 'running (provisional)'
      : `exit ${run.exitCode ?? 'unknown'}`

export function incompleteReasons(
  state: RunOutput['state'],
  exitCode: number | undefined,
  warnings: string[],
): string[] {
  return [
    ...(state === 'provisional' ? ['provisional result'] : []),
    ...(state === 'final' && exitCode === undefined ? ['exit code unknown; run may have been interrupted'] : []),
    ...(state === 'final' && exitCode !== undefined && exitCode >= 128 ? ['run interrupted or terminated'] : []),
    ...warnings,
  ]
}

const lineBytes = (line: OutputLine): number => Buffer.byteLength(line.text, 'utf8') + 32

// reserve space for problem excerpts before trimming the beginning and end.
export class RetainedOutput {
  private head: OutputLine[] = []
  private tail: OutputLine[] = []
  private headBytes = 0
  private tailBytes = 0
  private context = new Map<number, { lines: OutputLine[]; bytes: number }>()
  private contextBytes = 0
  private count = 0

  constructor(private readonly budget = RUN_OUTPUT_BYTES) {}

  append(text: string): void {
    const line = { number: this.count++, text }
    const bytes = lineBytes(line)
    const endBudget = (this.budget - this.contextBytes) / 2
    if (!this.tail.length && this.headBytes + bytes <= endBudget) {
      this.head.push(line)
      this.headBytes += bytes
    } else {
      this.tail.push(line)
      this.tailBytes += bytes
      while (this.tailBytes > endBudget && this.tail.length) {
        this.tailBytes -= lineBytes(this.tail.shift() as OutputLine)
      }
    }
  }

  retain(start: number, lines: OutputLine[]): void {
    const previous = this.context.get(start)
    const combined = new Map([...(previous?.lines ?? []), ...lines].map((line) => [line.number, line]))
    const excerpt: OutputLine[] = []
    let bytes = 0
    for (const line of combined.values()) {
      const size = lineBytes(line)
      if (bytes + size > Math.min(PROBLEM_CONTEXT_BYTES, this.budget / 2)) continue
      bytes += size
      excerpt.push(line)
    }
    this.contextBytes += bytes - (previous?.bytes ?? 0)
    this.context.set(start, { lines: excerpt, bytes })
    while (this.contextBytes > this.budget / 2 && this.context.size) {
      const oldest = this.context.keys().next().value as number
      this.contextBytes -= this.context.get(oldest)?.bytes ?? 0
      this.context.delete(oldest)
    }
    const endBudget = (this.budget - this.contextBytes) / 2
    while (this.headBytes > endBudget && this.head.length) this.headBytes -= lineBytes(this.head.pop() as OutputLine)
    while (this.tailBytes > endBudget && this.tail.length) this.tailBytes -= lineBytes(this.tail.shift() as OutputLine)
  }

  snapshot(partial?: string): { lines: OutputLine[]; lineCount: number } {
    const tail = [...this.tail]
    let bytes = this.tailBytes
    if (partial !== undefined) {
      const line = { number: this.count, text: partial }
      tail.push(line)
      bytes += lineBytes(line)
      while (bytes > (this.budget - this.contextBytes) / 2 && tail.length)
        bytes -= lineBytes(tail.shift() as OutputLine)
    }
    const lines = new Map(
      [...[...this.context.values()].flatMap((excerpt) => excerpt.lines), ...this.head, ...tail].map((line) => [
        line.number,
        line,
      ]),
    )
    return {
      lines: [...lines.values()].sort((a, b) => a.number - b.number),
      lineCount: this.count + (partial === undefined ? 0 : 1),
    }
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
  const lines = [
    `$ ${run.command}`,
    `folder: ${run.folder || 'unknown'}`,
    `started: ${new Date(run.started).toISOString()}`,
    `${runState(run)}: ${new Date(run.updated).toISOString()}`,
    `completeness: ${run.incomplete.length ? `incomplete (${run.incomplete.join('; ')})` : 'complete'}`,
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
