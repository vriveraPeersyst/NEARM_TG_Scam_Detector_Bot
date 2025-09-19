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

// Optional whitelist of user IDs to never moderate
const optionalEnv = [
  'WHITELIST_USER_IDS'
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
  OWNER_USER_ID,
  WHITELIST_USER_IDS
} = process.env;

// 4. Validate OWNER_USER_ID is an integer
const OWNER_ID = parseInt(OWNER_USER_ID, 10);
if (isNaN(OWNER_ID)) {
  console.error('⛔ OWNER_USER_ID must be a valid Telegram user ID integer');
  process.exit(1);
}

// 5. Parse whitelist user IDs (optional)
let WHITELIST_IDS = [];
if (WHITELIST_USER_IDS) {
  try {
    WHITELIST_IDS = WHITELIST_USER_IDS.split(',')
      .map(id => parseInt(id.trim(), 10))
      .filter(id => !isNaN(id));
    console.log(`✅ Whitelist configured with ${WHITELIST_IDS.length} user IDs:`, WHITELIST_IDS);
  } catch (error) {
    console.error('⚠️ Invalid WHITELIST_USER_IDS format. Using empty whitelist.');
    WHITELIST_IDS = [];
  }
} else {
  console.log('ℹ️ No whitelist configured (WHITELIST_USER_IDS not set)');
}

// 5. Initialize bots and APIs
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const nearMobileSupportChatId = SUPPORT_GROUP_CHAT_ID;
const deletedMessagesChatId   = DELETED_GROUP_CHAT_ID;

console.log('Telegram bot is running...');

// Simple in-memory storage for user messages
const userMessageHistory = new Map(); // userId -> array of recent messages

// Function to store user message
function storeUserMessage(userId, messageContent) {
  if (!userMessageHistory.has(userId)) {
    userMessageHistory.set(userId, []);
  }
  
  const messages = userMessageHistory.get(userId);
  messages.push({
    content: messageContent,
    timestamp: Date.now()
  });
  
  // Keep only last 20 messages per user to avoid memory issues
  if (messages.length > 20) {
    messages.shift();
  }
}

