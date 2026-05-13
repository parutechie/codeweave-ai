import * as vscode from 'vscode';
import * as path from 'path';
import { walkDirectory, getWalkerConfig, getFileStats } from './walker';
import { extractFromFile, buildEmbedText, RawChunk } from './chunker';
import { embed } from '../ai/ollama';
import { initStore, addChunks, clearStore, ChunkRecord , deleteChunksForFile } from '../store/lancedb';
import { GraphEntity, GraphEdge, AdjacencyMap } from '../graph/types';
import { extractRelationships, buildAdjacency } from '../graph/relationshipExtractor';
import { saveGraph, addEntitiesToGraph, removeFileEntities } from '../graph/graphStore';
import { saveIndexMeta } from '../store/indexMeta';


export interface IndexingResult {
  totalFiles: number;
  totalChunks: number;
  skippedFiles: number;
  durationSeconds: number;
}

export async function indexWorkspace(workspaceRoot: string, options: { skipConfirm?: boolean } = {}): Promise<IndexingResult> {
  const config = vscode.workspace.getConfiguration('codeweave');
  const walkerConfig = getWalkerConfig();

  const stats = getFileStats(workspaceRoot, walkerConfig);

  if (stats.totalFiles === 0) {
    throw new Error(
      'No indexable files found. Check your "codeweave.includeExtensions" setting.'
    );
  }

  if (!options.skipConfirm) {
    const extSummary = Object.entries(stats.byExtension)
      .sort(([, a], [, b]) => b - a).slice(0, 5)
      .map(([ext, count]) => `${ext}(${count})`).join(', ');

    const answer = await vscode.window.showInformationMessage(
      `CodeWeave will index ${stats.totalFiles} files (${extSummary}).`,
      'Start Indexing', 'Cancel'
    );
    if (answer !== 'Start Indexing') {
      throw new Error('Indexing cancelled by user.');
    }
  }

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'CodeWeave: Indexing codebase',
      cancellable: true,
    },
    async (progress, cancellationToken) => {
      const startTime = Date.now();
      let totalChunks = 0;
      let skippedFiles = 0;

      progress.report({ message: 'Clearing old index...' });

      await clearStore();
      await initStore(workspaceRoot);

      progress.report({ message: 'Scanning files...' });

      const files = walkDirectory(workspaceRoot, walkerConfig);
      const totalFiles = files.length;

      console.log(`[Indexer] Starting: ${totalFiles} files to index`);

      const allGraphEntities: GraphEntity[] = [];
      const fileModules: GraphEntity[] = [];

      for (let i = 0; i < files.length; i++) {
        if (cancellationToken.isCancellationRequested) {
          console.log('[Indexer] Cancelled by user');
          break;
        }

        const absolutePath = files[i];
        const relativePath = path.relative(workspaceRoot, absolutePath);
        const percent = Math.round((i / totalFiles) * 100);

        progress.report({
          message:   `(${i + 1}/${totalFiles}) ${relativePath}`,
          increment: 100 / totalFiles,
        });

        const { rawChunks, entities } = extractFromFile(absolutePath, workspaceRoot);

        if (rawChunks.length === 0) {
          skippedFiles++;
          continue;
        }

        const records: ChunkRecord[] = [];

        for (const rawChunk of rawChunks) {
          if (cancellationToken.isCancellationRequested) { break; }

          if (rawChunk.entityType === 'module') {
            continue;
          }

          try {
            const embedText = buildEmbedText(rawChunk);
            const vector = await embed(embedText);

            records.push({
              id:         rawChunk.id,
              filePath:   rawChunk.filePath,
              startLine:  rawChunk.startLine,
              endLine:    rawChunk.endLine,
              content:    rawChunk.content,
              entityType: rawChunk.entityType,
              entityName: rawChunk.entityName,
              vector,
            });

          } catch (err) {
            console.warn(`[Indexer] Failed to embed ${rawChunk.id}: ${err}`);
          }
        }

        if (records.length > 0) {
          await addChunks(records);
          totalChunks += records.length;
        }

        allGraphEntities.push(...entities);
        const moduleEntity = rawChunks.find(c => c.entityType === 'module');
        if (moduleEntity) {
          fileModules.push({
            id: moduleEntity.id,
            filePath: moduleEntity.filePath,
            entityType: 'module',
            entityName: moduleEntity.entityName,
            startLine: moduleEntity.startLine,
            endLine: moduleEntity.endLine,
            content: moduleEntity.content,
          });
        }

        if (i % 10 === 0) {
          console.log(`[Indexer] ${percent}% — ${i + 1}/${totalFiles} files — ${totalChunks} chunks so far`);
        }
      }

      progress.report({ message: 'Building knowledge graph...' });

      const allEdges: GraphEdge[] = [];
      for (const moduleEnt of fileModules) {
        const fileEntities = allGraphEntities.filter(e => e.filePath === moduleEnt.filePath);
        const edges = extractRelationships(fileEntities, moduleEnt, allGraphEntities);
        allEdges.push(...edges);
      }

      const adjacency = buildAdjacency(allEdges);
      saveGraph(workspaceRoot, [...fileModules, ...allGraphEntities], allEdges, adjacency);

      const durationSeconds = (Date.now() - startTime) / 1000;

      console.log(`[Indexer] Done. ${totalFiles} files, ${totalChunks} chunks, ${allEdges.length} graph edges in ${durationSeconds.toFixed(1)}s`);

      saveIndexMeta(workspaceRoot, {
        lastIndexed: Date.now(),
        totalFiles,
        totalChunks,
      });

      return {
        totalFiles,
        totalChunks,
        skippedFiles,
        durationSeconds,
      };
    }
  );
}



export async function reindexFile(
  absolutePath: string,
  workspaceRoot: string
): Promise<number> {
  const config = vscode.workspace.getConfiguration('codeweave');
  const relativePath = path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/');

  removeFileEntities(workspaceRoot, relativePath);

  await deleteChunksForFile(relativePath);

  const { rawChunks, entities } = extractFromFile(absolutePath, workspaceRoot);

  if (rawChunks.length === 0) { return 0; }

  const records: ChunkRecord[] = [];
  for (const raw of rawChunks) {
      if (raw.entityType === 'module') {
        continue;
      }
    try {
      const vector = await embed(buildEmbedText(raw));
      records.push({
        id: raw.id,
        filePath: raw.filePath,
        startLine: raw.startLine,
        endLine: raw.endLine,
        content: raw.content,
        entityType: raw.entityType,
        entityName: raw.entityName,
        vector,
      });
    } catch {
      // skip chunks that fail to embed
    }
  }

  if (records.length > 0) { await addChunks(records); }

  const graphData = await import('../graph/graphStore');
  const { extractRelationships, buildAdjacency } = await import('../graph/relationshipExtractor');
  const fileModule = rawChunks.find(c => c.entityType === 'module');
  if (fileModule && entities.length > 0) {
    const moduleEntity: GraphEntity = {
      id: fileModule.id,
      filePath: fileModule.filePath,
      entityType: 'module',
      entityName: fileModule.entityName,
      startLine: fileModule.startLine,
      endLine: fileModule.endLine,
      content: fileModule.content,
    };
    const edges = extractRelationships(entities, moduleEntity, []);
    const adjacency = buildAdjacency(edges);
    graphData.addEntitiesToGraph(workspaceRoot, [moduleEntity, ...entities], edges, adjacency);
  }

  return records.length;
}
