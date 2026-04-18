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

/**
 * Read cached registry if still valid.
 * Returns { bots } or null.
 */
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

/**
 * Get tenant_access_token from Feishu API.
 */
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

/**
 * Send a text message to a Feishu chat using a specific bot's token.
 */
async function sendFeishuMessage(token, chatId, text, domain) {
  const base = domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  const url = `${base}/open-apis/im/v1/messages?receive_id_type=chat_id`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  });
  const json = await res.json();
  if (json.code !== 0) {
    debugLog(`[sendFeishuMessage] Failed: ${json.msg}`);
  }
  return json;
}

/**
 * Get bot info (open_id, bot_name) from Feishu API.
 */
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

/**
 * Get all bot members in a group chat.
 * Returns a Set of open_ids for bots in the chat.
 */
async function getGroupBotMembers(token, chatId, domain) {
  const base = domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  const botOpenIds = new Set();
  let pageToken = '';
  for (let i = 0; i < 10; i++) { // max 10 pages
    const params = new URLSearchParams({ member_id_type: 'open_id', page_size: '100' });
    if (pageToken) params.set('page_token', pageToken);
    const url = `${base}/open-apis/im/v1/chats/${chatId}/members?${params}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    if (json.code !== 0) {
      debugLog(`[getGroupBotMembers] API error: ${json.msg}`);
      break;
    }
    const items = json.data?.items || [];
    for (const m of items) {
      // member_type: "bot" for bots
      if (m.member_type === 'bot' && m.member_id) {
        botOpenIds.add(m.member_id);
      }
    }
    if (!json.data?.has_more) break;
    pageToken = json.data.page_token || '';
  }
  return botOpenIds;
}

/**
 * Discover all Feishu bots from OpenClaw config.
 *
 * 1. Read bindings → filter feishu channel with accountId → agentId→accountId map
 * 2. Read channels.feishu.accounts → accountId→{appId, appSecret, botName}
 * 3. Check cache; if miss, call Feishu API for each account to get botOpenId
 * 4. Write cache and return botRegistry
 */
async function discoverBots(config, log) {
  const bindings = config.bindings || [];
  const feishuChannel = config.channels?.feishu || {};
  const accounts = feishuChannel.accounts || {};
  const domain = feishuChannel.domain || 'feishu';

  // Step 1: agentId → accountId (only bindings with explicit accountId match)
  const agentAccountMap = new Map();
  for (const b of bindings) {
    if (b.match?.channel === 'feishu' && b.match?.accountId) {
      agentAccountMap.set(b.agentId, b.match.accountId);
    }
  }

  debugLog(`[discover] Found ${agentAccountMap.size} feishu agent-account bindings`);
  if (agentAccountMap.size === 0) return {};

  // Step 2: filter accounts that have appId+appSecret (skip "default" etc.)
  const validAccounts = new Map();
  for (const [accountId, acct] of Object.entries(accounts)) {
    if (acct.appId && acct.appSecret) {
      validAccounts.set(accountId, acct);
    }
  }

  // Step 3: check cache
  const cached = readCache();
  if (cached?.bots) {
    // Validate cache still covers all current bindings
    const allCovered = [...agentAccountMap.keys()].every(agentId => cached.bots[agentId]);
    if (allCovered) {
      return cached.bots;
    }
    debugLog(`[discover] Cache incomplete, re-discovering`);
  }

  // Step 4: call Feishu API for each account
  const bots = {};
  const tokenCache = new Map(); // accountId → token (avoid duplicate calls for same account)

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
      // Try to use cached entry if available
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
  description: 'Enables bot-to-bot @ communication in Feishu group chats',

  register(api) {
    const cfg = api.pluginConfig ?? {};
    const maxChainDepth = cfg.maxChainDepth ?? 3;
    const log = api.logger;

    // Chain depth tracking: sessionKey -> depth
    const chainDepthMap = new Map();
    // Track which runIds we've already forwarded to avoid duplicates
    const forwardedRuns = new Set();

    // Feishu account config for sending messages directly
    const feishuChannel = api.config?.channels?.feishu || {};
    const feishuAccounts = feishuChannel.accounts || {};
    const feishuDomain = feishuChannel.domain || 'feishu';

    if (_registerCount === 0) {
      debugLog(`REGISTER called — maxChainDepth=${maxChainDepth}`);
    }

    // Shared state: populated sync (manual config) or async (auto-discovery)
    let botRegistry = {};
    const accountToBotMap = new Map();
    const botOpenIdSet = new Set();
    const botOpenIdToAgentMap = new Map();
    const agentIdSet = new Set();

    function buildLookups(registry) {
      botRegistry = registry;
      accountToBotMap.clear();
      botOpenIdSet.clear();
      botOpenIdToAgentMap.clear();
      agentIdSet.clear();

      for (const [agentId, bot] of Object.entries(registry)) {
        accountToBotMap.set(bot.accountId, { agentId, ...bot });
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

      // Auto-enable heartbeat for discovered bots
      ensureHeartbeatEnabled([...agentIdSet]);
    }

    function ensureHeartbeatEnabled(agentIds) {
      if (agentIds.length === 0) return;

      try {
        const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
        const configRaw = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(configRaw);

        if (!config.agents) config.agents = {};
        if (!config.agents.list) config.agents.list = [];

        let modified = false;
        for (const agentId of agentIds) {
          let agent = config.agents.list.find(a => a.id === agentId);
          if (!agent) {
            agent = { id: agentId };
            config.agents.list.push(agent);
            modified = true;
          }
          if (!agent.heartbeat) {
            agent.heartbeat = { every: '999m' };
            modified = true;
            debugLog(`[ensureHeartbeat] Added heartbeat to ${agentId}`);
            log.info(`[feishu-bot-chat] Auto-enabled heartbeat for ${agentId}`);
          }
        }

        if (modified) {
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
          debugLog(`[ensureHeartbeat] Updated config with heartbeat for ${agentIds.length} agents`);
          log.warn('[feishu-bot-chat] Updated openclaw.json with heartbeat config — restart gateway to apply');
        }
      } catch (e) {
        debugLog(`[ensureHeartbeat] Failed: ${e.message}`);
        log.error(`[feishu-bot-chat] Failed to auto-enable heartbeat: ${e.message}`);
      }
    }

    // Determine botRegistry source
    if (cfg.botRegistry && Object.keys(cfg.botRegistry).length > 0) {
      // Manual config takes priority
      debugLog(`Using manual botRegistry with ${Object.keys(cfg.botRegistry).length} bots`);
      buildLookups(cfg.botRegistry);
    } else {
      // Auto-discover (async — hooks registered immediately, lookups populated when ready)
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
    // Hook 1: before_prompt_build — 注入可用 Bot 列表
    // ========================================================================
    api.on('before_prompt_build', (event, ctx) => {
      if (ctx.channelId !== 'feishu') return;

      const currentAgentId = ctx.agentId;

      const otherBots = Object.entries(botRegistry)
        .filter(([agentId]) => agentId !== currentAgentId)
        .map(([agentId, bot]) => {
          const desc = bot.description ? ` — ${bot.description}` : '';
          const atTag = `<at user_id="${bot.botOpenId}">${bot.botName}</at>`;
          return `- ${atTag}${desc}`;
        });

      if (otherBots.length === 0) return;

      const botList = otherBots.join('\n');
      const instruction = `[A2A Bridge — 群内协作规则]\n\n默认行为：\n- 正常情况下不要主动 @ 其他机器人\n- 每次回复最多 @ 1 个机器人\n\n重要：区分"提到"和"请求"\n- 如果你只是在回复中提到某个机器人，直接用它的名字（如"文案助手"），不要用 <at> 标签\n- 只有当你确实需要对方执行任务、回答问题时，才使用 <at> 标签\n- <at> 标签会触发实际的消息转发，所以不要随意使用\n\n触发协作：\n- 当用户提到"群内协作"、"分配任务"、"协作完成"等关键字时，你可以根据任务需要，主动 @ 合适的机器人分配子任务\n- 当用户明确要求你联系某个机器人时，也可以 @\n\n回复规则：\n- 如果你是被其他机器人通过 [A2A Bridge 转发] @ 的（消息类型为"任务请求"），请直接输出你的处理结果（不要使用 message 工具），插件会自动将你的输出发送到群聊中。按转发消息中的指示 @ 回发起者\n- 如果你收到的是"结果回传"类型的消息，说明对方已经完成了你分配的任务并把结果告诉你了，此时绝对不要再 @ 回对方，直接整理结果回复用户即可\n- 如果你是被用户直接 @ 的，不需要 @ 任何机器人（除非用户要求或触发了协作关键字）\n- 如果你 @ 其他机器人只是为了通知或共享信息，不需要对方回复或执行任务，请在消息中明确说明"仅供参考，无需回复"，这样对方就不会 @ 你触发不必要的回传\n\n通知标记（工程化控制）：\n- 如果你 @ 其他机器人只是单向通知、共享结果，不需要对方回复或 @ 你，请在消息中加上 🔕仅通知 标记\n- 插件检测到此标记后，转发时不会要求对方 @ 回你，从根本上避免不必要的回传\n- 示例：「🔕仅通知 <at ...>xxx</at> 排期已确认，按原计划推进即可」\n\n当你确实需要 @ 其他机器人时，必须直接在回复正文中写 <at> 标签，不要使用 feishu_im_user_message 工具。\n\n可用机器人列表（仅供参考，不要主动 @ 他们）：\n${botList}`;

      return { appendSystemContext: instruction };
    });

    // ========================================================================
    // Hook 2: llm_output — 检测 <at> 标签，转发给目标 bot
    // ========================================================================
    api.on('llm_output', (event, ctx) => {
      debugLog(`[llm_output] FIRED — agentId=${ctx.agentId}, channelId=${ctx.channelId}, runId=${ctx.runId}, sessionKey=${ctx.sessionKey}`);

      if (!ctx.agentId || !agentIdSet.has(ctx.agentId)) {
        debugLog(`[llm_output] SKIP: agentId=${ctx.agentId} not in registry`);
        return;
      }

      // Only process feishu group sessions
      const sessionKey = ctx.sessionKey || '';
      const groupMatchEarly = sessionKey.match(/:feishu:group:(oc_[^:]+)(.*)?$/);
      if (!groupMatchEarly) {
        debugLog(`[llm_output] SKIP: not a feishu group session`);
        return;
      }

      // Extract group chat ID early (needed for both auto-send and forwarding)
      const chatId = groupMatchEarly[1];
      const threadSuffix = groupMatchEarly[2] || '';

      // Deduplicate: only forward once per runId
      const runId = ctx.runId;
      if (runId && forwardedRuns.has(runId)) {
        debugLog(`[llm_output] SKIP: runId=${runId} already forwarded`);
        return;
      }

      const fullText = (event.assistantTexts || []).join('\n');
      if (!fullText) return;

      debugLog(`[llm_output] fullText length=${fullText.length}, first200=${fullText.substring(0, 200)}`);

      // Auto-send to Feishu for A2A-triggered sessions (heartbeat-woken bots)
      // These sessions have channelId=cron-event, so output won't reach Feishu automatically
      const isA2ASession = chainDepthMap.has(sessionKey);
      if (isA2ASession) {
        const bot = botRegistry[ctx.agentId];
        if (bot) {
          const acct = feishuAccounts[bot.accountId];
          if (acct?.appId && acct?.appSecret) {
            (async () => {
              try {
                const token = await getTenantToken(acct.appId, acct.appSecret, feishuDomain);
                await sendFeishuMessage(token, chatId, fullText, feishuDomain);
                debugLog(`[llm_output] Auto-sent A2A response to chat=${chatId} as ${bot.botName}`);
              } catch (e) {
                debugLog(`[llm_output] Failed to auto-send A2A response: ${e.message}`);
              }
            })();
          }
        }
      }
      // Detect <at> tags targeting other bots
      const atTagRegex = /<at user_id="([^"]+)">([^<]+)<\/at>/g;
      let match;
      const forwardTargets = [];
      const seenAgentIds = new Set();

      while ((match = atTagRegex.exec(fullText)) !== null) {
        const targetOpenId = match[1];
        const targetBot = botOpenIdToAgentMap.get(targetOpenId);
        if (targetBot && targetBot.agentId !== ctx.agentId && !seenAgentIds.has(targetBot.agentId)) {
          forwardTargets.push(targetBot);
          seenAgentIds.add(targetBot.agentId);
        }
      }

      // Also detect plain @botName text
      for (const [agentId, bot] of Object.entries(botRegistry)) {
        if (agentId === ctx.agentId || seenAgentIds.has(agentId)) continue;
        const flexPattern = escapeRegExp(bot.botName).replace(/-/g, '-?');
        const pattern = new RegExp('@' + flexPattern, 'g');
        if (pattern.test(fullText)) {
          forwardTargets.push({ agentId, ...bot });
          seenAgentIds.add(agentId);
        }
      }

      debugLog(`[llm_output] forwardTargets count=${forwardTargets.length}, targets=${forwardTargets.map(t=>t.agentId).join(',')}`);
      if (forwardTargets.length === 0) return;

      // Limit: only forward to bots that were explicitly @-ed via <at> tag (max 3)
      // This prevents LLM from spamming all bots when it uses plain @botName
      if (forwardTargets.length > 3) {
        debugLog(`[llm_output] Too many targets (${forwardTargets.length}), trimming to first 3`);
        forwardTargets.length = 3;
      }

      // Check chain depth
      const currentDepth = (chainDepthMap.get(sessionKey) ?? 0) + 1;
      if (currentDepth > maxChainDepth) {
        log.warn(`[feishu-bot-chat] Chain depth exceeded (${currentDepth} > ${maxChainDepth}), skipping forward`);
        return;
      }

      // Mark as forwarded
      if (runId) forwardedRuns.add(runId);
      if (forwardedRuns.size > 100) {
        const iter = forwardedRuns.values();
        for (let i = 0; i < 50; i++) forwardedRuns.delete(iter.next().value);
      }

      const rt = api.runtime;
      if (!rt?.system) {
        debugLog(`[llm_output] FATAL: api.runtime.system not available`);
        return;
      }

      for (const target of forwardTargets) {
        const targetSessionKey = `agent:${target.agentId}:feishu:group:${chatId}${threadSuffix}`;
        chainDepthMap.set(targetSessionKey, currentDepth);

        const senderBot = botRegistry[ctx.agentId];
        const senderName = senderBot ? senderBot.botName : ctx.agentId;

        // depth=1: 初始任务请求，目标处理完后需要 @ 回发起者
        // depth>1: 结果回传，目标收到后直接整理结果，不要再 @ 回去
        // 🔕仅通知 / 🚫回传: 发起者明确标记不需要回传
        const isResultReturn = currentDepth > 1;
        const isNotifyOnly = /🔕仅通知|🚫回传/.test(fullText);
        let contextMessage;
        if (isResultReturn || isNotifyOnly) {
          const label = isNotifyOnly ? '仅通知' : '结果回传';
          contextMessage = `[A2A Bridge 转发 — ${label}] 来自「${senderName}」的消息：\n\n${fullText}\n\n${isNotifyOnly ? '对方标记了🔕仅通知，表示这条消息仅供参考，不需要你回复或 @ 回对方。请阅读后自行处理即可。' : '对方已完成你之前分配的任务，请直接整理结果回复用户，不要再 @ 回对方。'}`;
        } else {
          const senderAtTag = senderBot?.botOpenId ? `<at user_id="${senderBot.botOpenId}">${senderName}</at>` : senderName;
          contextMessage = `[A2A Bridge 转发 — 任务请求] 来自「${senderName}」在群聊中的消息：\n\n${fullText}\n\n请直接输出你的处理结果（不要使用 message 工具），在回复末尾 @ 回发起者 ${senderAtTag}。插件会自动将你的输出发送到群聊中。\n\n注意：插件已代你发送了确认消息"✍️ 收到，马上处理"，你只需输出完整的处理结果即可。`;
        }

        debugLog(`[llm_output] Forwarding to ${target.agentId}, sessionKey=${targetSessionKey}, depth=${currentDepth}`);
        log.info(`[feishu-bot-chat] Forwarding to ${target.agentId}, chatId=${chatId}, depth=${currentDepth}`);

        try {
          rt.system.enqueueSystemEvent(contextMessage, {
            sessionKey: targetSessionKey,
            contextKey: 'cron:a2a-bridge',
          });

          // Send immediate confirmation message as the target bot
          // Delay to let the sender's streaming message arrive first
          (async () => {
            try {
              await new Promise(r => setTimeout(r, 3000));
              const acct = feishuAccounts[target.accountId];
              if (acct?.appId && acct?.appSecret) {
                const token = await getTenantToken(acct.appId, acct.appSecret, feishuDomain);
                await sendFeishuMessage(token, chatId, `✍️ 收到，马上处理`, feishuDomain);
                debugLog(`[llm_output] Sent confirmation as ${target.botName} to chat=${chatId}`);
              } else {
                debugLog(`[llm_output] No credentials for ${target.accountId}, skipping confirmation`);
              }
            } catch (e) {
              debugLog(`[llm_output] Failed to send confirmation for ${target.agentId}: ${e.message}`);
            }
          })();

          const wakeOpts = {
            agentId: target.agentId,
            sessionKey: targetSessionKey,
            reason: 'hook:a2a-bridge-forward',
            heartbeat: { target: 'last' },
            deps: { getQueueSize: () => 0 },
          };

          // Fire-and-forget async retry loop
          (async () => {
            const maxWaitMs = 30000;
            const retryDelayMs = 2000;
            const startedAt = Date.now();
            let attempts = 0;

            for (;;) {
              attempts++;
              try {
                const result = await rt.system.runHeartbeatOnce(wakeOpts);
                debugLog(`[llm_output] runHeartbeatOnce for ${target.agentId}: status=${result?.status}, reason=${result?.reason} (attempt ${attempts})`);
                if (!result || result.status !== 'skipped' || result.reason !== 'requests-in-flight') break;
              } catch (e) {
                debugLog(`[llm_output] runHeartbeatOnce error for ${target.agentId}: ${e.message}`);
                break;
              }

              if (Date.now() - startedAt > maxWaitMs) {
                debugLog(`[llm_output] runHeartbeatOnce timeout for ${target.agentId} after ${attempts} attempts, falling back`);
                rt.system.requestHeartbeatNow({
                  agentId: target.agentId,
                  sessionKey: targetSessionKey,
                  reason: 'hook:a2a-bridge-forward',
                });
                break;
              }

              await new Promise(r => setTimeout(r, retryDelayMs));
            }
          })();

          log.info(`[feishu-bot-chat] Forwarded to ${target.agentId} via enqueue+runHeartbeatOnce`);
        } catch (err) {
          debugLog(`[llm_output] ERROR forwarding to ${target.agentId}: ${err.message}`);
          log.error(`[feishu-bot-chat] Failed to forward to ${target.agentId}: ${err.message}`);
        }
      }
    });

    // ========================================================================
    // Hook 3: message_sending — @botName → <at> 标签替换
    // ========================================================================
    api.on('message_sending', (event, ctx) => {
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
        return { content };
      }
    });

    // ========================================================================
    // Hook 4: inbound_claim — 人类消息重置链深度
    // ========================================================================
    api.on('inbound_claim', (event, ctx) => {
      if (event.channel !== 'feishu' || !event.isGroup) return;

      const isBotSender = botOpenIdSet.has(event.senderId);

      if (!isBotSender) {
        for (const [key] of chainDepthMap) {
          if (key.includes(event.conversationId)) {
            chainDepthMap.delete(key);
          }
        }
        return;
      }

      if (event.wasMentioned !== true) {
        log.info(`[feishu-bot-chat] Swallowing bot message (not mentioned) from ${event.senderId}`);
        return { handled: true };
      }
    });

    if (_registerCount === 0) {
      debugLog('All hooks registered successfully');
      log.info('[feishu-bot-chat] All hooks registered');
    }
  }
};

module.exports = plugin;
module.exports.default = plugin;
