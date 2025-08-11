// Discord Message Observer Script - Injected into Discord web pages
// This script runs in the browser context to detect new messages

;(function () {
  'use strict'

  let observer
  let processedMessages = new Set()

  function extractMessageData(messageElement) {
    try {
      // Discord's message structure - updated for current DOM
      let messageId = null
      
      // Extract message ID from the li element's ID (format: chat-messages-{guild/channel}-{messageId})
      if (messageElement.id?.startsWith('chat-messages-')) {
        const parts = messageElement.id.replace('chat-messages-', '').split('-')
        messageId = parts[parts.length - 1] // Last part is the actual message ID
      }
      
      // Fallback to data attributes
      if (!messageId) {
        messageId = messageElement.getAttribute('data-message-id') ||
                   messageElement.querySelector('[data-message-id]')?.getAttribute('data-message-id')
      }

      if (!messageId) return null

      // Extract content from the main message content
      const contentElement =
        messageElement.querySelector('.messageContent_c19a55') ||
        messageElement.querySelector('[class*="messageContent"]') ||
        messageElement.querySelector('.markup__75297') ||
        messageElement.querySelector('[class*="markup"]')
      const content = contentElement?.textContent?.trim() || ''

      // Extract author info from the username span
      const authorElement =
        messageElement.querySelector('.username_c19a55') ||
        messageElement.querySelector('[class*="username"]')
      const authorName = authorElement?.textContent?.trim() || 'Unknown'

      // Extract author ID from avatar image src (Discord CDN pattern)
      let authorId = 'unknown'
      const avatarElement = messageElement.querySelector('.avatar_c19a55')
      if (avatarElement?.src) {
        const avatarMatch = avatarElement.src.match(/\/avatars\/(\d+)\//)
        if (avatarMatch) {
          authorId = avatarMatch[1]
        }
      }

      // Extract timestamp
      const timestampElement = messageElement.querySelector('time[datetime]')
      const timestamp = timestampElement?.getAttribute('datetime') || new Date().toISOString()

      // Check for reply info - updated for new Discord structure
      let replyToMessageId = null
      const replyElement = messageElement.querySelector('.repliedMessage_c19a55')
      if (replyElement) {
        // Try to extract reply message ID from the replied content element
        const repliedContent = replyElement.querySelector('[id^="message-content-"]')
        if (repliedContent?.id) {
          replyToMessageId = repliedContent.id.replace('message-content-', '')
        }
      }

      // Extract channel info from URL
      const pathParts = window.location.pathname.split('/')
      const channelId = pathParts[pathParts.length - 1] || 'unknown'

      // Check if it's in a thread
      const isThread = window.location.pathname.includes('/threads/')
      const threadId = isThread
        ? window.location.pathname.split('/threads/')[1]?.split('/')[0]
        : null

      // Check if this message has a reply (has the reply class)
      const hasReply = messageElement.querySelector('[class*="hasReply"]') !== null

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
          element: messageElement.outerHTML.substring(0, 1000), // Increased for better debugging
          hasReply,
          isReply: replyToMessageId !== null,
          author: {
            name: authorName,
            id: authorId,
          },
        },
      }
    } catch (error) {
      console.error('Error extracting message data:', error)
      return null
    }
  }

  function handleNewMessage(messageElement) {
    const messageData = extractMessageData(messageElement)

    if (!messageData || !messageData.messageId) {
      return
    }

    // Avoid processing the same message multiple times
    if (processedMessages.has(messageData.messageId)) {
      return
    }

    processedMessages.add(messageData.messageId)

    // Send message to main process via exposed function
    if (typeof window.handleDiscordMessage === 'function') {
      window.handleDiscordMessage(messageData)
    }

    console.log(
      'New Discord message detected:',
      messageData.content.substring(0, 50) + '...',
    )
  }

  function startObserving() {
    // Find the messages container - updated selectors for current Discord
    const messagesContainer =
      document.querySelector('[data-list-id="chat-messages"]') ||
      document.querySelector('ol[class*="scrollerInner"]') ||
      document.querySelector('[class*="messagesWrapper"]') ||
      document.querySelector('.scroller')

    if (!messagesContainer) {
      console.log('Messages container not found, retrying in 2 seconds...')
      setTimeout(startObserving, 2000)
      return
    }

    console.log(
      'Discord observer: Found messages container, starting to observe...',
    )

    // Process existing messages first - look for li elements with message IDs
    const existingMessages =
      messagesContainer.querySelectorAll('li[id^="chat-messages-"]') ||
      messagesContainer.querySelectorAll('.messageListItem__5126c') ||
      messagesContainer.querySelectorAll('[class*="messageListItem"]')

    existingMessages.forEach((messageElement) => {
      const messageData = extractMessageData(messageElement)
      if (messageData?.messageId) {
        processedMessages.add(messageData.messageId)
      }
    })

    // Set up MutationObserver for new messages
    observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Check if the added node is a message list item
            if (
              node.id?.startsWith('chat-messages-') ||
              node.classList?.contains('messageListItem__5126c') ||
              node.classList?.contains('messageListItem')
            ) {
              handleNewMessage(node)
            }

            // Check if the added node contains message list items
            const messageElements = node.querySelectorAll?.(
              'li[id^="chat-messages-"], .messageListItem__5126c, [class*="messageListItem"]',
            )
            messageElements?.forEach(handleNewMessage)
          }
        })
      })
    })

    observer.observe(messagesContainer, {
      childList: true,
      subtree: true,
    })

    console.log('Discord observer: Started observing for new messages')
  }

  function stopObserving() {
    if (observer) {
      observer.disconnect()
      observer = null
    }
    processedMessages.clear()
  }

  // Start observing when page is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserving)
  } else {
    startObserving()
  }

  // Expose controls to the window object for debugging
  window.discordObserver = {
    start: startObserving,
    stop: stopObserving,
    processedCount: () => processedMessages.size,
    clear: () => processedMessages.clear(),
  }

  // Handle page navigation (Discord is a SPA)
  let currentUrl = window.location.href
  const urlObserver = new MutationObserver(() => {
    if (window.location.href !== currentUrl) {
      currentUrl = window.location.href
      console.log('Discord observer: URL changed, restarting observer...')
      stopObserving()
      setTimeout(startObserving, 1000) // Give time for new content to load
    }
  })

  urlObserver.observe(document.body, {
    childList: true,
    subtree: true,
  })
})()
