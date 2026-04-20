# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Feishu Bot Chat Plugin** - An OpenClaw plugin that enables bot-to-bot @ communication in Feishu (Lark) group chats. Relies on Feishu's native `im:message.group_at_msg.include_bot:readonly` permission for message delivery between bots.

## Architecture

### Core Mechanism
When a bot @-mentions another bot in a group chat, Feishu natively delivers the message to the target bot's webhook (requires the `im:message.group_at_msg.include_bot:readonly` permission). The plugin handles bot discovery, prompt injection, and message formatting.

### Hook System
The plugin implements three OpenClaw hooks:

1. **`before_prompt_build`** - Injects available bot list into system prompts so bots know who they can @mention. Also detects if native delivery hasn't been confirmed yet and warns the user.
2. **`message_sending`** - Converts `@botName` text to Feishu `<at>` tags with correct `user_id`.
3. **`inbound_claim`** - Filters bot messages (swallows non-mentioned bot messages) and detects native bot-to-bot delivery confirmation.

### Auto-Discovery System
- Automatically discovers all Feishu bots from OpenClaw config (`~/.openclaw/openclaw.json`)
- Calls Feishu API (`bot/v3/info`) to get bot metadata (name, open_id)
- Caches results in `~/.openclaw/fbc-registry/registry.json` (24h TTL)

### Native Delivery Detection
- In `inbound_claim`, when a bot message arrives with `wasMentioned=true`, the plugin records that chat as having native A2A delivery confirmed (`nativeA2AChats` Set)
- If a chat hasn't been confirmed yet, `before_prompt_build` injects a warning about enabling the permission
- This is a passive detection — no canary messages needed, just observes real traffic

### Required Feishu Permission
Each bot app must have `im:message.group_at_msg.include_bot:readonly` enabled in the Feishu Developer Console (开发者后台 → 权限管理). Without this, bot @bot messages won't be delivered via webhook.

## Development

### No Build System
This is plain JavaScript with no build step. Edit `index.js` directly.

### Testing
No automated tests. Test by:
1. Installing plugin: `openclaw plugins install .`
2. Enabling: `openclaw plugins enable feishu-bot-chat`
3. Restarting gateway: `openclaw gateway --force`
4. Testing in Feishu group chat with multiple bots

### Debugging
Log file written daily to `logs/`:
- `a2a-debug-YYYY-MM-DD.log` - Human-readable debug logs (discovery, delivery detection, errors)

Monitor in real-time: `tail -f logs/a2a-debug-$(date +%Y-%m-%d).log`
Check registry cache: `~/.openclaw/fbc-registry/registry.json` (24h TTL)

### Configuration
Plugin config in `~/.openclaw/openclaw.json` under `plugins.feishu-bot-chat`:
- `botRegistry` (object) - Manual bot registry (overrides auto-discovery)

## Key Files

- **index.js** - Main plugin implementation (~340 lines)
- **openclaw.plugin.json** - Plugin metadata, config schema, and skills registration
- **package.json** - Node.js >=18.0.0, OpenClaw >=2026.3.24-beta.2
- **README.md** - Chinese documentation
- **skills/** - A2A collaboration skills for bots (6 skills total)

## Internal State

The plugin maintains several in-memory lookup maps built during `register()`:
- `botRegistry` - agentId → {accountId, botOpenId, botName}
- `nativeA2AChats` - Set of chatIds where native bot-to-bot delivery has been confirmed
- `botOpenIdSet`, `botOpenIdToAgentMap`, `agentIdSet` - reverse lookup tables
- `groupMemberCache` - chatId → {botOpenIds, fetchedAt} (10-min TTL, filters bot list to actual group members)

These are rebuilt on each gateway restart from auto-discovery results.

## Skills

The plugin provides 6 skills to help bots collaborate effectively:

1. **a2a-collaboration-guide** (alwaysActive) - Comprehensive reference for A2A collaboration rules
2. **a2a-task-decompose** - Task decomposition and delegation strategies
3. **a2a-result-merge** - Multi-bot result aggregation and conflict resolution
4. **a2a-interrupt** - Handling interruption and cancellation signals
5. **a2a-status-check** - Progress tracking and status reporting
6. **a2a-mode-switch** - Switching between collaboration modes (normal/solo/specified/full)

Skills are automatically loaded by OpenClaw from the `skills/` directory.

## Dependencies

Runtime: Node.js native modules only (`fs`, `path`, `os`)
External: Feishu Open API (auth, bot info)
Platform: OpenClaw plugin system
