import * as vscode from 'vscode'
import { type Change, display, mapPosition, normalizeCode, type Position } from './display'

const key = (d: vscode.Diagnostic) =>
  `${d.range.start.line}:${d.range.start.character}|${d.source}|${normalizeCode(d.code)}|${d.message}`

// Each run keeps its whole result; the collection shows what display() makes of all of them.
export class Problems implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('gleaner')
  private readonly byRun = new Map<string, Map<string, vscode.Diagnostic[]>>()
  private readonly shown = new Map<string, vscode.Diagnostic[]>()
  hideDuplicates = true

  set(run: string, files: Map<string, vscode.Diagnostic[]>): void {
    // one spelling per file: Uri.fsPath is what edits and other sources report
    const normalized = new Map([...files].map(([file, list]) => [vscode.Uri.file(file).fsPath, list]))
    const touched = new Set([...(this.byRun.get(run)?.keys() ?? []), ...normalized.keys()])
    if (normalized.size) this.byRun.set(run, normalized)
    else this.byRun.delete(run)
    for (const file of touched) this.render(file)
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

  // An edit moves gleaner's problems along with the text; a problem whose text was replaced goes.
  edit(file: string, changes: readonly Change[]): void {
    for (const files of this.byRun.values()) {
      const list = files.get(file)
      if (!list) continue
      const kept: vscode.Diagnostic[] = []
      for (const d of list) {
        let start: Position | undefined = d.range.start
        let end: Position | undefined = d.range.end
        for (const change of changes) {
          start = start && mapPosition(start, change)
          end = end && mapPosition(end, change)
        }
        if (!start) continue
        end ??= start
        d.range = new vscode.Range(start.line, start.character, end.line, end.character)
        kept.push(d)
      }
      if (kept.length) files.set(file, kept)
      else files.delete(file)
    }
    this.render(file, true)
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
