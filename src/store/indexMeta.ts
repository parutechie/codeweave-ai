import * as fs from 'fs';
import * as path from 'path';

interface IndexMeta {
  lastIndexed: number; 
  totalFiles:  number;
  totalChunks: number;
}

function getMetaPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.codeweave-index', 'meta.json');
}

export function saveIndexMeta(workspaceRoot: string, meta: IndexMeta): void {
  const p = getMetaPath(workspaceRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(meta), 'utf-8');
}

export function loadIndexMeta(workspaceRoot: string): IndexMeta | null {
  const p = getMetaPath(workspaceRoot);
  if (!fs.existsSync(p)) { return null; }
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

export function countStaleFiles(
  workspaceRoot: string,
  indexedFiles: string[]
): number {
  const meta = loadIndexMeta(workspaceRoot);
  if (!meta) { return 0; }
  let stale = 0;
  for (const f of indexedFiles) {
    try {
      const mtime = fs.statSync(f).mtimeMs;
      if (mtime > meta.lastIndexed) { stale++; }
    } catch { /* file deleted */ stale++; }
  }
  return stale;
}