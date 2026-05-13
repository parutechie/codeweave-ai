import * as vscode from "vscode";
import { getStats } from "./store/lancedb";
import { indexWorkspace } from "./indexer/indexer";
import { ask } from "./chat/chatEngine";
import { CodeWeaveViewProvider } from "./webview/panel";

export function activate(context: vscode.ExtensionContext) {
  vscode.window.showInformationMessage("CodeWeave AI activated! 🧵");

  const indexCommand = vscode.commands.registerCommand(
    "codeweave.index",
    async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      if (!workspaceRoot) {
        vscode.window.showErrorMessage("CodeWeave: Open a folder first.");
        return;
      }

      try {
        const result = await indexWorkspace(workspaceRoot);
        vscode.window.showInformationMessage(
          `CodeWeave: Indexed ${result.totalFiles} files → ${result.totalChunks} chunks in ${result.durationSeconds.toFixed(1)}s ✅`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== "Indexing cancelled by user.") {
          vscode.window.showErrorMessage(`CodeWeave: Indexing failed — ${msg}`);
        }
      }
    },
  );

  const clearCommand = vscode.commands.registerCommand(
    "codeweave.clearIndex",
    async () => {
      const answer = await vscode.window.showWarningMessage(
        "CodeWeave: Delete the entire index? You will need to re-index to use the chat.",
        "Delete Index",
        "Cancel",
      );
      if (answer !== "Delete Index") {
        return;
      }

      const { clearStore } = await import("./store/lancedb");
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      if (workspaceRoot) {
        await clearStore();
        vscode.window.showInformationMessage("CodeWeave: Index cleared.");
      }
    },
  );

  const statusCommand = vscode.commands.registerCommand(
    "codeweave.status",
    async () => {
      const stats = await getStats();
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      const config = vscode.workspace.getConfiguration("codeweave");
      const embedModel = config.get<string>("embedModel");
      const chatModel = config.get<string>("chatModel");

      if (!stats.isReady) {
        vscode.window.showInformationMessage(
          `CodeWeave: No index found. Run "CodeWeave: Index Codebase" to start.`,
        );
      } else {
        vscode.window.showInformationMessage(
          `CodeWeave: ${stats.totalChunks} chunks indexed | Chat: ${chatModel} | Embed: ${embedModel}`,
        );
      }
    },
  );

  const outputChannel = vscode.window.createOutputChannel("CodeWeave AI");
  context.subscriptions.push(outputChannel);

  const askCommand = vscode.commands.registerCommand(
    "codeweave.ask",
    async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      if (!workspaceRoot) {
        vscode.window.showErrorMessage("CodeWeave: Open a folder first.");
        return;
      }

      // Ask the user for their question
      const question = await vscode.window.showInputBox({
        prompt: "Ask anything about your codebase",
        placeHolder: "e.g. how does the risk manager work?",
      });
      if (!question) {
        return;
      }

      // Clear previous answer and show the channel
      outputChannel.clear();
      outputChannel.show(true);
      outputChannel.appendLine(`Question: ${question}`);
      outputChannel.appendLine("─".repeat(60));
      outputChannel.appendLine("Searching codebase...");
      outputChannel.appendLine("");

      await ask({
        question,
        workspaceRoot,

        onSources: (ctx) => {
          // Show which files were used BEFORE streaming the answer
          outputChannel.appendLine(
            `Sources searched (${ctx.totalIndexed} chunks total):`,
          );
          ctx.chunks.forEach((c, i) => {
            outputChannel.appendLine(
              `  ${i + 1}. ${c.filePath} lines ${c.startLine}-${c.endLine} (${Math.round(c.score * 100)}% match)`,
            );
          });
          outputChannel.appendLine("");
          outputChannel.appendLine("Answer:");
          outputChannel.appendLine("─".repeat(60));
        },

        onToken: (token) => {
          outputChannel.append(token);
        },

        onError: (err) => {
          outputChannel.appendLine("");
          outputChannel.appendLine(`ERROR: ${err}`);
          vscode.window.showErrorMessage(`CodeWeave: ${err}`);
        },
      });
      // Add a newline after the answer finishes
      outputChannel.appendLine("");
      outputChannel.appendLine("─".repeat(60));
      outputChannel.appendLine(
        "Done. Ask another question with Cmd+Shift+P → CodeWeave: Ask",
      );
    },
  );

  const provider = new CodeWeaveViewProvider(context.extensionUri);

  context.subscriptions.push(
    indexCommand,
    clearCommand,
    statusCommand,
    askCommand,
    vscode.window.registerWebviewViewProvider(
      CodeWeaveViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
}

export function deactivate() {
  vscode.window.showInformationMessage("CodeWeave AI deactivated! 🧵");
}
