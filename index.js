'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEBUG_LOG_DIR = path.join(__dirname, 'logs');
const REGISTRY_DIR = path.join(os.homedir(), '.openclaw', 'fbc-registry');
const REGISTRY_PATH = path.join(REGISTRY_DIR, 'registry.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function getDebugLogPath() {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(DEBUG_LOG_DIR, `a2a-debug-${date}.log`);
}

function debugLog(msg) {
  try {
    fs.mkdirSync(DEBUG_LOG_DIR, { recursive: true });
    fs.appendFileSync(getDebugLogPath(), `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Auto-discovery: derive botRegistry from OpenClaw config + Feishu API
// ---------------------------------------------------------------------------

function readCache() {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
    const cached = JSON.parse(raw);
    if (cached.discoveredAt && Date.now() - new Date(cached.discoveredAt).getTime() < CACHE_TTL_MS) {
      debugLog(`[discover] Using cached registry (discoveredAt=${cached.discoveredAt})`);
      return cached;
    }
    debugLog(`[discover] Cache expired (discoveredAt=${cached.discoveredAt})`);
    return null;
  } catch (_) {
    return null;
  }
}

function writeCache(bots) {
  try {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    const data = { discoveredAt: new Date().toISOString(), bots };
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2));
    debugLog(`[discover] Wrote registry cache with ${Object.keys(bots).length} bots`);
  } catch (e) {
    debugLog(`[discover] Failed to write cache: ${e.message}`);
  }
}

async function getTenantToken(appId, appSecret, domain) {
  const base = domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  const url = `${base}/open-apis/auth/v3/tenant_access_token/internal`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`tenant_token failed: ${json.msg}`);
  return json.tenant_access_token;
}

async function getBotInfo(token, domain) {
  const base = domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  const url = `${base}/open-apis/bot/v3/info`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`bot/v3/info failed: ${json.msg}`);
  const bot = json.bot || {};
  return { botOpenId: bot.open_id, botName: bot.app_name || bot.bot_name };
}

async function discoverBots(config, log) {
  const bindings = config.bindings || [];
  const feishuChannel = config.channels?.feishu || {};
  const accounts = feishuChannel.accounts || {};
  const domain = feishuChannel.domain || 'feishu';

  const agentAccountMap = new Map();
  for (const b of bindings) {
    if (b.match?.channel === 'feishu' && b.match?.accountId) {
      agentAccountMap.set(b.agentId, b.match.accountId);
    }
  }

  debugLog(`[discover] Found ${agentAccountMap.size} feishu agent-account bindings`);
  if (agentAccountMap.size === 0) return {};

  const validAccounts = new Map();
  for (const [accountId, acct] of Object.entries(accounts)) {
    if (acct.appId && acct.appSecret) {
      validAccounts.set(accountId, acct);
    }
  }

  const cached = readCache();
  if (cached?.bots) {
    const allCovered = [...agentAccountMap.keys()].every(agentId => cached.bots[agentId]);
    if (allCovered) {
      return cached.bots;
    }
    debugLog(`[discover] Cache incomplete, re-discovering`);
  }

  const bots = {};
  const tokenCache = new Map();

  for (const [agentId, accountId] of agentAccountMap) {
    const acct = validAccounts.get(accountId);
    if (!acct) {
      debugLog(`[discover] No valid account config for accountId=${accountId}, skipping agent=${agentId}`);
      continue;
    }

    try {
      let token = tokenCache.get(accountId);
      if (!token) {
        token = await getTenantToken(acct.appId, acct.appSecret, domain);
        tokenCache.set(accountId, token);
      }

      const info = await getBotInfo(token, domain);
      bots[agentId] = {
        accountId,
        botOpenId: info.botOpenId,
        botName: info.botName,
      };
      debugLog(`[discover] Discovered: agent=${agentId}, accountId=${accountId}, botOpenId=${info.botOpenId}, botName=${info.botName}`);
      log.info(`[feishu-bot-chat] Discovered bot: ${agentId} → ${info.botName} (${info.botOpenId})`);
    } catch (e) {
      debugLog(`[discover] Failed for agent=${agentId}, accountId=${accountId}: ${e.message}`);
      log.warn(`[feishu-bot-chat] Failed to discover bot for ${agentId}: ${e.message}`);
      if (cached?.bots?.[agentId]) {
        bots[agentId] = cached.bots[agentId];
        debugLog(`[discover] Using stale cache for agent=${agentId}`);
      }
    }
  }

  if (Object.keys(bots).length > 0) {
    writeCache(bots);
  }

  return bots;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let _lastBotSignature = '';
let _registerCount = 0;

const plugin = {
  id: 'feishu-bot-chat',
  name: 'Feishu Bot Chat',
  description: 'Enables bot-to-bot @ communication in Feishu group chats via native delivery',

  register(api) {
    const cfg = api.pluginConfig ?? {};
    const log = api.logger;

    if (_registerCount === 0) {
      debugLog(`REGISTER called`);
    }

    // Shared state
    let botRegistry = {};
    const botOpenIdSet = new Set();
    const botOpenIdToAgentMap = new Map();
    const agentIdSet = new Set();

    // Track which group chats have confirmed native bot-to-bot delivery
    const nativeA2AChats = new Set();

    // Cache: chatId → { botOpenIds: Set, fetchedAt: number }
    const groupMemberCache = new Map();
    const GROUP_MEMBER_CACHE_TTL = 10 * 60 * 1000; // 10 min

    // Feishu account config for API calls
    const feishuChannel = api.config?.channels?.feishu || {};
    const feishuAccounts = feishuChannel.accounts || {};
    const feishuDomain = feishuChannel.domain || 'feishu';

    async function getGroupBotOpenIds(chatId) {
      const cached = groupMemberCache.get(chatId);
      if (cached && Date.now() - cached.fetchedAt < GROUP_MEMBER_CACHE_TTL) {
        return cached.botOpenIds;
      }

      // Get a token from any valid account
      let token = null;
      for (const [, acct] of Object.entries(feishuAccounts)) {
        if (acct.appId && acct.appSecret) {
          try {
            token = await getTenantToken(acct.appId, acct.appSecret, feishuDomain);
            break;
          } catch (_) { /* try next */ }
        }
      }
      if (!token) return null;

      const base = feishuDomain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
      const memberOpenIds = new Set();
      let pageToken = '';
      for (let i = 0; i < 10; i++) {
        const params = new URLSearchParams({ member_id_type: 'open_id', page_size: '100' });
        if (pageToken) params.set('page_token', pageToken);
        const url = `${base}/open-apis/im/v1/chats/${chatId}/members?${params}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        const json = await res.json();
        if (json.code !== 0) {
          debugLog(`[getGroupBotOpenIds] API error for chat=${chatId}: ${json.msg}`);
          return null;
        }
        for (const m of (json.data?.items || [])) {
          if (m.member_type === 'bot' && m.member_id) {
            memberOpenIds.add(m.member_id);
          }
        }
        if (!json.data?.has_more) break;
        pageToken = json.data.page_token || '';
      }

      const knownBotCount = botOpenIdSet.size;
      const foundCount = memberOpenIds.size;

      if (knownBotCount > 1 && foundCount <= 1) {
        debugLog(`[getGroupBotOpenIds] chat=${chatId} returned only ${foundCount} bots but registry has ${knownBotCount} — likely permission issue, skipping cache`);
        log.warn(`[feishu-bot-chat] Group member API returned suspiciously few bots (${foundCount}/${knownBotCount}) for chat=${chatId} — token may lack im:chat or im:chat.member:readonly permission`);
        return null;
      }

      groupMemberCache.set(chatId, { botOpenIds: memberOpenIds, fetchedAt: Date.now() });
      debugLog(`[getGroupBotOpenIds] chat=${chatId} has ${memberOpenIds.size} bots: ${[...memberOpenIds].join(', ')}`);
      return memberOpenIds;
    }

    function buildLookups(registry) {
      botRegistry = registry;
      botOpenIdSet.clear();
      botOpenIdToAgentMap.clear();
      agentIdSet.clear();

      for (const [agentId, bot] of Object.entries(registry)) {
        botOpenIdSet.add(bot.botOpenId);
        botOpenIdToAgentMap.set(bot.botOpenId, { agentId, ...bot });
        agentIdSet.add(agentId);
      }

      const signature = [...agentIdSet].sort().join(',');
      const isFirstOrChanged = _registerCount === 0 || signature !== _lastBotSignature;
      _registerCount++;
      _lastBotSignature = signature;

      if (isFirstOrChanged) {
        debugLog(`buildLookups: ${agentIdSet.size} bots ready — ${[...agentIdSet].join(', ')}`);
        log.info(`[feishu-bot-chat] ${agentIdSet.size} bots active: ${[...agentIdSet].join(', ')}`);
      }
    }

    // Determine botRegistry source
    if (cfg.botRegistry && Object.keys(cfg.botRegistry).length > 0) {
      debugLog(`Using manual botRegistry with ${Object.keys(cfg.botRegistry).length} bots`);
      buildLookups(cfg.botRegistry);
    } else {
      debugLog(`No manual botRegistry, starting auto-discovery...`);
      discoverBots(api.config, log).then(registry => {
        if (Object.keys(registry).length > 0) {
          buildLookups(registry);
        } else {
          log.warn('[feishu-bot-chat] Auto-discovery found 0 bots — plugin will be inactive');
        }
      }).catch(e => {
        debugLog(`Auto-discovery failed: ${e.message}`);
        log.error(`[feishu-bot-chat] Auto-discovery failed: ${e.message}`);
      });
    }

    // ========================================================================
    // Hook 1: before_prompt_build — 注入可用 Bot 列表（仅群内成员）
    // ========================================================================
    api.on('before_prompt_build', async (event, ctx) => {
      debugLog(`[before_prompt_build] event=${JSON.stringify({ channelId: ctx.channelId, isGroup: event.isGroup, agentId: ctx.agentId, conversationId: event.conversationId, sessionKey: ctx.sessionKey })}`);

      if (ctx.channelId !== 'feishu') return;

      const currentAgentId = ctx.agentId;

      // Extract chatId from sessionKey
      const sessionKey = ctx.sessionKey || '';
      const groupMatch = sessionKey.match(/:feishu:group:(oc_[^:]+)/);
      const chatId = groupMatch ? groupMatch[1] : null;

      // Try to get actual group members to filter bot list
      let groupBotOpenIds = null;
      if (chatId) {
        try {
          groupBotOpenIds = await getGroupBotOpenIds(chatId);
        } catch (e) {
          debugLog(`[before_prompt_build] Failed to get group members: ${e.message}`);
        }
      }

      const allOtherBots = Object.entries(botRegistry)
        .filter(([agentId]) => agentId !== currentAgentId);

      // Split into in-group and not-in-group
      let inGroupBots = allOtherBots;
      let notInGroupBots = [];

      if (groupBotOpenIds) {
        inGroupBots = allOtherBots.filter(([, bot]) => groupBotOpenIds.has(bot.botOpenId));
        notInGroupBots = allOtherBots.filter(([, bot]) => !groupBotOpenIds.has(bot.botOpenId));
      }

      if (inGroupBots.length === 0 && notInGroupBots.length === 0) return;

      const botList = inGroupBots
        .map(([, bot]) => {
          const desc = bot.description ? ` — ${bot.description}` : '';
          const atTag = `<at user_id="${bot.botOpenId}">${bot.botName}</at>`;
          return `- ${atTag}${desc}`;
        })
        .join('\n');

      // Note about bots not in this group
      let missingBotsNote = '';
      if (notInGroupBots.length > 0) {
        const missingNames = notInGroupBots.map(([, bot]) => bot.botName).join('、');
        missingBotsNote = `\n\n💡 以下机器人未在本群中，如需协作请让管理员将它们拉入群聊：${missingNames}`;
      }

      const hasNativeA2A = chatId && nativeA2AChats.has(chatId);

      let permissionNote = '';
      if (!hasNativeA2A) {
        permissionNote = `\n\n⚠️ 注意：当前群聊尚未检测到飞书原生 bot@bot 投递能力。如果你 @ 其他机器人后对方没有响应，请提醒用户在飞书开发者后台为每个机器人应用开通「接收群聊中机器人@机器人的消息」权限（im:message.group_at_msg.include_bot:readonly）。开通后，机器人之间就可以直接通过 @ 来通信了。`;
      }

      const instruction = `[A2A — 群内协作规则]

默认行为：
- 正常情况下不要主动 @ 其他机器人
- 每次回复最多 @ 1 个机器人

重要：区分"提到"和"请求"
- 如果你只是在回复中提到某个机器人，直接用它的名字，不要用 <at> 标签
- 只有当你确实需要对方执行任务、回答问题时，才使用 <at> 标签

触发协作：
- 当用户提到"群内协作"、"分配任务"、"协作完成"等关键字时，可以根据任务需要主动 @ 合适的机器人
- 当用户明确要求你联系某个机器人时，也可以 @

@ 的两种类型：

1. 任务型 @（需要对方完成任务并回传结果）：
   - 直接在回复中用 <at> 标签 @ 对方，说明任务内容
   - 对方完成后应该 @ 回你汇报结果
   - 你收到结果后，整理结果回复用户，不要再 @ 回对方

2. 通知型 @（只是告知信息，不需要对方回复）：
   - 在消息中加上 🔕仅通知 标记
   - 示例：「🔕仅通知 <at ...>xxx</at> 排期已确认，按原计划推进即可」
   - 对方收到后不需要 @ 回你

回复规则：
- 当其他机器人 @ 你并请求你执行任务时，处理完后在回复末尾 @ 回发起者汇报结果
- 如果对方只是通知你信息（消息中包含🔕仅通知），不需要 @ 回对方
- 如果对方是把结果回传给你，不要 @ 回对方，直接整理结果回复用户
- 如果你是被用户直接 @ 的，不需要 @ 任何机器人（除非用户要求或触发了协作关键字）

⚠️ @ 格式要求（非常重要）：
- 必须使用 <at user_id="ou_xxxx">名字</at> 格式
- 禁止使用 @名字 这种明文写法，明文写法不会触发飞书的 @ 投递
- 示例：<at user_id="ou_abc123">mac-前端</at> 请帮忙实现这个页面

${inGroupBots.length > 0 ? `本群中可用的机器人（仅供参考，不要主动 @ 他们）：\n${botList}` : '本群中暂无其他可协作的机器人。'}${missingBotsNote}${permissionNote}`;

      debugLog(`[before_prompt_build] Injecting bot list for agent=${currentAgentId}, inGroup=${inGroupBots.length}, notInGroup=${notInGroupBots.length}, hasNativeA2A=${hasNativeA2A}`);

      return { appendSystemContext: instruction };
    });

    // ========================================================================
    // Hook 2: message_sending — @botName → <at> 标签替换
    // ========================================================================
    api.on('message_sending', (event, ctx) => {
      debugLog(`[message_sending] channelId=${ctx.channelId}, agentId=${ctx.agentId}, contentLength=${event.content?.length}, content=${event.content?.substring(0, 200)}`);

      if (ctx.channelId !== 'feishu') return;

      let content = event.content;

      for (const [agentId, bot] of Object.entries(botRegistry)) {
        if (bot.accountId === ctx.accountId) continue;
        const flexPattern = escapeRegExp(bot.botName).replace(/-/g, '-?');
        const pattern = new RegExp('@' + flexPattern, 'g');
        const newContent = content.replace(
          pattern,
          `<at user_id="${bot.botOpenId}">${bot.botName}</at>`
        );
        if (newContent !== content) {
          debugLog(`[message_sending] Replaced @${bot.botName} with <at> tag`);
          content = newContent;
          log.info(`[feishu-bot-chat] Replaced @${bot.botName} with <at> tag`);
        }
      }

      // Add text fallback after <at> tags for streaming card visibility
      content = content.replace(
        /<at user_id="([^"]+)">([^<]+)<\/at>(?!\s*\([^)]+\))/g,
        (_, userId, name) => `<at user_id="${userId}">${name}</at> (${name})`
      );

      if (content !== event.content) {
        debugLog(`[message_sending] Final content (first 300 chars): ${content.substring(0, 300)}`);
        return { content };
      }
    });

    // ========================================================================
    // Hook 3: inbound_claim — 过滤 bot 消息 + 检测原生投递 + 注入发送者信息
    // ========================================================================
    api.on('inbound_claim', (event, ctx) => {
      debugLog(`[inbound_claim] event=${JSON.stringify({ channel: event.channel, isGroup: event.isGroup, senderId: event.senderId, wasMentioned: event.wasMentioned, conversationId: event.conversationId, content: event.content?.substring?.(0, 200) })}`);

      if (event.channel !== 'feishu' || !event.isGroup) return;

      const isBotSender = botOpenIdSet.has(event.senderId);

      if (!isBotSender) {
        debugLog(`[inbound_claim] Human message from ${event.senderId}, passing through`);
        return;
      }

      // A bot message arrived via Feishu webhook with wasMentioned=true
      // This confirms native bot-to-bot delivery is working for this chat
      if (event.wasMentioned === true) {
        const chatId = event.conversationId;
        if (chatId && !nativeA2AChats.has(chatId)) {
          nativeA2AChats.add(chatId);
          debugLog(`[inbound_claim] Native bot-to-bot delivery confirmed for chat=${chatId} (sender=${event.senderId})`);
          log.info(`[feishu-bot-chat] Native A2A delivery confirmed for chat=${chatId}`);
        }

        // Inject sender bot identity so the receiving agent knows how to @ back
        const senderBot = botOpenIdToAgentMap.get(event.senderId);
        if (senderBot && event.content) {
          const senderAtTag = `<at user_id="${senderBot.botOpenId}">${senderBot.botName}</at>`;
          const senderInfo = `[来自机器人「${senderBot.botName}」— 如需 @ 回对方请使用：${senderAtTag}]\n\n`;
          debugLog(`[inbound_claim] Injecting sender info: ${senderBot.botName} (${senderBot.botOpenId})`);
          return { content: senderInfo + event.content };
        }

        debugLog(`[inbound_claim] Bot @mention from ${event.senderId}, allowing through`);
        return;
      }

      // Bot message without mention — swallow it
      debugLog(`[inbound_claim] Swallowing bot message (not mentioned) from ${event.senderId}`);
      log.info(`[feishu-bot-chat] Swallowing bot message (not mentioned) from ${event.senderId}`);
      return { handled: true };
    });

    if (_registerCount === 0) {
      debugLog('All hooks registered successfully');
      log.info('[feishu-bot-chat] All hooks registered');
    }
  }
};

module.exports = plugin;
module.exports.default = plugin;
