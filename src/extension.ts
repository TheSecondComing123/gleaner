import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { registerCopyProblems } from './copy'
import { incompleteReasons, OutputHistory, type OutputReference, type RunOutput } from './history'
import { compileMatchers } from './matchers'
import { LiveUpdates, Output } from './output'
import { DEFAULT_IGNORED, parsers, pickParsers } from './parsers'
import type { Problem } from './problem'
import { type OutputDiagnostic, Problems } from './problems'
import { mapPath, resolveFile } from './resolve'
import { MAX_PROBLEMS, type SavedRun } from './session'
import { type Comparison, compareRuns, comparison, type Delta } from './summary'
import { registerOutputViewer } from './viewer'
import { WatchPass } from './watch'

const SESSION_KEY = 'committedProblems'
// read() may still be flushing
const DRAIN_MS = 500
const REREPORT_MS = 2000
const INTEGRATION_GRACE_MS = 5000
const SHELL_INTEGRATION_DOCS = 'https://code.visualstudio.com/docs/terminal/shell-integration'

interface Run {
  id: string
  started: number
  terminal: vscode.Terminal
  command: string
  // rerun replaces, any terminal
  key: string
  generation: number
  cwds: string[]
  mappingLogs: Set<string>
  output?: Output
  live: LiveUpdates
  // only finished watch passes count here
  cycle: number
  revision: number
  watchPublish?: Promise<void>
  superseded: boolean
  sealed: boolean
  drainTimedOut: boolean
  reading: Promise<void>
  baseline?: Comparison
}

const SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
}

