import * as fs from 'fs';
import * as path from 'path';
import { GraphEntity, EntityType } from './types';

interface EntityMatch {
  entityType: EntityType;
  entityName: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface ExtractResult {
  entities: GraphEntity[];
  fileModule: GraphEntity;
}

function getExt(absolutePath: string): string {
  return path.extname(absolutePath).toLowerCase();
}

function parseImportsPy(lines: string[], relativePath: string): EntityMatch[] {
  const result: EntityMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const match =
      trimmed.match(/^from\s+(\S+)\s+import\s+(.+)/) ||
      trimmed.match(/^import\s+(\S+)/);
    if (match) {
      const name = match[1] + (match[2] ? ' -> ' + match[2] : '');
      result.push({
        entityType: 'import',
        entityName: name,
        startLine: i + 1,
        endLine: i + 1,
        content: line,
      });
    }
  }
  return result;
}

function parseImportsTs(lines: string[], relativePath: string): EntityMatch[] {
  const result: EntityMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const match =
      trimmed.match(/^import\s+(?:\{[^}]*\}\s+from\s+)?['"]([^'"]+)['"]/) ||
      trimmed.match(/^import\s+(\S+)\s+from\s+['"]([^'"]+)['"]/) ||
      trimmed.match(/^import\s+['"]([^'"]+)['"]/);
    if (match) {
      const name = match[1] || match[2] || '';
      result.push({
        entityType: 'import',
        entityName: name,
        startLine: i + 1,
        endLine: i + 1,
        content: line,
      });
    }
  }
  return result;
}

function parseImportsGo(lines: string[], relativePath: string): EntityMatch[] {
  const result: EntityMatch[] = [];
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('import (')) { inBlock = true; continue; }
    if (inBlock && trimmed === ')') { inBlock = false; continue; }
    if (inBlock) {
      const match = trimmed.match(/^"([^"]+)"$/);
      if (match) {
        result.push({
          entityType: 'import',
          entityName: match[1],
          startLine: i + 1,
          endLine: i + 1,
          content: line,
        });
      }
      continue;
    }
    const single = trimmed.match(/^import\s+"([^"]+)"/);
    if (single) {
      result.push({
        entityType: 'import',
        entityName: single[1],
        startLine: i + 1,
        endLine: i + 1,
        content: line,
      });
    }
  }
  return result;
}

function parseImportsRust(lines: string[], relativePath: string): EntityMatch[] {
  const result: EntityMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const match = trimmed.match(/^use\s+([^;]+);/);
    if (match) {
      result.push({
        entityType: 'import',
        entityName: match[1],
        startLine: i + 1,
        endLine: i + 1,
        content: line,
      });
    }
  }
  return result;
}

function parseImportsJava(lines: string[], relativePath: string): EntityMatch[] {
  const result: EntityMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const match = trimmed.match(/^import\s+(?:static\s+)?([^;]+);/);
    if (match) {
      result.push({
        entityType: 'import',
        entityName: match[1],
        startLine: i + 1,
        endLine: i + 1,
        content: line,
      });
    }
  }
  return result;
}

function findBlockEnd(
  lines: string[],
  startIdx: number,
  openDelim: string = '{',
  closeDelim: string = '}'
): number {
  let depth = 0;
  let started = false;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === openDelim) { depth++; started = true; }
      else if (ch === closeDelim) { depth--; }
    }
    if (started && depth <= 0) { return i + 1; }
  }
  return lines.length;
}

function findIndentBlockEnd(lines: string[], startIdx: number, baseIndent: number): number {
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].trim().length === 0) { continue; }
    const indent = lines[i].search(/\S/);
    if (indent <= baseIndent) { return i; }
  }
  return lines.length;
}

