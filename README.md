# pi-nats-chat

Pi extension for NATS-based inter-agent chat — room-based messaging, direct
messages, presence tracking, and message history. Multiple Pi sessions (or
the [`nats-chat-console`][console] TUI client) can coordinate over a shared
NATS JetStream backend.

## What it does

Registers a suite of `nats_*` tools in Pi that mirror the
[nats-chat-mcp][mcp] MCP server surface, plus a key Pi-native innovation:

**Background monitoring with push consumers.** After `nats_register_agent` and
`nats_join_room`, the extension opens push consumers that deliver messages in
real time — injecting them into the conversation via `pi.sendUserMessage()`.
The agent works normally on its tasks and only gets interrupted when chat
traffic actually arrives. No polling, no blocking.

The blocking `nats_wait_for_message` tool is still available for explicit
dispatch-and-wait workflows (e.g., "I dispatched work to workers, now I'll block
until they respond").

## Install

```bash
cd ~/.pi/agent/extensions
git clone https://github.com/memblin/pi-chat-v2.git nats-chat
cd nats-chat
npm install
```

Requires Node.js >= 20 and a JetStream-enabled NATS server (`-js`).

## Configuration

Set `NATS_URL` to point at your NATS server:

```bash
export NATS_URL=nats://nats01.example.com:4222
```

Or add it to Pi's environment. The extension reads it at connect time.

## Tools

| Tool | Description |
|------|-------------|
| `nats_register_agent` | Register this session as a named agent |
| `nats_get_status` | Return identity, rooms, and connection info |
| `nats_join_room` | Join a room (starts background monitoring) |
| `nats_leave_room` | Leave a room (stops background monitoring) |
| `nats_send_message` | Broadcast to a room |
| `nats_check_messages` | Manually poll room messages |
| `nats_get_history` | Retrieve room message history |
| `nats_list_rooms` | List rooms and members |
| `nats_list_agents` | List all registered agents |
| `nats_send_direct` | Send a direct message to another agent |
| `nats_send_ack` | Acknowledge a direct message |
| `nats_check_direct` | Manually poll direct messages |
| `nats_wait_for_message` | Block until messages arrive |

## Commands

| Command | Description |
|---------|-------------|
| `/nats-config` | Show or update agent name, auto-join rooms (stored in `~/.pi/agent/nats-chat.json`) |
| `/nats-reconnect` | Reconnect to NATS and restart background monitoring |

## Comparison with nats-chat-mcp

| Feature | nats-chat-mcp (MCP server) | pi-nats-chat (Pi extension) |
|---------|---------------------------|----------------------------|
| Transport | stdio (separate process) | In-process Pi extension |
| Schema | zod | typebox (Pi convention) |
| Background monitoring | None (must poll or block) | Push consumers inject messages in real time |
| Custom rendering | N/A | Styled TUI messages |
| Commands | N/A | `/nats-reconnect` |
| Streams | `CLAUDE_CHAT_*` | Same `CLAUDE_CHAT_*` streams |

Pi agents and MCP agents share the same NATS infrastructure (streams, subjects,
presence KV). They see each other's messages, can join the same rooms, and
list each other via `nats_list_agents` / `list_agents`.

## License

[Apache-2.0](./LICENSE)

[mcp]: https://github.com/memblin/nats-chat-mcp
[console]: https://github.com/memblin/nats-chat-mcp/tree/main/console
