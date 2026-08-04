# multi-tab-listening

A browser-automation tool that monitors multiple Discord channels simultaneously and uses AI to detect questions and generate answers — **no Bot Token required**.

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-2EAD33?style=flat&logo=playwright&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat&logo=postgresql&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-000000?style=flat&logo=bun&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue?style=flat)

## Overview

This project has three independently running modules:

- **Discord Monitor** — opens one browser tab per Discord channel using Playwright, injects a `MutationObserver` script to capture new messages in real time, filters noise, and stores everything in PostgreSQL.
- **AI Assistant** — polls the database for unprocessed messages, calls the Fireworks AI API to detect whether each message is a question (≥70% confidence threshold), retrieves relevant context from message history, generates an answer, and pushes both to a Discord channel via Webhook.
- **X Poster** — drains a queue of pending tweets from the database and posts each one through a real Chrome browser driven over CDP, pacing the interaction so it reads as human.

## Architecture

```mermaid
flowchart LR
    A["Discord Browser Tabs\n(Playwright)"] -->|"new messages"| B["Discord Monitor\n(filter + extract)"]
    B -->|store| C[("PostgreSQL\n+ pgvector")]
    C -->|poll| D["AI Assistant\n(Fireworks AI)"]
    D -->|"question detected"| E["Discord Webhook\n(Q&A notification)"]
    C -->|"claim pending tweet"| F["X Poster\n(real Chrome via CDP)"]
    F -->|post| G["x.com"]
```

## Features

- Monitors multiple Discord channels in parallel browser tabs
- No Bot Token needed — works via browser automation and DOM observation
- Smart message filtering: drops short messages, trivial phrases, emoji-only, and bot messages
- AI question detection with configurable confidence threshold (default 70%)
- Automatic answer generation with context retrieval from recent message history
- pgvector column on messages table, ready for semantic search
- Queue-driven X posting through a real Chrome, with human-like pacing, a dry-run mode, and a circuit breaker that stops on an expired session rather than hammering the account

## Quick Start

**Prerequisites:** Node.js 18+, pnpm, Bun, Docker

```bash
# 1. Clone
git clone https://github.com/your-username/multi-tab-listening.git
cd multi-tab-listening

# 2. Configure environment variables
cp discord-monitor/.env.example discord-monitor/.env
cp ai-assistant/.env.example ai-assistant/.env
# Edit both .env files with your values (see Configuration below)

# 3. Start PostgreSQL
docker compose up -d

# 4. Install dependencies for both packages (pnpm workspace, run from the repo root)
pnpm install

# 5. Initialise the database schema
pnpm --filter discord-monitor run setup-db

# 6. Start the Discord monitor (keeps running, one tab per channel)
pnpm --filter discord-monitor start

# 7. In a new terminal, start the AI assistant
pnpm --filter ai-assistant start

# 8. In a third terminal, start the X poster.
#    First run only: it opens a Chrome window with a blank dedicated profile.
#    Log in to X manually there — the profile persists.
#    X_DRY_RUN defaults to true, so it runs the full script without posting.
cp x-poster/.env.example x-poster/.env
pnpm --filter x-poster start
```

The Discord monitor will open a Chromium window. Log in to Discord manually on the first run — Playwright saves the session to `discord-session.json` so you only need to do this once.

## Configuration

### Discord Monitor (`discord-monitor/.env`)

| Variable | Description | Default |
|----------|-------------|---------|
| `DISCORD_CHANNELS` | Comma-separated `guild_id/channel_id` pairs to monitor | required |
| `DB_HOST` | PostgreSQL host | `localhost` |
| `DB_PORT` | PostgreSQL port | `5432` |
| `DB_USER` | PostgreSQL user | required |
| `DB_PASSWORD` | PostgreSQL password | required |
| `DB_NAME` | PostgreSQL database name | `discord_monitor` |
| `STORAGE_STATE_PATH` | Path to Playwright session file | `./discord-session.json` |
| `ENABLE_FILTERING` | Enable message noise filtering | `true` |
| `MIN_MESSAGE_LENGTH` | Minimum character count to store a message | `30` |
| `CUSTOM_TRIVIAL_PHRASES` | Additional comma-separated phrases to filter out | — |
| `DISCORD_WEBHOOK_URL` | Webhook URL for daily health reports | optional |
| `LOG_LEVEL` | Logging level: `info`, `debug`, `warn` | `info` |

### AI Assistant (`ai-assistant/.env`)

