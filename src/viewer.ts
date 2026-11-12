import * as vscode from 'vscode'
import { type OutputHistory, type OutputReference, outputDocument } from './history'
import type { Problems } from './problems'

export function registerOutputViewer(
  context: vscode.ExtensionContext,
  history: OutputHistory,
  problems: Problems,
): void {
  let viewRevision = 0
  const decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
  })
  const uriFor = (id: string): vscode.Uri =>
    vscode.Uri.from({ scheme: 'gleaner-output', path: `/${id}/output.log`, query: String(viewRevision++) })
  const idFor = (uri: vscode.Uri): string => uri.path.slice(1, -'/output.log'.length)
  const unavailable = 'output unavailable: this run was evicted or cleared. last-session output is not retained.'
  const show = async (reference?: OutputReference): Promise<void> => {
    if (!reference) {
      const recent = history.recent()
      if (!recent.length) {
        void vscode.window.showInformationMessage(
          'no retained output. last-session output is not available; rerun the command.',
        )
        return
      }
      const picked = await vscode.window.showQuickPick(
        recent.map((run) => ({
          label: run.command,
          description: `${run.state === 'pass' ? `watch pass ${run.pass}` : run.state === 'provisional' ? 'running' : `exit ${run.exitCode ?? 'unknown'}`} · ${new Date(run.updated).toLocaleString()}`,
          detail: run.folder,
          run,
        })),
        { placeHolder: 'choose a recent run, including hidden duplicates' },
      )
      if (!picked) return
      reference = { id: picked.run.id, span: picked.run.focus }
    }
    const run = history.get(reference.id)
    if (!run) {
      void vscode.window.showInformationMessage(unavailable)
      return
    }
    const uri = uriFor(run.id)
    const document = await vscode.workspace.openTextDocument(uri)
    const view = outputDocument(run, reference.span)
    const start = Math.min(view.selection.start, document.lineCount - 1)
    const end = Math.min(view.selection.end - 1, document.lineCount - 1)
    const range = new vscode.Range(start, 0, end, document.lineAt(end).text.length)
    const editor = await vscode.window.showTextDocument(document, { preview: true, selection: range })
    editor.setDecorations(decoration, [range])
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  }
  context.subscriptions.push(
    decoration,
    vscode.workspace.registerTextDocumentContentProvider('gleaner-output', {
      provideTextDocumentContent: (uri) => {
        const run = history.get(idFor(uri))
        return run ? outputDocument(run).text : unavailable
      },
    }),
    vscode.commands.registerCommand('gleaner.showOutput', show),
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      {
        provideCodeActions(document, range) {
          return problems.at(document.uri.fsPath, range).map(({ diagnostic, output }) => {
            const run = output && history.get(output.id)
            const title = output
              ? `gleaner: show output${run ? ` (${run.command})` : ''}`
              : 'gleaner: output unavailable (last session)'
            const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix)
            action.diagnostics = [diagnostic]
            action.command = {
              title,
              command: 'gleaner.showOutput',
              arguments: [output ?? { id: 'last-session' }],
            }
            return action
          })
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  )
}
