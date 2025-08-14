# Discord Webhook Setup Guide

## Overview

The AI Assistant uses Discord webhooks to send question and answer notifications to your personal Discord channel. When a question is detected in monitored channels, the AI generates a suggested answer and sends both to your notification channel.

## Setup Steps

### 1. Create a Discord Webhook

1. **Open your Discord server** where you want to receive notifications
2. **Right-click on the target channel** → Settings → Integrations
3. **Click "Create Webhook"**
4. **Configure the webhook:**
   - Name: `AI Assistant` (or your preference)
   - Channel: Your notification channel
   - Avatar: Optional
5. **Copy the Webhook URL**

### 2. Configure Environment Variables

Add the webhook URL to your `.env` file:

```env
# Discord Webhook Configuration
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN
```

### 3. Test the Webhook

Run the test script to verify your webhook is working:

```bash
cd ai-assistant
bun run test-webhook
```

Expected output:
```
🔧 Testing Discord Webhook...
📡 Testing basic connection...
✅ Basic webhook test passed
📝 Testing question/answer embed...
✅ Question/answer embed test passed
🎉 All webhook tests completed successfully!
```

## Webhook Message Format

The AI Assistant sends rich embed messages with the following information:

### Embed Structure

- **Title**: 🤖 AI Assistant - Question Detected
- **Color**: Based on confidence level (Green=90%+, Yellow=80%+, Orange=70%+)
- **Fields**:
  - ❓ **Original Question**: Author and content
  - 🎯 **Extracted Question**: AI-parsed question
  - 💡 **Suggested Answer**: Generated response
  - 📊 **Analysis**: Confidence, type, context count
  - 🔗 **Original Message**: Link to source message

### Example Output

```
🤖 AI Assistant - Question Detected

❓ Original Question
Author: JohnDoe
Content: How do I configure webpack for React?

🎯 Extracted Question
How do I configure webpack for React development?

💡 Suggested Answer
To configure webpack for React development, you'll need to:
1. Install dependencies: webpack, @babel/preset-react...
[Detailed answer with code examples]

📊 Analysis
Confidence: 95%
Type: technical
Context Messages: 3

🔗 Original Message
[View in Discord](https://discord.com/channels/...)
```

## Configuration Options

### Rate Limiting

The webhook sender includes built-in rate limiting:
- **Batch size**: 5 questions per batch
- **Delay**: 500ms between requests
- **Retry handling**: Automatic retry on rate limits

### Webhook Behavior

- **Automatic sending**: Questions are sent immediately when detected
- **Error handling**: Webhook failures don't stop message processing
- **Startup test**: Connection is tested when the AI Assistant starts

## Troubleshooting

### Common Issues

1. **"Webhook test failed"**
   - Check your `DISCORD_WEBHOOK_URL` is correct
   - Verify the webhook still exists in Discord
   - Ensure the bot has permissions to send messages

2. **"Rate limited"**
   - Normal behavior for high-volume channels
   - Messages will be queued and sent when possible

3. **"Invalid response format"**
   - Discord webhook might be disabled
   - Check webhook permissions and channel access

### Debug Logs

Check the log files for detailed error information:
- `discord-webhook.log` - Webhook-specific logs
- `message-poller.log` - General processing logs

### Manual Testing

Test specific components:

```bash
# Test webhook connection only
bun run test-webhook

# Test full AI pipeline with webhook
bun run dev
# Then manually trigger processing
```

## Security Considerations

- **Keep webhook URLs private** - treat them like passwords
- **Regenerate webhooks** if compromised
- **Monitor usage** in Discord's audit logs
- **Use dedicated channels** for AI notifications

## Advanced Configuration

### Custom Message Format

Edit `src/discord/webhook-sender.ts` to customize:
- Embed colors and styling
- Field names and content
- Message formatting and truncation

### Multiple Webhooks

You can configure different webhooks for different types of questions by modifying the webhook sender logic.

### Webhook Rotation

For high-volume scenarios, implement webhook rotation to distribute load across multiple webhook URLs.