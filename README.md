# multi-tab-listening

A browser-automation tool that monitors multiple Discord channels simultaneously and uses AI to detect questions and generate answers — **no Bot Token required**.

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-2EAD33?style=flat&logo=playwright&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat&logo=postgresql&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-000000?style=flat&logo=bun&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue?style=flat)

## Overview

This project has two independently running modules:

- **Scraper** — opens one browser tab per Discord channel using Playwright, injects a `MutationObserver` script to capture new messages in real time, filters noise, and stores everything in PostgreSQL.
- **AI Assistant** — polls the database for unprocessed messages, calls the Fireworks AI API to detect whether each message is a question (≥70% confidence threshold), retrieves relevant context from message history, generates an answer, and pushes both to a Discord channel via Webhook.

## Architecture

```mermaid
flowchart LR
    A["Discord Browser Tabs\n(Playwright)"] -->|"new messages"| B["Scraper\n(filter + extract)"]
    B -->|store| C[("PostgreSQL\n+ pgvector")]
    C -->|poll| D["AI Assistant\n(Fireworks AI)"]
    D -->|"question detected"| E["Discord Webhook\n(Q&A notification)"]
```

## Features

- Monitors multiple Discord channels in parallel browser tabs
- No Bot Token needed — works via browser automation and DOM observation
- Smart message filtering: drops short messages, trivial phrases, emoji-only, and bot messages
- AI question detection with configurable confidence threshold (default 70%)
- Automatic answer generation with context retrieval from recent message history
- pgvector column on messages table, ready for semantic search

## Quick Start

**Prerequisites:** Node.js 18+, pnpm, Bun, Docker

```bash
# 1. Clone
git clone https://github.com/your-username/multi-tab-listening.git
cd multi-tab-listening

# 2. Configure environment variables
cp scraper/.env.example scraper/.env
cp ai-assistant/.env.example ai-assistant/.env
# Edit both .env files with your values (see Configuration below)

# 3. Start PostgreSQL
docker-compose up -d

# 4. Install dependencies for both packages (pnpm workspace, run from the repo root)
pnpm install

# 5. Initialise the database schema
pnpm --filter scraper run setup-db

# 6. Start the scraper (keeps running, one tab per channel)
pnpm --filter scraper start

# 7. In a new terminal, start the AI assistant
pnpm --filter ai-assistant start
```

The scraper will open a Chromium window. Log in to Discord manually on the first run — Playwright saves the session to `discord-session.json` so you only need to do this once.

## Configuration

### Scraper (`scraper/.env`)

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

## Project Structure

```
multi-tab-listening/
├── shared/                     # Types shared by both services (mirrors the DB schema)
│   └── src/types.ts
├── scraper/                    # Playwright-based Discord monitor
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
├── pnpm-workspace.yaml         # Workspace members + shared dependency catalog
└── docker-compose.yml          # PostgreSQL + pgvector
```

## License

MIT