// Function to get user's recent messages from our storage
function getUserRecentMessages(userId, limit = 10) {
  const messages = userMessageHistory.get(userId) || [];
  const recentMessages = messages.slice(-limit).map(msg => msg.content);
  
  console.log(`Found ${recentMessages.length} recent messages from user ${userId}`);
  
  if (recentMessages.length > 0) {
    console.log(`User's recent messages: ${recentMessages.map(msg => `"${msg.substring(0, 50)}..."`).join(', ')}`);
  }
  
  return recentMessages;
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

  // Skip messages from whitelisted users
  if (WHITELIST_IDS.includes(msg.from.id)) {
    console.log(`Message from WHITELISTED user (${msg.from.username || msg.from.first_name}), skipping moderation.`);
    return;
  }

  // ----- Handle stories/media posts -----
  if (msg.story) {
    console.log('Message contains a story, checking user permissions...');

    // Check if user is admin/creator before deleting story
    try {
      const chatMember = await bot.getChatMember(chatId, msg.from.id);
      if (['administrator', 'creator', 'owner'].includes(chatMember.status)) {
        console.log('Story is from an admin/creator, skipping deletion and banning.');
        return;
      }
    } catch (error) {
      console.error('Failed to check user permissions for story:', error);
      // Continue with deletion if we can't check permissions
    }

    console.log('User is not an admin, marking story for deletion and banning user.');

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

  // Check if user is admin/creator before analyzing message
  try {
    const chatMember = await bot.getChatMember(chatId, msg.from.id);
    if (['administrator', 'creator', 'owner'].includes(chatMember.status)) {
      console.log('Message is from an admin/creator, skipping moderation.');
      return;
    }
  } catch (error) {
    console.error('Failed to check user permissions:', error);
    // Continue with moderation if we can't check permissions
  }

  // Get user's recent messages (up to 9) BEFORE adding the current one
  const previousMessages = getUserRecentMessages(msg.from.id, 9);
  
  // Store the current message for this user
  storeUserMessage(msg.from.id, messageContent);
  
  // Combine previous messages with current message for analysis
  const messagesToAnalyze = [...previousMessages, messageContent];

  try {
    const userName = msg.from.first_name || msg.from.username || 'Unknown';
    const messageType = await retryDetectMessageType(messagesToAnalyze, userName, 3);
    console.log('User classification:', messageType);
    console.log(`Analyzed ${messagesToAnalyze.length} messages from user`);

    if (messageType === 'delete') {
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
async function retryDetectMessageType(userMessages, userName, retries) {
  let attempts = 0;
  while (attempts < retries) {
    attempts++;
    console.log(`Attempt ${attempts}: Analyzing ${userMessages.length} messages from user`);
    try {
      const messageType = await detectMessageType(userMessages, userName);
      // Extract just 'delete' or 'normal' from the response
      if (messageType.includes('delete')) {
        return 'delete';
      } else if (messageType.includes('normal')) {
        return 'normal';
      }
      console.log(`Unexpected result: "${messageType}". Retrying...`);
    } catch (error) {
      console.error(`Error during attempt ${attempts}:`, error);
    }
  }
  throw new Error(`Failed to classify messages after ${retries} attempts`);
}

// OpenAI classification call analyzing all user messages
async function detectMessageType(userMessages, userName) {
  try {
    console.log(`Prompting OpenAI to analyze ${userMessages.length} messages from user`);
    
    // Prepare all messages for analysis
    let analysisContent;
    
    if (userMessages.length === 1) {
      analysisContent = `User's display name: "${userName}"\n\nAnalyze this single message from the user: "${userMessages[0]}"\n\nPay special attention to impersonation attempts (users with official-sounding names offering private support).`;
    } else {
      const messagesText = userMessages
        .map((msg, index) => `${index + 1}. "${msg}"`)
        .join('\n');
      analysisContent = `User's display name: "${userName}"\n\nAnalyze all these messages from the user (oldest to newest):\n\n${messagesText}\n\nBased on ALL these messages and the user's display name, determine if this user should be deleted/banned or is normal. Pay special attention to impersonation attempts.`;
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
- CRITICAL: Users impersonating official support (names like "NEAR Mobile", "Support", "Admin") offering private help should be "delete"
- ANY message asking users to DM or contact privately for support should be "delete"

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
   - IMPERSONATION ATTEMPTS: Users pretending to be official support/staff
   - Messages asking users to "DM me", "message me privately", "contact me directly"
   - Fake support responses like "share your issue with me", "I will help you", "contact me for assistance"
   - Users with names like "NEAR Mobile", "Support", "Admin", "Official" who are not actual staff
   - Attempts to provide "customer support" or "technical assistance" via private messages
   - CRYPTO GIVEAWAY/AIRDROP SCAMS: Any mention of free tokens, vouchers, airdrops, or rewards
   - Messages promoting connecting wallets to external bots or websites
   - Any mention of "eligible to receive", "minimum prize", "voucher lottery", "free USDC/tokens"
   - Promotional content about bots (e.g., @usdcvouchersbot, @anytokenbot)
   - Messages about "connecting your wallet", "complete steps to receive", "enter lottery"
   - Any forwarded promotional content from channels/bots offering crypto rewards
   - Claims about "guaranteed" crypto rewards, prizes, or distributions

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
- "Hello, directly share your issue with me while I attend to it."
- "DM me for support with your wallet issues"
- "Contact me privately and I'll help you recover your funds"
- "I'm from NEAR support team, message me directly"
- "Introducing USDC VOUCHERS - Any holder of a SOL wallet is eligible to receive at least 100 USDC"
- "Connect your SOL wallet - Complete a few simple steps - You'll be automatically entered into the voucher lottery"
- "Free airdrop! Connect your wallet to @anybotname to claim your tokens"
- "Minimum prize is 500 USDC - Fair distribution - Immediate payouts"
- "You are eligible to receive free tokens! Visit our bot @examplebot"

Examples of messages to classify as "normal":
- "How can I transfer funds using the NEARMobile wallet?"
- "How can I earn NPRO tokens?"
- "Is there a way to resolve a stuck transaction?"
- "I have an issue logging into my NEARMobile wallet. Can anyone help?"

CRITICAL IMPERSONATION CHECK: If the user's display name is "NEAR Mobile", "Support", "Admin", "Official" or similar AND they are asking users to contact them privately or share issues directly, this is 100% a scammer impersonating official support and should be "delete".

CRITICAL CRYPTO SCAM CHECK: Any message promoting free crypto tokens, vouchers, airdrops, connecting wallets to bots, or "eligible to receive" crypto rewards is 100% a scam and should be "delete". These include USDC vouchers, token lotteries, wallet connection requests, and forwarded promotional content from crypto channels/bots.

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
