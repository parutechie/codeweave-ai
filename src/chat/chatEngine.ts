import { retrieve, RetrievalContext } from '../retriever/retriever';
import { buildUserMessage, getSystemPrompt, estimatePromptSize } from './promptBuilder';
import { chat, ping, Message } from '../ai/ollama';

export interface HistoryEntry {
  question: string;
  answer:   string;
}

export interface AskOptions {
  question:       string;
  workspaceRoot:  string;
  history?:       HistoryEntry[];
  onToken:        (token: string) => void;
  onSources:      (ctx: RetrievalContext) => void;
  onError:        (err: string) => void;
}

export async function ask(options: AskOptions): Promise<void> {
  const { question, workspaceRoot, onToken, onSources, onError } = options;

  const alive = await ping();
  if (!alive) {
    onError('Ollama is not running. Start it with: ollama serve');
    return;
  }

  let context: RetrievalContext;
  try {
    context = await retrieve(question, workspaceRoot);
  } catch (err) {
    onError(`Retrieval failed: ${err}`);
    return;
  }

  onSources(context);

  if (context.chunks.length === 0) {
    onToken('No relevant code was found in your index for this question. Try re-indexing your codebase or rephrasing the question.');
    return;
  }

  const systemPrompt = getSystemPrompt();
  const userMessage  = buildUserMessage(context);

  const estimatedTokens = estimatePromptSize(context);
  console.log(`[ChatEngine] Prompt size: ~${estimatedTokens} tokens`);
  console.log(`[ChatEngine] Sources: ${context.chunks.map(c => c.filePath).join(', ')}`);
  if (context.graphContext) {
    console.log(`[ChatEngine] Graph: ${context.graphContext.seedEntities.length} seeds → ${context.graphContext.relatedEntities.length} related`);
  }

  if (estimatedTokens > 3000) {
    console.warn(`[ChatEngine] Large prompt (${estimatedTokens} tokens) — consider reducing topK`);
  }

  try {
    const historyMessages: Message[] = [];
    if (options.history && options.history.length > 0) {
      const recent = options.history.slice(-3);
      for (const entry of recent) {
        historyMessages.push({ role: 'user',      content: entry.question });
        historyMessages.push({ role: 'assistant', content: entry.answer   });
      }
    }

    await chat(
      [
        { role: 'system', content: systemPrompt },
        ...historyMessages,
        { role: 'user',   content: userMessage  },
      ],
      onToken
    );
  } catch (err) {
    onError(`LLM failed: ${err}`);
  }
}
