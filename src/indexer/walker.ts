import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import ignore from "ignore";

export interface WalkerConfig {
  includeExtensions: Set<string>;
  excludePaths: Set<string>;
  maxFileSizeBytes: number;
}

export function getWalkerConfig(): WalkerConfig {
  const config = vscode.workspace.getConfiguration("codeweave");

  const includeExts = config.get<string[]>("includeExtensions") ?? [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".go",
    ".rs",
    ".java",
    ".cs",
    ".cpp",
    ".c",
    ".h",
    ".rb",
    ".php",
    ".swift",
    ".kt",
    ".md",
  ];

  const excludeList = config.get<string[]>("excludePaths") ?? [
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    "__pycache__",
    ".codeweave-index",
    "vendor",
    ".next",
    ".venv",
    "venv",
  ];

  return {
    includeExtensions: new Set(includeExts),
    excludePaths: new Set(excludeList),
    maxFileSizeBytes: 500 * 1024,
  };
}

function loadIgnoreRules(rootDir: string): ReturnType<typeof ignore> {
  const ig = ignore();
  const ignoreFile = path.join(rootDir, ".codeweaveIgnore");
  if (fs.existsSync(ignoreFile)) {
    const rules = fs.readFileSync(ignoreFile, "utf-8");
    ig.add(rules);
  }
  return ig;
}

export function walkDirectory(rootDir: string, config: WalkerConfig): string[] {
  const results: string[] = [];
  const ig = loadIgnoreRules(rootDir);

  function walk(currentDir: string): void {
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (config.excludePaths.has(entry.name)) {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);
      if (ig.ignores(relativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!config.includeExtensions.has(ext)) {
          continue;
        }
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > config.maxFileSizeBytes) {
            console.log(
              `[Walker] Skipping large file: ${entry.name} (${(stat.size / 1024).toFixed(0)} KB)`,
            );
            continue;
          }
        } catch {
          continue;
        }

        results.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return results;
}

export function getFileStats(
  rootDir: string,
  config: WalkerConfig,
): {
  totalFiles: number;
  byExtension: Record<string, number>;
} {
  const files = walkDirectory(rootDir, config);
  const byExtension: Record<string, number> = {};

  for (const f of files) {
    const ext = path.extname(f);
    byExtension[ext] = (byExtension[ext] ?? 0) + 1;
  }

  return { totalFiles: files.length, byExtension };
}

export function walkAllFiles(rootDir: string, config: WalkerConfig): string[] {
  const results: string[] = [];
  const ig = loadIgnoreRules(rootDir);

  function walk(currentDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (config.excludePaths.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);
      if (ig.ignores(relativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > config.maxFileSizeBytes) {
            continue;
          }
        } catch {
          continue;
        }
        results.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return results;
}

export function buildDirectoryTree(
  rootDir: string,
  config: WalkerConfig,
): string {
  const files = walkAllFiles(rootDir, config);

  const tree: Record<string, any> = {};
  for (const f of files) {
    const rel = path.relative(rootDir, f);
    const parts = rel.split("/");
    let node = tree;
    for (const part of parts) {
      if (!node[part]) {
        node[part] = {};
      }
      node = node[part];
    }
  }

  function render(node: Record<string, any>, prefix = ""): string[] {
    const lines: string[] = [];
    const keys = Object.keys(node).sort((a, b) => {
      const aIsDir = Object.keys(node[a]).length > 0;
      const bIsDir = Object.keys(node[b]).length > 0;
      if (aIsDir && !bIsDir) {
        return -1;
      }
      if (!aIsDir && bIsDir) {
        return 1;
      }
      return a.localeCompare(b);
    });

    keys.forEach((key, i) => {
      const isLast = i === keys.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";
      const hasChildren = Object.keys(node[key]).length > 0;
      const icon = hasChildren ? "📁 " : "📄 ";
      lines.push(`${prefix}${connector}${icon}${key}`);
      if (hasChildren) {
        lines.push(...render(node[key], prefix + childPrefix));
      }
    });

    return lines;
  }

  const lines = ["📁 workspace/"];
  lines.push(...render(tree));
  return lines.join("\n");
}
