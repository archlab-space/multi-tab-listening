# Discord Multi-Tab Monitor

A Playwright-based automation tool that monitors multiple Discord channels in real-time, capturing and storing messages with intelligent filtering and thread linking capabilities.

## Features

- 🔗 **Multi-tab Architecture**: Monitor 3-5 Discord channels simultaneously in separate browser tabs
- 🤖 **Real-time Message Detection**: Uses MutationObserver to detect new messages as they appear
- 🧠 **Smart Filtering**: Filter out trivial messages like greetings and emoji-only responses
- 🧵 **Thread Linking**: Automatically link replies and thread messages to their parent messages
- 🗄️ **PostgreSQL Storage**: Store all messages with full metadata in a structured database
- 🔮 **AI-Ready**: Database schema prepared for future vector embeddings and semantic search
- 📊 **Comprehensive Logging**: Detailed logging with Winston for monitoring and debugging

## Quick Start

### 1. Prerequisites

- Node.js 18+ with pnpm
- PostgreSQL database
- Discord account access to target channels

### 2. Installation

```bash
# Clone and install dependencies
pnpm install

# Install Playwright browsers
pnpm playwright install chromium
```

### 3. Configuration

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your settings:
# - Add your PostgreSQL credentials
# - List Discord channel IDs (comma-separated)
# - Configure filtering preferences
```

### 4. Database Setup

The schema belongs to the workspace, not to this service — it is defined in
`shared/src/schema.ts` and applied by migrations. Run this from the repo root:

```bash
pnpm db:up
```

### 5. Run

```bash
# Start monitoring
pnpm run dev
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DISCORD_CHANNELS` | Comma-separated Discord channel IDs | Required |
| `DB_*` | PostgreSQL connection settings | See .env.example |
| `STORAGE_STATE_PATH` | Path to save Discord session | Optional |
| `ENABLE_FILTERING` | Enable message filtering | `true` |
| `MIN_MESSAGE_LENGTH` | Minimum message length to process | `3` |
| `CUSTOM_TRIVIAL_PHRASES` | Additional phrases to filter | Optional |

### Finding Discord Channel IDs

1. Enable Developer Mode in Discord (User Settings → Advanced → Developer Mode)
2. Right-click on any channel
3. Select "Copy ID"

## Architecture

```
Browser (Playwright)
├── Tab 1 (Channel A) ← discord-observer.js injected
├── Tab 2 (Channel B) ← discord-observer.js injected  
└── Tab N (Channel N) ← discord-observer.js injected
                ↓
        Message Detection (MutationObserver)
                ↓
        Filter & Process (MessageFilter)
                ↓
        Store in Database (PostgreSQL)
```

## Database Schema

### Tables
- `channels`: Channel metadata
- `messages`: All captured messages with full context
- `threads`: Thread/reply relationships

### Indexes
- Optimized for channel, timestamp, and author queries
- Ready for vector embedding columns

## Message Filtering

The system automatically filters out:
- Short messages (< 3 characters by default)
- Common greetings ("hi", "hello", "good morning", etc.)
- Emoji-only messages
- Bot messages (optional)
- Custom trivial phrases

## Future AI Integration

The database schema includes:
- `embedding` column (VECTOR type) for message embeddings
- `raw_data` JSONB column for additional context
- Optimized queries for semantic search

Example future usage:
```sql
-- Semantic search for similar messages
SELECT * FROM messages 
ORDER BY embedding <-> $1 
LIMIT 10;
```

## Development

### Scripts
- `pnpm run dev`: Start with auto-reload
- `pnpm run start`: Start production mode
- `pnpm run build`: Compile TypeScript

### Project Structure
```
src/
├── index.ts              # Main entry point
├── discord-monitor.ts    # Core monitoring logic
├── discord-observer.js   # Injected browser script
├── database.ts          # Database operations
├── message-filter.ts    # Message filtering logic
├── config.ts           # Configuration management
└── types.ts            # TypeScript interfaces
```

## Troubleshooting

### Common Issues

1. **Browser won't start**: Install Playwright browsers with `pnpm playwright install chromium`
2. **Database connection failed**: Check PostgreSQL credentials in `.env`
3. **No messages detected**: Verify channel IDs and Discord login state
4. **Rate limiting**: Reduce number of channels or add delays

### Debugging

- Check `discord-monitor.log` for detailed logs
- Use browser console to debug injected scripts
- Enable debug logging: set `LOG_LEVEL=debug`

## Security Notes

- Store Discord session state securely (`STORAGE_STATE_PATH`)
- Use environment variables for sensitive data
- Consider running in a separate browser profile
- Monitor for Discord ToS compliance

## License

ISC License - See package.json for details