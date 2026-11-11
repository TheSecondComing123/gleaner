// Stands in for a language server: reports cart.ts's TS2322 the way the typescript extension does.
const vscode = require('vscode')

exports.activate = (context) => {
  const collection = vscode.languages.createDiagnosticCollection('e2e-ls')
  context.subscriptions.push(
    collection,
    vscode.commands.registerCommand('e2eLs.report', () => {
      const file = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'src', 'cart.ts')
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(6, 2, 6, 8),
        "Type 'string' is not assignable to type 'number'.",
        vscode.DiagnosticSeverity.Error,
      )
      diagnostic.source = 'ts'
      diagnostic.code = 2322
      collection.set(file, [diagnostic])
    }),
    vscode.commands.registerCommand('e2eLs.drop', () => collection.clear()),
  )
}
