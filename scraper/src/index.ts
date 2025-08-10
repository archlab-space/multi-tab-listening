import { DiscordMonitor } from './discord-monitor.js';
import { loadConfig, validateConfig } from './config.js';
import { setupDatabase } from './setup-database.js';

async function main() {
  console.log('🚀 Starting Discord Multi-Tab Monitor...');

  try {
    // Load and validate configuration
    const config = loadConfig();
    validateConfig(config);

    console.log(`📋 Configuration loaded:`);
    console.log(`   - Channels: ${config.channels.length}`);
    console.log(`   - Filtering: ${config.filtering.enabled ? 'enabled' : 'disabled'}`);
    console.log(`   - Database: ${config.database.host}:${config.database.port}/${config.database.database}`);

    // Setup database if needed
    console.log('🗄️  Setting up database...');
    await setupDatabase();

    // Create and start monitor
    console.log('🌐 Starting Discord monitor...');
    const monitor = new DiscordMonitor(config);
    
    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`\n📡 Received ${signal}, shutting down gracefully...`);
      
      // Save session state before shutting down
      if (config.storageStatePath) {
        try {
          await monitor.saveStorageState(config.storageStatePath);
        } catch (error) {
          console.warn('Could not save storage state:', error);
        }
      }
      
      await monitor.stop();
      console.log('✅ Discord monitor stopped');
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Start monitoring
    await monitor.start();

    console.log('✅ Discord monitor is now running...');
    console.log('📝 Logs are being written to discord-monitor.log');
    console.log('⏹️  Press Ctrl+C to stop');

    // Keep the process alive
    await new Promise(() => {}); // Run indefinitely

  } catch (error) {
    console.error('❌ Failed to start Discord monitor:', error);
    process.exit(1);
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

main();