# PR Review Reminder Bot — Overview

A Slack bot that watches team channels for GitHub Enterprise PR links, chases reviewers during business hours, and suggests reviewers using Claude.

## Features

- **PR tracking** — detects `*.soma.salesforce.com` PR links in monitored Slack channels and reacts with :robot_face:.
- **Review reminders** — posts a thread reply 2h after the PR is shared if no review; only 9 AM – 5 PM PST, Mon–Fri; recurring until reviewed.
- **Status polling** — a VPN-connected worker checks GHE every 5 min for open/closed + has-reviews state.
- **Reviewer suggestions (Claude tool-use)** — for each new PR, Claude picks up to 5 reviewers from team history using four tools: `fetch_pr_files`, `fetch_pr_diff`, `get_past_reviewers`, `get_past_authors`. Posted as a threaded reply with @-mentions.
- **Proactive user mapping** — on `/pr-monitor add` and when members join, the bot enqueues channel members and the worker resolves their Slack email → GHE login so `@-mentions` work from day one.
- **Slash commands** — `/pr-monitor add | remove | list | pending | stats | status | help`.
- **Cancel reminders shortcut** — message shortcut `cancel_reminder` (on any PR-link post) silences all further review reminders for that message. Scoped per-message (every PR link in the post), not reversible, confirmation is ephemeral.
- **Channel allowlist (optional)** — `ALLOWED_CHANNEL_IDS` Heroku config var restricts which Slack channels the bot will act on. When unset or empty, enforcement is disabled and every channel is permitted (a warning is logged at boot). Set it to a comma-separated list of channel IDs to re-enable.
- **Error funnel** — runtime failures posted to a configured Slack error channel (throttled 1/min per source+message).

## Setup for a team

Assumes an admin has already deployed the Heroku app (see `README.md` §Setup for the one-time deploy).

### 1. Channel allowlist (only if enforcement is on)

By default the admin runs with `ALLOWED_CHANNEL_IDS` unset/empty, which disables enforcement and permits every channel — no action needed. If your admin has set the var to a non-empty list, send your Slack channel ID(s) to them so they can append them.

### 2. Add the bot and start monitoring

In the target channel:

```
/invite @pr-review-reminder
/pr-monitor add
```

`add` registers the channel, queues channel members for reviewer-mapping, and acks with a "queued N member(s)" ephemeral follow-up.

### 3. Run the VPN worker on one team laptop

The worker needs VPN access to `*.soma.salesforce.com`.

```bash
git clone <repo> && cd team_pr_management
cp .env.example .env
# Fill in: HEROKU_API_URL, WORKER_API_KEY (from admin),
#         GHE_TOKENS (JSON map of host→PAT), ANTHROPIC_API_KEY, CLAUDE_MODEL
npm ci && npm run compile
npm run worker:watch   # runs every 5 min; Ctrl+C to stop
```

For a background service, see `README.md` §5 (macOS launchd plist).

### 4. Verify

- Post a test PR link in the channel → bot adds :robot_face:.
- Within 5 min (next worker tick): reviewer-suggestion thread reply.
- After 2h with no review (inside business hours): reminder thread reply.
- `/pr-monitor status` — shows monitored state, allowlist, worker-reported stats.
- `/pr-monitor pending` — lists PRs still awaiting review with wait times.
- To stop reminders on a specific PR post: open the message's "More actions" menu → **Cancel reminder**. Confirmation is ephemeral.

## Requirements at a glance

| Who | Needs |
|---|---|
| Admin | Heroku app + Postgres, Slack app with Socket Mode, `WORKER_API_KEY`, optional `ALLOWED_CHANNEL_IDS` |
| Team | One laptop on VPN, GHE PAT per hostname, Anthropic key (channel ID allowlisted only if enforcement is on) |
| User | Post PR links as usual — no extra steps |

## Where to go next

- **Deploy from scratch**: `README.md`
- **Env vars**: `docs/environment.md`
- **How it all fits together**: `docs/architecture.md`
- **Slash commands and HTTP API**: `docs/api-endpoints.md`
