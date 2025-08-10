// Discord Message Observer Script - Injected into Discord web pages
// This script runs in the browser context to detect new messages

(function() {
  'use strict';

  let observer;
  let processedMessages = new Set();

  function extractMessageData(messageElement) {
    try {
      // Discord's message structure (may need updates as Discord changes their DOM)
      const messageId = messageElement.id?.replace('chat-messages-', '') || 
                       messageElement.getAttribute('data-message-id') ||
                       messageElement.querySelector('[data-message-id]')?.getAttribute('data-message-id');
      
      if (!messageId) return null;

      // Extract content
      const contentElement = messageElement.querySelector('[data-slate-editor="true"]') || 
                           messageElement.querySelector('.messageContent') ||
                           messageElement.querySelector('.markup');
      const content = contentElement?.textContent?.trim() || '';

      // Extract author info
      const authorElement = messageElement.querySelector('.username') ||
                           messageElement.querySelector('[class*="username"]');
      const authorName = authorElement?.textContent?.trim() || 'Unknown';
      
      // Extract author ID (harder to get, might be in click handlers or data attributes)
      const authorId = messageElement.querySelector('[data-user-id]')?.getAttribute('data-user-id') ||
                      authorElement?.getAttribute('data-user-id') || 
                      'unknown';

      // Extract timestamp
      const timestampElement = messageElement.querySelector('time') ||
                              messageElement.querySelector('[datetime]');
      const timestamp = timestampElement?.getAttribute('datetime') || 
                       timestampElement?.getAttribute('title') ||
                       new Date().toISOString();

      // Check for reply/thread info
      const replyElement = messageElement.querySelector('[class*="replying"]') ||
                          messageElement.querySelector('.repliedMessage');
      const replyToMessageId = replyElement?.getAttribute('data-message-id') || null;

      // Extract channel info from URL or page context
      const channelId = window.location.pathname.split('/').pop() || 'unknown';

      // Check if it's in a thread
      const isThread = window.location.pathname.includes('/threads/');
      const threadId = isThread ? window.location.pathname.split('/threads/')[1]?.split('/')[0] : null;

      return {
        messageId,
        channelId,
        authorId,
        authorName,
        content,
        timestamp: new Date(timestamp),
        replyToMessageId,
        threadId,
        rawData: {
          url: window.location.href,
          element: messageElement.outerHTML.substring(0, 500), // Truncate for storage
          author: {
            name: authorName,
            id: authorId
          }
        }
      };
    } catch (error) {
      console.error('Error extracting message data:', error);
      return null;
    }
  }

  function handleNewMessage(messageElement) {
    const messageData = extractMessageData(messageElement);
    
    if (!messageData || !messageData.messageId) {
      return;
    }

    // Avoid processing the same message multiple times
    if (processedMessages.has(messageData.messageId)) {
      return;
    }
    
    processedMessages.add(messageData.messageId);

    // Send message to main process
    window.postMessage({
      type: 'DISCORD_MESSAGE',
      data: messageData
    }, '*');

    console.log('New Discord message detected:', messageData.content.substring(0, 50) + '...');
  }

  function startObserving() {
    // Find the messages container
    const messagesContainer = document.querySelector('[data-list-id="chat-messages"]') ||
                             document.querySelector('.messages') ||
                             document.querySelector('[class*="messages"]') ||
                             document.querySelector('.scroller');

    if (!messagesContainer) {
      console.log('Messages container not found, retrying in 2 seconds...');
      setTimeout(startObserving, 2000);
      return;
    }

    console.log('Discord observer: Found messages container, starting to observe...');

    // Process existing messages first
    const existingMessages = messagesContainer.querySelectorAll('[id^="chat-messages-"]') ||
                            messagesContainer.querySelectorAll('[data-message-id]') ||
                            messagesContainer.querySelectorAll('.message');
    
    existingMessages.forEach(messageElement => {
      const messageData = extractMessageData(messageElement);
      if (messageData?.messageId) {
        processedMessages.add(messageData.messageId);
      }
    });

    // Set up MutationObserver for new messages
    observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Check if the added node is a message
            if (node.id?.startsWith('chat-messages-') || 
                node.getAttribute?.('data-message-id') ||
                node.classList?.contains('message')) {
              handleNewMessage(node);
            }
            
            // Check if the added node contains messages
            const messageElements = node.querySelectorAll?.('[id^="chat-messages-"], [data-message-id], .message');
            messageElements?.forEach(handleNewMessage);
          }
        });
      });
    });

    observer.observe(messagesContainer, {
      childList: true,
      subtree: true
    });

    console.log('Discord observer: Started observing for new messages');
  }

  function stopObserving() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    processedMessages.clear();
  }

  // Start observing when page is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserving);
  } else {
    startObserving();
  }

  // Expose controls to the window object for debugging
  window.discordObserver = {
    start: startObserving,
    stop: stopObserving,
    processedCount: () => processedMessages.size,
    clear: () => processedMessages.clear()
  };

  // Handle page navigation (Discord is a SPA)
  let currentUrl = window.location.href;
  const urlObserver = new MutationObserver(() => {
    if (window.location.href !== currentUrl) {
      currentUrl = window.location.href;
      console.log('Discord observer: URL changed, restarting observer...');
      stopObserving();
      setTimeout(startObserving, 1000); // Give time for new content to load
    }
  });

  urlObserver.observe(document.body, {
    childList: true,
    subtree: true
  });

})();