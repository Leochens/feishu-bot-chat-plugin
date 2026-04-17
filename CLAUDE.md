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
- Caches results in `~/.openclaw/feishu-bot-chat/registry.json` (24h TTL)
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
- Debug logs written to `logs/a2a-debug-YYYY-MM-DD.log` (daily rotation)
- Use `tail -f logs/a2a-debug-$(date +%Y-%m-%d).log` to monitor plugin behavior
- Check registry cache at `~/.openclaw/feishu-bot-chat/registry.json`

### Configuration
Plugin config in `~/.openclaw/openclaw.json` under `plugins.feishu-bot-chat`:
- `maxChainDepth` (number, default: 3) - Max bot-to-bot call chain depth
- `botRegistry` (object) - Manual bot registry (overrides auto-discovery)

## Key Files

- **index.js** - Main plugin implementation (~612 lines)
- **openclaw.plugin.json** - Plugin metadata and config schema
- **package.json** - Minimal Node.js package definition
- **README.md** - Chinese documentation

## Dependencies

Runtime: Node.js native modules only (`fs`, `path`, `os`)
External: Feishu Open API (auth, bot info, messaging)
Platform: OpenClaw plugin system
