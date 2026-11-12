import * as vscode from 'vscode'
import { type OutputHistory, type RunOutput, runState } from './history'
import type { Problem } from './problem'
import type { Problems } from './problems'
import type { SavedRun } from './session'

export type CopyRun = Omit<RunOutput, 'started' | 'updated' | 'state'> & {
  started?: number
  updated?: number
  state: RunOutput['state'] | 'restored'
}

const stateLabel = (run: CopyRun): string =>
  run.state === 'restored' ? 'last session (exit unknown)' : runState({ ...run, state: run.state })
const fence = (text: string): string => {
  let length = 3
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1)
  const ticks = '`'.repeat(length)
  return `${ticks}text\n${text}\n${ticks}`
}

export function restoredCopyRun(run: SavedRun): CopyRun {
  const [folder, command] = run.key.split('\0')
  return {
    id: `last-session:${run.key}`,
    command: command ?? run.key,
    folder: command === undefined ? '' : folder,
    state: 'restored',
    incomplete: ['last session; completeness unknown; output not retained'],
    warnings: [],
    lines: [],
    lineCount: 0,
    problems: run.problems.map(
      (p): Problem => ({
        file: p.file,
        line: p.range.start.line + 1,
        col: p.range.start.character + 1,
        message: p.message,
        code: p.code === undefined ? undefined : String(typeof p.code === 'object' ? p.code.value : p.code),
        severity: p.severity === 0 ? 'error' : p.severity === 1 ? 'warning' : 'info',
        source: p.source ?? 'gleaner (last session)',
      }),
    ),
  }
}

export function copyMarkdown(run: CopyRun): string {
  const parts = [
    '# gleaner problems',
    `command:\n${fence(run.command)}`,
    `folder:\n${fence(run.folder || 'unknown')}`,
    `state: ${stateLabel(run)}`,
    `started: ${run.started === undefined ? 'unknown (last session)' : new Date(run.started).toISOString()}`,
    `updated: ${run.updated === undefined ? 'unknown (last session)' : new Date(run.updated).toISOString()}`,
    `completeness: ${run.incomplete.length ? `incomplete or unknown (${run.incomplete.join('; ')})` : 'complete'}`,
    ...run.warnings.map((warning) => `[gleaner: ${warning}]`),
    '## problems',
    run.problems.length
      ? fence(
          run.problems
            .map((p) => `${p.file}:${p.line}:${p.col ?? 1}: ${p.severity}${p.code ? ` ${p.code}` : ''}: ${p.message}`)
            .join('\n'),
        )
      : 'no problems found.',
    '## output excerpts',
  ]
  const spans = run.problems.flatMap((p) =>
    p.output ? [{ start: Math.max(0, p.output.start - 2), end: Math.min(run.lineCount, p.output.end + 2) }] : [],
  )
  spans.sort((a, b) => a.start - b.start)
  const merged: typeof spans = []
  for (const span of spans) {
    const last = merged.at(-1)
    if (last && last.end >= span.start) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }
  for (const span of merged) {
    const lines: string[] = []
    let next = span.start
    for (const line of run.lines) {
      if (line.number < span.start || line.number >= span.end) continue
      if (line.number > next) lines.push(`[gleaner: output lines ${next + 1}-${line.number} unavailable]`)
      lines.push(line.text)
      next = line.number + 1
    }
    if (next < span.end) lines.push(`[gleaner: output lines ${next + 1}-${span.end} unavailable]`)
    parts.push(`output lines ${span.start + 1}-${span.end}:\n${fence(lines.join('\n'))}`)
  }
  if (!merged.length)
    parts.push(run.problems.length ? 'output unavailable for these problems.' : 'no problem excerpts.')
  if (spans.length < run.problems.length && merged.length) parts.push('some problems have no output location.')
  return `${parts.join('\n\n')}\n`
}

export function registerCopyProblems(
  context: vscode.ExtensionContext,
  history: OutputHistory,
  problems: Problems,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('gleaner.copyProblems', async () => {
      const restored = problems
        .save()
        .filter((run) => run.problems.some((p) => p.source?.endsWith(' (last session)')))
        .map(restoredCopyRun)
      const runs: CopyRun[] = [...history.recent(), ...restored]
      if (!runs.length) {
        void vscode.window.showInformationMessage('no runs to copy. run a command first.')
        return
      }
      const picked = await vscode.window.showQuickPick(
        runs.map((run) => ({
          label: run.command,
          description: `${stateLabel(run)} · ${run.updated === undefined ? 'time unknown' : new Date(run.updated).toLocaleString()}`,
          detail: `${run.folder || 'folder unknown'} · ${run.incomplete.length ? 'incomplete or unknown' : 'complete'}`,
          run,
        })),
        { placeHolder: 'choose a run to copy as markdown, including hidden duplicates' },
      )
      if (picked) await vscode.env.clipboard.writeText(copyMarkdown(picked.run))
    }),
  )
}