const FUNC_PATTERNS: [RegExp, number, string][] = [
  [/^\s*def\s+(\w+)\s*\(/, 1, 'function'],
  [/^\s*async\s+def\s+(\w+)\s*\(/, 1, 'function'],
  [/^\s*(?:export\s+)?(?:default\s+)?function\s*\*?\s*(\w+)\s*\(/, 1, 'function'],
  [/^\s*(?:export\s+)?(?:default\s+)?async\s+function\s+(\w+)\s*\(/, 1, 'function'],
  [/^\s*(?:private|public|protected|internal)?\s*(?:static\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)\s*{/, 1, 'function'],
  [/^\s*func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/, 1, 'function'],
  [/^\s*fn\s+(\w+)\s*[<(]/, 1, 'function'],
  [/^\s*(?:pub\s+)?fn\s+(\w+)\s*[<(]/, 1, 'function'],
  [/^\s*(?:public|private|protected)\s+(?:static\s+)?(?:async\s+)?(\w+)\s*\(/, 1, 'function'],
  [/^\s*(?:public|private|protected)\s+(?:static\s+)?(?:function\s+)?(\w+)\s*\(/, 1, 'function'],
];

const CLASS_PATTERNS: [RegExp, number, string][] = [
  [/^\s*class\s+(\w+)/, 1, 'class'],
  [/^\s*(?:export\s+)?(?:default\s+)?class\s+(\w+)/, 1, 'class'],
  [/^\s*(?:abstract\s+)?class\s+(\w+)/, 1, 'class'],
  [/^\s*type\s+(\w+)\s+struct/, 1, 'class'],
  [/^\s*type\s+(\w+)\s+interface/, 1, 'class'],
  [/^\s*(?:pub\s+)?struct\s+(\w+)/, 1, 'class'],
  [/^\s*(?:pub\s+)?enum\s+(\w+)/, 1, 'class'],
  [/^\s*(?:pub\s+)?trait\s+(\w+)/, 1, 'class'],
  [/^\s*(?:pub\s+)?impl\s+(\w+)/, 1, 'class'],
  [/^\s*interface\s+(\w+)/, 1, 'class'],
];

const METHOD_PATTERNS: [RegExp, number][] = [
  [/^\s*(\w+)\s*\([^)]*\)\s*{/, 1],
  [/^\s*(\w+)\s*\([^)]*\)\s*->/, 1],
  [/^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*{/, 1],
];

function parseEntities(lines: string[], relativePath: string, ext: string): EntityMatch[] {
  const entities: EntityMatch[] = [];

  const isPy = ext === '.py';
  const isTsLike = ['.ts', '.tsx', '.js', '.jsx'].includes(ext);
  const isGo = ext === '.go';
  const isRust = ext === '.rs';
  const isJavaLike = ['.java', '.cs', '.cpp', '.c', '.h'].includes(ext);

  let imports: EntityMatch[] = [];
  if (isPy) imports = parseImportsPy(lines, relativePath);
  else if (isTsLike) imports = parseImportsTs(lines, relativePath);
  else if (isGo) imports = parseImportsGo(lines, relativePath);
  else if (isRust) imports = parseImportsRust(lines, relativePath);
  else if (isJavaLike) imports = parseImportsJava(lines, relativePath);
  entities.push(...imports);

  const allPatterns: [RegExp, number, EntityType][] = [
    ...FUNC_PATTERNS.map(p => [p[0], p[1], p[2] as EntityType] as [RegExp, number, EntityType]),
    ...CLASS_PATTERNS.map(p => [p[0], p[1], p[2] as EntityType] as [RegExp, number, EntityType]),
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const [pattern, nameGroup, entityType] of allPatterns) {
      const match = line.match(pattern);
      if (!match) { continue; }
      const name = match[nameGroup];

      let endLine: number;
      const hasBrace = line.includes('{');
      if (isPy) {
        const baseIndent = line.search(/\S/);
        endLine = findIndentBlockEnd(lines, i, baseIndent);
      } else if (isGo) {
        endLine = findBlockEnd(lines, i, '{', '}');
      } else if (hasBrace) {
        endLine = findBlockEnd(lines, i, '{', '}');
      } else {
        endLine = i + 1;
      }

      if (entityType === 'class' && isTsLike) {
        const classLines = lines.slice(i, endLine);
        const methods = extractClassMethods(classLines, i);
        for (const method of methods) {
          const methodEntity: EntityMatch = {
            entityType: 'function',
            entityName: method.name,
            startLine: method.startLine,
            endLine: method.endLine,
            content: lines.slice(method.startLine - 1, method.endLine).join('\n'),
          };
          entities.push(methodEntity);
        }
      }

      entities.push({
        entityType,
        entityName: name,
        startLine: i + 1,
        endLine: Math.max(i + 1, endLine),
        content: lines.slice(i, endLine).join('\n'),
      });
      break;
    }
  }

  return entities;
}

function extractClassMethods(classLines: string[], fileStartLine: number): { name: string; startLine: number; endLine: number }[] {
  const methods: { name: string; startLine: number; endLine: number }[] = [];
  for (let i = 0; i < classLines.length; i++) {
    const line = classLines[i];
    for (const [pattern, nameGroup] of METHOD_PATTERNS) {
      const match = line.match(pattern);
      if (!match) { continue; }
      const name = match[nameGroup];
      if (['if', 'while', 'for', 'switch', 'catch', 'else', 'return'].includes(name)) { continue; }
      const absLine = fileStartLine + i + 1;
      const endLine = findBlockEnd(classLines, i, '{', '}');
      methods.push({ name, startLine: absLine, endLine: fileStartLine + endLine });
    }
  }
  return methods;
}

export function extractEntities(absolutePath: string, workspaceRoot: string): ExtractResult {
  let content: string;
  try {
    content = fs.readFileSync(absolutePath, 'utf-8');
  } catch {
    return { entities: [], fileModule: null as any };
  }

  const lines = content.split('\n');
  const relativePath = path.relative(workspaceRoot, absolutePath);
  const ext = getExt(absolutePath);
  const fileName = path.basename(absolutePath);

  const fileModule: GraphEntity = {
    id: `${relativePath}:module`,
    filePath: relativePath,
    entityType: 'module',
    entityName: fileName,
    startLine: 1,
    endLine: lines.length,
    content: content,
  };

  const matches = parseEntities(lines, relativePath, ext);
  const entities: GraphEntity[] = matches
    .filter(m => {
      if (m.entityType === 'function' && m.content.length < 10) { return false; }
      if (m.entityType === 'class' && m.content.length < 10) { return false; }
      return true;
    })
    .map(m => ({
      id: `${relativePath}:${m.startLine}`,
      filePath: relativePath,
      entityType: m.entityType,
      entityName: m.entityName,
      startLine: m.startLine,
      endLine: m.endLine,
      content: m.content,
    }));

  return { entities, fileModule };
}

export function buildEmbedText(
  entity: GraphEntity,
  maxChars: number = 800
): string {
  const full = `Entity: ${entity.entityType}:${entity.entityName}\nFile: ${entity.filePath}\nLines: ${entity.startLine}-${entity.endLine}\n\n${entity.content}`;
  if (full.length <= maxChars) { return full; }
  return full.slice(0, maxChars) + '\n... [truncated]';
}
