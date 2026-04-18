# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Feishu Bot Chat Plugin** - An OpenClaw plugin that enables bot-to-bot @ communication in Feishu (Lark) group chats. This solves a platform limitation where Feishu doesn't deliver bot messages to other bots via webhooks.

## Architecture

### Core Mechanism
The plugin creates an internal communication channel between bots using OpenClaw's system event queue and heartbeat mechanism, bypassing Feishu's webhook limitations.

### Hook System
The plugin implements four OpenClaw hooks that work together:

1. **`before_prompt_build`** - Injects available bot list into system prompts so bots know who they can @mention
2. **`llm_output`** - Detects `<at>` tags in bot responses, forwards messages via system events to target bots
3. **`message_sending`** - Converts `@botName` text to Feishu `<at>` tags (fallback mechanism)
4. **`inbound_claim`** - Filters bot messages and resets chain depth on human messages

### Auto-Discovery System
- Automatically discovers all Feishu bots from OpenClaw config (`~/.openclaw/openclaw.json`)
- Calls Feishu API (`bot/v3/info`) to get bot metadata (name, description)
- Caches results in `~/.openclaw/fbc-registry/registry.json` (24h TTL)
- Auto-enables heartbeat for discovered bots to ensure they can receive forwarded messages

### Chain Depth Tracking
- Prevents infinite bot loops by tracking call chain depth (default max: 3)
- Depth=1: Initial task request from one bot to another
- Depth>1: Result returns or subsequent forwarding
- Human messages reset chain depth to 0

### Critical Implementation Details

**Heartbeat Triggering:**
- Uses `runHeartbeatOnce` with retry loop instead of `requestHeartbeatNow`
- This avoids the "request already in flight" skip behavior
- Ensures target bot actually processes the forwarded message

**Message Confirmation:**
- Sends immediate confirmation ("✍️ 收到，马上处理") when forwarding task requests (depth=1)
- No confirmation for result returns (depth>1) to avoid noise

**System Event Context Key:**
- Uses `contextKey: 'cron:a2a-bridge'` when enqueuing forwarded messages
- The `cron:` prefix is required to pass OpenClaw's heartbeat gate (`shouldInspectPendingEvents`)
- Without this prefix, the target bot's heartbeat won't consume the queued event

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
Two log files are written daily to `logs/`:
- `a2a-debug-YYYY-MM-DD.log` - Human-readable debug logs (discovery, forwarding, errors)
- `a2a-events-YYYY-MM-DD.jsonl` - Structured event log (JSONL format)

Monitor in real-time: `tail -f logs/a2a-debug-$(date +%Y-%m-%d).log`
Check registry cache: `~/.openclaw/fbc-registry/registry.json` (24h TTL)

### Configuration
Plugin config in `~/.openclaw/openclaw.json` under `plugins.feishu-bot-chat`:
- `maxChainDepth` (number, default: 3) - Max bot-to-bot call chain depth
- `botRegistry` (object) - Manual bot registry (overrides auto-discovery)

## Key Files

- **index.js** - Main plugin implementation (~640 lines)
- **openclaw.plugin.json** - Plugin metadata, config schema, and skills registration
- **package.json** - Node.js >=18.0.0, OpenClaw >=2026.3.24-beta.2
- **README.md** - Chinese documentation
- **skills/** - A2A collaboration skills for bots (6 skills total)

## Internal State

The plugin maintains several in-memory lookup maps built during `register()`:
- `botRegistry` - agentId → {accountId, botOpenId, botName}
- `chainDepthMap` - sessionKey → depth (loop prevention)
- `forwardedRuns` - Set of processed runIds (deduplication)
- `accountToBotMap`, `botOpenIdSet`, `botOpenIdToAgentMap`, `agentIdSet` - reverse lookup tables

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
External: Feishu Open API (auth, bot info, messaging)
Platform: OpenClaw plugin system
