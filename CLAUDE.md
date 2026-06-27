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

# Spin up a local JetStream NATS server for the tests (podman or docker)
podman run -d --name nats-test -p 4222:4222 docker.io/library/nats:latest -js

# Run the smoke test (requires a NATS server)
NATS_URL=nats://localhost:4222 npx tsx src/test-greet.ts

# Run the autojoin test
NATS_URL=nats://localhost:4222 npx tsx src/test-autojoin.ts

# Run the messaging integration test (mention filtering, history tail, DM-by-id)
NATS_URL=nats://localhost:4222 npx tsx src/test-messaging.ts

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

## Pi slash commands

Commands registered on the Pi `ExtensionAPI`:

- `/nats-connect` — **connect to NATS and start monitoring.** The extension loads *dormant* (no
  connection, heartbeat, or subscribers) so simple sessions don't pay for NATS they never use;
  this command brings it up and auto-registers/joins from config or env. Reconnecting an existing
  identity (e.g. after `/nats-disconnect`) re-binds consumers and rejoins the same rooms.
  `/nats-reconnect` forces a fresh connection after a server restart.
- `/nats-disconnect` — **log off NATS while keeping the Pi session running.** Drops presence so
  peers see you leave, stops monitoring/heartbeat, and frees the connection. In-process identity
  and room memberships are kept (durable consumers persist server-side), so `/nats-connect` brings
  you back as the same agent in the same rooms.
- `/nats-monitor [on|off|toggle|status]` — toggle showing unaddressed room chatter in this session (default off). Mentions/DMs/acks always show; the monitor adds everything else, with no agent turn. Lets a human watch the full chat from the Pi session without the separate chat console.
- `/nats-config` — interactive panel (select-menu loop) to view/edit the agent name, auto-join rooms, and the monitor default, with a project-vs-global scope picker. Falls back to a display-only panel when there's no UI.
- `/nats-config show` — print the effective config (and which scope provides each value) as a `nats-chat` panel
- `/nats-config set name <agent-name> [global]` — set the agent name (project scope by default; append `global` for the global file)
- `/nats-config set rooms <room1,room2> [global]` — set auto-join rooms
- `/nats-config clear [global]` — wipe the project (or global) config
- `/nats-reconnect` — drain + reconnect NATS and restart all background subscribers (useful after a server restart)

The command displays config via `pi.sendMessage` (a persistent panel) and edits it with interactive `ctx.ui` prompts. Note `ctx.ui.editor(title, prefill)` takes the prefilled content as its **second** argument — the rooms editor passes the current value there so it isn't empty.

## Bundled skill

