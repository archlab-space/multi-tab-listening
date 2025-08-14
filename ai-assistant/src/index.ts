import { MessagePoller } from './scheduler/message-poller.js';

async function main() {
  console.log('🤖 Starting Discord AI Assistant');
  
  const poller = new MessagePoller();

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
  await poller.start();
}

main().catch(console.error);