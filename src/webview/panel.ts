import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ask } from "../chat/chatEngine";
import { indexWorkspace, reindexFile } from "../indexer/indexer";
import { getStats } from "../store/lancedb";
import { countStaleFiles } from "../store/indexMeta";
import { walkDirectory, getWalkerConfig } from "../indexer/walker";

export class CodeWeaveViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "codeweave.chatView";
  private _view?: vscode.WebviewView;
  private _history: { question: string; answer: string }[] = [];

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      console.log("[CodeWeave Panel] Received message:", message.type);

      switch (message.type) {
        case "ready":
          console.log("[CodeWeave Panel] Webview ready - checking setup");
          await this._sendSetupStatus();
          break;

        case "ask":
          await this._handleQuestion(message.question);
          break;

        case "index":
          await this._handleIndex();
          break;

        case "clearHistory":
          this._history = [];
          break;

        case "openFile": {
          const workspaceRoot =
            vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
          if (!workspaceRoot) {
            break;
          }
          const fullPath = path.join(workspaceRoot, message.filePath);
          try {
            const uri = vscode.Uri.file(fullPath);
            const doc = await vscode.workspace.openTextDocument(uri);
            const startLine = Math.max(0, (message.line ?? 1) - 1);
            const endLine = Math.max(
              0,
              (message.endLine ?? message.line ?? 1) - 1,
            );
            const range = new vscode.Range(
              startLine,
              0,
              endLine,
              Number.MAX_SAFE_INTEGER,
            );

            const editor = await vscode.window.showTextDocument(doc, {
              selection: range,
              preserveFocus: false,
              viewColumn: vscode.ViewColumn.One,
            });
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
          } catch {
            this._post({
              type: "error",
              message: "Cannot open " + message.filePath,
            });
          }
          break;
        }

        case "runInTerminal": {
          const terminal = vscode.window.createTerminal({
            name: "CodeWeave Setup",
          });
          terminal.show(false);
          terminal.sendText(message.cmd);
          break;
        }

        case "checkSetup": {
          await this._sendSetupStatus();
          break;
        }
      }
    });

    setTimeout(async () => {
      console.log("[CodeWeave Panel] Fallback timeout - checking setup");
      await this._sendSetupStatus();
    }, 2000);

    const watcher = vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      if (!workspaceRoot) {
        return;
      }
      const config = vscode.workspace.getConfiguration("codeweave");
      const includeExts = new Set(
        config.get<string[]>("includeExtensions") ?? [],
      );
      const ext = path.extname(doc.fileName).toLowerCase();
      if (!includeExts.has(ext)) {
        return;
      }
      const stats = await getStats();
      if (!stats.isReady) {
        return;
      }
      const relativePath = path.relative(workspaceRoot, doc.fileName);
      if (relativePath.startsWith("..")) {
        return;
      }
      this._post({
        type: "status",
        message: "Re-indexing " + relativePath + "...",
      });
      try {
        const count = await reindexFile(doc.fileName, workspaceRoot);
        this._post({
          type: "status",
          message:
            "Updated " + relativePath + " (" + count + " chunks) - ready",
        });
      } catch (err) {
        console.warn(
          "[Watcher] Re-index failed for " + relativePath + ": " + err,
        );
      }
    });

    webviewView.onDidDispose(() => watcher.dispose());
  }

  private async _sendSetupStatus(): Promise<void> {
    const platform =
      process.platform === "darwin"
        ? "mac"
        : process.platform === "win32"
          ? "win"
          : "linux";

    const { ping, getModels } = await import("../ai/ollama");
    const ollamaRunning = await ping();

    if (!ollamaRunning) {
      this._post({
        type: "setupRequired",
        platform,
        ollamaRunning: false,
        missingModels: [],
      });
      return;
    }

    const config = vscode.workspace.getConfiguration("codeweave");
    const embedModel = config.get<string>("embedModel") ?? "mxbai-embed-large";
    const chatModel = config.get<string>("chatModel") ?? "qwen2.5-coder:7b";
    const models = await getModels();

    const missingModels: string[] = [];
    if (!models.some((m) => m.startsWith(embedModel.split(":")[0])))
      missingModels.push(embedModel);
    if (!models.some((m) => m.startsWith(chatModel.split(":")[0])))
      missingModels.push(chatModel);

    if (missingModels.length > 0) {
      this._post({
        type: "setupRequired",
        platform,
        ollamaRunning: true,
        missingModels,
      });
      return;
    }

    this._post({ type: "setupDone" });
    await this._sendIndexStatus();
  }

  private _post(message: object): void {
    console.log(
      "[CodeWeave Panel] Posting to webview:",
      JSON.stringify(message).slice(0, 100),
    );
    this._view?.webview.postMessage(message);
  }

  private async _sendIndexStatus(): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (workspaceRoot) {
      const { initStore } = await import("../store/lancedb");
      await initStore(workspaceRoot);
    }
    const stats = await getStats();

    let staleCount = 0;
    if (stats.isReady && workspaceRoot) {
      const walkerConfig = getWalkerConfig();
      const files = walkDirectory(workspaceRoot, walkerConfig);
      staleCount = countStaleFiles(workspaceRoot, files);
    }

    this._post({
      type: "indexStatus",
      totalChunks: stats.totalChunks,
      isReady: stats.isReady,
      staleCount,
    });
  }

  private async _handleQuestion(question: string): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (!workspaceRoot) {
      this._post({
        type: "error",
        message: "No folder open. Open a project folder first.",
      });
      return;
    }
    this._post({ type: "status", message: "Searching codebase..." });
    let fullAnswer = "";
    await ask({
      question,
      workspaceRoot,
      history: this._history,
      onSources: (ctx) => {
        this._post({
          type: "sources",
          chunks: ctx.chunks.map((c) => ({
            filePath: c.filePath,
            startLine: c.startLine,
            endLine: c.endLine,
            score: Math.round(c.score * 100),
          })),
        });
      },
      onToken: (token) => {
        fullAnswer += token;
        this._post({ type: "token", content: token });
      },
      onError: (err) => {
        this._post({ type: "error", message: err });
      },
    });
    this._history.push({ question, answer: fullAnswer });
    if (this._history.length > 10) {
      this._history.shift();
    }
    this._post({ type: "done" });
  }

  private async _handleIndex(): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (!workspaceRoot) {
      this._post({ type: "error", message: "No folder open." });
      return;
    }

    const { ping } = await import("../ai/ollama");
    const ollamaRunning = await ping();
    if (!ollamaRunning) {
      this._post({
        type: "error",
        message:
          "Ollama is not running. Complete the setup steps first, then index.",
      });
      await this._sendSetupStatus();
      return;
    }
    try {
      this._post({ type: "status", message: "Indexing codebase..." });
      const result = await indexWorkspace(workspaceRoot, { skipConfirm: true });
      this._post({
        type: "indexed",
        totalFiles: result.totalFiles,
        totalChunks: result.totalChunks,
        duration: result.durationSeconds.toFixed(1),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== "Indexing cancelled by user.") {
        this._post({ type: "error", message: msg });
      }
    }
  }

  private _getHtml(): string {
    const webview = this._view!.webview;

    const htmlPath = path.join(
      this._extensionUri.fsPath,
      "media",
      "webview.html",
    );

    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this._extensionUri,
        "assets",
        "codeweave_no_background.png",
      ),
    );

    const logoColoredUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "assets", "codeweave.png"),
    );

    const settingsIconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "assets", "settings.svg"),
    );

    try {
      let html = fs.readFileSync(htmlPath, "utf-8");

      // Inject logo path
      html = html.replace("__LOGO_URI__", logoUri.toString());

      // Inject Colored Logo path
      html = html.replace("__LOGO_COLORED_URI__", logoColoredUri.toString());

      // Inject CSP source
      html = html.replace("__CSP_SOURCE__", webview.cspSource);

      // Inject settings icon path
      html = html.replace("__SETTINGS_ICON_URI__", settingsIconUri.toString());

      return html;
    } catch (err) {
      console.error("[CodeWeave] Failed to load webview.html:", err);

      return `
      <!DOCTYPE html>
      <html>
      <body>
        <p style="color:red;padding:12px;">
          Error loading webview.
        </p>
      </body>
      </html>
    `;
    }
  }
}
