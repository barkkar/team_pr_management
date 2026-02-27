export type ErrorSeverity = 'warn' | 'error' | 'fatal';
/**
 * Send an error notification to the configured Slack error channel.
 *
 * No-ops silently if ERROR_SLACK_CHANNEL_ID or SLACK_BOT_TOKEN is not set.
 * Throttles duplicate source+message combos to 1 per minute.
 * Never throws — safe to call from any catch block.
 */
export declare function notifyError(source: string, message: string, severity?: ErrorSeverity, details?: string): Promise<void>;
//# sourceMappingURL=errorNotifier.d.ts.map