Project Goal:
Build a Playwright-based automation tool that opens multiple browser tabs,
each connected to a specific Discord channel (Web version), in order to
monitor and capture live messages in real-time.
Key Features & Requirements:

1. Multi-tab architecture:

Open one tab per Discord channel.
Share the same browser session (logged-in account via storageState).
Inject a MutationObserver script in each tab to detect newly rendered messages
(.messageContent) and metadata (author, timestamp, message ID).

2. Message Filtering:

Ignore trivial messages such as short greetings ("hi", "good morning") with no
meaningful content.
Use a configurable list or heuristic to define what qualifies as “low-value”
messages.

3. Thread & Reply Handling:

If a message is a direct reply to another message, store it together with the
original message in a linked structure (e.g., thread object).

4. Storage Layer:

Store parsed messages in a local database.
Start with PostgreSQL for structured storage (channel_id, message_id,
timestamp, text, author_id, reply_to, etc.).
Consider designing the DB schema to be easily extended.

5. Future AI Integration:

Future goal: enable quick retrieval and AI-assisted responses based on past
channel messages.
For semantic search, consider integrating a vector database (e.g., PostgreSQL

- pgvector extension, or external services like Weaviate, Pinecone, Qdrant).
  Store message embeddings alongside raw text for future AI queries.

6. Data Pipeline:

Browser injection → MutationObserver detects new messages → send data to
Node.js main process → apply filtering & thread linking → store in database.

7. Performance & Reliability:

Handle 3~5 channels in parallel with minimal CPU/memory overhead.
Avoid excessive DOM queries (only react to nodes added via MutationObserver).

8. Code Quality:

Modular architecture: separate scraping, filtering, storage, and
AI-integration logic.
Include logging and error handling for long-running execution.
