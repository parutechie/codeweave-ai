export type EntityType = 'function' | 'class' | 'import' | 'module';

export interface GraphEntity {
  id: string;
  filePath: string;
  entityType: EntityType;
  entityName: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface GraphEdge {
  sourceId: string;
  targetId: string;
  relationship: string;
}

export interface AdjacencyMap {
  [entityId: string]: {
    calls: string[];
    imports: string[];
    contains: string[];
    contained_by: string[];
    extends: string[];
    extended_by: string[];
  };
}

export interface GraphData {
  entities: { [id: string]: GraphEntity };
  adjacency: AdjacencyMap;
}

export interface GraphContext {
  seedEntities: GraphEntity[];
  relatedEntities: GraphEntity[];
}
