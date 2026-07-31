import * as vscode from "vscode";

export interface DiagnosticCommandInput {
  uri: vscode.Uri;
  diagnostic: vscode.Diagnostic;
}

export interface SymbolCommandInput {
  uri: vscode.Uri;
  range: vscode.Range;
}

export class FlavorCodeActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    return context.diagnostics.slice(0, 20).flatMap((diagnostic) => {
      const input: DiagnosticCommandInput = { uri: document.uri, diagnostic };
      const fix = new vscode.CodeAction("Fix with Flavor", vscode.CodeActionKind.QuickFix);
      fix.command = { command: "flavor.fixDiagnostic", title: "Fix with Flavor", arguments: [input] };
      fix.diagnostics = [diagnostic];
      fix.isPreferred = false;

      const explain = new vscode.CodeAction("Explain with Flavor", vscode.CodeActionKind.QuickFix);
      explain.command = { command: "flavor.explainDiagnostic", title: "Explain with Flavor", arguments: [input] };
      explain.diagnostics = [diagnostic];
      return [fix, explain];
    });
  }
}

export class FlavorCodeLensProvider implements vscode.CodeLensProvider {
  readonly #emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.#emitter.event;

  refresh(): void {
    this.#emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration("flavorCode").get<boolean>("codeLens", true)) return [];
    if (document.uri.scheme !== "file" || document.lineCount > 20_000) return [];
    const lenses: vscode.CodeLens[] = [];
    for (let line = 0; line < document.lineCount && lenses.length < 40; line += 1) {
      const text = document.lineAt(line).text;
      if (!isSymbolDeclaration(text, document.languageId)) continue;
      const range = document.lineAt(line).range;
      const input: SymbolCommandInput = { uri: document.uri, range };
      lenses.push(
        new vscode.CodeLens(range, {
          command: "flavor.reviewSymbol",
          title: "$(shield) Review",
          arguments: [input],
        }),
        new vscode.CodeLens(range, {
          command: "flavor.generateTests",
          title: "$(beaker) Add tests",
          arguments: [input],
        }),
      );
    }
    return lenses;
  }

  dispose(): void {
    this.#emitter.dispose();
  }
}

function isSymbolDeclaration(text: string, languageId: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.startsWith("//") || trimmed.startsWith("#")) return false;
  if (languageId === "python") return /^(?:async\s+)?def\s+\w+|^class\s+\w+/.test(trimmed);
  if (languageId === "rust") return /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+\w+|^(?:pub\s+)?(?:struct|enum|trait)\s+\w+/.test(trimmed);
  if (languageId === "go") return /^func\s+(?:\([^)]*\)\s*)?\w+|^type\s+\w+\s+(?:struct|interface)/.test(trimmed);
  if (["javascript", "javascriptreact", "typescript", "typescriptreact"].includes(languageId)) {
    return /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+\w+|^(?:export\s+)?(?:abstract\s+)?class\s+\w+|^(?:export\s+)?(?:const|let)\s+\w+\s*=\s*(?:async\s*)?\(/.test(trimmed);
  }
  return /^(?:public|private|protected|internal|static|final|abstract|async|\s)*(?:class|interface|enum|function|fun|def)\s+\w+/.test(trimmed);
}
