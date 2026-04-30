# PR Review Reminder Bot

A Slack bot that monitors team channels for GitHub Enterprise PR links and sends reminders when PRs haven't received reviews.

## Features

- Monitors Slack channels for PR links from `*.soma.salesforce.com` (any subdomain)
- Adds a :robot_face: reaction to acknowledge PR posts
- Tracks PRs and checks review status via GitHub Enterprise API
- Sends reminder after 2 hours if no reviews received
- Respects business hours: reminders sent only 9 AM - 5 PM PST (Mon-Fri)
- Skips weekends for reminder scheduling
- **Slash commands** to configure which channels to monitor
- **Local VPN worker** to check PR status from internal GitHub Enterprise

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Slack Channel  │────▶│  Heroku App      │────▶│  PostgreSQL     │
│  (PR Links)     │     │  (Node.js/Bolt)  │     │  (Tracked PRs)  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                 ▲
                                 │ API
                                 ▼
                        ┌──────────────────┐     ┌─────────────────┐
                        │  Local Worker    │────▶│ GitHub Enterprise│
                        │  (Your Laptop)   │     │ (VPN Required)   │
                        └──────────────────┘     └─────────────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │  Claude AI       │
                        │  (chat + review) │
                        └──────────────────┘
```

The local worker runs on your VPN-connected laptop to check PR status from internal GitHub Enterprise servers, then reports the status back to Heroku. AI reviews are generated via **Claude AI API** (Anthropic). Semantic retrieval has been removed; reviewer suggestions and code context use deterministic file-path + ontology matching.

## Prerequisites

- Node.js 20+
- PostgreSQL database (provided by Heroku)
- Slack workspace with admin access
- GitHub Enterprise Personal Access Token
- VPN access to GitHub Enterprise (for local worker)
- **Anthropic API Key** — for Claude AI chat/LLM (get one at [console.anthropic.com](https://console.anthropic.com))

## Setup

### 1. Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click "Create New App" → "From scratch"
3. Name your app (e.g., "PR Review Reminder") and select your workspace

#### Configure Bot Token Scopes

Navigate to **OAuth & Permissions** and add these Bot Token Scopes:

- `channels:history` - Read messages in public channels
- `channels:read` - List channels
- `groups:history` - Read messages in private channels
- `groups:read` - List private channels
- `chat:write` - Post reminder messages
- `reactions:write` - Add emoji reactions to messages
- `commands` - Handle slash commands

#### Enable Socket Mode

1. Navigate to **Socket Mode**
2. Enable Socket Mode
3. Generate an App-Level Token with `connections:write` scope
4. Save the token (starts with `xapp-`)

#### Enable Event Subscriptions

1. Navigate to **Event Subscriptions**
2. Enable Events
3. Subscribe to bot events:
   - `message.channels`
   - `message.groups`
   - `app_home_opened` (optional)

#### Create Slash Command

1. Navigate to **Slash Commands**
2. Click "Create New Command"
3. Configure:
   - **Command**: `/pr-monitor`
   - **Short Description**: `Manage PR monitoring for this channel`
   - **Usage Hint**: `add | remove | list | status | help`

#### Install App

1. Navigate to **Install App**
2. Click "Install to Workspace"
3. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

### 2. Generate GitHub Enterprise Token(s)

Generate a token for **each** GHE hostname your PRs come from (e.g., `gitcore.soma.salesforce.com` and `git.soma.salesforce.com`). Tokens are per-instance -- a token from one hostname won't work on another.

1. Go to your GitHub Enterprise settings (e.g., `https://gitcore.soma.salesforce.com/settings/tokens`)
2. Click "Generate new token"
3. Select scope: `repo` (full repository access)
4. Copy the generated token
5. Repeat for each GHE hostname if your team posts PRs from multiple instances

### 3. Deploy to Heroku

