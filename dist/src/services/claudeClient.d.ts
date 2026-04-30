/**
 * Claude AI Client
 *
 * Shared Anthropic Claude client for all LLM chat/generation tasks.
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
    maxIterations?: number;
    onToolCall: (call: ClaudeToolCall) => Promise<ClaudeToolResult>;
}
export interface ToolLoopResult {
    finalText: string;
    iterations: number;
    toolCalls: {
        name: string;
        input: any;
    }[];
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
export declare function claudeToolLoop(systemPrompt: string | undefined, userPrompt: string, tools: ClaudeTool[], options: ToolLoopOptions): Promise<ToolLoopResult>;
//# sourceMappingURL=claudeClient.d.ts.map