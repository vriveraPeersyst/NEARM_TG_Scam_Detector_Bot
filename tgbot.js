const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
require('dotenv').config();

// 1. List all required env-vars
const requiredEnv = [
  'TELEGRAM_BOT_TOKEN',
  'OPENAI_API_KEY',
  'SUPPORT_GROUP_CHAT_ID',
  'DELETED_GROUP_CHAT_ID',
  'OWNER_USER_ID'
];

// 2. Check which ones are missing
const missing = requiredEnv.filter(key => !process.env[key]);
if (missing.length) {
  console.error(`⛔ Missing required .env values: ${missing.join(', ')}`);
  process.exit(1);
}

// 3. Safe to destructure now
const {
  TELEGRAM_BOT_TOKEN,
  OPENAI_API_KEY,
  SUPPORT_GROUP_CHAT_ID,
  DELETED_GROUP_CHAT_ID,
  OWNER_USER_ID
} = process.env;

// 4. Validate OWNER_USER_ID is an integer
const OWNER_ID = parseInt(OWNER_USER_ID, 10);
if (isNaN(OWNER_ID)) {
  console.error('⛔ OWNER_USER_ID must be a valid Telegram user ID integer');
  process.exit(1);
}

// 5. Initialize bots and APIs
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const nearMobileSupportChatId = SUPPORT_GROUP_CHAT_ID;
const deletedMessagesChatId   = DELETED_GROUP_CHAT_ID;

console.log('Telegram bot is running...');

// Function to get user's recent messages directly from Telegram
async function getUserRecentMessages(chatId, userId, limit = 10) {
  try {
    console.log(`Getting last ${limit} messages from user ${userId} in chat ${chatId}`);
    
    const userMessages = [];
    let offset = 0;
    const batchSize = 100; // Get messages in batches
    
    // Search through recent messages to find messages from this user
    while (userMessages.length < limit && offset < 1000) { // Limit search to last 1000 messages
      try {
        // Get recent messages from the chat
        const updates = await bot.getUpdates({
          offset: offset,
          limit: batchSize
        });
        
        if (!updates || updates.length === 0) break;
        
        // Filter messages from this chat and user
        const matchingMessages = updates
          .filter(update => 
            update.message &&
            update.message.chat &&
            update.message.chat.id.toString() === chatId.toString() &&
            update.message.from &&
            update.message.from.id === userId &&
            (update.message.text || update.message.caption) // Only text/caption messages
          )
          .map(update => update.message.text || update.message.caption);
        
        userMessages.push(...matchingMessages);
        offset += batchSize;
        
        // If we didn't find any new messages in this batch, break
        if (matchingMessages.length === 0) {
          break;
        }
      } catch (apiError) {
        console.log('Could not retrieve message history via getUpdates, using alternative approach');
        break;
      }
    }
    
    // Take only the most recent messages up to the limit
    const recentMessages = userMessages.slice(-limit);
    
    console.log(`Found ${recentMessages.length} recent messages from user`);
    
    if (recentMessages.length > 0) {
      console.log(`User's recent messages: ${recentMessages.map(msg => `"${msg.substring(0, 50)}..."`).join(', ')}`);
    }
    
    return recentMessages;
    
  } catch (error) {
    console.error('Error getting user recent messages:', error);
    console.log('Falling back to analyzing just the current message');
    return []; // Return empty array if we can't get history
  }
}

bot.on('message', async (msg) => {
  console.log('Received message object:', msg);

  const chatId    = msg.chat.id;
  const messageId = msg.message_id;

  // Skip messages from the owner
  if (msg.from.id === OWNER_ID) {
    console.log(`Message from OWNER (${msg.from.username || msg.from.first_name}), skipping moderation.`);
    return;
  }

  // ----- Handle stories/media posts -----
  if (msg.story) {
    console.log('Message contains a story, marking for deletion and banning user.');

    const storyChat    = msg.story.chat || {};
    const storyDetails = `Shared story from @${storyChat.username || 'unknown'}: "${storyChat.title || 'No Title'}"`;

    try {
      console.log('Deleting the story...');
      await bot.deleteMessage(chatId, messageId);
      console.log('Message deleted successfully.');

      await bot.sendMessage(
        deletedMessagesChatId,
        `Deleted story or media post from user: ${msg.from.username || msg.from.first_name}\nDetails:\n${storyDetails}`
      );
      console.log('Notified deleted messages group.');

      console.log(`Banning user: ${msg.from.username || msg.from.first_name} (ID: ${msg.from.id})`);
      await bot.banChatMember(chatId, msg.from.id);
      console.log('User banned successfully.');
    } catch (error) {
      console.error('Failed to delete story or ban user:', error);
    }
    return;
  }

  // ----- Handle normal text/caption messages -----
  const messageContent = msg.caption || msg.text;
  if (!messageContent) {
    console.log('Non-text or captionless message received, ignoring.');
    return;
  }

  // Only moderate in the designated support group
  if (chatId.toString() !== nearMobileSupportChatId.toString()) {
    console.log(`Message from an untracked group (${chatId}) ignored.`);
    return;
  }

  console.log(`New message received from ${msg.from.username || msg.from.first_name}: ${messageContent}`);

  // Get user's recent messages (up to 10) including the current one
  const userMessages = await getUserRecentMessages(chatId, msg.from.id, 10);
  
  // Add the current message to the analysis (in case it wasn't captured in history)
  if (!userMessages.includes(messageContent)) {
    userMessages.push(messageContent);
  }
  
  // Keep only the last 10 messages
  const messagesToAnalyze = userMessages.slice(-10);

  try {
    const messageType = await retryDetectMessageType(messagesToAnalyze, 3);
    console.log('User classification:', messageType);
    console.log(`Analyzed ${messagesToAnalyze.length} messages from user`);

    if (messageType === 'delete') {
      // Skip admins/creator
      const chatMember = await bot.getChatMember(chatId, msg.from.id);
      if (['administrator', 'creator', 'owner'].includes(chatMember.status)) {
        console.log('Message is from an admin/creator, skipping deletion and banning.');
        return;
      }

      console.log(`Attempting to delete message: ${messageContent}`);
      await bot.deleteMessage(chatId, messageId);
      console.log('Message deleted successfully');

      try {
        console.log('Forwarding deleted message to the deleted messages group...');
        await bot.sendMessage(
          deletedMessagesChatId,
          `Deleted and banned user: ${msg.from.username || msg.from.first_name}\nMessage:\n\n${messageContent}`
        );
      } catch (error) {
        console.error('Failed to forward the deleted message:', error);
      }

      console.log(`Banning user: ${msg.from.username || msg.from.first_name} (ID: ${msg.from.id})`);
      await bot.banChatMember(chatId, msg.from.id);
      console.log('User banned successfully');
    }
  } catch (error) {
    console.error('Error processing message:', error);
  }
});

