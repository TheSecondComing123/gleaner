import * as path from 'node:path'
import * as vscode from 'vscode'
import { clean } from './clean'
import { compileMatchers } from './matchers'
import { DEFAULT_IGNORED, parseAll, parsers, pickParsers } from './parsers'
import type { Problem } from './problem'
import { Problems } from './problems'
import { resolveFile } from './resolve'
import { lastPass } from './watch'

const MAX_BYTES = 4_000_000
const MAX_PROBLEMS = 500
const MAX_CANDIDATES = 2000
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
  ignored: string[]
  cwds: string[]
  raw: string
  // how far raw was searched for a watch pass ending
  scanned: number
  // bumped per publish, so an older watch pass never lands after a newer one
  cycle: number
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

  const updateStatus = (): void => {
    const active = vscode.window.activeTerminal
    if (active && withoutIntegration.has(active)) {
      status.text = '$(warning) Gleaner: no shell integration'
      status.tooltip =
        "This terminal doesn't report its commands, so Gleaner can't see their errors. Click for VS Code's shell integration docs."
      status.command = {
        title: 'Open docs',
        command: 'vscode.open',
        arguments: [vscode.Uri.parse(SHELL_INTEGRATION_DOCS)],
      }
      status.show()
    } else if (problems.count) {
      status.text = `$(list-unordered) ${problems.count} from terminal`
      status.tooltip = 'Problems Gleaner found in terminal output. Click to open the Problems panel.'
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
  vscode.window.terminals.forEach(watchIntegration)

  // newest run wins
  const latest = new Map<string, number>()
  let nextGeneration = 0
  // Clear drops ended runs
  let clears = 0

  const finish = async (execution: vscode.TerminalShellExecution, exitCode?: number): Promise<void> => {
    const run = runs.get(execution)
    if (!run) return
    runs.delete(execution)
    if (exitCode === undefined) {
      const timer = setTimeout(() => ended.delete(run), REREPORT_MS)
      ended.set(run, timer)
    }
    const cleared = clears
    await Promise.race([run.reading, new Promise((resolve) => setTimeout(resolve, DRAIN_MS))])
    // a watcher's results come from finished passes; ctrl+c exits tsc --watch with 0
    if (run.cycle) {
      log.appendLine(`${run.command}: watch stopped, kept the last pass`)
      return
    }
    await publish(run, run.raw, exitCode, cleared)
  }

  // a watch pass that ended counts as a clean exit
  const publish = async (run: Run, output: string, exitCode: number | undefined, cleared: number): Promise<void> => {
    const cycle = ++run.cycle
    // cwd may have changed
    const chosen = pickParsers(run.command, run.ignored, await scriptsIn(run.cwds.at(-1)))
    if (
      chosen.length === Object.keys(parsers).length &&
      vscode.workspace.getConfiguration('gleaner').get<boolean>('extensionMatchers', true)
    )
      chosen.push(...extensionMatchers)
    const found = parseAll(chosen, clean(output)).slice(0, MAX_CANDIDATES)
    // failed, nothing found: keep last
    if (exitCode !== 0 && !found.length) {
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
    const kept = real.slice(0, MAX_PROBLEMS)
    const diagnostics = await Promise.all(kept.map(({ problem }) => toDiagnostic(problem, find)))
    if (latest.get(run.key) !== run.generation || run.cycle !== cycle || clears !== cleared) return

    const files = new Map<string, vscode.Diagnostic[]>()
    for (const [i, { file }] of kept.entries()) files.set(file, [...(files.get(file) ?? []), diagnostics[i]])
    problems.set(run.key, files)
    updateStatus()
    const skipped = found.length - real.length
    log.appendLine(
      `${run.command}: exit ${exitCode ?? '?'}, ${kept.length} problem${kept.length === 1 ? '' : 's'}${skipped ? `, ${skipped} skipped (file not found)` : ''}`,
    )
  }

  const clear = (): void => {
    clears++
    problems.clear()
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
      runs.clear()
      clear()
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
        ignored,
        cwds: previous?.cwds ?? (execution.cwd ? [execution.cwd.fsPath] : []),
        raw: '',
        scanned: 0,
        cycle: 0,
        reading: Promise.resolve(),
      }
      run.reading = (async () => {
        for await (const chunk of execution.read()) {
          if (run.raw.length < MAX_BYTES) run.raw += chunk
          // a marker can arrive split across chunks
          const pass = lastPass(run.raw, run.scanned - 100)
          run.scanned = run.raw.length
          if (!pass || runs.get(execution) !== run) continue
          const output = run.raw.slice(pass.start, pass.end)
          run.raw = run.raw.slice(pass.end)
          run.scanned = run.raw.length
          void publish(run, output, 0, clears)
        }
      })()
      runs.set(execution, run)
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
