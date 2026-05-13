import * as path from "path";
import * as lancedb from "vectordb";
import * as fs from "fs";

export interface ChunkRecord {
  [key: string]: unknown;
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  entityType: string;
  entityName: string;
  vector: number[];
}

export interface SearchResult {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  entityType: string;
  entityName: string;
  score: number;
}

let table: any = null;
let dbPath: string = "";

function getDbPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".codeweave-index");
}

export async function initStore(workspaceRoot: string): Promise<void> {
  dbPath = getDbPath(workspaceRoot);
  const db = await lancedb.connect(dbPath);
  const tableNames = await db.tableNames();
  if (tableNames.includes("chunks")) {
    table = await db.openTable("chunks");
    console.log(
      `[CodeWeave Store] Opened existing table with ${await table.countRows()} chunks`,
    );
  } else {
    const dummyRow: ChunkRecord = {
      id: "__init__",
      filePath: "",
      startLine: 0,
      endLine: 0,
      content: "",
      entityType: "",
      entityName: "",
      vector: new Array(1024).fill(0),
    };

    table = await db.createTable("chunks", [dummyRow]);
    await table.delete(`id = '__init__'`);
    console.log("[CodeWeave Store] Created new table");
  }
}

export async function addChunks(chunks: ChunkRecord[]): Promise<void> {
  if (!table) {
    throw new Error("Store not initialized. Call initStore() first.");
  }
  if (chunks.length === 0) {
    return;
  }

  await table.add(chunks);
  console.log(`[CodeWeave Store] Added ${chunks.length} chunks`);
}

export async function search(
  queryVector: number[],
  topK: number = 5,
): Promise<SearchResult[]> {
  if (!table) {
    throw new Error("Store not initialized. Call initStore() first.");
  }
  const raw = await table.search(queryVector).limit(topK).execute();
  return raw.map((row: any) => ({
    id: row.id as string,
    filePath: row.filePath as string,
    startLine: row.startLine as number,
    endLine: row.endLine as number,
    content: row.content as string,
    entityType: row.entityType as string,
    entityName: row.entityName as string,
    score: 1 - (row._distance as number),
  }));
}

export async function clearStore(): Promise<void> {
  table = null;
  if (fs.existsSync(dbPath)) {
    fs.rmSync(dbPath, { recursive: true, force: true });
    console.log("[CodeWeave Store] Index cleared from disk");
  }
}

export async function getStats(): Promise<{
  totalChunks: number;
  isReady: boolean;
}> {
  if (!table) {
    return { totalChunks: 0, isReady: false };
  }

  try {
    const count = await table.countRows();
    return { totalChunks: count, isReady: count > 0 };
  } catch {
    return { totalChunks: 0, isReady: false };
  }
}

export async function deleteChunksForFile(relativePath: string): Promise<void> {
  if (!table) {
    return;
  }
  const normalized = relativePath.replace(/\\/g, "/");
  await table.delete(`filePath = '${normalized}'`);
  console.log(`[Store] Deleted chunks for ${normalized}`);
}
