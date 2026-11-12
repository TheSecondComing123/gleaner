import type { Diagnostic } from 'vscode'
import type { Position } from './display'

export const MAX_PROBLEMS = 500
const MAX_RUNS = 50
const MAX_BYTES = 1_000_000

interface Range {
  start: Position
  end: Position
}

interface DiagnosticData extends Pick<Diagnostic, 'message' | 'severity' | 'source' | 'code'> {
  range: Range
  relatedInformation?: { location: { uri: { fsPath: string }; range: Range }; message: string }[]
}

interface SavedProblem {
  file: string
  range: Range
  message: string
  severity: number
  source?: string
  code?: string | number | { value: string | number; target: string }
  related?: { file: string; range: Range; message: string }[]
}

export interface SavedRun {
  key: string
  problems: SavedProblem[]
}

const rangeData = ({ start, end }: Range): Range => ({
  start: { line: start.line, character: start.character },
  end: { line: end.line, character: end.character },
})

export function serializeSession(
  runs: ReadonlyMap<string, ReadonlyMap<string, readonly DiagnosticData[]>>,
): SavedRun[] {
  const saved: SavedRun[] = []
  let bytes = 2
  for (const [key, files] of [...runs].reverse()) {
    const problems = [...files]
      .flatMap(([file, list]) =>
        list.map(
          (d): SavedProblem => ({
            file,
            range: rangeData(d.range),
            message: d.message,
            severity: d.severity,
            source: d.source,
            code: typeof d.code === 'object' ? { value: d.code.value, target: d.code.target.toString() } : d.code,
            related: d.relatedInformation?.map((r) => ({
              file: r.location.uri.fsPath,
              range: rangeData(r.location.range),
              message: r.message,
            })),
          }),
        ),
      )
      .slice(-MAX_PROBLEMS)
    if (!problems.length) continue
    const run = { key, problems }
    const size = Buffer.byteLength(JSON.stringify(run), 'utf8') + 1
    // command keys and multi-line messages can grow even with a per-run count cap.
    if (bytes + size > MAX_BYTES) continue
    saved.unshift(run)
    bytes += size
    if (saved.length === MAX_RUNS) break
  }
  return saved
}

export function restoreSession(saved: readonly SavedRun[], dirty: ReadonlySet<string>): SavedRun[] {
  return saved.flatMap(({ key, problems }) => {
    const kept = problems
      .filter((p) => !dirty.has(p.file))
      .map((p) => ({
        ...p,
        source: `${(p.source ?? 'gleaner').replace(/ \(last session\)$/, '')} (last session)`,
        related: p.related?.filter((r) => !dirty.has(r.file)),
      }))
    return kept.length ? [{ key, problems: kept }] : []
  })
}
