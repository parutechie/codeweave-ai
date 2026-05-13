import * as vscode from 'vscode';

function getConfig() {
  const config = vscode.workspace.getConfiguration('codeweave');
  return {
    ollamaUrl: config.get<string>('ollamaUrl') ?? 'http://localhost:11434',
    chatModel:  config.get<string>('chatModel')  ?? 'qwen2.5-coder:7b',
    embedModel: config.get<string>('embedModel') ?? 'mxbai-embed-large',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ping()
// Checks if Ollama is running by hitting the /api/tags endpoint.
// Returns true if Ollama responds, false if it's not running.
// We call this on startup so we can show a warning immediately.
// ─────────────────────────────────────────────────────────────────────────────
export async function ping(): Promise<boolean> {
  const { ollamaUrl } = getConfig();
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000), // give up after 3 seconds
    });
    return response.ok;
  } catch {
    // fetch throws if Ollama is not running (connection refused)
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getModels()
// Returns a list of all models currently pulled in Ollama.
// Useful for showing the user what's available.
// ─────────────────────────────────────────────────────────────────────────────
export async function getModels(): Promise<string[]> {
  const { ollamaUrl } = getConfig();
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`);
    const data = await response.json() as { models: { name: string }[] };
    return data.models.map(m => m.name);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// embed(text)
// Converts a string into a vector (array of numbers) using mxbai-embed-large.
// The vector captures the semantic meaning of the text.
// Two pieces of text with similar meaning will have similar vectors.
// This is called once per chunk during indexing, and once per question during retrieval.
// ─────────────────────────────────────────────────────────────────────────────
export async function embed(text: string): Promise<number[]> {
  const { ollamaUrl, embedModel } = getConfig();
  const safeText = text.length > 800 ? text.slice(0, 800) : text;
  const response = await fetch(`${ollamaUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: embedModel,
      prompt: safeText,   
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Ollama embed failed (${response.status}): ${error}`);
  }

  const data = await response.json() as { embedding: number[] };

  if (!data.embedding || data.embedding.length === 0) {
    throw new Error(`Ollama returned empty embedding. Is "${embedModel}" pulled?`);
  }

  return data.embedding;
}

// ─────────────────────────────────────────────────────────────────────────────
// chat(messages, onToken)
// Sends a conversation to Ollama and streams the response back.
// 
// messages: array of { role: 'system' | 'user' | 'assistant', content: string }
// onToken:  callback fired for each word/token as it streams in
//
// The streaming is what makes the UI feel like the AI is "typing".
// Without streaming you'd wait for the full response then show it all at once.
//
// Ollama streams newline-delimited JSON — each line is one token like:
//   {"message":{"content":"The"},"done":false}
//   {"message":{"content":" auth"},"done":false}
//   {"message":{"content":""},"done":true}
// ─────────────────────────────────────────────────────────────────────────────
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export async function chat(
  messages: Message[],
  onToken: (token: string) => void
): Promise<string> {
  const { ollamaUrl, chatModel } = getConfig();

  const response = await fetch(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: chatModel,
      stream: true,
      messages: messages,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Ollama chat failed (${response.status}): ${error}`);
  }

  if (!response.body) {
    throw new Error('Ollama returned no response body');
  }

  // Read the stream chunk by chunk
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullResponse = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) { break; }

    // Decode the raw bytes into a string and add to buffer
    buffer += decoder.decode(value, { stream: true });

    // Split on newlines — each line is one complete JSON object
    const lines = buffer.split('\n');

    // The last item might be an incomplete line — keep it in the buffer
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }

      try {
        const parsed = JSON.parse(trimmed) as {
          message?: { content: string };
          done: boolean;
        };

        const token = parsed.message?.content ?? '';
        if (token) {
          fullResponse += token;
          onToken(token); // fire the callback → UI updates in real time
        }

        if (parsed.done) { break; }

      } catch {
        // Incomplete JSON line — ignore, it'll be in the buffer next iteration
      }
    }
  }

  return fullResponse;
}