import * as vscode from 'vscode'
import { clean } from './clean'
import { DEFAULT_IGNORED, pickParsers } from './parsers'
import type { Parser, Problem } from './problem'
import { Problems } from './problems'
import { resolveFile } from './resolve'

const MAX_BYTES = 4_000_000
const MAX_PROBLEMS = 500
const RUN_TIMEOUT_MS = 10 * 60_000
// read() can still be flushing its last chunk when the end event fires.
const DRAIN_MS = 500
// Shell integration usually connects within a second or two of the terminal opening.
const INTEGRATION_GRACE_MS = 5000
const SHELL_INTEGRATION_DOCS = 'https://code.visualstudio.com/docs/terminal/shell-integration'

interface Run {
  terminal: vscode.Terminal
  command: string
  parsers: Parser[]
  cwds: string[]
  raw: string
  reading: Promise<void>
  timer: NodeJS.Timeout
}

const SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
}

export function activate(context: vscode.ExtensionContext): void {
  const problems = new Problems()
  const log = vscode.window.createOutputChannel('Gleaner')
  const runs = new Map<vscode.TerminalShellExecution, Run>()
  const terminalIds = new WeakMap<vscode.Terminal, number>()
  let nextTerminalId = 0
  const withoutIntegration = new Set<vscode.Terminal>()
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0)

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

  const terminalId = (terminal: vscode.Terminal): number => {
    const known = terminalIds.get(terminal)
    if (known !== undefined) return known
    terminalIds.set(terminal, nextTerminalId)
    return nextTerminalId++
  }

  const finish = async (execution: vscode.TerminalShellExecution): Promise<void> => {
    const run = runs.get(execution)
    if (!run) return
    runs.delete(execution)
    clearTimeout(run.timer)
    await Promise.race([run.reading, new Promise((resolve) => setTimeout(resolve, DRAIN_MS))])

    const lines = clean(run.raw)
    // Unknown commands go through every parser, and some formats overlap.
    const seen = new Set<string>()
    const found = run.parsers
      .flatMap((parse) => parse(lines))
      .filter((p) => {
        const key = `${p.file}:${p.line}:${p.col}:${p.message}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, MAX_PROBLEMS)
    const dirs = [...new Set([...run.cwds].reverse().concat(workspaceDirs()))]
    const files = new Map<string, vscode.Diagnostic[]>()
    let skipped = 0

    for (const problem of found) {
      const file = await resolveFile(problem.file, dirs, exists)
      if (!file) {
        skipped++
        continue
      }
      const diagnostic = await toDiagnostic(problem, dirs)
      files.set(file, [...(files.get(file) ?? []), diagnostic])
    }

    problems.set(`${terminalId(run.terminal)}\0${run.command.trim()}`, files)
    updateStatus()
    const count = found.length - skipped
    log.appendLine(
      `${run.command}: ${count} problem${count === 1 ? '' : 's'}${skipped ? `, ${skipped} skipped (file not found)` : ''}`,
    )
  }

  context.subscriptions.push(
    problems,
    log,
    status,
    vscode.commands.registerCommand('gleaner.clear', () => {
      problems.clear()
      updateStatus()
    }),
    vscode.window.onDidOpenTerminal(watchIntegration),
    vscode.window.onDidChangeActiveTerminal(updateStatus),
    vscode.window.onDidStartTerminalShellExecution(({ terminal, execution }) => {
      const config = vscode.workspace.getConfiguration('gleaner')
      if (!config.get<boolean>('enable', true)) return
      const parsers = pickParsers(execution.commandLine.value, config.get<string[]>('ignoredCommands', DEFAULT_IGNORED))
      if (!parsers.length) return
      const run: Run = {
        terminal,
        command: execution.commandLine.value,
        parsers,
        cwds: execution.cwd ? [execution.cwd.fsPath] : [],
        raw: '',
        reading: Promise.resolve(),
        timer: setTimeout(() => void finish(execution), RUN_TIMEOUT_MS),
      }
      run.reading = (async () => {
        for await (const chunk of execution.read()) {
          if (run.raw.length < MAX_BYTES) run.raw += chunk
        }
      })()
      runs.set(execution, run)
    }),
    vscode.window.onDidEndTerminalShellExecution(({ execution }) => void finish(execution)),
    // `cd sub && make` keeps the old execution.cwd; the shell reports the new one here.
    vscode.window.onDidChangeTerminalShellIntegration(({ terminal, shellIntegration }) => {
      if (withoutIntegration.delete(terminal)) updateStatus()
      const cwd = shellIntegration.cwd?.fsPath
      if (!cwd) return
      for (const run of runs.values()) if (run.terminal === terminal) run.cwds.push(cwd)
    }),
    // A terminal closed mid-command never fires an end event (microsoft/vscode#341547).
    vscode.window.onDidCloseTerminal((terminal) => {
      withoutIntegration.delete(terminal)
      for (const [execution, run] of runs) if (run.terminal === terminal) void finish(execution)
    }),
  )
}

function workspaceDirs(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)
}

async function exists(file: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(file))
    return true
  } catch {
    return false
  }
}

async function toDiagnostic(problem: Problem, dirs: string[]): Promise<vscode.Diagnostic> {
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
    const file = await resolveFile(r.file, dirs, exists)
    if (!file) continue
    const at = new vscode.Position(Math.max(r.line - 1, 0), Math.max((r.col ?? 1) - 1, 0))
    related.push(new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.file(file), at), r.message))
  }
  if (related.length) diagnostic.relatedInformation = related
  return diagnostic
}
