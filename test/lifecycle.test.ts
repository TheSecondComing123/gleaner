import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  events: new Map<string, (value: unknown) => unknown>(),
  shown: new Map<string, { message: string }[]>(),
  logs: [] as string[],
  clear: () => {},
  stat: async () => {},
  enabled: true,
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
  }
  const event = (name: string) => (callback: (value: unknown) => unknown) => {
    state.events.set(name, callback)
    return { dispose() {} }
  }
  return {
    Position,
    Range,
    Diagnostic: class {
      constructor(
        public range: Range,
        public message: string,
        public severity: number,
      ) {}
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    Disposable: class {
      constructor(public dispose: () => void) {}
    },
    Uri: { file: (file: string) => ({ fsPath: file, scheme: 'file' }) },
    StatusBarAlignment: { Left: 1 },
    extensions: { all: [], onDidChange: event('extensions') },
    commands: {
      registerCommand: (_name: string, callback: () => void) => {
        state.clear = callback
        return { dispose() {} }
      },
    },
    languages: {
      createDiagnosticCollection: () => ({
        set: (uri: { fsPath: string }, list: { message: string }[]) => state.shown.set(uri.fsPath, list),
        clear: () => state.shown.clear(),
        dispose() {},
      }),
      getDiagnostics: () => [],
      onDidChangeDiagnostics: event('diagnostics'),
    },
    workspace: {
      workspaceFolders: [],
      getConfiguration: () => ({
        get: (name: string, fallback: unknown) => (name === 'enable' ? state.enabled : fallback),
      }),
      fs: {
        readFile: async () => new TextEncoder().encode('{}'),
        stat: () => state.stat(),
      },
      findFiles: async () => [],
      onDidChangeConfiguration: event('config'),
      onDidChangeTextDocument: event('edit'),
    },
    window: {
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
const error = (message: string) => `src/cart.ts(7,3): error TS2322: ${message}\n`
let subscriptions: vscode.Disposable[]
let terminalId = 0

async function start(command = 'perl slow.pl', terminal = { name: `terminal ${terminalId++}` }) {
  const feed = new Feed()
  const execution = { commandLine: { value: command }, cwd: { fsPath: '/repo' }, read: () => feed.read() }
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
  state.logs.length = 0
  state.enabled = true
  state.stat = async () => {}
  Object.assign(state.status, { text: '', tooltip: '', visible: false })
  subscriptions = []
  activate({ subscriptions, extension: { id: 'test' } } as unknown as vscode.ExtensionContext)
})

afterEach(() => {
  for (const subscription of subscriptions) subscription.dispose()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('run lifecycle', () => {
  it('publishes live results without treating them as watch passes', async () => {
    const run = await start()
    await run.write(error('one'))
    await vi.advanceTimersByTimeAsync(1500)
    expect(messages()).toEqual(['one'])
    await run.write(error('two'))
    await run.end(1)
    expect(messages()).toEqual(['one', 'two'])
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
      document: { uri: { scheme: 'file', fsPath: '/repo/src/cart.ts' } },
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
