"use strict";
/**
 * LLM Review Generator
 *
 * Uses Ollama to generate AI-powered code review comments based on:
 * - PR diff content
 * - Similar past review comments (RAG)
 * - Codebase knowledge (RAG)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateReview = generateReview;
exports.checkLLMHealth = checkLLMHealth;
const ollama_1 = require("ollama");
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3-coder';
let ollamaClient = null;
function getClient() {
    if (!ollamaClient) {
        ollamaClient = new ollama_1.Ollama({ host: OLLAMA_HOST });
    }
    return ollamaClient;
}
/**
 * Build the system prompt for the review generator.
 */
function buildSystemPrompt() {
    return `You are an expert code reviewer for a software engineering team. Your task is to review a pull request diff and provide helpful, constructive review comments.

You have access to:
1. The PR diff (files changed)
2. Similar past review comments from the team's history
3. Codebase knowledge about the repository

Guidelines:
- Focus on substantive issues: bugs, logic errors, security concerns, performance problems
- Reference past review patterns when relevant
- Ask clarifying questions when intent is unclear
- Suggest improvements based on codebase conventions
- Be concise and actionable
- Do NOT comment on trivial formatting or style unless it deviates significantly from codebase conventions

Output your review as a JSON object with this structure:
{
  "comments": [
    {
      "file_path": "path/to/file.ts",
      "line_hint": "brief description of the code location",
      "comment": "your review comment",
      "type": "comment|question|suggestion"
    }
  ],
  "summary": "1-2 sentence overall assessment"
}

Respond ONLY with the JSON object, no markdown fences or other text.`;
}
/**
 * Build the user prompt with PR context and RAG results.
 */
function buildUserPrompt(prTitle, prDiff, changedFiles, similarReviews, similarCode) {
    const parts = [];
    parts.push(`## Pull Request: ${prTitle}`);
    parts.push(`\n### Changed Files:\n${changedFiles.map(f => `- ${f}`).join('\n')}`);
    // Add similar past reviews as context
    if (similarReviews.length > 0) {
        parts.push('\n### Relevant Past Review Comments (from team history):');
        for (const review of similarReviews.slice(0, 5)) {
            parts.push(`\n**${review.org}/${review.repo}** - ${review.file_path || 'general'}:`);
            parts.push(`> ${review.comment_body.substring(0, 500)}`);
        }
    }
    // Add codebase knowledge as context
    if (similarCode.length > 0) {
        parts.push('\n### Related Codebase Context:');
        for (const code of similarCode.slice(0, 3)) {
            parts.push(`\n**${code.file_path}:**`);
            parts.push(`\`\`\`\n${code.content_chunk.substring(0, 1000)}\n\`\`\``);
        }
    }
    // Add the PR diff (truncated to fit context window)
    parts.push('\n### PR Diff:');
    parts.push(`\`\`\`diff\n${prDiff.substring(0, 16000)}\n\`\`\``);
    return parts.join('\n');
}
/**
 * Generate review comments for a PR using Ollama LLM.
 */
async function generateReview(prTitle, prDiff, changedFiles, similarReviews, similarCode) {
    const client = getClient();
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(prTitle, prDiff, changedFiles, similarReviews, similarCode);
    try {
        const response = await client.chat({
            model: OLLAMA_MODEL,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            options: {
                temperature: 0.3,
                num_predict: 4096,
                num_ctx: 32768,
            },
        });
        const content = response.message.content.trim();
        // Try to parse JSON from the response
        const parsed = parseReviewResponse(content);
        return parsed;
    }
    catch (error) {
        console.error(`[ReviewGenerator] LLM error: ${error.message}`);
        return {
            comments: [],
            summary: `Failed to generate review: ${error.message}`,
        };
    }
}
/**
 * Parse the LLM response, handling potential formatting issues.
 */
function parseReviewResponse(content) {
    // Try direct JSON parse
    try {
        const parsed = JSON.parse(content);
        return validateReview(parsed);
    }
    catch {
        // Try extracting JSON from markdown fences
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[1].trim());
                return validateReview(parsed);
            }
            catch {
                // Fall through
            }
        }
        // Try finding JSON object in the text
        const braceMatch = content.match(/\{[\s\S]*\}/);
        if (braceMatch) {
            try {
                const parsed = JSON.parse(braceMatch[0]);
                return validateReview(parsed);
            }
            catch {
                // Fall through
            }
        }
        // Give up — return raw content as a single comment
        return {
            comments: [{
                    file_path: null,
                    line_hint: null,
                    comment: content.substring(0, 2000),
                    type: 'comment',
                }],
            summary: 'AI review generated (unstructured)',
        };
    }
}
function validateReview(parsed) {
    const comments = [];
    if (Array.isArray(parsed.comments)) {
        for (const c of parsed.comments) {
            comments.push({
                file_path: c.file_path || null,
                line_hint: c.line_hint || null,
                comment: String(c.comment || ''),
                type: ['comment', 'question', 'suggestion'].includes(c.type) ? c.type : 'comment',
            });
        }
    }
    return {
        comments,
        summary: String(parsed.summary || 'AI review complete'),
    };
}
/**
 * Check if Ollama LLM model is available.
 */
async function checkLLMHealth() {
    try {
        const client = getClient();
        await client.chat({
            model: OLLAMA_MODEL,
            messages: [{ role: 'user', content: 'respond with: ok' }],
            options: { num_predict: 10 },
        });
        return { ok: true };
    }
    catch (error) {
        return { ok: false, error: error.message };
    }
}
//# sourceMappingURL=reviewGenerator.js.map