```bash
# Login to Heroku
heroku login

# Create a new Heroku app
heroku create your-app-name

# Add PostgreSQL
heroku addons:create heroku-postgresql:essential-0

# Set environment variables
heroku config:set SLACK_BOT_TOKEN=xoxb-your-bot-token
heroku config:set SLACK_SIGNING_SECRET=your-signing-secret
heroku config:set SLACK_APP_TOKEN=xapp-your-app-token
# GitHub Enterprise tokens (use GHE_TOKENS for multiple hosts, or GHE_TOKEN for a single host)
heroku config:set GHE_TOKENS='{"gitcore.soma.salesforce.com":"token-for-gitcore","git.soma.salesforce.com":"token-for-git"}'
heroku config:set TZ=America/Los_Angeles
heroku config:set NODE_ENV=production

# Generate and set worker API key
heroku config:set WORKER_API_KEY=$(openssl rand -hex 32)

# Set allowed channel IDs (comma-separated list of Slack channel IDs)
# Only these channels will be readable by the bot (required for groups:history / channels:history scopes)
heroku config:set ALLOWED_CHANNEL_IDS=C0123ABC456,G0789DEF012

# Deploy
git push heroku main

# Run database migrations
heroku run "npm run migrate" -a your-app-name
```

### 4. Set Up Heroku Scheduler

1. Add the Scheduler add-on:
   ```bash
   heroku addons:create scheduler:standard
   ```

2. Open the Scheduler dashboard:
   ```bash
   heroku addons:open scheduler
   ```

3. Add a new job:
   - **Command**: `npm run check-reminders`
   - **Frequency**: Every 10 minutes

### 5. Set Up Local VPN Worker

The local worker runs on your laptop (behind VPN) to check PR status from internal GitHub Enterprise.

1. Clone the repository to your local machine

2. Create a local `.env` file:
   ```bash
   cp .env.example .env
   ```

3. Configure local `.env`:
   ```
   GHE_TOKENS={"gitcore.soma.salesforce.com":"token-for-gitcore","git.soma.salesforce.com":"token-for-git"}
   HEROKU_API_URL=https://your-app-name.herokuapp.com
   WORKER_API_KEY=<same-key-as-heroku>

   # Claude AI (required for LLM chat/review generation)
   ANTHROPIC_API_KEY=sk-ant-...
   CLAUDE_MODEL=claude-sonnet-4-20250514
   ```

4. Get the worker API key from Heroku:
   ```bash
   heroku config:get WORKER_API_KEY -a your-app-name
   ```

5. Run the worker:
   ```bash
   # Single run
   npm run worker

   # Continuous (every 5 minutes)
   npm run worker:watch
   ```

#### Optional: Run Worker as Background Service (macOS)

Create `~/Library/LaunchAgents/com.pr-worker.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.pr-worker</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>source ~/.nvm/nvm.sh && cd /path/to/team_pr_management && npm run worker</string>
    </array>
    <key>StartInterval</key>
    <integer>300</integer>
    <key>StandardOutPath</key>
    <string>/tmp/pr-worker.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/pr-worker.log</string>
</dict>
</plist>
```

Load the service:
```bash
launchctl load ~/Library/LaunchAgents/com.pr-worker.plist
```

You can check if it's running with:
launchctl list | grep pr-worker

## Usage

### Slash Commands

| Command | Description |
|---------|-------------|
| `/pr-monitor add` | Start monitoring the current channel |
| `/pr-monitor remove` | Stop monitoring the current channel |
| `/pr-monitor list` | Show all monitored channels |
| `/pr-monitor pending` | Show PRs awaiting review with wait times and reminder counts |
| `/pr-monitor stats` | Show review statistics: reviewed without reminders, reminders per PR, averages |
| `/pr-monitor status` | Show bot status and statistics |
| `/pr-monitor help` | Show help message |

### Workflow

1. In a Slack channel, run `/pr-monitor add` to start monitoring
2. When someone posts a PR link (e.g., `https://gitcore.soma.salesforce.com/org/repo/pull/123`), the bot adds a :robot_face: reaction
3. The local worker checks PR status every 5 minutes and reports to Heroku
4. After 2 hours (or 9 AM next business day if posted after 5 PM PST), if no reviews are found, a reminder is posted (only during 9 AM - 5 PM PST)

## Project Structure