The package ships a Pi skill at `skills/nats-chat-protocol/SKILL.md` (declared via `pi.skills` in
`package.json`, so it's discovered when the package is installed). It encodes the agent-facing
protocol for using nats-chat — most importantly that **a reply must be sent back over NATS with a
`nats_*` tool**, since text an agent writes only in its own Pi window never reaches the room/DM and
is invisible to a remote operator or other agents. It also covers channel discipline (reply on the
same room/DM, `@mention` the sender), the DM ack flow, and etiquette. It doubles as a starter
example of shipping a skill alongside an extension.

## Key design patterns

- **Singleton NATS connection** — `nats-client.ts` holds one shared `NatsConnection`, `JetStreamClient`, and `JetStreamManager`. All other modules access them via `getConnection()`, `getJetStream()`, `getManager()`.
- **Push consumers for background monitoring** — After `nats_register_agent` and `nats_join_room`, `subscriber.ts` opens push consumers that call `pi.sendUserMessage()` when messages arrive, triggering a natural agent turn. The agent is not blocked.
- **@mention-based addressing** — Room messages mentioning `@<agentName>` or `@all` trigger a full turn (`pi.sendUserMessage`). Matching is token-aware (`src/mentions.ts`): `@bob` does not fire on `@bobby` or `x@bob.dev`, and `@all` does not fire on `@allison`. Direct messages and acks are always surfaced; DMs trigger a turn.
- **Chat monitor (default off)** — Unaddressed room chatter is **suppressed** by default (acked on NATS but not shown — no display, no token processing). The monitor toggle (`subscriber.ts` `setMonitor`/`isMonitorEnabled`) restores chat-console-style display: when on, unaddressed messages are printed to the session via `pi.sendMessage` for a human to read, still without triggering a turn. Controlled live by `/nats-monitor [on|off]`, initialised from `NATS_MONITOR` env or the persisted `monitor` config default.
- **Self-healing push consumers** — `startPushConsumer` (`stream-manager.ts`) re-binds its durable consumer with capped exponential backoff if the `consume()` iterator throws or ends, so a connection blip or reconnect doesn't leave a room/DM silently dark. Errors surface in-conversation via the subscriber's `onError`.
- **Connection resilience** — `connectNats` sets `maxReconnectAttempts: -1` so a session survives a broker restart (the library default of 10 gives up after ~20s). A status watcher in `index.ts` updates a footer widget (`ctx.ui.setWidget`) and posts disconnect/reconnect lines; `isConnected()` returns false once the link is closed for good. A failed connect at `session_start` degrades to "chat offline" instead of breaking the Pi session.
- **Polling vs. background monitoring contend for the same durable** — `nats_check_messages` / `nats_wait_for_message` pull from the same per-agent durable consumer as the always-running push subscriber. Each retained message is delivered to exactly one puller, so when background monitoring is active the push subscriber usually wins and a manual poll returns empty. This is expected: prefer background monitoring; use polling only when monitoring is off.
- **Durable per-agent consumers** — Each agent gets a durable consumer per joined room (`room_<id>_<room>`) and one for DMs (`direct_<id>`). Consumers expire after 7 days idle.
- **Presence via KV bucket with TTL** — Agent presence stored in the `claude_chat_agents` KV bucket with 5-minute TTL, refreshed every 60s by the heartbeat. Crashed sessions auto-expire.
- **Wait cooldown/coalescing** — `nats_wait_for_message` enforces a per-identity cooldown (5s) to prevent multiple calls per turn. Concurrent calls from the same identity are coalesced into a single in-flight wait. A 200ms settle window after the first delivery sweeps up burst messages into a single response.
- **Re-registration is safe** — `register()` in `identity.ts` reuses the existing agent id and room set when called again (e.g. to rename), so the DM consumer created under the original id is not orphaned.
- **NATS token validation** — Room names and agent names must match `^[A-Za-z0-9_-]{1,64}$` (enforced by `assertValidToken` in `stream-manager.ts`). Agent IDs are generated as `a` + UUID-without-dashes to satisfy the same constraint while always starting with a letter.
- **AckMessage type** — `nats_send_ack` publishes an `AckMessage` (extends `Message` with `type: "ack"`, `regarding`, `status: AckStatus`, and optional `note`) to the sender's DM subject. Acks are rendered with a custom `nats-chat` message type and never trigger an agent turn.
- **NATS subject patterns** — Room messages publish to `chat.room.<room>.msg`; direct messages publish to `chat.direct.<agentId>.msg`. Both patterns are matched by wildcard subjects on their respective streams.
- **Schema uses `typebox`** (Pi convention), not `zod` (MCP convention).
- **Test scripts** are standalone (not Jest/Vitest) — they import modules directly, connect to a real NATS server, and verify behavior by checking presence and fetching messages.
- **Test-only reset helpers** — `resetIdentityForTests()`, `resetStreamManagerForTests()`, and `resetEmptyWakeupsForTests()` clear module-level singletons between test runs; never call these from production code.

## NATS infrastructure

Two JetStream streams and one KV bucket are created on first connect:

| Name | Purpose | Subjects | Retention |
|------|---------|----------|-----------|
| `CLAUDE_CHAT_ROOMS` | Room messages | `chat.room.>` | Limits, 24h max age, 1000 msgs/subject |
| `CLAUDE_CHAT_DIRECT` | Direct messages | `chat.direct.>` | Limits, 24h max age, 1000 msgs/subject |
| `claude_chat_agents` | Presence registry | (KV, TTL 5min) | — |

## Configuration

- `NATS_URL` env var (default: `nats://localhost:4222`) — NATS server address
- `NATS_AUTOCONNECT` env var — when set, connect on session start (the default is **dormant**:
  the extension loads but does not connect until `/nats-connect`). Use this for headless/automated
  sessions that can't run a command.
- `NATS_AGENT_NAME` env var — agent name to auto-register with **once connected**
- `NATS_AUTO_JOIN` env var — comma-separated room names to auto-join once connected
- `NATS_MONITOR` env var — when truthy, start with the chat monitor on (show unaddressed room chatter). Default off; `/nats-monitor` overrides it live.
- Persistent config (fallback when env vars not set), managed by `/nats-config`, written atomically (temp + rename), at two scopes:
  - `<cwd>/.pi/nats-chat.json` — **project** scope (per-repo)
  - `~/.pi/agent/nats-chat.json` — **global** scope (all sessions)

Precedence (highest first): environment variables → project config → global config. Project values override global per key (mirrors Pi's own `settings.json` layering). `loadConfig(cwd)` resolves the project file relative to the session's `ctx.cwd`.

### Auth / TLS (opt-in, for non-localhost brokers)

All optional; unset means anonymous localhost as before. Handled in `nats-client.ts`:

- `NATS_TOKEN` — token auth
- `NATS_USER` / `NATS_PASS` — user/password auth
- `NATS_CREDS` — path to a NATS `.creds` file (JWT/nkey; loaded via `credsAuthenticator`)
- `NATS_TLS=1` — enable TLS
