const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
require('dotenv').config();

// Required environment variables
const {
  TELEGRAM_BOT_TOKEN,
  OPENAI_API_KEY,
  SUPPORT_GROUP_CHAT_ID,
  DELETED_GROUP_CHAT_ID,
  OWNER_USER_ID
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !OPENAI_API_KEY || !SUPPORT_GROUP_CHAT_ID || !DELETED_GROUP_CHAT_ID || !OWNER_USER_ID) {
  console.error('⛔ Missing required .env values. Ensure TELEGRAM_BOT_TOKEN, OPENAI_API_KEY, SUPPORT_GROUP_CHAT_ID, DELETED_GROUP_CHAT_ID, and OWNER_USER_ID are set.');
  process.exit(1);
}

// Parse owner ID as integer
const OWNER_ID = parseInt(OWNER_USER_ID, 10);
if (isNaN(OWNER_ID)) {
  console.error('⛔ OWNER_USER_ID must be a valid Telegram user ID integer');
  process.exit(1);
}

// Initialize the Telegram bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Initialize OpenAI API
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Chat IDs
const nearMobileSupportChatId = SUPPORT_GROUP_CHAT_ID;
const deletedMessagesChatId   = DELETED_GROUP_CHAT_ID;

console.log('Telegram bot is running...');

bot.on('message', async (msg) => {
  console.log('Received message object:', msg);

  const chatId = msg.chat.id;
  const messageId = msg.message_id;

  // Always skip messages from the owner
  if (msg.from.id === OWNER_ID) {
    console.log(`Message from OWNER (${msg.from.username || msg.from.first_name}), skipping moderation.`);
    return;
  }

  // Handle stories/media posts
  if (msg.story) {
    console.log('Message contains a story, marking for deletion and banning user.');

    const storyChat = msg.story.chat || {};
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

  // Determine the content to check: caption or text
  const messageContent = msg.caption || msg.text;
  if (!messageContent) {
    console.log('Non-text or captionless message received, ignoring.');
    return;
  }

  // Ensure this is the support group
  if (chatId.toString() !== nearMobileSupportChatId.toString()) {
    console.log(`Message from an untracked group (${chatId}) ignored.`);
    return;
  }

  console.log(`New message received from ${msg.from.username || msg.from.first_name}: ${messageContent}`);

  // Classify message type with retries
  try {
    const messageType = await retryDetectMessageType(messageContent, 3);
    console.log('Message type detected:', messageType);

    if (messageType === 'delete') {
      // Skip administrators and creator
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

// Retry wrapper for classification
async function retryDetectMessageType(messageContent, retries) {
  let attempts = 0;
  while (attempts < retries) {
    attempts++;
    console.log(`Attempt ${attempts}: Detecting message type for: "${messageContent}"`);
    try {
      const messageType = await detectMessageType(messageContent);
      if (['delete', 'normal'].includes(messageType)) {
        return messageType;
      }
      console.log(`Unexpected result: "${messageType}". Retrying...`);
    } catch (error) {
      console.error(`Error during attempt ${attempts}:`, error);
    }
  }
  throw new Error(`Failed to classify message after ${retries} attempts`);
}

// Function to detect message type
async function detectMessageType(messageContent) {
  try {
    console.log(`Prompting OpenAI to classify message: "${messageContent}"`);
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: `
You are a Scam/Spam detector bot for the NEARMobile Wallet Telegram group. In this group, we answer user doubts and solve wallet interaction issues. Classify the following message as "delete" or "normal" depending on if the message is clearly a promotion, scam, or spam. The prompt output can only be "delete" or "normal".

Guidelines:
1. Classify as "delete" if the message contains:
   - Claims of investment opportunities or trading signals.
   - Promoted trading pairs, leverage, stop-loss, or profit targets.
   - Attempts to lure members into trades or financial schemes.
   - Explicit or implied promotions of external trading platforms or services.
   - Content urging members to DM or interact outside the group.
   - Messages mentioning specific financial instruments (e.g., TON, LTC, leverage).

2. Classify as "normal" if the message:
   - Asks legitimate questions about the NEARMobile wallet or related issues.
   - Seeks technical help or guidance about wallet interactions.
   - Shares community-related updates, events, or discussions about the NEAR ecosystem.

Examples of messages to classify as "delete":
- "Trade: #BTC/USDT 🟢 LONG ZONE: 30,000 - 29,500 🀄️ LEVERAGE: 10x 🎯 Targets: 30,500, 31,000, 32,000 ⛔️ STOP-LOSS: 29,000"
- "Sign up for guaranteed trading profits! DM me for more info."
- "Earn $500/day with our proven trading system. DM for details!"

Examples of messages to classify as "normal":
- "How can I transfer funds using the NEARMobile wallet?"
- "Is there a way to resolve a stuck transaction?"
- "I have an issue logging into my NEARMobile wallet. Can anyone help?"

Evaluate each message based on these criteria and classify accordingly. The prompt output can only be "delete" or "normal"
`,
        },
        { role: 'user', content: messageContent },
      ],
    });
    return completion.choices[0].message.content.trim().toLowerCase();
  } catch (error) {
    console.error('Error during OpenAI API call:', error);
    throw error;
  }
}

// Prevent the process from crashing on unhandled errors
process.on('uncaughtException', err => console.error('uncaughtException:', err));
process.on('unhandledRejection', err => console.error('unhandledRejection:', err));
