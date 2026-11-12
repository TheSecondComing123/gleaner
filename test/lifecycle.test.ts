import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  events: new Map<string, (value: unknown) => unknown>(),
  shown: new Map<string, import('../src/problems').OutputDiagnostic[]>(),
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  providers: new Map<string, vscode.TextDocumentContentProvider>(),
  actions: undefined as vscode.CodeActionProvider | undefined,
  picker: [] as { label: string; run: import('../src/history').RunOutput }[],
  pick: true,
  opened: '',
  selection: undefined as vscode.Range | undefined,
  decorations: [] as vscode.Range[],
  information: [] as string[],
  others: [] as vscode.Diagnostic[],
  logs: [] as string[],
  clear: () => {},
  stat: async (_file: string) => {},
  mappings: {} as Record<string, string>,
  folders: [] as { name: string; uri: { fsPath: string } }[],
  matches: [] as { fsPath: string }[],
  contributions: [] as unknown[],
  enabled: true,
  saved: new Map<string, unknown>(),
  status: { text: '', tooltip: '', visible: false },
}))

vi.mock('vscode', () => {
  class Position {
    constructor(
      public line: number,
      public character: number,
    ) {}
  }
  class Range {
    start: Position
    end: Position
    constructor(start: Position | number, end: Position | number, endLine?: number, endCol?: number) {
      this.start = typeof start === 'number' ? new Position(start, end as number) : start
      this.end = typeof end === 'number' ? new Position(endLine ?? 0, endCol ?? 0) : end
    }
    intersection(other: Range) {
      return this.start.line <= other.end.line && this.end.line >= other.start.line ? this : undefined
    }
  }
  const event = (name: string) => (callback: (value: unknown) => unknown) => {
    state.events.set(name, callback)
    return { dispose() {} }
  }
  return {
    Position,
    Range,
    ThemeColor: class {},
    TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
    CodeActionKind: { QuickFix: 'quickfix' },
    CodeAction: class {
      constructor(
        public title: string,
        public kind: string,
      ) {}
    },
    Diagnostic: class {
      constructor(
        public range: Range,
        public message: string,
        public severity: number,
      ) {}
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    Location: class {
      range: Range
      constructor(
        public uri: vscode.Uri,
        at: Range | Position,
      ) {
        this.range = at instanceof Position ? new Range(at, at) : at
      }
    },
    DiagnosticRelatedInformation: class {
      constructor(
        public location: vscode.Location,
        public message: string,
      ) {}
    },
    Disposable: class {
      constructor(public dispose: () => void) {}
    },
    Uri: {
      file: (file: string) => ({ fsPath: file, scheme: 'file' }),
      from: (parts: unknown) => parts,
    },
    StatusBarAlignment: { Left: 1 },
    extensions: {
      get all() {
        return state.contributions.map((contributes) => ({ id: 'matcher', packageJSON: { contributes } }))
      },
      onDidChange: event('extensions'),
    },
    commands: {
      registerCommand: (name: string, callback: (...args: unknown[]) => unknown) => {
        state.commands.set(name, callback)
        if (name === 'gleaner.clear') state.clear = callback
        return { dispose() {} }
      },
    },
    languages: {
      createDiagnosticCollection: () => ({
        set: (uri: { fsPath: string }, list: vscode.Diagnostic[]) => state.shown.set(uri.fsPath, list),
        clear: () => state.shown.clear(),
        dispose: () => state.shown.clear(),
      }),
      registerCodeActionsProvider: (_selector: unknown, provider: vscode.CodeActionProvider) => {
        state.actions = provider
        return { dispose() {} }
      },
      getDiagnostics: () => [...state.shown.values()].flat().concat(state.others),
      onDidChangeDiagnostics: event('diagnostics'),
    },
    workspace: {
      registerTextDocumentContentProvider: (scheme: string, provider: vscode.TextDocumentContentProvider) => {
        state.providers.set(scheme, provider)
        return { dispose() {} }
      },
      openTextDocument: async (uri: vscode.Uri) => {
        const provider = state.providers.get(uri.scheme)
        state.opened = String(await provider?.provideTextDocumentContent(uri, {} as vscode.CancellationToken))
        const lines = state.opened.split('\n')
        return { lineCount: lines.length, lineAt: (line: number) => ({ text: lines[line] }) }
      },
      get workspaceFolders() {
        return state.folders
      },
      textDocuments: [],
      getConfiguration: () => ({
        get: (name: string, fallback: unknown) =>
          name === 'enable' ? state.enabled : name === 'pathMappings' ? state.mappings : fallback,
      }),
      fs: {
        readFile: async () => new TextEncoder().encode('{}'),
        stat: (uri: { fsPath: string }) => state.stat(uri.fsPath),
      },
      findFiles: async () => state.matches,
      onDidChangeConfiguration: event('config'),
      onDidChangeTextDocument: event('edit'),
    },
    window: {
      createTextEditorDecorationType: () => ({ dispose() {} }),
      showInformationMessage: (text: string) => {
        state.information.push(text)
      },
      showQuickPick: async (items: typeof state.picker) => {
        state.picker = items
        return state.pick ? items[0] : undefined
      },
      showTextDocument: async (_document: unknown, options: { selection: vscode.Range }) => {
        state.selection = options.selection
        return {
          setDecorations: (_type: unknown, ranges: vscode.Range[]) => {
            state.decorations = ranges
          },
          revealRange() {},
        }
      },
      terminals: [],
      createOutputChannel: () => ({ appendLine: (line: string) => state.logs.push(line), dispose() {} }),
      createStatusBarItem: () =>
        Object.assign(state.status, {
          show: () => {
            state.status.visible = true
          },
          hide: () => {
            state.status.visible = false
          },
          dispose() {},
        }),
      onDidOpenTerminal: event('open'),
      onDidChangeActiveTerminal: event('active'),
      onDidStartTerminalShellExecution: event('start'),
      onDidEndTerminalShellExecution: event('end'),
      onDidChangeTerminalShellIntegration: event('integration'),
      onDidCloseTerminal: event('close'),
    },
  }
})

import type * as vscode from 'vscode'
import { activate } from '../src/extension'
import type { SavedRun } from '../src/session'

class Feed {
  private chunks: string[] = []
  private wake?: () => void
  private done = false

  write(text: string): void {
    this.chunks.push(text)
    this.wake?.()
  }

  close(): void {
    this.done = true
    this.wake?.()
  }

  async *read(): AsyncGenerator<string> {
    while (!this.done || this.chunks.length) {
      const chunk = this.chunks.shift()
      if (chunk !== undefined) yield chunk
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
    }
  }
}

const tick = () => vi.advanceTimersByTimeAsync(0)
const messages = () => [...state.shown.values()].flat().map((p) => p.message)
const savedMessages = () =>
  ((state.saved.get('committedProblems') ?? []) as SavedRun[]).flatMap((r) => r.problems.map((p) => p.message))
const error = (message: string) => `src/cart.ts(7,3): error TS2322: ${message}\n`
let subscriptions: vscode.Disposable[]
let terminalId = 0

async function start(command = 'perl slow.pl', terminal = { name: `terminal ${terminalId++}` }) {
  const feed = new Feed()
  const execution = { commandLine: { value: command }, cwd: { fsPath: resolve('/repo') }, read: () => feed.read() }
  state.events.get('start')?.({ terminal, execution })
  await tick()
  return {
    terminal,
    execution,
    async write(text: string) {
      feed.write(text)
      await tick()
    },
    async end(exitCode?: number, close = true) {
      if (close) feed.close()
      state.events.get('end')?.({ execution, exitCode })
      await tick()
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  state.events.clear()
  state.shown.clear()
  state.commands.clear()
  state.providers.clear()
  state.picker = []
  state.pick = true
  state.opened = ''
  state.information = []
  state.others = []
  state.logs.length = 0
  state.enabled = true
  state.saved.clear()
  state.contributions = []
  state.stat = async () => {}
  state.mappings = {}
  state.folders = []
  state.matches = []
  Object.assign(state.status, { text: '', tooltip: '', visible: false })
  subscriptions = []
  activate({
    subscriptions,
    extension: { id: 'test' },
    workspaceState: {
      get: (key: string, fallback: unknown) => state.saved.get(key) ?? fallback,
      update: async (key: string, value: unknown) => {
        state.saved.set(key, value)
      },
    },
  } as unknown as vscode.ExtensionContext)
})

afterEach(() => {
  for (const subscription of subscriptions) subscription.dispose()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('path mapping lookup', () => {
  it('maps primary and related locations before accepting existing build copies', async () => {
    const copy = resolve('/build/copy')
    state.mappings = { [copy]: 'src' }
    state.folders = [{ name: 'shop', uri: { fsPath: resolve('/repo/shop') } }]
    const files = new Set(
      ['main.cpp', 'types.h'].flatMap((file) => [join(copy, file), resolve('/repo/shop/src', file)]),
    )
    const checked: string[] = []
    state.stat = async (file) => {
      checked.push(file)
      if (!files.has(file)) throw new Error('not found')
    }
    const run = await start('gcc main.cpp')
    await run.write(`${join(copy, 'main.cpp')}:7:3: error: broken\n${join(copy, 'types.h')}:4:1: note: declared here\n`)
    await run.end(1)
    expect([...state.shown.keys()]).toEqual([resolve('/repo/shop/src/main.cpp')])
    expect([...state.shown.values()].flat()[0].relatedInformation?.[0].location.uri.fsPath).toBe(
      resolve('/repo/shop/src/types.h'),
    )
    expect(checked).toEqual([resolve('/repo/shop/src/main.cpp'), resolve('/repo/shop/src/types.h')])
  })

  it('uses a mapping before suffix lookup and anchors its target to the workspace, not cwd', async () => {
    state.mappings = { src: 'original' }
    state.folders = [{ name: 'shop', uri: { fsPath: resolve('/workspace/shop') } }]
    state.matches = [{ fsPath: resolve('/elsewhere/src/cart.ts') }]
    state.stat = async (file) => {
      if (file !== resolve('/workspace/shop/original/cart.ts')) throw new Error('not found')
    }
    const run = await start()
    await run.write(error('mapped'))
    await run.end(1)
    expect([...state.shown.keys()]).toEqual([resolve('/workspace/shop/original/cart.ts')])
  })

  it('logs a missing mapped file once across live and final publishes, then retries on a new run', async () => {
    const file = resolve('/app/src/a.ts')
    state.mappings = { [resolve('/app/src')]: 'src' }
    state.folders = [{ name: 'shop', uri: { fsPath: resolve('/workspace/shop') } }]
    state.stat = async (file) => {
      if (file !== resolve('/app/src/a.ts')) throw new Error('not found')
    }
    const run = await start()
    await run.write(`${file}(7,3): error TS2322: fallback\n`)
    await vi.advanceTimersByTimeAsync(1500)
    await run.end(1)
    expect([...state.shown.keys()]).toEqual([file])
    const message = `mapped ${file} to src/a.ts, not found`
    expect(state.logs.filter((line) => line === message)).toHaveLength(1)
    const next = await start()
    await next.write(`${file}(7,3): error TS2322: fallback\n`)
    await next.end(1)
    expect(state.logs.filter((line) => line === message)).toHaveLength(2)
  })

  it('falls back to the original suffix lookup when the mapped target is missing', async () => {
    state.mappings = { src: 'missing' }
    state.folders = [{ name: 'shop', uri: { fsPath: resolve('/workspace/shop') } }]
    state.stat = async () => {
      throw new Error('not found')
    }
    state.matches = [{ fsPath: resolve('/workspace/shop/nested/src/cart.ts') }]
    const run = await start()
    await run.write(error('fallback'))
    await run.end(1)
    expect([...state.shown.keys()]).toEqual([resolve('/workspace/shop/nested/src/cart.ts')])
    expect(state.logs).toContain('mapped src/cart.ts to missing/cart.ts, not found')
  })

  it('logs and ignores ambiguous relative targets in a multi-root workspace', async () => {
    state.mappings = { [resolve('/app')]: 'src' }
    state.folders = ['shop', 'other'].map((name) => ({ name, uri: { fsPath: resolve('/workspace', name) } }))
    const run = await start()
    await run.write(`${resolve('/app/a.ts')}(7,3): error TS2322: fallback\n`)
    await vi.advanceTimersByTimeAsync(1500)
    await run.end(1)
    expect([...state.shown.keys()]).toEqual([resolve('/app/a.ts')])
    expect(state.logs.filter((line) => line.startsWith('ignored path mapping'))).toEqual([
      expect.stringContaining(`use \${workspaceFolder:name}`),
    ])
  })
})

describe('run lifecycle', () => {
  it('keeps contributed matchers for nodemon and honors their fileLocation before root lookups', async () => {
    const contribution = JSON.parse(readFileSync(join(__dirname, 'matchers/contributes.json'), 'utf8')).stylelint
    state.contributions = [
      {
        ...contribution,
        problemMatchers: contribution.problemMatchers.map((matcher: object) => ({
          ...matcher,
          fileLocation: ['relative', `\${cwd}/src`],
        })),
      },
    ]
    state.events.get('extensions')?.(undefined)
    const run = await start('nodemon --exec stylelint a.css')
    const capture = readFileSync(join(__dirname, 'matchers/stylelint-unix.txt'), 'utf8').replaceAll(
      '/private/tmp/claude-501/gl-matchers/',
      '',
    )
    await run.write(capture)
    await run.end(1)
    expect(messages()).toHaveLength(3)
    expect([...state.shown.keys()]).toEqual([resolve('/repo/src/a.css')])
  })

  it('keeps committed jest failures when help expands or a filter is canceled', async () => {
    const run = await start('jest --watchAll')
    await run.write(readFileSync(join(__dirname, 'watch/jest-watch.txt'), 'utf8'))
    const failures = messages()
    expect(failures).toHaveLength(1)
    await run.write('\nWatch Usage\n › Press q to quit watch mode.\n')
    await vi.advanceTimersByTimeAsync(6000)
    expect(messages()).toEqual(failures)
    expect(savedMessages()).toEqual(failures)
    await run.write('\nWatch Usage: Press w to show more.')
    await run.end(130)
    expect(messages()).toEqual(failures)
  })

  it('publishes live results without treating them as watch passes', async () => {
    const run = await start()
    await run.write(error('one'))
    await vi.advanceTimersByTimeAsync(1500)
    expect(messages()).toEqual(['one'])
    expect(savedMessages()).toEqual([])
    await run.write(error('two'))
    await run.end(1)
    expect(messages()).toEqual(['one', 'two'])
    expect(savedMessages()).toEqual(['one', 'two'])
    expect(state.logs.some((line) => line.includes('watch stopped'))).toBe(false)
  })

  it('restores the committed list after an empty provisional result is interrupted', async () => {
    const first = await start()
    await first.write(error('one') + error('two'))
    await first.end(1)
    const second = await start()
    await second.write('progress\n')
    await vi.advanceTimersByTimeAsync(1500)
    expect(messages()).toEqual([])
    await second.end(130)
    expect(messages()).toEqual(['one', 'two'])
    expect(savedMessages()).toEqual(['one', 'two'])
  })

  it('commits problems on failure and clears them on a clean exit', async () => {
    const first = await start()
    await first.write(error('old'))
    await first.end(1)
    const second = await start()
    await second.write(error('new'))
    await vi.advanceTimersByTimeAsync(1500)
    await second.end(130)
    expect(messages()).toEqual(['new'])
    const clean = await start()
    await clean.end(0)
    expect(messages()).toEqual([])
    const interrupted = await start()
    await interrupted.end(130)
    expect(messages()).toEqual([])
  })

  it('keeps watch passes committed and restores them over an unfinished provisional pass', async () => {
    const run = await start('tsc --watch')
    await run.write(`${error('pass')}Watching for file changes.\n`)
    expect(messages()).toEqual(['pass'])
    expect(savedMessages()).toEqual(['pass'])
    await vi.advanceTimersByTimeAsync(6000)
    expect(messages()).toEqual(['pass'])
    await run.write(error('unfinished'))
    await vi.advanceTimersByTimeAsync(1500)
    expect(messages()).toEqual(['unfinished'])
    await run.end(0)
    expect(messages()).toEqual(['pass'])
  })

  it('does not let a provisional publish cancel a pending committed watch pass', async () => {
    let release = () => {}
    state.stat = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
    const run = await start('tsc --watch')
    await run.write(`${error('pass')}Watching for file changes.\n`)
    state.stat = async () => {}
    await run.write(error('unfinished'))
    await vi.advanceTimersByTimeAsync(1500)
    expect(messages()).toEqual(['unfinished'])
    release()
    await tick()
    expect(messages()).toEqual(['unfinished'])
    await run.end(0)
    expect(messages()).toEqual(['pass'])
  })

  it('rejects older provisional and final results when a newer terminal reruns the key', async () => {
    let release = () => {}
    state.stat = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
    const older = await start()
    await older.write(error('old'))
    await vi.advanceTimersByTimeAsync(1500)
    state.stat = async () => {}
    const newer = await start()
    await newer.write(error('new'))
    await newer.end(1)
    release()
    await tick()
    await older.end(1)
    expect(messages()).toEqual(['new'])
    expect(savedMessages()).toEqual(['new'])
  })

  it('clear blocks pending publishes and rollback, but allows new output', async () => {
    const first = await start()
    await first.write(error('old'))
    await first.end(1)
    const second = await start()
    await second.write('progress\n')
    state.clear()
    await vi.advanceTimersByTimeAsync(6000)
    expect(messages()).toEqual([])
    expect(savedMessages()).toEqual([])
    await second.end(130)
    expect(messages()).toEqual([])
    const third = await start()
    await third.write(error('new'))
    state.clear()
    await third.write('progress\n')
    await vi.advanceTimersByTimeAsync(1500)
    expect(messages()).toEqual(['new'])
    await third.end(1)
  })

  it('clear rejects a live publish already resolving files', async () => {
    let release = () => {}
    state.stat = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
    const run = await start()
    await run.write(error('old'))
    await vi.advanceTimersByTimeAsync(1500)
    state.clear()
    release()
    await tick()
    expect(messages()).toEqual([])
    state.stat = async () => {}
    await run.end(1)
    expect(messages()).toEqual(['old'])
  })

  it('keeps powershell re-reports in the same generation and rejects the replaced reader', async () => {
    const older = await start()
    await older.write(error('old'))
    await vi.advanceTimersByTimeAsync(1500)
    await older.end()
    const replacement = await start('perl slow.pl', older.terminal)
    await replacement.write(error('new'))
    await replacement.end(1)
    expect(messages()).toEqual(['new'])
    expect(state.logs.some((line) => line.includes('same run reported again'))).toBe(true)
    const interrupted = await start()
    await interrupted.end(130)
    expect(messages()).toEqual(['new'])
  })

  it('supersedes every active powershell re-report, including the third one', async () => {
    const first = await start()
    await first.write(error('first'))
    const second = await start('perl slow.pl', first.terminal)
    await second.write(error('second'))
    const third = await start('perl slow.pl', first.terminal)
    await third.write(error('third'))
    await vi.advanceTimersByTimeAsync(1500)
    expect(messages()).toEqual(['third'])
    await second.write(error('stale'))
    await vi.advanceTimersByTimeAsync(1500)
    expect(messages()).toEqual(['third'])
    await first.end(1)
    await second.end(1)
    await third.end(1)
    expect(messages()).toEqual(['third'])
  })

  it('keeps an ended powershell generation from overriding a newer terminal', async () => {
    const first = await start()
    await first.write(error('old'))
    await first.end()
    const newer = await start()
    await newer.write(error('new'))
    await newer.end(1)
    const reported = await start('perl slow.pl', first.terminal)
    await reported.write(error('old again'))
    await vi.advanceTimersByTimeAsync(1500)
    await reported.end(1)
    expect(messages()).toEqual(['new'])
  })

  it('moves hidden committed diagnostics before restoring them', async () => {
    const first = await start()
    await first.write(error('old'))
    await first.end(1)
    const second = await start()
    await second.write('progress\n')
    await vi.advanceTimersByTimeAsync(1500)
    expect(messages()).toEqual([])
    state.events.get('edit')?.({
      document: { uri: { scheme: 'file', fsPath: resolve('/repo/src/cart.ts') } },
      contentChanges: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          text: '\n',
        },
      ],
    })
    await second.end(130)
    const restored = [...state.shown.values()].flat()[0] as unknown as vscode.Diagnostic
    expect(restored.range.start.line).toBe(7)
  })

  it('drains late output and warns if the reader outlives the deadline', async () => {
    const run = await start()
    await run.write(error('first'))
    await run.end(1, false)
    await vi.advanceTimersByTimeAsync(250)
    await run.write(error('drained'))
    await vi.advanceTimersByTimeAsync(250)
    expect(messages()).toEqual(['first', 'drained'])
    expect(state.status.tooltip).toContain('output drain timed out')
    await run.write(error('too late'))
    expect(messages()).toEqual(['first', 'drained'])
  })

  it('warns in the log and tooltip even when truncated output contains no problems', async () => {
    const run = await start()
    await run.write(`${'x'.repeat(20_000)}\n`)
    await vi.advanceTimersByTimeAsync(1500)
    expect(state.status.visible).toBe(true)
    expect(state.status.tooltip).toContain('long lines truncated')
    expect(state.logs.some((line) => line.includes('long lines truncated'))).toBe(true)
    await run.end(0)
    state.clear()
    expect(state.status.visible).toBe(false)
  })

  it('reports the display cap and keeps the later problems', async () => {
    const run = await start()
    await run.write(Array.from({ length: 501 }, (_, i) => error(`error ${i}`)).join(''))
    await run.end(1)
    expect(messages()).toHaveLength(500)
    expect(messages().at(-1)).toBe('error 500')
    expect(state.status.tooltip).toContain('500 display limit')
  })

  it('turning off cancels scheduled live updates', async () => {
    const run = await start()
    await run.write(error('old'))
    state.enabled = false
    state.events.get('config')?.({ affectsConfiguration: (key: string) => key === 'gleaner.enable' })
    await vi.advanceTimersByTimeAsync(6000)
    await run.end(0)
    expect(messages()).toEqual([])
  })
})

const shownProblems = () => [...state.shown.values()].flat()
const showOutput = (output?: import('../src/history').OutputReference) =>
  state.commands.get('gleaner.showOutput')?.(output)
const codeActions = async (diagnostic: vscode.Diagnostic) =>
  (await state.actions?.provideCodeActions(
    { uri: { fsPath: resolve('/repo/src/cart.ts') } } as vscode.TextDocument,
    diagnostic.range,
    { diagnostics: [], triggerKind: 1, only: undefined },
    {} as vscode.CancellationToken,
  )) as vscode.CodeAction[]

describe('problem output provenance', () => {
  it('opens the committed log after an interrupted rerun restores its diagnostics', async () => {
    const first = await start()
    await first.write(`${error('committed')}  original detail\n`)
    await first.end(1)
    const origin = shownProblems()[0].output
    const second = await start()
    await second.write('different output\n')
    await vi.advanceTimersByTimeAsync(1500)
    expect(messages()).toEqual([])
    await second.end(130)
    expect(shownProblems()[0].output).toEqual(origin)
    await showOutput(origin)
    expect(state.opened).toContain('error TS2322: committed\n  original detail')
    expect(state.opened).not.toContain('different output')
    expect(state.opened).toContain('exit 1:')
    expect(state.decorations).toEqual([state.selection])
  })

  it('keeps watch pass output separate from a later unfinished pass and its synthetic exit', async () => {
    const run = await start('tsc --watch')
    await run.write(`${error('first')}Watching for file changes.\n`)
    const first = shownProblems()[0].output
    await run.write(`${error('second')}Watching for file changes.\n`)
    const second = shownProblems()[0].output
    expect(second?.id).not.toBe(first?.id)
    await run.write(error('unfinished'))
    await vi.advanceTimersByTimeAsync(1500)
    await run.end(0)
    expect(shownProblems()[0].output).toEqual(second)
    await showOutput(second)
    expect(state.opened).toContain('watch pass 2:')
    expect(state.opened).toContain('error TS2322: second')
    expect(state.opened).not.toContain('unfinished')
    expect(state.opened).not.toContain('exit 0')
    await showOutput(first)
    expect(state.opened).toContain('error TS2322: first')
  })

  it('offers each producing run through code actions and the picker despite language-server dedupe', async () => {
    const first = await start('tsc -p .')
    await first.write(error('same'))
    await first.end(1)
    const diagnostic = shownProblems()[0]
    state.others = [{ ...diagnostic, source: 'typescript' }]
    state.events.get('diagnostics')?.({ uris: [{ scheme: 'file', fsPath: resolve('/repo/src/cart.ts') }] })
    expect(messages()).toEqual([])
    const second = await start('npx tsc -p .')
    await second.write(error('same'))
    await second.end(1)
    expect(messages()).toEqual([])
    const actions = await codeActions(diagnostic)
    expect(actions).toHaveLength(2)
    expect(actions.map((a) => a.title)).toEqual([
      'gleaner: show output (tsc -p .)',
      'gleaner: show output (npx tsc -p .)',
    ])
    await state.commands.get(actions[0].command?.command ?? '')?.(...(actions[0].command?.arguments ?? []))
    expect(state.opened).toContain('$ tsc -p .')
    await showOutput()
    expect(state.picker.map((item) => item.label)).toEqual(['npx tsc -p .', 'tsc -p .'])
    expect(state.opened).toContain('$ npx tsc -p .')
    state.pick = false
    await showOutput()
    expect(state.opened).toContain('$ npx tsc -p .')
  })

  it('keeps a link through edits and explains when clear has removed its log', async () => {
    const run = await start()
    await run.write(error('before edit'))
    await run.end(1)
    const origin = shownProblems()[0].output
    state.events.get('edit')?.({
      document: { uri: { scheme: 'file', fsPath: resolve('/repo/src/cart.ts') } },
      contentChanges: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: '\n\n' }],
    })
    expect(shownProblems()[0].range.start.line).toBe(8)
    expect(shownProblems()[0].output).toEqual(origin)
    state.clear()
    await showOutput(origin)
    expect(state.information.at(-1)).toContain('evicted or cleared')
    await showOutput()
    expect(state.information.at(-1)).toContain('no retained output')
  })

  it('marks restored output unavailable and replaces that policy on rerun', async () => {
    const run = await start()
    await run.write(error('history'))
    await run.end(1)
    for (const subscription of subscriptions) subscription.dispose()
    subscriptions = []
    activate({
      subscriptions,
      extension: { id: 'test' },
      workspaceState: {
        get: (key: string, fallback: unknown) => state.saved.get(key) ?? fallback,
        update: async (key: string, value: unknown) => {
          state.saved.set(key, value)
        },
      },
    } as unknown as vscode.ExtensionContext)
    expect(shownProblems()[0].source).toContain('(last session)')
    expect(shownProblems()[0].output).toBeUndefined()
    const actions = await codeActions(shownProblems()[0])
    expect(actions[0].title).toContain('output unavailable (last session)')
    await state.commands.get(actions[0].command?.command ?? '')?.(...(actions[0].command?.arguments ?? []))
    expect(state.information.at(-1)).toContain('last-session output is not retained')
    const rerun = await start()
    await rerun.write(error('current'))
    await rerun.end(1)
    expect(shownProblems()[0].output).toBeDefined()
    await showOutput(shownProblems()[0].output)
    expect(state.opened).toContain('error TS2322: current')
  })
})