```
├── src/
│   ├── app.ts                    # Slack Bolt app setup + slash commands
│   ├── index.ts                  # Entry point + Worker API endpoints
│   ├── services/
│   │   ├── github.ts             # GitHub Enterprise API client
│   │   ├── prTracker.ts          # PR tracking logic
│   │   ├── reminder.ts           # Reminder processing
│   │   ├── channelPoller.ts      # Channel polling for PRs
│   │   ├── channelAccessControl.ts # Channel allowlist enforcement
│   │   ├── claudeClient.ts       # Claude AI (Anthropic) shared client for all LLM chat calls
│   │   ├── ontologyEngine.ts     # Deterministic rule resolver (file paths + code patterns → exact rules)
│   │   └── ruleClassifier.ts     # LLM-as-classifier fallback (via Claude) for edge cases
│   ├── db/
│   │   ├── client.ts             # PostgreSQL client + queries
│   │   ├── migrate.ts            # Migration runner
│   │   └── migrations/           # SQL migrations (includes 015/016 for ontology tables + seed data)
│   └── utils/
│       ├── timezone.ts           # Business hours logic
│       ├── prParser.ts           # PR URL parser
│       └── gheTokenResolver.ts   # Per-hostname GHE token resolution
├── scripts/
│   └── checkReminders.ts         # Scheduled job (Heroku Scheduler)
├── worker/
│   ├── localPRChecker.ts         # Local VPN worker (status checks + lesson extraction)
│   ├── prAnalyzer.ts             # AI PR analysis worker (multi-pass review via Claude)
│   ├── testReview.ts             # Dry-run AI review for a single PR (no Slack posting)
│   ├── bootstrapLearner.ts       # Batch lesson extraction for closed PRs
│   └── reviewLearner.ts          # Continuous lesson extraction worker
├── package.json
├── tsconfig.json
├── Procfile
└── .env.example
```

## API Endpoints