| Variable | Description | Default |
|----------|-------------|---------|
| `FIREWORKS_API_KEY` | Fireworks AI API key | required |
| `DISCORD_WEBHOOK_URL` | Webhook URL to post Q&A results | required |
| `POLLING_INTERVAL_MINUTES` | How often to poll for new messages | `1` |
| `POLLING_BATCH_SIZE` | Number of messages to process per cycle | `50` |
| `CONTEXT_KEYWORD_SEARCH_DAYS` | Days of history to search for keyword context | `30` |
| `CONTEXT_FALLBACK_SEARCH_DAYS` | Days of history for fallback context | `7` |
| `CONTEXT_MAX_MESSAGES` | Max context messages sent to AI | `20` |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | PostgreSQL connection | required |

### X Poster (`x-poster/.env`)

| Variable | Description | Default |
|----------|-------------|---------|
| `X_PROFILE_DIR` | Dedicated Chrome user-data directory | required |
| `X_DEBUG_PORT` | CDP port, bound to `127.0.0.1` | `9333` |
| `X_CHROME_PATH` | Chrome binary path | macOS install path |
| `X_DRY_RUN` | Run the full script but never click submit | `false` |
| `X_MIN_INTERVAL_MINUTES` | Interval floor between tweets | `20` |
| `X_MAX_INTERVAL_MINUTES` | Interval ceiling between tweets | `60` |
| `X_DAILY_CAP` | Maximum tweets per day | `10` |
| `X_ACTIVE_HOURS` | Local-time posting window; must not wrap past midnight | `09:00-23:00` |
| `X_MAX_ATTEMPTS` | Retries for retryable errors | `3` |
| `DISCORD_WEBHOOK_URL` | Where circuit-break alerts are sent | optional |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | PostgreSQL connection | required |

> `X_PROFILE_DIR` must **not** point at your everyday Chrome profile. Chrome 136+
> ignores `--remote-debugging-port` unless a non-default `--user-data-dir` is
> given, and an open debugging port grants any local process full control over
> every session in that profile.

Queue a tweet by inserting a row. `dedupe_key` is a `UNIQUE` idempotency key,
so re-inserting the same logical tweet is rejected by the database:

```sql
INSERT INTO tweets (content, dedupe_key, source)
VALUES ('Hello from the queue.', 'manual:2026-08-04-1', 'manual');
```

## Project Structure

```
multi-tab-listening/
├── shared/                     # Code shared by all three services
│   ├── src/types.ts            # Mirrors the DB schema
│   ├── src/logger.ts           # The one winston factory
│   └── src/db.ts               # Postgres config loader + pool factory
├── discord-monitor/            # Playwright-based Discord monitor
│   ├── src/
│   │   ├── discord-monitor.ts  # Tab management and message pipeline
│   │   ├── discord-observer.js # MutationObserver script injected into browser
│   │   ├── message-filter.ts   # Noise filtering logic
│   │   ├── database.ts         # PostgreSQL storage
│   │   ├── status-reporter.ts  # Daily health reports via Webhook
│   │   └── config.ts           # Environment variable loading
│   └── .env.example
├── ai-assistant/               # AI question detection and answer generation
│   ├── src/
│   │   ├── ai/
│   │   │   ├── fireworks-client.ts   # Fireworks AI API wrapper
│   │   │   └── message-analyzer.ts   # Question detection logic
│   │   ├── discord/
│   │   │   └── webhook-sender.ts     # Rich embed notifications
│   │   ├── scheduler/
│   │   │   └── message-poller.ts     # Polling loop
│   │   └── config.ts
│   └── .env.example
├── x-poster/                   # Queue-driven X posting via a real Chrome
│   ├── src/
│   │   ├── browser/
│   │   │   ├── chrome-launcher.ts  # Attach over CDP, or spawn if absent
│   │   │   └── launch-args.ts      # The six permitted launch flags
│   │   ├── human/
│   │   │   ├── delay.ts            # Log-normal action delays
│   │   │   ├── mouse.ts            # Bezier cursor travel with overshoot
│   │   │   └── clipboard.ts        # pbcopy/pbpaste with backup + restore
│   │   ├── x/
│   │   │   ├── selectors.ts        # Every X DOM selector, in one place
│   │   │   ├── session.ts          # Login-state check
│   │   │   └── composer.ts         # The seven-step posting script
│   │   ├── queue/
│   │   │   ├── tweet-queue.ts      # SKIP LOCKED claiming + state machine
│   │   │   └── rate-limiter.ts     # Active hours, daily cap, interval
│   │   └── errors.ts               # Retryable / Fatal / Uncertain
│   └── .env.example
├── pnpm-workspace.yaml         # Workspace members + shared dependency catalog
└── docker-compose.yml          # PostgreSQL + pgvector
```

## License

MIT
