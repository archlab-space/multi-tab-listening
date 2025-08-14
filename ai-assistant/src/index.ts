import { MessagePoller } from './scheduler/message-poller.js';

async function main() {
  console.log('🤖 Starting Discord AI Assistant');
  
  const poller = new MessagePoller();

  // Test webhook connection on startup
  console.log('🔗 Testing Discord webhook connection...');
  const webhookWorking = await poller.testWebhook();
  if (webhookWorking) {
    console.log('✅ Discord webhook connection successful');
  } else {
    console.log('❌ Discord webhook connection failed - check DISCORD_WEBHOOK_URL');
    console.log('⚠️  AI Assistant will continue but won\'t send notifications');
  }

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n📋 Shutting down gracefully...');
    await poller.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n📋 Shutting down gracefully...');
    await poller.stop();
    process.exit(0);
  });

  // Start the message polling (this will run continuously)
  console.log('🚀 Starting message polling...');
  await poller.start();
}

main().catch(console.error);