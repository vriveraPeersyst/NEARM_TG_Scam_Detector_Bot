# Scam Detector Bot Improvements

## Context-Aware Message Detection

The bot has been improved to reduce false positives by analyzing user message history for better context.

### New Features

1. **Message History Storage**: The bot now stores the last 100 messages per chat in memory to build user context.

2. **Context-Aware Analysis**: Before classifying a message, the bot:
   - Retrieves the user's last 5 messages from the chat
   - Sends both current message and history to OpenAI for analysis
   - Uses conversation patterns to make better decisions

3. **Improved OpenAI Prompt**: The detection prompt now:
   - Considers user conversation history
   - Identifies legitimate users with consistent NEAR/NEARMobile questions
   - Better distinguishes between promotional content and legitimate discussions
   - Provides more context-aware classification

### How It Works

1. **Message Reception**: When a message arrives, the bot:
   - Gets the user's recent message history (before storing the new message)
   - Stores the current message for future context
   - Sends both current message and history to OpenAI

2. **Enhanced Classification**: OpenAI analyzes:
   - Current message content
   - User's conversation pattern
   - Context from previous legitimate questions/discussions

3. **Better Decision Making**: The bot is now more conservative with deletions:
   - Users with legitimate conversation history get more benefit of the doubt
   - Sudden promotional content from established users is handled more carefully
   - New users posting only promotional content are still flagged

### Benefits

- **Reduced False Positives**: Legitimate users asking questions won't be banned for unclear messages
- **Better Context Understanding**: The bot understands conversation flow and user intent
- **Improved Accuracy**: Message classification considers user behavior patterns
- **Memory Efficient**: Only stores last 100 messages per chat to avoid memory issues

### Technical Implementation

- In-memory message cache using Map data structure
- Non-blocking message storage
- Fallback handling for cases where history can't be retrieved
- Enhanced error handling and logging