# PR Review Reminder Bot

A Slack bot that monitors team channels for GitHub Enterprise PR links and sends reminders when PRs haven't received reviews.

## Features

- Monitors Slack channels for PR links from `git.soma.salesforce.com`
- Tracks PRs and checks review status via GitHub Enterprise API
- Sends reminder after 2 hours if no reviews received
- Respects business hours: PRs posted after 4 PM PST wait until 10 AM next day
- Skips weekends for reminder scheduling

## Prerequisites

- Node.js 18+
- PostgreSQL database
- Slack workspace with admin access
- GitHub Enterprise Personal Access Token

## Setup

### 1. Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click "Create New App" → "From scratch"
3. Name your app (e.g., "PR Review Reminder") and select your workspace

#### Configure Bot Token Scopes

Navigate to **OAuth & Permissions** and add these Bot Token Scopes:

- `channels:history` - Read messages in public channels
- `channels:read` - List channels
- `chat:write` - Post reminder messages
- `app_mentions:read` - (Optional) Respond to @mentions

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
   - `app_home_opened` (optional)

#### Install App

1. Navigate to **Install App**
2. Click "Install to Workspace"
3. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

### 2. Generate GitHub Enterprise Token

1. Go to [git.soma.salesforce.com/settings/tokens](https://git.soma.salesforce.com/settings/tokens)
2. Click "Generate new token"
3. Select scope: `repo` (full repository access)
4. Copy the generated token

### 3. Local Development

```bash
# Clone the repository
git clone <repo-url>
cd team_pr_management

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your credentials
```

Configure `.env`:
```
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_APP_TOKEN=xapp-your-app-token
GHE_TOKEN=your-github-enterprise-token
GHE_BASE_URL=https://git.soma.salesforce.com/api/v3
DATABASE_URL=postgres://localhost:5432/pr_reminders
```

```bash
# Run database migrations
npm run migrate

# Start development server
npm run dev
```

### 4. Deploy to Heroku

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
heroku config:set GHE_TOKEN=your-github-enterprise-token
heroku config:set GHE_BASE_URL=https://git.soma.salesforce.com/api/v3
heroku config:set TZ=America/Los_Angeles
heroku config:set NODE_ENV=production

# Deploy
git push heroku main

# Run database migrations
heroku run npm run migrate

# Check logs
heroku logs --tail
```

### 5. Set Up Heroku Scheduler

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

## Usage

1. Add the bot to channels where your team posts PR links
2. When someone posts a PR link from `git.soma.salesforce.com`, the bot will track it
3. After 2 hours (or 10 AM next day if posted after 4 PM PST), if no reviews are found, a reminder is posted

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Slack Channel  │────▶│  Node.js App     │────▶│  PostgreSQL     │
│  (PR Links)     │     │  (Bolt SDK)      │     │  (Tracked PRs)  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │  GitHub Enterprise│
                        │  API (Reviews)    │
                        └──────────────────┘
```

## Project Structure

```
├── src/
│   ├── app.ts              # Slack Bolt app setup
│   ├── index.ts            # Entry point
│   ├── services/
│   │   ├── github.ts       # GitHub Enterprise API client
│   │   ├── prTracker.ts    # PR tracking logic
│   │   └── reminder.ts     # Reminder processing
│   ├── db/
│   │   ├── client.ts       # PostgreSQL client
│   │   ├── migrate.ts      # Migration runner
│   │   └── migrations/     # SQL migrations
│   └── utils/
│       ├── timezone.ts     # Business hours logic
│       └── prParser.ts     # PR URL parser
├── scripts/
│   └── checkReminders.ts   # Scheduled job
├── package.json
├── tsconfig.json
├── Procfile
└── .env.example
```

## Scripts

- `npm run build` - Compile TypeScript
- `npm run start` - Start production server
- `npm run dev` - Start development server
- `npm run migrate` - Run database migrations
- `npm run check-reminders` - Run reminder check (for scheduler)

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (xoxb-...) |
| `SLACK_SIGNING_SECRET` | Signing secret from app settings |
| `SLACK_APP_TOKEN` | App-level token for Socket Mode (xapp-...) |
| `GHE_TOKEN` | GitHub Enterprise Personal Access Token |
| `GHE_BASE_URL` | GitHub Enterprise API URL |
| `DATABASE_URL` | PostgreSQL connection string |
| `TZ` | Timezone (America/Los_Angeles) |
| `NODE_ENV` | Environment (production/development) |

## License

ISC
