import { extractEntities, buildEmbedText as entityBuildEmbed } from '../graph/entityExtractor';
import { GraphEntity } from '../graph/types';

export interface RawChunk {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  entityType: string;
  entityName: string;
}

export interface ExtractionOutput {
  rawChunks: RawChunk[];
  entities: GraphEntity[];
}

export function extractFromFile(
  absolutePath: string,
  workspaceRoot: string
): ExtractionOutput {
  const result = extractEntities(absolutePath, workspaceRoot);

  const rawChunks: RawChunk[] = [];

  if (result.fileModule) {
    rawChunks.push({
      id: result.fileModule.id,
      filePath: result.fileModule.filePath,
      startLine: result.fileModule.startLine,
      endLine: result.fileModule.endLine,
      content: result.fileModule.content,
      entityType: result.fileModule.entityType,
      entityName: result.fileModule.entityName,
    });
  }

  for (const entity of result.entities) {
    rawChunks.push({
      id: entity.id,
      filePath: entity.filePath,
      startLine: entity.startLine,
      endLine: entity.endLine,
      content: entity.content,
      entityType: entity.entityType,
      entityName: entity.entityName,
    });
  }

  return { rawChunks, entities: result.entities };
}

export function chunkFile(
  absolutePath: string,
  workspaceRoot: string,
  _chunkSize?: number
): RawChunk[] {
  return extractFromFile(absolutePath, workspaceRoot).rawChunks;
}

export function buildEmbedText(
  rawChunk: RawChunk,
  maxChars: number = 800
): string {
  const entity: GraphEntity = {
    id: rawChunk.id,
    filePath: rawChunk.filePath,
    entityType: rawChunk.entityType as any,
    entityName: rawChunk.entityName,
    startLine: rawChunk.startLine,
    endLine: rawChunk.endLine,
    content: rawChunk.content,
  };
  return entityBuildEmbed(entity, maxChars);
}
