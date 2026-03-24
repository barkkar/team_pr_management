/**
 * Claude AI Client
 *
 * Shared Anthropic Claude client for all LLM chat/generation tasks.
 * Replaces Ollama for text generation while Ollama remains for embeddings.
 */

import Anthropic from '@anthropic-ai/sdk';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    if (!ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }
    anthropicClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

// ---------------------------------------------------------------------------
// Main chat interface
// ---------------------------------------------------------------------------

export interface ClaudeChatOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

/**
 * Send a chat request to Claude and return the text response.
 *
 * @param systemPrompt - System-level instructions (optional)
 * @param userPrompt - The user message content
 * @param options - temperature, maxTokens, jsonMode
 * @returns The text content from Claude's response
 */
export async function claudeChat(
  systemPrompt: string | undefined,
  userPrompt: string,
  options: ClaudeChatOptions = {},
): Promise<string> {
  const client = getClient();

  const {
    temperature = 0.3,
    maxTokens = 4096,
    jsonMode = false,
  } = options;

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userPrompt },
  ];

  // For JSON mode, use a prefill to guide Claude to output JSON
  if (jsonMode) {
    messages.push({ role: 'assistant', content: '{' });
  }

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    temperature,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    messages,
  });

  // Extract text from the response content blocks
  let text = '';
  for (const block of response.content) {
    if (block.type === 'text') {
      text += block.text;
    }
  }

  // If we used JSON prefill, prepend the opening brace back
  if (jsonMode) {
    text = '{' + text;
  }

  return text.trim();
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * Check if the Claude API is reachable and the API key is valid.
 */
export async function checkClaudeHealth(): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await claudeChat(
      undefined,
      'Respond with exactly: ok',
      { maxTokens: 10, temperature: 0 },
    );
    return { ok: response.toLowerCase().includes('ok') };
  } catch (error: any) {
    return { ok: false, error: error.message };
  }
}

/**
 * Get the configured Claude model name.
 */
export function getClaudeModel(): string {
  return CLAUDE_MODEL;
}
