export interface ParsedQuestion {
  cleanQuestion: string;
  mentionedFiles: string[];
  mentionedSymbols: string[];
}

export function parseMentions(question: string): ParsedQuestion {
  const mentionedFiles: string[] = [];
  const mentionedSymbols: string[] = [];

  // Match @filename.ext or @path/to/file.ext
  const fileRegex = /@([\w./\-]+\.\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = fileRegex.exec(question)) !== null) {
    mentionedFiles.push(match[1]);
  }

  // Match @FunctionName or @ClassName (CamelCase or camelCase, no extension)
  const symbolRegex = /@([A-Za-z_]\w+)(?!\.\w)/g;
  while ((match = symbolRegex.exec(question)) !== null) {
    if (!mentionedFiles.some((f) => f.includes(match![1]))) {
      mentionedSymbols.push(match[1]);
    }
  }

  // Remove @mentions from the question before embedding
  const cleanQuestion = question.replace(/@[\w./\-]+/g, "").trim();

  return { cleanQuestion, mentionedFiles, mentionedSymbols };
}
