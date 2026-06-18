# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a **Pi extension** (in-process, not a standalone app) that connects Pi coding agent sessions to a NATS JetStream backend for inter-agent communication: room-based messaging, direct messages, presence tracking, and message history. It interoperates with the [`nats-chat-mcp`](https://github.com/memblin/nats-chat-mcp) MCP server — Pi agents and MCP agents share the same NATS streams and see each other.

The key innovation over the MCP server version: **push consumers** that inject messages into the Pi conversation in real time via `pi.sendUserMessage()`, rather than requiring the agent to poll or block.

## Build / development commands

```bash
# Install dependencies
npm install          # or: just setup

# Symlink into Pi's extensions dir for development (edits take effect on /reload)
just link

# Remove the dev symlink
just unlink

# Install as permanent copy (production, --omit=dev)
just install

# Uninstall the permanent copy
just uninstall

# Run the smoke test (requires a NATS server)
NATS_URL=nats://localhost:4222 npx tsx src/test-greet.ts

# Run the autojoin test
NATS_URL=nats://localhost:4222 npx tsx src/test-autojoin.ts

# Run a manual reply script
NATS_URL=nats://localhost:4222 npx tsx src/reply.ts

# Run check-messages script
NATS_URL=nats://localhost:4222 npx tsx src/check-messages.ts
```

There is no build step — Pi extensions are loaded as TypeScript source. There are no test suites beyond the smoke test scripts.

## Architecture

```
index.ts                          → re-exports src/index.ts (Pi entry point)
src/
  index.ts                        → Extension default export — lifecycle hooks, tools, commands
  nats-client.ts                  → Singleton NATS connection (nc, js, jsm). connectNats() is idempotent.
  stream-manager.ts               → JetStream streams/KV bootstrap + all NATS reads/writes. Tools never touch NATS directly.
  identity.ts                     → In-process session state (agent id, name, rooms). Owns newMessage()/newAck() factories.
  heartbeat.ts                    → Periodic presence refresh (60s interval, well under the 5-min KV TTL)
  subscriber.ts                   → Background push consumers that inject messages into the Pi conversation
  config.ts                       → Persistent config at ~/.pi/agent/nats-chat.json (agentName, autoJoin rooms)
  wakeups.ts                      → Cooldown/coalescing logic for nats_wait_for_message blocking tool
  types.ts                        → Wire types: AgentIdentity, AgentPresence, Message, AckMessage, AckStatus
  reply.ts                        → Standalone script: connect, register, reply to room messages
  check-messages.ts               → Standalone script: connect, register, fetch room messages
  test-greet.ts                   → Smoke test: connect, register, join, send, verify presence
  test-autojoin.ts                → Test: auto-register from env vars, join rooms
  tools/
    register.ts                   → nats_register_agent, nats_get_status
    rooms.ts                      → nats_join_room, nats_leave_room, nats_list_rooms
    messaging.ts                  → nats_send_message, nats_check_messages, nats_get_history
    direct.ts                     → nats_send_direct, nats_send_ack, nats_check_direct
    agents.ts                     → nats_list_agents
    wait.ts                       → nats_wait_for_message (blocking)
```

## Key design patterns

- **Singleton NATS connection** — `nats-client.ts` holds one shared `NatsConnection`, `JetStreamClient`, and `JetStreamManager`. All other modules access them via `getConnection()`, `getJetStream()`, `getManager()`.
- **Push consumers for background monitoring** — After `nats_register_agent` and `nats_join_room`, `subscriber.ts` opens push consumers that call `pi.sendUserMessage()` when messages arrive, triggering a natural agent turn. The agent is not blocked.
- **@mention-based addressing** — Room messages containing `@<agentName>` trigger a full turn (`pi.sendUserMessage`). Unaddressed room chatter is displayed silently via `pi.sendMessage` without interrupting the agent. Direct messages always trigger a turn.
- **Durable per-agent consumers** — Each agent gets a durable consumer per joined room (`room_<id>_<room>`) and one for DMs (`direct_<id>`). Consumers expire after 7 days idle.
- **Presence via KV bucket with TTL** — Agent presence stored in the `claude_chat_agents` KV bucket with 5-minute TTL, refreshed every 60s by the heartbeat. Crashed sessions auto-expire.
- **Wait cooldown/coalescing** — `nats_wait_for_message` enforces a per-identity cooldown (5s) to prevent multiple calls per turn. Concurrent calls from the same identity are coalesced into a single in-flight wait.
- **Schema uses `typebox`** (Pi convention), not `zod` (MCP convention).
- **Test scripts** are standalone (not Jest/Vitest) — they import modules directly, connect to a real NATS server, and verify behavior by checking presence and fetching messages.

## NATS infrastructure

Two JetStream streams and one KV bucket are created on first connect:

| Name | Purpose | Subjects | Retention |
|------|---------|----------|-----------|
| `CLAUDE_CHAT_ROOMS` | Room messages | `chat.room.>` | Limits, 24h max age, 1000 msgs/subject |
| `CLAUDE_CHAT_DIRECT` | Direct messages | `chat.direct.>` | Limits, 24h max age, 1000 msgs/subject |
| `claude_chat_agents` | Presence registry | (KV, TTL 5min) | — |

## Configuration

- `NATS_URL` env var (default: `nats://localhost:4222`) — NATS server address
- `NATS_AGENT_NAME` env var — auto-register with this name on session start
- `NATS_AUTO_JOIN` env var — comma-separated room names to auto-join
- `~/.pi/agent/nats-chat.json` — persistent config file (fallback when env vars not set), managed by `/nats-config` command

Enivornment variables take precedence over the config file.
