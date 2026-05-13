import { GraphEntity, AdjacencyMap, GraphEdge } from './types';

const BUILTIN_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'switch', 'case', 'return', 'break',
  'continue', 'try', 'catch', 'finally', 'throw', 'new', 'delete',
  'typeof', 'instanceof', 'void', 'this', 'super', 'yield', 'await',
  'async', 'function', 'var', 'let', 'const', 'class', 'import',
  'export', 'from', 'of', 'in', 'with', 'debugger',
  'def', 'class', 'import', 'from', 'as', 'pass', 'lambda',
  'if', 'elif', 'else', 'for', 'while', 'break', 'continue',
  'try', 'except', 'finally', 'raise', 'with', 'yield', 'return',
  'and', 'or', 'not', 'is', 'in', 'True', 'False', 'None',
  'print', 'len', 'range', 'int', 'str', 'float', 'list', 'dict', 'set', 'tuple',
  'func', 'defer', 'go', 'select', 'chan', 'map', 'range',
  'let', 'mut', 'fn', 'impl', 'struct', 'enum', 'trait', 'use', 'mod',
  'pub', 'self', 'Self', 'Some', 'None', 'Ok', 'Err', 'match',
  'public', 'private', 'protected', 'static', 'void', 'int',
  'String', 'boolean', 'number', 'string', 'object', 'Array',
  'console', 'describe', 'it', 'expect', 'test',
  'require', 'define', 'process', 'module', 'exports',
  'JSON', 'Math', 'Date', 'RegExp', 'Error', 'Promise',
  'Set', 'Map', 'WeakSet', 'WeakMap', 'Symbol', 'Reflect', 'Proxy',
  'document', 'window', 'global', 'globalThis',
  'undefined', 'null', 'true', 'false',
]);

export function extractRelationships(
  entities: GraphEntity[],
  fileModule: GraphEntity,
  allEntities: GraphEntity[]
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const entityById = new Map<string, GraphEntity>();
  const entityByName = new Map<string, GraphEntity[]>();
  const idSet = new Set<string>();

  for (const e of entities) {
    entityById.set(e.id, e);
    idSet.add(e.id);
  }
  if (fileModule) {
    entityById.set(fileModule.id, fileModule);
    idSet.add(fileModule.id);
  }

  for (const e of entities) {
    const key = e.entityName.toLowerCase();
    if (!entityByName.has(key)) { entityByName.set(key, []); }
    entityByName.get(key)!.push(e);
  }

  for (const e of allEntities) {
    const key = e.entityName.toLowerCase();
    if (!entityByName.has(key)) { entityByName.set(key, []); }
    entityByName.get(key)!.push(e);
  }

  for (const e of entities) {
    const body = e.content;

    const callNames = extractCallNames(body);
    for (const callName of callNames) {
      const callees = entityByName.get(callName.toLowerCase());
      if (callees) {
        for (const callee of callees) {
          if (callee.id === e.id) { continue; }
          edges.push({
            sourceId: e.id,
            targetId: callee.id,
            relationship: 'calls',
          });
        }
      }
    }
  }

  for (const e of entities) {
    if (e.entityType !== 'class') { continue; }
    const extendMatch = e.content.match(
      /(?:extends|inherits|:)\s*(\w+)/i
    );
    if (extendMatch) {
      const parentName = extendMatch[1];
      const parents = entityByName.get(parentName.toLowerCase());
      if (parents) {
        for (const parent of parents) {
          edges.push({
            sourceId: e.id,
            targetId: parent.id,
            relationship: 'extends',
          });
        }
      }
    }
  }

  // ── Import edges: file → file ────────────────────────────
const importEntities = entities.filter(e => e.entityType === 'import');

for (const importEnt of importEntities) {
  // importName might be "../../store/lancedb" or "lodash" etc.
  const rawName = importEnt.entityName.split(' -> ')[0].trim(); // handle "from X -> { y }"
  const baseName = rawName.split('/').pop()?.replace(/['"]/g, '') ?? '';

  if (!baseName || baseName.length < 2) { continue; }

  // Find a module entity whose filePath ends with this name
  const targetModules = allEntities.filter(e =>
    e.entityType === 'module' &&
    (
      e.filePath.endsWith(`/${baseName}.ts`) ||
      e.filePath.endsWith(`/${baseName}.js`) ||
      e.filePath.endsWith(`/${baseName}.py`) ||
      e.filePath.endsWith(`/${baseName}/index.ts`) ||
      e.filePath.endsWith(`/${baseName}/index.js`)
    )
  );

  for (const target of targetModules) {
    if (target.id === fileModule.id) { continue; } // no self-loops
    edges.push({
      sourceId: fileModule.id,
      targetId: target.id,
      relationship: 'imports',
    });
  }
}

  for (const e of entities) {
    if (fileModule) {
      edges.push({
        sourceId: fileModule.id,
        targetId: e.id,
        relationship: 'contains',
      });
    }
  }

  return edges;
}

function extractCallNames(body: string): string[] {
  const names = new Set<string>();
  const regex = /([a-zA-Z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    const name = match[1];
    if (
      name.length >= 2 &&
      !BUILTIN_KEYWORDS.has(name) &&
      name.toUpperCase() !== name
    ) {
      names.add(name);
    }
  }
  return Array.from(names);
}

export function buildAdjacency(edges: GraphEdge[]): AdjacencyMap {
  const adj: AdjacencyMap = {};

  for (const edge of edges) {
    if (!adj[edge.sourceId]) {
      adj[edge.sourceId] = { calls: [], imports: [], contains: [], contained_by: [], extends: [], extended_by: [] };
    }
    if (!adj[edge.targetId]) {
      adj[edge.targetId] = { calls: [], imports: [], contains: [], contained_by: [], extends: [], extended_by: [] };
    }

    switch (edge.relationship) {
      case 'calls':
        adj[edge.sourceId].calls.push(edge.targetId);
        break;
      case 'contains':
        adj[edge.sourceId].contains.push(edge.targetId);
        adj[edge.targetId].contained_by.push(edge.sourceId);
        break;
      case 'extends':
        adj[edge.sourceId].extends.push(edge.targetId);
        if (adj[edge.targetId]) {
          adj[edge.targetId].extended_by.push(edge.sourceId);
        }
        break;
      case 'imports':
        adj[edge.sourceId].imports.push(edge.targetId);
        break;
    }
  }

  return adj;
}
