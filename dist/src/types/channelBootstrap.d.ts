export type BootstrapStatus = 'pending' | 'in_progress' | 'resolved' | 'unresolved' | 'aged_out';
export interface BootstrapMemberRow {
    id: number;
    channel_id: string;
    slack_user_id: string;
    email: string;
    status: BootstrapStatus;
    attempts: number;
    last_error: string | null;
    claimed_at: Date | null;
    enqueued_at: Date;
    resolved_at: Date | null;
}
export interface BootstrapClaim {
    id: number;
    channel_id: string;
    slack_user_id: string;
    email: string;
}
export type BootstrapResult = {
    id: number;
    status: 'resolved';
    ghe_login: string;
    email: string;
    display_name: string | null;
    slack_user_id: string;
} | {
    id: number;
    status: 'unresolved';
} | {
    id: number;
    status: 'pending';
    attempts_delta: 1;
    last_error: string;
};
//# sourceMappingURL=channelBootstrap.d.ts.map