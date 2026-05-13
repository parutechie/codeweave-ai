import { RetrievalContext } from '../retriever/retriever';

const SYSTEM_PROMPT = `You are CodeWeave AI, an expert code assistant embedded in VS Code.

You have been given relevant code snippets retrieved from the user's codebase.

Rules:
1. Base your answer on the provided code snippets. Reference file paths and line numbers.
2. Always include the relevant code snippet in your answer using triple backtick code blocks.
3. If a function or class is relevant, show its full body from the context provided.
4. For broad questions like "explain the project", describe each major module and how they connect.
5. If something genuinely is not in the provided context, say so — but first check all snippets carefully.
6. Use the knowledge graph relationships to explain how components connect.
7. Do not invent code. Do not omit code that was given to you in the context.
8. If you do not have the implementation of a function in your context, say
   "I can see it is called but its implementation was not retrieved — try asking
   specifically about _send or notifier.py". Never write a placeholder body.
9. The "File:", "Lines:", "Relevance:" headers in the context are metadata for 
   your reference only. Never repeat them verbatim in your answer. Reference 
   files like this instead: "In notifier.py (lines 40-43), notify_hold does..."
10. When you receive a folder structure tree, render it as-is in a code block and 
    then explain each top-level folder and key files in 1-2 sentences each.
11. CRITICAL — Folder structure queries: the tree was built by reading the real 
    filesystem. Do NOT invent files or folders. If the tree only shows 3 files, 
    that is accurate — do not fabricate any. Never guess or hallucinate a 
    "standard" project layout.`;

export function buildUserMessage(context: RetrievalContext): string {
  const lines: string[] = [];

  lines.push('CODEBASE CONTEXT');
  lines.push('─'.repeat(50));
  lines.push('');

  if (context.chunks.length === 0) {
    lines.push('No relevant code was found for this question.');
  } else {
    context.chunks.forEach((chunk, i) => {
      const relevance = Math.round(chunk.score * 100);
      const entityTag = chunk.entityType && chunk.entityName
        ? ` [${chunk.entityType}: ${chunk.entityName}]`
        : '';
      lines.push(`[${i + 1}] File: ${chunk.filePath} | Lines ${chunk.startLine}-${chunk.endLine}${entityTag} | Relevance: ${relevance}%`);
      lines.push('');
      lines.push(chunk.content);
      lines.push('');
      if (i < context.chunks.length - 1) {
        lines.push('─'.repeat(30));
        lines.push('');
      }
    });
  }

  if (context.graphContext && context.graphContext.relatedEntities.length > 0) {
    lines.push('');
    lines.push('='.repeat(50));
    lines.push('KNOWLEDGE GRAPH — RELATED CODE');
    lines.push('='.repeat(50));
    lines.push('');

    const seeds = context.graphContext.seedEntities;
    if (seeds.length > 0) {
      lines.push('Seed entities (directly matched):');
      for (const s of seeds) {
        lines.push(`  • ${s.entityType}: ${s.entityName} (${s.filePath}:${s.startLine})`);
      }
      lines.push('');
    }

    const seen = new Set(context.chunks.map(c => c.id));
    const related = context.graphContext.relatedEntities.filter(e => !seen.has(e.id));
    if (related.length > 0) {
      lines.push('Related entities (via graph traversal — calls, extends, contains):');
      for (const r of related.slice(0, 15)) {
        const snippet = r.content.split('\n')[0].trim().slice(0, 80);
        lines.push(`  • ${r.entityType}: ${r.entityName} (${r.filePath}:${r.startLine})`);
        lines.push(`    ${snippet}...`);
      }
      if (related.length > 15) {
        lines.push(`  ... and ${related.length - 15} more related entities`);
      }
    }
  }

  lines.push('');
  lines.push('─'.repeat(50));
  lines.push('');
  lines.push(`QUESTION: ${context.question}`);

  return lines.join('\n');
}

export function getSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

export function estimatePromptSize(context: RetrievalContext): number {
  const userMsg = buildUserMessage(context);
  const totalChars = SYSTEM_PROMPT.length + userMsg.length;
  return Math.round(totalChars / 3.5);
}
