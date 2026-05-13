import * as vscode from "vscode";
import { embed } from "../ai/ollama";
import { initStore, search, getStats, SearchResult } from "../store/lancedb";
import { GraphData, GraphEntity, GraphContext } from "../graph/types";
import { loadGraph } from "../graph/graphStore";
import { traverseGraph } from "../graph/graphTraversal";
import { parseMentions } from "./mentionParser";
import { getWalkerConfig, buildDirectoryTree } from "../indexer/walker";

export interface RetrievalContext {
  question: string;
  chunks: SearchResult[];
  totalIndexed: number;
  graphContext?: GraphContext;
}

export async function retrieve(
  question: string,
  workspaceRoot: string,
): Promise<RetrievalContext> {
  const config = vscode.workspace.getConfiguration("codeweave");
  const topK = config.get<number>("topK") ?? 5;

  await initStore(workspaceRoot);
  const stats = await getStats();

  if (!stats.isReady) {
    throw new Error('No index found. Run "CodeWeave: Index Codebase" first.');
  }

  // ── Parse @mentions ────────────────────────────────────────────────────────
  const { cleanQuestion, mentionedFiles, mentionedSymbols } =
    parseMentions(question);
  const pinnedChunks: SearchResult[] = [];

  if (mentionedFiles.length > 0 || mentionedSymbols.length > 0) {
    const graphData = loadGraph(workspaceRoot);
    if (graphData) {
      for (const entity of Object.values(graphData.entities)) {
        const fileMatch = mentionedFiles.some((f) =>
          entity.filePath.includes(f),
        );
        const symbolMatch = mentionedSymbols.some(
          (s) => entity.entityName.toLowerCase() === s.toLowerCase(),
        );
        if ((fileMatch || symbolMatch) && entity.entityType !== "import") {
          pinnedChunks.push({
            id: entity.id,
            filePath: entity.filePath,
            startLine: entity.startLine,
            endLine: entity.endLine,
            content: entity.content,
            entityType: entity.entityType,
            entityName: entity.entityName,
            score: 1.0,
          });
        }
      }
    }
  }

  const safeQuestion =
    cleanQuestion.length > 800 ? cleanQuestion.slice(0, 800) : cleanQuestion;
  const questionVector = await embed(safeQuestion || question);
  if (pinnedChunks.length > 0) {
    const rawResults = await search(questionVector, topK * 2);
    const maxScore = rawResults[0]?.score ?? 0;
    const threshold = maxScore < 0.35 ? 0.1 : 0.25;
    const vectorChunks = rawResults
      .filter((r) => r.score > threshold)
      .slice(0, topK);

    const pinnedIds = new Set(pinnedChunks.map((c) => c.id));
    const merged = [
      ...pinnedChunks,
      ...vectorChunks.filter((c) => !pinnedIds.has(c.id)),
    ].slice(0, topK + pinnedChunks.length);

    const graphData = loadGraph(workspaceRoot);
    let graphContext: GraphContext | undefined;
    if (graphData && merged.length > 0) {
      const seeds = merged.map(
        (r) => graphData.entities[r.id] ?? entityFromResult(r),
      );
      graphContext = traverseGraph(seeds, graphData);
    }

    return {
      question,
      chunks: merged,
      totalIndexed: stats.totalChunks,
      graphContext,
    };
  }

  const isStructureQuery =
    /folder.?struct|file.?struct|project.?layout|directory.?struct|tree|what files|where.*file|list.*file|show.*file|how.*organize|project.?map|repo.?layout|codebase.?layout|all.*file|every.*file|project.?overview|tell me about.*project|structure|layout|hierarchy|organize/i.test(
      safeQuestion,
    );
  const isBroadQuery =
    /explain|overview|architecture|project|how does.*work|what is/i.test(
      safeQuestion,
    );

  if (isStructureQuery) {
    return structureRetrieve(cleanQuestion, workspaceRoot, stats.totalChunks);
  }

  if (isBroadQuery) {
    return graphFirstRetrieve(
      cleanQuestion,
      questionVector,
      workspaceRoot,
      topK,
      stats.totalChunks,
    );
  }

  // ── Normal focused query ───────────────────────────────────────────────────
  const rawResults = await search(questionVector, topK * 2);
  const maxScore = rawResults[0]?.score ?? 0;
  const threshold = maxScore < 0.35 ? 0.1 : 0.25;
  const filtered = rawResults.filter((r) => r.score > threshold).slice(0, topK);

  let graphContext: GraphContext | undefined;
  if (filtered.length > 0) {
    const graphData = loadGraph(workspaceRoot);
    if (graphData) {
      const seedEntities = filtered.map(
        (r) => graphData.entities[r.id] ?? entityFromResult(r),
      );
      graphContext = traverseGraph(seedEntities, graphData);
    }
  }

  return {
    question,
    chunks: filtered,
    totalIndexed: stats.totalChunks,
    graphContext,
  };
}

