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
export interface ClaudeChatOptions {
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
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
export declare function claudeChat(systemPrompt: string | undefined, userPrompt: string, options?: ClaudeChatOptions): Promise<string>;
/**
 * Check if the Claude API is reachable and the API key is valid.
 */
export declare function checkClaudeHealth(): Promise<{
    ok: boolean;
    error?: string;
}>;
/**
 * Get the configured Claude model name.
 */
export declare function getClaudeModel(): string;
//# sourceMappingURL=claudeClient.d.ts.map