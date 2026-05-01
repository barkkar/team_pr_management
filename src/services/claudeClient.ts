/**
 * Claude AI Client
 *
 * Shared Anthropic Claude client for all LLM chat/generation tasks.
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

// ---------------------------------------------------------------------------
// Tool-use loop
// ---------------------------------------------------------------------------

export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface ClaudeToolCall {
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface ClaudeToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ToolLoopOptions {
  temperature?: number;
  maxTokens?: number;
  maxIterations?: number; // hard cap on tool-use rounds (default 6)
  onToolCall: (call: ClaudeToolCall) => Promise<ClaudeToolResult>;
}

export interface ToolLoopResult {
  finalText: string;
  iterations: number;
  toolCalls: { name: string; input: any }[];
}

async function rawMessagesCall(body: any): Promise<any> {
  if (USE_BEDROCK) {
    const baseUrl = BEDROCK_BASE_URL!.replace(/\/bedrock\/?$/, '');
    const url = `${baseUrl}/v1/messages`;
    try {
      const response = await axios.post(url, body, {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': AUTH_TOKEN!,
          'anthropic-version': '2023-06-01',
        },
        timeout: 120000,
      });
      return response.data;
    } catch (err: any) {
      const detail = err.response?.data
        ? JSON.stringify(err.response.data).substring(0, 500)
        : err.message;
      throw new Error(`Bedrock proxy failed (${err.response?.status || 'unknown'}): ${detail}`);
    }
  }
  if (ANTHROPIC_API_KEY) {
    // Direct SDK supports tools via messages.create
    const client = getDirectClient();
    const response = await client.messages.create(body);
    return response;
  }
  throw new Error(
    'Claude AI requires either ANTHROPIC_BEDROCK_BASE_URL + ANTHROPIC_AUTH_TOKEN (Bedrock proxy) '
    + 'or ANTHROPIC_API_KEY (direct API)',
  );
}

/**
 * Run a Claude conversation with tool use until the model returns end_turn or
 * we hit maxIterations. The caller provides tool definitions and an executor.
 *
 * Conversation shape:
 *   1. user: <userPrompt>
 *   2. assistant: [text] + [tool_use]  ← Claude decides to call a tool
 *   3. user: [tool_result]              ← we run the tool and send back the result
 *   4. repeat 2–3 until stop_reason === 'end_turn'
 */
export async function claudeToolLoop(
  systemPrompt: string | undefined,
  userPrompt: string,
  tools: ClaudeTool[],
  options: ToolLoopOptions,
): Promise<ToolLoopResult> {
  const {
    temperature = 0.2,
    maxTokens = 2048,
    maxIterations = 6,
    onToolCall,
  } = options;

  const messages: any[] = [{ role: 'user', content: userPrompt }];
  const toolCallLog: { name: string; input: any }[] = [];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const body: any = {
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      temperature,
      messages,
      tools,
    };
    if (systemPrompt) body.system = systemPrompt;

    const response = await rawMessagesCall(body);

    const stopReason = response.stop_reason;
    const contentBlocks = Array.isArray(response.content) ? response.content : [];

    // Append assistant turn verbatim so Claude keeps context on subsequent calls
    messages.push({ role: 'assistant', content: contentBlocks });

    if (stopReason === 'end_turn' || stopReason === 'stop_sequence') {
      const finalText = contentBlocks
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('')
        .trim();
      return { finalText, iterations: iteration + 1, toolCalls: toolCallLog };
    }

    if (stopReason !== 'tool_use') {
      throw new Error(`Claude returned unexpected stop_reason=${stopReason}`);
    }

    // Find tool_use blocks and execute them
    const toolUseBlocks = contentBlocks.filter((b: any) => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) {
      throw new Error('stop_reason=tool_use but no tool_use blocks present');
    }

    const toolResultBlocks: any[] = [];
    for (const block of toolUseBlocks) {
      const call: ClaudeToolCall = { id: block.id, name: block.name, input: block.input || {} };
      toolCallLog.push({ name: call.name, input: call.input });
      try {
        const result = await onToolCall(call);
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: result.tool_use_id,
          content: result.content,
          ...(result.is_error ? { is_error: true } : {}),
        });
      } catch (err: any) {
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: `Tool execution failed: ${err.message}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: 'user', content: toolResultBlocks });
  }

  throw new Error(`claudeToolLoop exceeded maxIterations=${maxIterations}`);
}

// ---------------------------------------------------------------------------
// JSON extraction — Claude sometimes wraps JSON in ```json fences or adds a
// preamble like "Here are the suggestions:" before the object. Strip those.
// ---------------------------------------------------------------------------

/**
 * Extract a JSON object from a Claude text response. Handles:
 *   - Plain JSON ("{...}")
 *   - Markdown-fenced JSON ("```json\n{...}\n```" or "```\n{...}\n```")
 *   - JSON with leading/trailing prose
 *
 * Returns the parsed object on success, or null if no valid JSON is found.
 */
export function extractJsonFromClaudeText<T = any>(text: string): T | null {
  if (!text) return null;

  // 1. Try as-is.
  const trimmed = text.trim();
  try { return JSON.parse(trimmed) as T; } catch { /* fall through */ }

  // 2. Strip a ```json ... ``` or ``` ... ``` fence if present.
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()) as T; } catch { /* fall through */ }
  }

  // 3. Grab the first balanced {...} block in the text.
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(trimmed.substring(firstBrace, lastBrace + 1)) as T; } catch { /* fall through */ }
  }

  return null;
}