async function structureRetrieve(
  question: string,
  workspaceRoot: string,
  totalChunks: number,
): Promise<RetrievalContext> {
  try {
    const walkerConfig = getWalkerConfig();
    const treeStr = buildDirectoryTree(workspaceRoot, walkerConfig);

    const treeChunk: SearchResult = {
      id: "folder-structure",
      filePath: "workspace",
      startLine: 1,
      endLine: treeStr.split("\n").length,
      content: treeStr,
      entityType: "module",
      entityName: "Folder Structure",
      score: 1.0,
    };

    return { question, chunks: [treeChunk], totalIndexed: totalChunks };
  } catch (err) {
    console.log(
      "[Retriever] Filesystem walk failed, falling back to graph tree:",
      err,
    );
  }

  // Fallback: build tree from graph module entities
  const graphData = loadGraph(workspaceRoot);
  if (!graphData) {
    return { question, chunks: [], totalIndexed: totalChunks };
  }

  const modules = Object.values(graphData.entities)
    .filter((e) => e.entityType === "module")
    .map((e) => e.filePath);

  const tree = buildFileTree(modules);
  const treeStr = renderTree(tree);

  const treeChunk: SearchResult = {
    id: "folder-structure",
    filePath: "workspace",
    startLine: 1,
    endLine: modules.length,
    content: treeStr,
    entityType: "module",
    entityName: "Folder Structure",
    score: 1.0,
  };

  return { question, chunks: [treeChunk], totalIndexed: totalChunks };
}

function buildFileTree(paths: string[]): Record<string, any> {
  const tree: Record<string, any> = {};
  for (const p of paths.sort()) {
    const parts = p.replace(/\\/g, "/").split("/");
    let node = tree;
    for (const part of parts) {
      if (!node[part]) {
        node[part] = {};
      }
      node = node[part];
    }
  }
  return tree;
}

function renderTree(
  tree: Record<string, any>,
  prefix = "",
  name = "root",
): string {
  const lines: string[] = name === "root" ? ["📁 workspace/"] : [];
  const keys = Object.keys(tree);
  keys.forEach((key, i) => {
    const isLast = i === keys.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";
    const hasChildren = Object.keys(tree[key]).length > 0;
    const icon = hasChildren ? "📁 " : "📄 ";
    lines.push(`${prefix}${connector}${icon}${key}`);
    if (hasChildren) {
      lines.push(renderTree(tree[key], prefix + childPrefix, key));
    }
  });
  return lines.filter(Boolean).join("\n");
}

