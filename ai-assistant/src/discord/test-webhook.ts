#!/usr/bin/env bun

import { DiscordWebhookSender } from './webhook-sender.js'
import type { QuestionAnalysis } from '../ai/message-analyzer.js'

async function testWebhook() {
  console.log('🔧 Testing Discord Webhook...')

  try {
    const webhookSender = new DiscordWebhookSender()

    // Test basic webhook connection
    console.log('📡 Testing basic connection...')
    const connectionTest = await webhookSender.testWebhook()

    if (!connectionTest) {
      console.log('❌ Basic webhook test failed')
      return
    }

    console.log('✅ Basic webhook test passed')

    // Test question and answer formatting
    console.log('📝 Testing question/answer embed...')

    const mockAnalysis: QuestionAnalysis = {
      message: {
        source: 'discord',
        messageId: '1405242049594396693',
        spaceId: '1287736665103798433',
        spaceName: 'Test Guild',
        channelId: '1389296411253670141',
        channelName: 'test-channel',
        authorId: 'test-user-789',
        authorName: 'TestUser',
        content: 'How do I configure webpack for React development?',
        timestamp: new Date(),
        replyToMessageId: null,
        threadId: null,
        rawData: {},
      },
      isQuestion: true,
      questionType: 'technical',
      confidence: 95,
      extractedQuestion: 'How do I configure webpack for React development?',
      suggestedAnswer:
        "To configure webpack for React development, you'll need to:\n\n1. Install the necessary dependencies: `webpack`, `webpack-cli`, `@babel/core`, `@babel/preset-react`, `babel-loader`\n2. Create a webpack.config.js file with React-specific loaders\n3. Configure Babel preset for JSX transformation\n4. Set up development and production modes\n\nHere's a basic configuration example:\n```javascript\nmodule.exports = {\n  entry: './src/index.js',\n  module: {\n    rules: [\n      {\n        test: /\\.(js|jsx)$/,\n        exclude: /node_modules/,\n        use: {\n          loader: 'babel-loader',\n          options: {\n            presets: ['@babel/preset-react']\n          }\n        }\n      }\n    ]\n  }\n};\n```",
      contextMessages: [],
    }

    await webhookSender.sendQuestionAndAnswer(mockAnalysis)
    console.log('✅ Question/answer embed test passed')

    console.log('🎉 All webhook tests completed successfully!')
  } catch (error) {
    console.error('❌ Webhook test failed:', error)
    process.exit(1)
  }
}

// Run test if this file is executed directly
if (import.meta.main) {
  testWebhook()
}
