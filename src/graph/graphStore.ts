import * as fs from 'fs';
import * as path from 'path';
import { GraphEntity, GraphEdge, AdjacencyMap, GraphData } from './types';

function getGraphPath(workspaceRoot: string): string {
  const dbPath = path.join(workspaceRoot, '.codeweave-index');
  return path.join(dbPath, 'graph.json');
}

export function saveGraph(
  workspaceRoot: string,
  entities: GraphEntity[],
  edges: GraphEdge[],
  adjacency: AdjacencyMap
): void {
  const graphPath = getGraphPath(workspaceRoot);
  const dir = path.dirname(graphPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const entityMap: { [id: string]: GraphEntity } = {};
  for (const e of entities) {
    entityMap[e.id] = e;
  }

  const data: GraphData = { entities: entityMap, adjacency };
  fs.writeFileSync(graphPath, JSON.stringify(data), 'utf-8');
}

export function loadGraph(workspaceRoot: string): GraphData | null {
  const graphPath = getGraphPath(workspaceRoot);
  if (!fs.existsSync(graphPath)) { return null; }
  try {
    const raw = fs.readFileSync(graphPath, 'utf-8');
    return JSON.parse(raw) as GraphData;
  } catch {
    return null;
  }
}

export function addEntitiesToGraph(
  workspaceRoot: string,
  newEntities: GraphEntity[],
  newEdges: GraphEdge[],
  newAdjacency: AdjacencyMap
): void {
  const existing = loadGraph(workspaceRoot);
  const entities: { [id: string]: GraphEntity } = existing?.entities || {};
  const adjacency: AdjacencyMap = existing?.adjacency || {};

  for (const e of newEntities) {
    entities[e.id] = e;
  }
  for (const [id, adj] of Object.entries(newAdjacency)) {
    if (!adjacency[id]) {
      adjacency[id] = { calls: [], imports: [], contains: [], contained_by: [], extends: [], extended_by: [] };
    }
    adjacency[id].calls.push(...adj.calls.filter(e => !adjacency[id].calls.includes(e)));
    adjacency[id].imports.push(...adj.imports.filter(e => !adjacency[id].imports.includes(e)));
    adjacency[id].contains.push(...adj.contains.filter(e => !adjacency[id].contains.includes(e)));
    adjacency[id].contained_by.push(...adj.contained_by.filter(e => !adjacency[id].contained_by.includes(e)));
    adjacency[id].extends.push(...adj.extends.filter(e => !adjacency[id].extends.includes(e)));
    adjacency[id].extended_by.push(...adj.extended_by.filter(e => !adjacency[id].extended_by.includes(e)));
  }

  const data: GraphData = { entities, adjacency };
  const graphPath = getGraphPath(workspaceRoot);
  const dir = path.dirname(graphPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(graphPath, JSON.stringify(data), 'utf-8');
}

export function removeFileEntities(workspaceRoot: string, filePath: string): void {
  const existing = loadGraph(workspaceRoot);
  if (!existing) { return; }

  const filePrefix = filePath.replace(/\\/g, '/');
  let changed = false;

  const entities = { ...existing.entities };
  for (const [id, entity] of Object.entries(entities)) {
    if (entity.filePath === filePrefix) {
      delete entities[id];
      changed = true;
    }
  }

  const adjacency: AdjacencyMap = {};
  for (const [id, adj] of Object.entries(existing.adjacency)) {
    if (id.startsWith(filePrefix + ':')) { continue; }
    adjacency[id] = {
      calls: adj.calls.filter(e => !!entities[e] && !e.startsWith(filePrefix + ':')),
      imports: adj.imports.filter(e => !!entities[e] && !e.startsWith(filePrefix + ':')),
      contains: adj.contains.filter(e => !!entities[e] && !e.startsWith(filePrefix + ':')),
      contained_by: adj.contained_by.filter(e => !!entities[e] && !e.startsWith(filePrefix + ':')),
      extends: adj.extends.filter(e => !!entities[e] && !e.startsWith(filePrefix + ':')),
      extended_by: adj.extended_by.filter(e => !!entities[e] && !e.startsWith(filePrefix + ':')),
    };
  }

  if (changed) {
    const data: GraphData = { entities, adjacency };
    fs.writeFileSync(getGraphPath(workspaceRoot), JSON.stringify(data), 'utf-8');
  }
}