async function graphFirstRetrieve(
  question: string,
  questionVector: number[],
  workspaceRoot: string,
  topK: number,
  totalChunks: number,
): Promise<RetrievalContext> {
  console.log("[Retriever] Using GRAPH-FIRST strategy");

  const graphData = loadGraph(workspaceRoot);

  const entryEntity = findEntryPoint(graphData);

  if (!entryEntity || !graphData) {
    console.log(
      "[Retriever] No graph or entry point — falling back to hierarchical",
    );
    return hierarchicalRetrieve(
      question,
      questionVector,
      workspaceRoot,
      topK,
      totalChunks,
    );
  }

  console.log(`[Retriever] Step 1 — Entry point: ${entryEntity.filePath}`);

  const importedFiles = expandImports(entryEntity, graphData, 2);
  importedFiles.add(entryEntity.filePath);

  console.log(
    `[Retriever] Step 2 — Import-expanded files (${importedFiles.size}):`,
  );
  importedFiles.forEach((f) => console.log(`  ${f}`));

  const candidateEntities: GraphEntity[] = [];
  for (const entity of Object.values(graphData.entities)) {
    if (!importedFiles.has(entity.filePath)) {
      continue;
    }
    if (entity.entityType === "module") {
      continue;
    }
    if (entity.entityType === "import") {
      continue;
    }
    candidateEntities.push(entity);
  }

  console.log(
    `[Retriever] Step 3 — Candidate symbols: ${candidateEntities.length}`,
  );

  const widePool = await search(questionVector, Math.min(topK * 8, 80));
  const candidateIds = new Set(candidateEntities.map((e) => e.id));
  const graphRanked = widePool.filter((r) => candidateIds.has(r.id));

  console.log(
    `[Retriever] Step 4 — Vector-ranked graph chunks: ${graphRanked.length}`,
  );

  const rankedIds = new Set(graphRanked.map((r) => r.id));
  const unranked = candidateEntities
    .filter((e) => !rankedIds.has(e.id))
    .map((e) => entityToSearchResult(e));

  const allRanked = [...graphRanked, ...unranked];
  const finalChunks = pickRepresentativeChunks(
    allRanked,
    importedFiles,
    topK + 2,
  );

  console.log("[Retriever] Final chunks:");
  finalChunks.forEach((c) =>
    console.log(
      `  ${c.filePath}:${c.startLine} [${c.entityType}: ${c.entityName}] score=${c.score.toFixed(3)}`,
    ),
  );

  const seedEntities = finalChunks.map(
    (c) => graphData.entities[c.id] ?? entityFromResult(c),
  );
  const graphContext = traverseGraph(seedEntities, graphData);

  return {
    question,
    chunks: finalChunks,
    totalIndexed: totalChunks,
    graphContext,
  };
}

const ENTRY_NAMES =
  /(?:^|\/)(?:main|index|app|server|cli|bootstrap|extension|manage)\.[^/]+$/i;

function findEntryPoint(graphData: GraphData | null): GraphEntity | null {
  if (!graphData) {
    return null;
  }

  for (const entity of Object.values(graphData.entities)) {
    if (entity.entityType === "module" && ENTRY_NAMES.test(entity.filePath)) {
      return entity;
    }
  }

  let best: GraphEntity | null = null;
  let bestCount = 0;

  for (const [id, adj] of Object.entries(graphData.adjacency)) {
    if (adj.contains.length > bestCount) {
      const entity = graphData.entities[id];
      if (entity?.entityType === "module") {
        best = entity;
        bestCount = adj.contains.length;
      }
    }
  }

  return best;
}

function expandImports(
  entryEntity: GraphEntity,
  graphData: GraphData,
  depth: number = 2,
): Set<string> {
  const visitedFiles = new Set<string>();
  let currentIds = [entryEntity.id];

  for (let d = 0; d < depth; d++) {
    const nextIds: string[] = [];

    for (const id of currentIds) {
      const adj = graphData.adjacency[id];
      if (!adj) {
        continue;
      }

      const neighbors = [...adj.imports, ...adj.calls];

      for (const neighborId of neighbors) {
        const neighbor = graphData.entities[neighborId];
        if (!neighbor) {
          continue;
        }
        if (!visitedFiles.has(neighbor.filePath)) {
          visitedFiles.add(neighbor.filePath);
          nextIds.push(neighborId);
        }
      }
    }

    currentIds = nextIds;
  }

  return visitedFiles;
}

