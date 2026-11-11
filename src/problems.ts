import * as vscode from 'vscode'

// Problems are grouped by the run that produced them (terminal + command), so
// rerunning a command replaces only its own problems.
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

  dispose(): void {
    this.collection.dispose()
  }
}
