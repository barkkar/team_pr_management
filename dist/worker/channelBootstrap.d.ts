#!/usr/bin/env npx ts-node
/**
 * Channel Bootstrap Drain Worker
 *
 * Drains the `channel_bootstrap_queue` by resolving Slack-member emails to
 * GHE logins via the configured GHE hosts. Runs on the VPN-connected laptop
 * because only it can reach GHE.
 *
 * Per-tick flow (one batch):
 *   1. POST /api/bootstrap-claim  -> BootstrapClaim[]
 *   2. For each row: search each configured host for the email, then fetch
 *      the user to confirm the email matches. First match wins.
 *   3. POST /api/bootstrap-complete with BootstrapResult[]
 *
 * See docs/superpowers/specs/2026-05-04-multi-team-user-mapping-design.md §5.3.
 *
 * Usage:
 *   npx ts-node worker/channelBootstrap.ts   # one-shot drain; exits when done
 *   (localPRChecker will call runBootstrapDrainLoop() from its tick in Packet F.)
 */
import 'dotenv/config';
/**
 * Run a single bootstrap-drain batch: claim up to 50 rows, resolve each, and
 * POST the results back. Safe to call from another worker — throws on fatal
 * configuration/transport errors but never on per-row failures.
 */
export declare function runBootstrapDrainLoop(): Promise<void>;
//# sourceMappingURL=channelBootstrap.d.ts.map