export function activate(context: vscode.ExtensionContext): void {
  const problems = new Problems()
  const history = new OutputHistory()
  registerOutputViewer(context, history, problems)
  registerCopyProblems(context, history, problems)
  problems.hideDuplicates = vscode.workspace.getConfiguration('gleaner').get<boolean>('hideDuplicates', true)
  const log = vscode.window.createOutputChannel('Gleaner')
  const runs = new Map<vscode.TerminalShellExecution, Run>()
  const ended = new Map<Run, ReturnType<typeof setTimeout>>()
  const withoutIntegration = new Set<vscode.Terminal>()
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0)
  const readMatchers = () =>
    vscode.extensions.all
      .filter((extension) => extension.id !== context.extension.id)
      .map((extension) => extension.packageJSON.contributes)
  let extensionMatchers = readMatchers()
  const warnings = new Map<string, string>()
  const committedWarnings = new Map<string, string>()
  const comparisons = new Map<string, Comparison>()
  let summary: { key: string; command: string; folder: string; delta: Delta } | undefined
  const remember = (key: string, snapshot: Comparison): void => {
    comparisons.delete(key)
    comparisons.set(key, snapshot)
    if (comparisons.size > 50) comparisons.delete(comparisons.keys().next().value as string)
  }
  const save = (): void => {
    void context.workspaceState.update(SESSION_KEY, problems.save()).then(undefined, (error: unknown) => {
      log.appendLine(`could not save problems: ${String(error)}`)
    })
  }

  const updateStatus = (): void => {
    const warning = [...warnings.values()].join('\n')
    const shownSummary = vscode.workspace.getConfiguration('gleaner').get<boolean>('runSummaries', false) && summary
    const delta = shownSummary ? ` · ${shownSummary.delta.fixed} fixed, ${shownSummary.delta.added} new` : ''
    const summaryTip = shownSummary
      ? `\n${shownSummary.command}\n${shownSummary.folder}\nchanges since its previous complete result; until the next command starts.`
      : ''
    const active = vscode.window.activeTerminal
    if (active && withoutIntegration.has(active)) {
      status.text = '$(warning) Gleaner: no shell integration'
      status.tooltip = `This terminal doesn't report its commands, so Gleaner can't see their errors. Click for VS Code's shell integration docs.${warning ? `\n${warning}` : ''}`
      status.command = {
        title: 'Open docs',
        command: 'vscode.open',
        arguments: [vscode.Uri.parse(SHELL_INTEGRATION_DOCS)],
      }
      status.show()
    } else if (problems.count || warning || shownSummary) {
      status.text =
        problems.count || shownSummary
          ? `$(list-unordered) ${problems.count} from terminal${delta}`
          : '$(warning) Gleaner: output truncated'
      status.tooltip = `Problems Gleaner found in terminal output. Click to open the Problems panel.${summaryTip}${warning ? `\n${warning}` : ''}`
      status.command = 'workbench.actions.view.problems'
      status.show()
    } else {
      status.hide()
    }
  }

  const watchIntegration = (terminal: vscode.Terminal): void => {
    setTimeout(() => {
      if (terminal.shellIntegration || terminal.exitStatus) return
      withoutIntegration.add(terminal)
      updateStatus()
    }, INTEGRATION_GRACE_MS)
  }
  if (vscode.workspace.getConfiguration('gleaner').get<boolean>('enable', true)) {
    problems.load(
      context.workspaceState.get<SavedRun[]>(SESSION_KEY, []),
      new Set(
        vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === 'file').map((d) => d.uri.fsPath),
      ),
    )
    updateStatus()
  }
  vscode.window.terminals.forEach(watchIntegration)

  // newest run wins
  const latest = new Map<string, number>()
  let nextGeneration = 0
  const sessionId = randomUUID()
  let nextRun = 0
  // clear drops ended runs
  let clears = 0

  const current = (run: Run, cleared: number): boolean =>
    !run.superseded && latest.get(run.key) === run.generation && clears === cleared

  const restore = (run: Run): void => {
    problems.restore(run.key)
    const warning = committedWarnings.get(run.key)
    if (warning) warnings.set(run.key, warning)
    else warnings.delete(run.key)
    updateStatus()
  }

  const reportDrainLoss = (run: Run): void => {
    const warning = `${run.command}: output drain timed out; trailing output may be missing`
    warnings.set(run.key, [warnings.get(run.key), warning].filter(Boolean).join('\n'))
    log.appendLine(warning)
    updateStatus()
  }

  const finish = async (execution: vscode.TerminalShellExecution, exitCode?: number): Promise<void> => {
    const run = runs.get(execution)
    if (!run) return
    runs.delete(execution)
    run.live.stop()
    run.revision++
    if (exitCode === undefined) {
      const timer = setTimeout(() => ended.delete(run), REREPORT_MS)
      ended.set(run, timer)
    }
    const cleared = clears
    let drained = false
    await Promise.race([
      run.reading.then(() => {
        drained = true
      }),
      new Promise((resolve) => setTimeout(resolve, DRAIN_MS)),
    ])
    run.sealed = true
    run.drainTimedOut = !drained
    // a watcher's results come from finished passes; ctrl+c exits tsc --watch with 0
    if (run.cycle) {
      await run.watchPublish
      if (current(run, cleared)) {
        restore(run)
        if (run.drainTimedOut) reportDrainLoss(run)
      }
      log.appendLine(`${run.command}: watch stopped, kept the last pass`)
      return
    }
    await publish(run, 'final', exitCode, cleared)
  }

  const publish = async (
    run: Run,
    kind: 'provisional' | 'pass' | 'final',
    exitCode: number | undefined,
    cleared: number,
  ): Promise<void> => {
    const revision = ++run.revision
    const cycle = kind === 'pass' ? ++run.cycle : run.cycle
    const found = run.output?.snapshot(kind === 'final') ?? []
    const losses = run.output?.warnings ?? []
    if (run.drainTimedOut) losses.push('output drain timed out; trailing output may be missing')
    if (!current(run, cleared)) return
    const outputId = `${run.id}/${kind === 'pass' ? cycle : cycle + 1}`
    const captured: RunOutput = {
      id: outputId,
      command: run.command,
      folder: run.cwds[0] ?? '',
      started: run.started,
      updated: Date.now(),
      state: kind,
      pass: kind === 'pass' ? cycle : undefined,
      exitCode: kind === 'final' ? exitCode : undefined,
      ...(run.output?.retainedOutput(kind === 'final') ?? { lines: [], lineCount: 0 }),
      warnings: [...losses],
      focus: found[0]?.output,
      problems: [],
      incomplete: incompleteReasons(kind, exitCode, losses),
    }
    if (kind === 'provisional' && run.cycle && !found.length) return
    if (kind === 'final' && exitCode !== 0 && !found.length) {
      captured.incomplete.push('failed run with no parsed problems; previous diagnostics kept')
      history.set(captured)
      remember(run.key, comparison(run.command, [], false))
      summary = undefined
      restore(run)
      if (losses.length) {
        const warning = `${run.command}: ${losses.join('; ')}`
        warnings.set(run.key, warning)
        log.appendLine(warning)
        updateStatus()
      }
      log.appendLine(`${run.command}: exit ${exitCode ?? '?'} with no problems found, kept the last result`)
      return
    }

    const dirs = [...new Set([...run.cwds].reverse().concat(workspaceDirs()))]
    const mappings = vscode.workspace.getConfiguration('gleaner').get<Record<string, string>>('pathMappings', {})
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      name: folder.name,
      path: folder.uri.fsPath,
    }))
    const logMapping = (message: string): void => {
      if (run.mappingLogs.has(message)) return
      run.mappingLogs.add(message)
      log.appendLine(message)
    }
    const lookups = new Map<string, Promise<string | undefined>>()
    const find = (file: string, source?: string): Promise<string | undefined> => {
      const key = `${source ?? ''}\0${file}`
      const known = lookups.get(key)
      if (known) return known
      const lookup = (async () => {
        const mapped = mapPath(file, mappings, folders)
        if (mapped && 'error' in mapped) logMapping(mapped.error)
        else if (mapped) {
          if (await exists(mapped.path)) return mapped.path
          logMapping(`mapped ${file} to ${mapped.target}, not found`)
        }
        const qualified = await locate(file, dirs)
        if (qualified || source !== 'java' || !file.includes('/')) return qualified
        return locate(path.posix.basename(file), dirs)
      })()
      lookups.set(key, lookup)
      return lookup
    }
    const located = await Promise.all(
      found.map(async (problem) => ({ problem, file: await find(problem.file, problem.source) })),
    )
    const real = located.filter((x): x is { problem: Problem; file: string } => x.file !== undefined)
    const kept = real.slice(-MAX_PROBLEMS)
    if (real.length > kept.length) losses.push(`older problems dropped (${MAX_PROBLEMS} display limit)`)
    const diagnostics = await Promise.all(
      kept.map(({ problem }) =>
        toDiagnostic(problem, (file) => find(file, problem.source), {
          id: outputId,
          span: problem.output && { ...problem.output },
        }),
      ),
    )
    if (!current(run, cleared) || run.cycle !== cycle) return
    const show = run.revision === revision
    if (kind === 'provisional' && !show) return

    captured.problems = kept.map(({ problem, file }) => ({ ...problem, file }))
    captured.warnings = [...losses]
    captured.incomplete = incompleteReasons(kind, exitCode, losses)
    const skipped = found.length - real.length
    if (skipped) captured.incomplete.push(`${skipped} problems skipped (file not found)`)
    history.set(captured)
    if (kind !== 'provisional') {
      // only tsc watch passes have known full scope; test watchers can change filters interactively.
      const selected = kind === 'pass' ? pickParsers(run.command) : []
      const scope = kind !== 'pass' || (selected.length === 1 && selected[0] === parsers.tsc)
      const snapshot = comparison(run.command, captured.problems, !captured.incomplete.length, scope)
      const delta = compareRuns(run.baseline, snapshot)
      remember(run.key, snapshot)
      run.baseline = snapshot
      if (show) summary = delta ? { key: run.key, command: run.command, folder: captured.folder, delta } : undefined
    } else if (summary?.key === run.key) summary = undefined

    const files = new Map<string, vscode.Diagnostic[]>()
    for (const [i, { file }] of kept.entries()) files.set(file, [...(files.get(file) ?? []), diagnostics[i]])
    problems.set(run.key, files, { provisional: kind === 'provisional', show })
    if (kind !== 'provisional') save()
    const warning = losses.length ? `${run.command}: ${losses.join('; ')}` : ''
    if (kind !== 'provisional') {
      if (warning) committedWarnings.set(run.key, warning)
      else committedWarnings.delete(run.key)
    }
    if (warning && warnings.get(run.key) !== warning) log.appendLine(warning)
    if (show) {
      if (warning) warnings.set(run.key, warning)
      else warnings.delete(run.key)
      updateStatus()
    }
    log.appendLine(
      `${run.command}: ${kind === 'provisional' ? 'live' : `exit ${exitCode ?? '?'}`}, ${kept.length} problem${kept.length === 1 ? '' : 's'}${skipped ? `, ${skipped} skipped (file not found)` : ''}`,
    )
  }

  const clear = (): void => {
    clears++
    for (const run of runs.values()) {
      run.live.stop()
      run.baseline = undefined
    }
    for (const timer of ended.values()) clearTimeout(timer)
    ended.clear()
    warnings.clear()
    committedWarnings.clear()
    problems.clear()
    history.clear()
    comparisons.clear()
    summary = undefined
    save()
    updateStatus()
  }

  context.subscriptions.push(
    problems,
    log,
    status,
    vscode.extensions.onDidChange(() => {
      extensionMatchers = readMatchers()
    }),
    new vscode.Disposable(() => {
      for (const run of runs.values()) run.live.stop()
      for (const timer of ended.values()) clearTimeout(timer)
      ended.clear()
    }),
    vscode.commands.registerCommand('gleaner.clear', clear),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('gleaner.runSummaries')) updateStatus()
      if (event.affectsConfiguration('gleaner.hideDuplicates')) {
        problems.hideDuplicates = vscode.workspace.getConfiguration('gleaner').get<boolean>('hideDuplicates', true)
        for (const file of problems.files()) problems.render(file, true)
        updateStatus()
      }
      if (!event.affectsConfiguration('gleaner.enable')) return
      if (vscode.workspace.getConfiguration('gleaner').get<boolean>('enable', true)) return
      clear()
      runs.clear()
    }),
    // a language server reporting (or dropping) the same error changes what's shown
    vscode.languages.onDidChangeDiagnostics(({ uris }) => {
      for (const uri of uris) if (uri.scheme === 'file' && problems.has(uri.fsPath)) problems.render(uri.fsPath)
      updateStatus()
    }),
    vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
      // a git diff view has the same path under another scheme
      if (!contentChanges.length || document.uri.scheme !== 'file' || !problems.touches(document.uri.fsPath)) return
      problems.edit(document.uri.fsPath, contentChanges)
      save()
      updateStatus()
    }),
    vscode.window.onDidOpenTerminal(watchIntegration),
    vscode.window.onDidChangeActiveTerminal(updateStatus),
    vscode.window.onDidStartTerminalShellExecution(({ terminal, execution }) => {
      const config = vscode.workspace.getConfiguration('gleaner')
      if (!config.get<boolean>('enable', true)) return
      summary = undefined
      updateStatus()
      const ignored = config.get<string[]>('ignoredCommands', DEFAULT_IGNORED)
      if (!pickParsers(execution.commandLine.value, ignored).length) return
      const command = execution.commandLine.value
      // powershell can report the same running command again
      const previous = [...runs.values(), ...ended.keys()].find(
        (run) => run.terminal === terminal && run.command === command,
      )
      if (previous) {
        previous.superseded = true
        previous.live.stop()
        for (const [other, run] of runs) if (run === previous) runs.delete(other)
        clearTimeout(ended.get(previous))
        ended.delete(previous)
        log.appendLine(`${command}: same run reported again in ${terminal.name}`)
      }
      const key = previous?.key ?? `${execution.cwd?.fsPath ?? ''}\0${command.trim()}`
      const generation = previous?.generation ?? nextGeneration++
      if (!previous) latest.set(key, generation)
      const run: Run = {
        id: `${sessionId}/${nextRun++}`,
        started: previous?.started ?? Date.now(),
        terminal,
        command,
        key,
        generation,
        cwds: previous?.cwds ?? (execution.cwd ? [execution.cwd.fsPath] : []),
        mappingLogs: previous?.mappingLogs ?? new Set(),
        cycle: 0,
        revision: 0,
        superseded: false,
        sealed: false,
        drainTimedOut: false,
        live: new LiveUpdates(() => {
          if (runs.get(execution) === run) void publish(run, 'provisional', undefined, clears)
        }),
        reading: Promise.resolve(),
        baseline: previous?.baseline ?? comparisons.get(key),
      }
      runs.set(execution, run)
      const stream = execution.read()
      run.reading = (async () => {
        const chosen = pickParsers(command, ignored, await scriptsIn(run.cwds.at(-1)))
        if (
          chosen.length === Object.keys(parsers).length &&
          vscode.workspace.getConfiguration('gleaner').get<boolean>('extensionMatchers', true)
        )
          chosen.push(
            ...compileMatchers(extensionMatchers, {
              cwd: run.cwds.at(-1),
              workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
                name: folder.name,
                path: folder.uri.fsPath,
              })),
            }),
          )
        run.output = new Output(chosen)
        const watch = new WatchPass()
        for await (const chunk of stream) {
          if (run.superseded || run.sealed) break
          run.output.append(chunk, (line) => {
            if (!watch.accept(`${line}\n`) || runs.get(execution) !== run) return
            run.live.stop()
            run.watchPublish = publish(run, 'pass', undefined, clears)
            run.output?.reset()
            run.started = Date.now()
          })
          if (runs.get(execution) === run && run.output.hasOutput) run.live.append()
        }
      })()
      log.appendLine(`${command}: started in ${terminal.name}${execution.cwd ? ` at ${execution.cwd.fsPath}` : ''}`)
    }),
    vscode.window.onDidEndTerminalShellExecution(({ execution, exitCode }) => void finish(execution, exitCode)),
    // `cd` updates cwd here
    vscode.window.onDidChangeTerminalShellIntegration(({ terminal, shellIntegration }) => {
      if (withoutIntegration.delete(terminal)) updateStatus()
      const cwd = shellIntegration.cwd?.fsPath
      if (!cwd) return
      for (const run of runs.values()) if (run.terminal === terminal) run.cwds.push(cwd)
    }),
    // no end event (vscode#341547)
    vscode.window.onDidCloseTerminal((terminal) => {
      withoutIntegration.delete(terminal)
      for (const [execution, run] of runs) if (run.terminal === terminal) void finish(execution)
    }),
  )
}

