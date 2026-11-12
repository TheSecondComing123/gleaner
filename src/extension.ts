import * as path from 'node:path'
import * as vscode from 'vscode'
import { compileMatchers } from './matchers'
import { LiveUpdates, Output } from './output'
import { DEFAULT_IGNORED, parsers, pickParsers } from './parsers'
import type { Problem } from './problem'
import { Problems } from './problems'
import { resolveFile } from './resolve'
import { MAX_PROBLEMS, type SavedRun } from './session'
import { lastPass } from './watch'

const SESSION_KEY = 'committedProblems'
// read() may still be flushing
const DRAIN_MS = 500
const REREPORT_MS = 2000
const INTEGRATION_GRACE_MS = 5000
const SHELL_INTEGRATION_DOCS = 'https://code.visualstudio.com/docs/terminal/shell-integration'

interface Run {
  terminal: vscode.Terminal
  command: string
  // rerun replaces, any terminal
  key: string
  generation: number
  cwds: string[]
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
}

const SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
}

export function activate(context: vscode.ExtensionContext): void {
  const problems = new Problems()
  problems.hideDuplicates = vscode.workspace.getConfiguration('gleaner').get<boolean>('hideDuplicates', true)
  const log = vscode.window.createOutputChannel('Gleaner')
  const runs = new Map<vscode.TerminalShellExecution, Run>()
  const ended = new Map<Run, ReturnType<typeof setTimeout>>()
  const withoutIntegration = new Set<vscode.Terminal>()
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0)
  const readMatchers = () =>
    compileMatchers(
      vscode.extensions.all
        .filter((extension) => extension.id !== context.extension.id)
        .map((extension) => extension.packageJSON.contributes),
    )
  let extensionMatchers = readMatchers()
  const warnings = new Map<string, string>()
  const committedWarnings = new Map<string, string>()
  const save = (): void => {
    void context.workspaceState.update(SESSION_KEY, problems.save()).then(undefined, (error: unknown) => {
      log.appendLine(`could not save problems: ${String(error)}`)
    })
  }

  const updateStatus = (): void => {
    const warning = [...warnings.values()].join('\n')
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
    } else if (problems.count || warning) {
      status.text = problems.count
        ? `$(list-unordered) ${problems.count} from terminal`
        : '$(warning) Gleaner: output truncated'
      status.tooltip = `Problems Gleaner found in terminal output. Click to open the Problems panel.${warning ? `\n${warning}` : ''}`
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
    if (kind === 'provisional' && run.cycle && !found.length) return
    if (kind === 'final' && exitCode !== 0 && !found.length) {
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
    const lookups = new Map<string, Promise<string | undefined>>()
    const find = (file: string): Promise<string | undefined> => {
      const known = lookups.get(file)
      if (known) return known
      const lookup = locate(file, dirs)
      lookups.set(file, lookup)
      return lookup
    }
    const located = await Promise.all(found.map(async (problem) => ({ problem, file: await find(problem.file) })))
    const real = located.filter((x): x is { problem: Problem; file: string } => x.file !== undefined)
    const kept = real.slice(-MAX_PROBLEMS)
    if (real.length > kept.length) losses.push(`older problems dropped (${MAX_PROBLEMS} display limit)`)
    const diagnostics = await Promise.all(kept.map(({ problem }) => toDiagnostic(problem, find)))
    if (!current(run, cleared) || run.cycle !== cycle) return
    const show = run.revision === revision
    if (kind === 'provisional' && !show) return

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
    const skipped = found.length - real.length
    log.appendLine(
      `${run.command}: ${kind === 'provisional' ? 'live' : `exit ${exitCode ?? '?'}`}, ${kept.length} problem${kept.length === 1 ? '' : 's'}${skipped ? `, ${skipped} skipped (file not found)` : ''}`,
    )
  }

  const clear = (): void => {
    clears++
    for (const run of runs.values()) run.live.stop()
    for (const timer of ended.values()) clearTimeout(timer)
    ended.clear()
    warnings.clear()
    committedWarnings.clear()
    problems.clear()
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
        terminal,
        command,
        key,
        generation,
        cwds: previous?.cwds ?? (execution.cwd ? [execution.cwd.fsPath] : []),
        cycle: 0,
        revision: 0,
        superseded: false,
        sealed: false,
        drainTimedOut: false,
        live: new LiveUpdates(() => {
          if (runs.get(execution) === run) void publish(run, 'provisional', undefined, clears)
        }),
        reading: Promise.resolve(),
      }
      runs.set(execution, run)
      const stream = execution.read()
      run.reading = (async () => {
        const chosen = pickParsers(command, ignored, await scriptsIn(run.cwds.at(-1)))
        if (
          chosen.length === Object.keys(parsers).length &&
          vscode.workspace.getConfiguration('gleaner').get<boolean>('extensionMatchers', true)
        )
          chosen.push(...extensionMatchers)
        run.output = new Output(chosen)
        for await (const chunk of stream) {
          if (run.superseded || run.sealed) break
          run.output.append(chunk, (line) => {
            if (!lastPass(`${line}\n`) || runs.get(execution) !== run) return
            run.live.stop()
            run.watchPublish = publish(run, 'pass', 0, clears)
            run.output?.reset()
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
): Promise<vscode.Diagnostic> {
  const start = new vscode.Position(Math.max(problem.line - 1, 0), Math.max((problem.col ?? 1) - 1, 0))
  const end =
    problem.endLine !== undefined
      ? new vscode.Position(Math.max(problem.endLine - 1, 0), Math.max((problem.endCol ?? 1) - 1, 0))
      : start
  const diagnostic = new vscode.Diagnostic(new vscode.Range(start, end), problem.message, SEVERITY[problem.severity])
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
