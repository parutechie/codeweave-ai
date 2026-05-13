import { GraphData, GraphEntity, GraphContext } from './types';

const MAX_DEPTH = 2;

export function traverseGraph(
  seedEntities: GraphEntity[],
  graph: GraphData,
  maxDepth: number = MAX_DEPTH
): GraphContext {
  const visited = new Set<string>();
  const collected = new Map<string, GraphEntity>();

  for (const seed of seedEntities) {
    collected.set(seed.id, seed);
  }

  let currentLayer: string[] = seedEntities.map(e => e.id);
  for (let depth = 0; depth < maxDepth && currentLayer.length > 0; depth++) {
    const nextLayer: string[] = [];

    for (const entityId of currentLayer) {
      if (visited.has(entityId)) { continue; }
      visited.add(entityId);

      const adj = graph.adjacency[entityId];
      if (!adj) { continue; }

      const neighborIds = [
        ...adj.calls,
        ...adj.extends,
        ...adj.extended_by,
      ];

      for (const neighborId of neighborIds) {
        if (visited.has(neighborId)) { continue; }
        const neighbor = graph.entities[neighborId];
        if (neighbor) {
          collected.set(neighborId, neighbor);
          nextLayer.push(neighborId);
        }
      }
    }

    currentLayer = nextLayer;
  }

  const seedSet = new Set(seedEntities.map(e => e.id));
  const related: GraphEntity[] = [];

  for (const entity of collected.values()) {
    if (!seedSet.has(entity.id)) {
      related.push(entity);
    }
  }

  return {
    seedEntities,
    relatedEntities: related,
  };
}