// re-add files.exclude defaults
function excludes(): string {
  const configured = vscode.workspace.getConfiguration('files').get<Record<string, boolean>>('exclude', {})
  const globs = Object.keys(configured).filter((glob) => configured[glob] === true)
  return `{${['**/node_modules/**', ...globs].join(',')}}`
}

function workspaceDirs(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)
}

async function scriptsIn(dir: string | undefined): Promise<Record<string, string>> {
  if (!dir) return {}
  try {
    const json = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(dir, 'package.json')))
    return JSON.parse(new TextDecoder().decode(json)).scripts ?? {}
  } catch {
    return {}
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(file))
    return true
  } catch {
    return false
  }
}

async function toDiagnostic(
  problem: Problem,
  find: (file: string) => Promise<string | undefined>,
  output: OutputReference,
): Promise<vscode.Diagnostic> {
  const start = new vscode.Position(Math.max(problem.line - 1, 0), Math.max((problem.col ?? 1) - 1, 0))
  const end =
    problem.endLine !== undefined
      ? new vscode.Position(Math.max(problem.endLine - 1, 0), Math.max((problem.endCol ?? 1) - 1, 0))
      : start
  const diagnostic: OutputDiagnostic = new vscode.Diagnostic(
    new vscode.Range(start, end),
    problem.message,
    SEVERITY[problem.severity],
  )
  diagnostic.output = output
  diagnostic.source = problem.source
  if (problem.code) diagnostic.code = problem.code
  const related: vscode.DiagnosticRelatedInformation[] = []
  for (const r of problem.related ?? []) {
    const file = await find(r.file)
    if (!file) continue
    const at = new vscode.Position(Math.max(r.line - 1, 0), Math.max((r.col ?? 1) - 1, 0))
    related.push(new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.file(file), at), r.message))
  }
  if (related.length) diagnostic.relatedInformation = related
  return diagnostic
}

// unique workspace suffix match
async function locate(file: string, dirs: string[]): Promise<string | undefined> {
  const direct = await resolveFile(file, dirs, exists)
  if (direct || path.isAbsolute(file) || file.startsWith('..')) return direct
  const relative = file.replace(/^\.\//, '')
  // glob chars → `?`, checked literally
  const glob = `**/${relative.replace(/[[\]{}*?]/g, '?')}`
  const suffix = `${path.sep}${relative.split('/').join(path.sep)}`
  const matches = (await vscode.workspace.findFiles(glob, excludes(), 50)).filter((m) => m.fsPath.endsWith(suffix))
  return matches.length === 1 ? matches[0].fsPath : undefined
}
