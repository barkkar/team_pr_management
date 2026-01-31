import { ParsedPR } from '../utils/prParser';
export interface TrackingResult {
    tracked: ParsedPR[];
    skipped: ParsedPR[];
}
/**
 * Process a Slack message and track any PR links found
 */
export declare function trackPRsFromMessage(text: string, channelId: string, messageTs: string, postedAt: Date): Promise<TrackingResult>;
//# sourceMappingURL=prTracker.d.ts.map