// Retry wrapper for analyzing user messages
async function retryDetectMessageType(userMessages, retries) {
  let attempts = 0;
  while (attempts < retries) {
    attempts++;
    console.log(`Attempt ${attempts}: Analyzing ${userMessages.length} messages from user`);
    try {
      const messageType = await detectMessageType(userMessages);
      if (['delete', 'normal'].includes(messageType)) {
        return messageType;
      }
      console.log(`Unexpected result: "${messageType}". Retrying...`);
    } catch (error) {
      console.error(`Error during attempt ${attempts}:`, error);
    }
  }
  throw new Error(`Failed to classify messages after ${retries} attempts`);
}

// OpenAI classification call analyzing all user messages
async function detectMessageType(userMessages) {
  try {
    console.log(`Prompting OpenAI to analyze ${userMessages.length} messages from user`);
    
    // Prepare all messages for analysis
    let analysisContent;
    
    if (userMessages.length === 1) {
      analysisContent = `Analyze this single message from the user: "${userMessages[0]}"`;
    } else {
      const messagesText = userMessages
        .map((msg, index) => `${index + 1}. "${msg}"`)
        .join('\n');
      analysisContent = `Analyze all these messages from the user (oldest to newest):\n\n${messagesText}\n\nBased on ALL these messages, determine if this user should be deleted/banned or is normal.`;
    }
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: `
You are a Scam/Spam detector bot for the NEARMobile Wallet Telegram group. In this group, we answer user doubts and solve wallet interaction issues, as well as NPRO token doubts. 

You will receive all available recent messages from a user (up to their last 10 messages). Analyze ALL the messages together to determine if this user should be classified as "delete" (ban/remove) or "normal" (legitimate user).

IMPORTANT: Analyze the overall pattern of ALL messages:
- If the user has been asking legitimate questions about NEAR/NEARMobile/NPRO, they're likely genuine
- If ALL or MOST messages are promotional/spam content, classify as "delete"
- If there's a mix but legitimate questions dominate, classify as "normal"
- New users with only promotional content should be "delete"
- Users with established legitimate conversation patterns should be "normal"

Only classify as "delete" if you are absolutely sure the user is a spammer/scammer based on their message pattern. If you are unsure, classify as "normal".

Guidelines:
1. Classify as "delete" if the message contains:
   - Claims of investment opportunities or trading signals
   - Promoted trading pairs, leverage, stop-loss, or profit targets
   - Attempts to lure members into trades or financial schemes
   - Explicit or implied promotions of external trading platforms or services
   - Content urging members to DM or interact outside the group
   - Messages mentioning specific financial instruments (e.g., TON, LTC, leverage)
   - Repeated promotional patterns in message history

2. Classify as "normal" if the message:
   - Asks legitimate questions about the NEARMobile wallet, NEAR, NPRO or related issues
   - Seeks technical help or guidance about wallet interactions
   - Shares community-related updates, events, or discussions about the NEAR ecosystem
   - Shows consistent legitimate conversation pattern in history
   - Could be legitimate based on conversation context

Examples of messages to classify as "delete":
- "Trade: #BTC/USDT 🟢 LONG ZONE: 30,000 - 29,500 🀄️ LEVERAGE: 10x 🎯 Targets: 30,500, 31,000, 32,000 ⛔️ STOP-LOSS: 29,000"
- "Sign up for guaranteed trading profits! DM me for more info."
- "Earn $500/day with our proven trading system. DM for details!"

Examples of messages to classify as "normal":
- "How can I transfer funds using the NEARMobile wallet?"
- "How can I earn NPRO tokens?"
- "Is there a way to resolve a stuck transaction?"
- "I have an issue logging into my NEARMobile wallet. Can anyone help?"

The prompt output can only be "delete" or "normal".
`
        },
        { role: 'user', content: analysisContent }
      ]
    });
    return completion.choices[0].message.content.trim().toLowerCase();
  } catch (error) {
    console.error('Error during OpenAI API call:', error);
    throw error;
  }
}

// Prevent crashes on unhandled errors
process.on('uncaughtException', err => console.error('uncaughtException:', err));
process.on('unhandledRejection', err => console.error('unhandledRejection:', err));