function pickRepresentativeChunks(
  ranked: SearchResult[],
  targetFiles: Set<string>,
  limit: number,
): SearchResult[] {
  const seen = new Set<string>();
  const byFile = new Map<string, SearchResult>();
  const overflowBag: SearchResult[] = [];

  for (const r of ranked) {
    if (seen.has(r.id)) {
      continue;
    }
    seen.add(r.id);

    if (!byFile.has(r.filePath)) {
      byFile.set(r.filePath, r);
    } else {
      overflowBag.push(r);
    }
  }

  const representatives = [...byFile.values()].sort(
    (a, b) => b.score - a.score,
  );

  const extras = overflowBag
    .filter((r) => !seen.has(r.id))
    .sort((a, b) => b.score - a.score);

  return [...representatives, ...extras]
    .filter((c, i, arr) => arr.findIndex((x) => x.id === c.id) === i)
    .slice(0, limit);
}

async function hierarchicalRetrieve(
  question: string,
  questionVector: number[],
  workspaceRoot: string,
  topK: number,
  totalChunks: number,
): Promise<RetrievalContext> {
  console.log("[Retriever] Falling back to HIERARCHICAL strategy");

  const pool = await search(questionVector, 60);
  const ENTRY_BOOST = 0.2;

  const fileScores = new Map<string, number[]>();
  for (const r of pool) {
    if (!fileScores.has(r.filePath)) {
      fileScores.set(r.filePath, []);
    }
    fileScores.get(r.filePath)!.push(r.score);
  }

  const rankedFiles: { filePath: string; fileScore: number }[] = [];
  for (const [filePath, scores] of fileScores) {
    const top3 = [...scores].sort((a, b) => b - a).slice(0, 3);
    let fileScore =
      (top3.reduce((a, b) => a + b, 0) / top3.length) *
      Math.log(1 + scores.length);
    if (ENTRY_NAMES.test(filePath)) {
      fileScore += ENTRY_BOOST;
    }
    rankedFiles.push({ filePath, fileScore });
  }
  rankedFiles.sort((a, b) => b.fileScore - a.fileScore);

  const topFiles = rankedFiles.slice(0, topK);
  const finalChunks: SearchResult[] = [];

  for (const { filePath } of topFiles) {
    const fileChunks = [...pool]
      .filter((r) => r.filePath === filePath)
      .sort((a, b) => b.score - a.score);
    const symbols = fileChunks.filter((r) => r.entityType !== "module");
    const candidates = symbols.length > 0 ? symbols : fileChunks;
    finalChunks.push(...candidates.slice(0, 2));
  }

  const allChunks = finalChunks
    .filter((c, i, arr) => arr.findIndex((x) => x.id === c.id) === i)
    .slice(0, topK + 2);

  const graphData = loadGraph(workspaceRoot);
  let graphContext: GraphContext | undefined;

  if (graphData) {
    const seeds = allChunks.map(
      (c) => graphData.entities[c.id] ?? entityFromResult(c),
    );
    graphContext = traverseGraph(seeds, graphData);
  }

  return {
    question,
    chunks: allChunks,
    totalIndexed: totalChunks,
    graphContext,
  };
}

function entityFromResult(r: SearchResult): GraphEntity {
  return {
    id: r.id,
    filePath: r.filePath,
    entityType: (r.entityType as any) || "module",
    entityName: r.entityName || r.filePath,
    startLine: r.startLine,
    endLine: r.endLine,
    content: r.content,
  };
}

function entityToSearchResult(e: GraphEntity): SearchResult {
  return {
    id: e.id,
    filePath: e.filePath,
    entityType: e.entityType,
    entityName: e.entityName,
    startLine: e.startLine,
    endLine: e.endLine,
    content: e.content,
    score: 0,
  };
}

export function formatContextForPrompt(context: RetrievalContext): string {
  if (context.chunks.length === 0) {
    return "No relevant code found in the index for this question.";
  }
  return context.chunks
    .map((chunk, i) => {
      const relevance = Math.round(chunk.score * 100);
      const entityTag =
        chunk.entityType && chunk.entityName
          ? `  |  ${chunk.entityType}: ${chunk.entityName}`
          : "";
      return [
        `=== RELEVANT CODE [${i + 1}/${context.chunks.length}] ===`,
        `File: ${chunk.filePath}  |  Lines: ${chunk.startLine}-${chunk.endLine}${entityTag}  |  Relevance: ${relevance}%`,
        "─".repeat(50),
        chunk.content,
      ].join("\n");
    })
    .join("\n\n");
}
