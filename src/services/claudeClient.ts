/**
 * Claude AI Client
 *
 * Shared Anthropic Claude client for all LLM chat/generation tasks.
 * Replaces Ollama for text generation while Ollama remains for embeddings.
 *
 * Supports two modes:
 *   1. Bedrock proxy (preferred) — raw HTTP to /model/{id}/invoke
 *   2. Direct Anthropic API — via @anthropic-ai/sdk
 */

import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';

// Bedrock proxy (preferred — used by internal Salesforce gateway)
const BEDROCK_BASE_URL = process.env.ANTHROPIC_BEDROCK_BASE_URL;
const AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
// Direct Anthropic API (fallback)
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022';

const USE_BEDROCK = !!(BEDROCK_BASE_URL && AUTH_TOKEN);

let anthropicClient: Anthropic | null = null;

function getDirectClient(): Anthropic {
  if (!anthropicClient) {
    if (!ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required for direct API mode');
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
 * Send a chat request via Bedrock proxy (raw HTTP to invoke-model endpoint).
 */
async function bedrockChat(
  systemPrompt: string | undefined,
  userPrompt: string,
  options: ClaudeChatOptions,
): Promise<string> {
  const {
    temperature = 0.3,
    maxTokens = 4096,
    jsonMode = false,
  } = options;

  const effectiveUserPrompt = jsonMode
    ? userPrompt + '\n\nIMPORTANT: Respond with valid JSON only. No markdown, no explanation, no code fences.'
    : userPrompt;

  const messages: any[] = [
    { role: 'user', content: effectiveUserPrompt },
  ];

  const body: any = {
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    temperature,
    messages,
  };
  if (systemPrompt) {
    body.system = systemPrompt;
  }

  // The gateway exposes the standard Anthropic messages API at /v1/messages
  // Strip any trailing path like /bedrock from the base URL
  const baseUrl = BEDROCK_BASE_URL!.replace(/\/bedrock\/?$/, '');
  const url = `${baseUrl}/v1/messages`;
  let data: any;
  try {
    const response = await axios.post(url, body, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': AUTH_TOKEN!,
        'anthropic-version': '2023-06-01',
      },
      timeout: 120000,
    });
    data = response.data;
  } catch (err: any) {
    const detail = err.response?.data
      ? JSON.stringify(err.response.data).substring(0, 500)
      : err.message;
    throw new Error(`Bedrock proxy failed (${err.response?.status || 'unknown'}): ${detail}`);
  }

  // Extract text from response
  let text = '';
  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      if (typeof block === 'string') {
        text += block;
      } else if (block.type === 'text') {
        text += block.text;
      }
    }
  } else if (typeof data.content === 'string') {
    text = data.content;
  } else if (data.completion) {
    text = data.completion;
  } else {
    throw new Error(`Unexpected Bedrock response: ${JSON.stringify(data).substring(0, 500)}`);
  }

  return text.trim();
}

/**
 * Send a chat request via direct Anthropic API (SDK).
 */
async function directChat(
  systemPrompt: string | undefined,
  userPrompt: string,
  options: ClaudeChatOptions,
): Promise<string> {
  const client = getDirectClient();

  const {
    temperature = 0.3,
    maxTokens = 4096,
    jsonMode = false,
  } = options;

  const effectiveUserPrompt = jsonMode
    ? userPrompt + '\n\nIMPORTANT: Respond with valid JSON only. No markdown, no explanation, no code fences.'
    : userPrompt;

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: effectiveUserPrompt },
  ];

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    temperature,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    messages,
  });

  let text = '';
  for (const block of response.content) {
    if (block.type === 'text') {
      text += block.text;
    }
  }

  return text.trim();
}

/**
 * Send a chat request to Claude and return the text response.
 * Routes to Bedrock proxy or direct API based on env config.
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
  if (USE_BEDROCK) {
    return bedrockChat(systemPrompt, userPrompt, options);
  }
  if (ANTHROPIC_API_KEY) {
    return directChat(systemPrompt, userPrompt, options);
  }
  throw new Error(
    'Claude AI requires either ANTHROPIC_BEDROCK_BASE_URL + ANTHROPIC_AUTH_TOKEN (Bedrock proxy) '
    + 'or ANTHROPIC_API_KEY (direct API)',
  );
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
