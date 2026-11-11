import * as vscode from 'vscode'

// grouped per run
export class Problems implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('gleaner')
  private readonly byRun = new Map<string, Map<string, vscode.Diagnostic[]>>()

  set(run: string, files: Map<string, vscode.Diagnostic[]>): void {
    const touched = new Set([...(this.byRun.get(run)?.keys() ?? []), ...files.keys()])
    if (files.size) this.byRun.set(run, files)
    else this.byRun.delete(run)
    for (const file of touched) {
      this.collection.set(
        vscode.Uri.file(file),
        [...this.byRun.values()].flatMap((m) => m.get(file) ?? []),
      )
    }
  }

  clear(): void {
    this.byRun.clear()
    this.collection.clear()
  }

  get count(): number {
    let total = 0
    for (const files of this.byRun.values()) for (const list of files.values()) total += list.length
    return total
  }

  dispose(): void {
    this.collection.dispose()
  }
}
