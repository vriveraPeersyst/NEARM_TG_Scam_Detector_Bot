const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
require('dotenv').config();

// Initialize the Telegram bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Initialize OpenAI API
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Replace with the chat ID of the NEARMobile Telegram support group
const nearMobileSupportChatId = process.env.SUPPORT_GROUP_CHAT_ID; // Replace with the actual chat ID

// Replace with the chat ID of the "DELETED | NEARMobile" group
const deletedMessagesChatId = process.env.DELETED_GROUP_CHAT_ID; // Replace with actual chat ID

// Log when the bot starts
console.log('Telegram bot is running...');

bot.on('message', async (msg) => {
  console.log('Received message object:', msg); // Log the full message object for debugging

  const chatId = msg.chat.id;
  const messageId = msg.message_id;

  // Check if the message contains a story
  if (msg.story) {
    console.log('Message contains a story, marking for deletion and banning user.');

    // Log details about the story
    const storyChat = msg.story.chat || {};
    const storyDetails = `Shared story from @${storyChat.username || 'unknown'}: "${storyChat.title || 'No Title'}"`;

    // Attempt to delete and ban the user
    try {
      // Delete the message
      console.log('Deleting the story...');
      await bot.deleteMessage(chatId, messageId);
      console.log('Message deleted successfully.');

      // Notify the deleted messages group
      await bot.sendMessage(
        deletedMessagesChatId,
        `Deleted story or media post from user: ${msg.from.username || msg.from.first_name}\nDetails:\n${storyDetails}`
      );
      console.log('Notified deleted messages group.');

      // Ban the user
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

  console.log('Support group chat ID:', nearMobileSupportChatId);
  console.log('Deleted group chat ID:', deletedMessagesChatId);

  // Check if the message is from the NEARMobile support group
  if (chatId.toString() !== nearMobileSupportChatId.toString()) {
    console.log(`Message from an untracked group (${chatId}) ignored.`);
    return;
  }

  // Log the received message
  console.log(`New message received from ${msg.from.username || msg.from.first_name}: ${messageContent}`);

  // Detect the message type with retry logic
  try {
    const messageType = await retryDetectMessageType(messageContent, 3); // Retry up to 3 times
    console.log('Message type detected:', messageType);

    if (['delete'].includes(messageType)) {
      // Check the sender's status in the group
      const chatMember = await bot.getChatMember(chatId, msg.from.id);
      console.log('Sender status:', chatMember.status);

      if (['administrator', 'creator', 'owner'].includes(chatMember.status)) {
        console.log('Message is from an admin, owner or group creator, skipping deletion and banning.');
        return;
      }

      console.log(`Attempting to delete message: ${messageContent}`);
      await bot.deleteMessage(chatId, messageId);
      console.log('Message deleted successfully');

      // Forward the deleted message to the "DELETED | NEARMobile" group
      try {
        console.log('Forwarding deleted message to the deleted messages group...');
        await bot.sendMessage(
          deletedMessagesChatId,
          `Deleted and banned user: ${msg.from.username || msg.from.first_name}\nMessage:\n\n${messageContent}`
        );
      } catch (error) {
        console.error('Failed to forward the deleted message to the group:', error);
      }

      // Ban the user from the group
      console.log(`Banning user: ${msg.from.username || msg.from.first_name} (ID: ${msg.from.id})`);
      await bot.banChatMember(chatId, msg.from.id);
      console.log('User banned successfully');
    }
  } catch (error) {
    console.error('Error processing message:', error);
  }
});

// Function to detect message type with retry logic
async function retryDetectMessageType(messageContent, retries) {
  let attempts = 0;

  while (attempts < retries) {
    try {
      attempts++;
      console.log(`Attempt ${attempts}: Detecting message type for: "${messageContent}"`);

      const messageType = await detectMessageType(messageContent);

      if (['delete', 'normal'].includes(messageType)) {
        return messageType; // Valid result
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