The Heroku app exposes these endpoints for the local worker:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/pending-prs` | GET | Get PRs needing status check |
| `/api/pr-status` | POST | Report PR status from worker |
| `/api/resolve-rules` | POST | Resolve ontology rules for a PR (changed files + diff) |
| `/api/ontology/taxonomy` | GET | Get full domain taxonomy with rule counts |
| `/api/ontology/domains` | GET/POST | List or create code domains |
| `/api/ontology/rules` | GET/POST | List or create coding rules (with matchers) |
| `/api/ontology/rules/:id` | PUT/DELETE | Update or delete a coding rule |
| `/api/ontology/rule-feedback` | POST | Record human override/dismissal of a rule |
| `/health` | GET | Health check |

All `/api/*` endpoints require the `X-Worker-API-Key` header.

### Ontology Rule Engine

The bot uses a **hybrid ontology + LLM classifier** for deterministic code rule enforcement during Pass 2 (compliance review):

1. **Deterministic matching** — File paths are matched against `domain_file_mappings` (glob patterns) to find applicable domains, then rules are fetched for those domains (with ancestor inheritance via recursive CTE). Code patterns in the diff are also matched against `rule_matchers`.
2. **LLM classifier fallback** — For files with no deterministic matches, **Claude AI** classifies the diff into domain categories using the full taxonomy as context, then fetches exact rules for those domains.

To seed initial rules, run the migrations:
```bash
npm run migrate
```

To add new rules via the API:
```bash
curl -X POST "$HEROKU_API_URL/api/ontology/rules" \
  -H "X-Worker-API-Key: $WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain_id": 1, "rule_key": "entity.field.must_have_help_text", "title": "Entity Fields Must Have Help Text", "description": "All custom entity fields must include a help text description.", "severity": "high", "matchers": [{"matcher_type": "code_pattern", "pattern": "CustomField", "is_regex": false}]}'
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run compile` | Compile TypeScript |
| `npm run start` | Start production server |
| `npm run dev` | Start development server |
| `npm run migrate` | Run database migrations |
| `npm run check-reminders` | Run reminder check (for scheduler) |
| `npm run worker` | Run local VPN worker once |
| `npm run worker:watch` | Run local VPN worker continuously |
| `npm run test-review -- <PR_URL>` | Dry-run AI review for a single PR (prints to console, no Slack posting) |
| `npm run test-review -- <PR_URL> --no-mention` | Same as above but suppresses reviewer @mentions |
| `npm run test-review -- <PR_URL> --post --channel=CHANNEL_ID` | Run AI review and post result to Slack |
| `npm run bootstrap-learn` | Batch process closed PRs through the full RAG + lesson pipeline (default limit: 50) |
| `npm run bootstrap-learn -- --limit 10` | Same as above with custom limit |
| `npm run bootstrap-learn -- --force` | Re-process PRs that already have lessons |
| `npm run review-learn` | Run lesson extraction once for PRs needing lessons |
| `npm run review-learn -- --watch` | Run lesson extraction continuously (every 10 minutes) |

## Environment Variables

### Heroku (Required)

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (xoxb-...) |
| `SLACK_SIGNING_SECRET` | Signing secret from app settings |
| `SLACK_APP_TOKEN` | App-level token for Socket Mode (xapp-...) |
| `GHE_TOKENS` | JSON map of GHE hostname to token (preferred for multiple GHE instances) |
| `GHE_TOKEN` | Single GHE token (fallback for hosts not in `GHE_TOKENS`) |
| `DATABASE_URL` | PostgreSQL connection string (auto-set by Heroku) |
| `TZ` | Timezone (America/Los_Angeles) |
| `WORKER_API_KEY` | API key for local worker authentication |
| `ALLOWED_CHANNEL_IDS` | Comma-separated Slack channel IDs the bot is allowed to read (see [Channel Access Control](#channel-access-control)) |

At least one of `GHE_TOKENS` or `GHE_TOKEN` must be set. If your PRs come from multiple GHE hostnames, use `GHE_TOKENS`:

```bash
heroku config:set GHE_TOKENS='{"gitcore.soma.salesforce.com":"ghp_abc","git.soma.salesforce.com":"ghp_xyz"}'
```

### Local Worker (Required)

| Variable | Description |
|----------|-------------|
| `GHE_TOKENS` | JSON map of GHE hostname to token (same as Heroku, preferred) |
| `GHE_TOKEN` | Single GHE token (fallback for hosts not in `GHE_TOKENS`) |
| `HEROKU_API_URL` | URL of your Heroku app |
| `WORKER_API_KEY` | Same API key as configured on Heroku |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude AI chat/LLM |
| `CLAUDE_MODEL` | Claude model to use (default: `claude-sonnet-4-20250514`) |

## Channel Access Control

The bot enforces a code-level channel allowlist to comply with Slack scope requirements for `groups:history` (private channels) and `channels:history` (public channels). Only channels listed in the `ALLOWED_CHANNEL_IDS` environment variable can be read by the bot.

- The allowlist is a comma-separated list of Slack channel IDs (e.g., `C0123ABC456,G0789DEF012`).
- The app will **refuse to start** if `ALLOWED_CHANNEL_IDS` is not set or is empty.
- Messages from non-allowlisted channels are silently ignored (with a warning logged).
- The `/pr-monitor add` command will reject channels not on the allowlist.
- The polling mechanism will skip non-allowlisted channels before calling `conversations.history`.

To add a new channel, first add its ID to the Heroku config var, then run `/pr-monitor add` in that channel:

```bash
# Get current allowlist
heroku config:get ALLOWED_CHANNEL_IDS -a your-app-name

# Add a new channel ID to the list
heroku config:set ALLOWED_CHANNEL_IDS=C0123ABC456,G0789DEF012,CNEWCHANNEL -a your-app-name
```

You can view the current allowlist from within Slack by running `/pr-monitor status`.

## Troubleshooting

### Worker can't connect to GitHub Enterprise
- Ensure you're connected to VPN
- Verify `GHE_TOKEN` is valid: `curl -H "Authorization: token YOUR_TOKEN" https://gitcore.soma.salesforce.com/api/v3/user`

### Slash command not working
- Ensure `commands` scope is added in Slack app settings
- Reinstall the app to your workspace after adding the scope

### Reminders not being sent
- Check if the PR's `eligible_reminder_at` time has passed
- Verify the local worker is running and reporting status
- Check Heroku logs: `heroku logs --tail -a your-app-name`

### View database contents
```bash
heroku run "node -e \"
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.query('SELECT * FROM tracked_prs ORDER BY created_at DESC LIMIT 10')
  .then(r => console.table(r.rows))
  .finally(() => pool.end());
\"" -a your-app-name
```

## License

ISC
