import * as vscode from 'vscode'
import { type Change, display, mapPosition, normalizeCode, type Position } from './display'
import type { OutputReference } from './history'
import { restoreSession, type SavedRun, serializeSession } from './session'

export type OutputDiagnostic = vscode.Diagnostic & { output?: OutputReference }

const key = (d: vscode.Diagnostic) =>
  `${d.range.start.line}:${d.range.start.character}|${d.source}|${normalizeCode(d.code)}|${d.message}`

// Each run keeps its whole result; the collection shows what display() makes of all of them.
export class Problems implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('gleaner')
  private readonly byRun = new Map<string, Map<string, vscode.Diagnostic[]>>()
  private readonly committed = new Map<string, Map<string, vscode.Diagnostic[]>>()
  private readonly shown = new Map<string, vscode.Diagnostic[]>()
  hideDuplicates = true

  set(
    run: string,
    files: Map<string, vscode.Diagnostic[]>,
    options: { provisional?: boolean; show?: boolean } = {},
  ): void {
    // one spelling per file: Uri.fsPath is what edits and other sources report
    const normalized = new Map([...files].map(([file, list]) => [vscode.Uri.file(file).fsPath, list]))
    if (!options.provisional) {
      this.committed.delete(run)
      if (normalized.size) this.committed.set(run, normalized)
    }
    if (options.show !== false) this.show(run, normalized)
  }

  restore(run: string): void {
    this.show(run, this.committed.get(run) ?? new Map())
  }

  save(): SavedRun[] {
    return serializeSession(this.committed)
  }

  load(saved: readonly SavedRun[], dirty: ReadonlySet<string>): void {
    const range = (r: SavedRun['problems'][number]['range']) =>
      new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character)
    for (const run of restoreSession(saved, dirty)) {
      const files = new Map<string, vscode.Diagnostic[]>()
      for (const p of run.problems) {
        const d = new vscode.Diagnostic(range(p.range), p.message, p.severity)
        d.source = p.source
        d.code = typeof p.code === 'object' ? { value: p.code.value, target: vscode.Uri.parse(p.code.target) } : p.code
        d.relatedInformation = p.related?.map(
          (r) =>
            new vscode.DiagnosticRelatedInformation(
              new vscode.Location(vscode.Uri.file(r.file), range(r.range)),
              r.message,
            ),
        )
        files.set(p.file, [...(files.get(p.file) ?? []), d])
      }
      this.set(run.key, files)
    }
  }

  private show(run: string, normalized: Map<string, vscode.Diagnostic[]>): void {
    const touched = new Set([...(this.byRun.get(run)?.keys() ?? []), ...normalized.keys()])
    if (normalized.size) this.byRun.set(run, normalized)
    else this.byRun.delete(run)
    for (const file of touched) this.render(file)
  }

  at(file: string, range: vscode.Range): { diagnostic: vscode.Diagnostic; output?: OutputReference }[] {
    return [...this.byRun.values()].flatMap((files) =>
      (files.get(file) ?? [])
        .filter((d) => d.range.intersection(range))
        .map((diagnostic: OutputDiagnostic) => ({
          diagnostic,
          output: diagnostic.output,
        })),
    )
  }

  has(file: string): boolean {
    for (const files of this.byRun.values()) if (files.has(file)) return true
    return false
  }

  files(): Set<string> {
    return new Set([...this.byRun.values()].flatMap((files) => [...files.keys()]))
  }

  render(file: string, force = false): void {
    const uri = vscode.Uri.file(file)
    const mine = this.shown.get(file) ?? []
    const runs = [...this.byRun.values()].map((files) => files.get(file) ?? [])
    const next = display(runs, this.hideDuplicates ? this.others(uri, mine) : [])
    // setting the collection fires onDidChangeDiagnostics, which renders again: stop when nothing changed
    if (!force && next.length === mine.length && next.every((d, i) => d === mine[i])) return
    if (next.length) this.shown.set(file, next)
    else this.shown.delete(file)
    this.collection.set(uri, next)
  }

  // does this file hold any of gleaner's problems or their related locations
  touches(file: string): boolean {
    for (const files of new Set([...this.byRun.values(), ...this.committed.values()]))
      for (const [owner, list] of files)
        if (owner === file || list.some((d) => d.relatedInformation?.some((r) => r.location.uri.fsPath === file)))
          return true
    return false
  }

  // An edit moves gleaner's problems and their related locations along with the text; a problem
  // whose text was replaced goes.
  edit(file: string, changes: readonly Change[]): void {
    const move = (range: vscode.Range): vscode.Range | undefined => {
      let start: Position | undefined = range.start
      let end: Position | undefined = range.end
      for (const change of changes) {
        start = start && mapPosition(start, change)
        end = end && mapPosition(end, change)
      }
      if (!start) return undefined
      end ??= start
      return new vscode.Range(start.line, start.character, end.line, end.character)
    }
    const touched = new Set<string>()
    for (const files of new Set([...this.byRun.values(), ...this.committed.values()])) {
      for (const [owner, list] of files) {
        const kept: vscode.Diagnostic[] = []
        for (const d of list) {
          if (owner === file) {
            touched.add(owner)
            const range = move(d.range)
            if (!range) continue
            d.range = range
          }
          if (d.relatedInformation?.some((r) => r.location.uri.fsPath === file)) {
            touched.add(owner)
            d.relatedInformation = d.relatedInformation.flatMap((r) => {
              if (r.location.uri.fsPath !== file) return [r]
              const range = move(r.location.range)
              return range
                ? [new vscode.DiagnosticRelatedInformation(new vscode.Location(r.location.uri, range), r.message)]
                : []
            })
          }
          kept.push(d)
        }
        if (kept.length) files.set(owner, kept)
        else files.delete(owner)
      }
    }
    for (const owner of touched) this.render(owner, true)
  }

  // Every diagnostic on the file except gleaner's own.
  private others(uri: vscode.Uri, mine: vscode.Diagnostic[]): vscode.Diagnostic[] {
    const left = new Map<string, number>()
    for (const d of mine) left.set(key(d), (left.get(key(d)) ?? 0) + 1)
    return vscode.languages.getDiagnostics(uri).filter((d) => {
      const n = left.get(key(d)) ?? 0
      if (!n) return true
      left.set(key(d), n - 1)
      return false
    })
  }

  clear(): void {
    this.byRun.clear()
    this.committed.clear()
    this.shown.clear()
    this.collection.clear()
  }

  get count(): number {
    let total = 0
    for (const list of this.shown.values()) total += list.length
    return total
  }

  dispose(): void {
    this.collection.dispose()
  }
}
