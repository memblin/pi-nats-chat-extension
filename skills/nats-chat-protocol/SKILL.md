---
name: nats-chat-protocol
description: >-
  Protocol for participating in nats-chat — the room/direct-message bus provided by the
  pi-nats-chat extension and shared with remote human operators and other agents. Use this
  WHENEVER the nats_* tools are available, you receive a message formatted like
  "[NATS room:… from …]", "[NATS DM from …]", or "[NATS ack from …]", someone @mentions you over
  nats-chat, or you're asked to coordinate, hand off work, or report status to other agents or a
  human operator over NATS. CRITICAL: a reply you write only as ordinary text in your own window
  is invisible to everyone on the bus — this skill makes sure you answer back *over NATS* so the
  operator and other agents actually see it.
---

# nats-chat protocol

You are one participant on a shared message bus. Other agents and a **remote human operator**
(connected via a separate chat console) are listening. This skill is the etiquette for being a
good participant — most importantly, making sure your replies actually reach them.

## The one rule that matters most

**When you are addressed over nats-chat, your answer must be SENT back over nats-chat with a
`nats_*` tool. Text you type in your own Pi window does NOT go onto the bus.**

When a message arrives addressed to you, the extension injects it into your conversation as a user
message and you take a turn. It is tempting to just *answer in that turn* — but that answer lives
only in your local Pi window. The operator who asked, and any other agents, see **nothing**. To
them you went silent.

So the final step of handling any addressed message is always: post the reply with
`nats_send_message` (for a room) or `nats_send_direct` (for a DM). Your local narration is for you;
the NATS message is for them.

## Two audiences — keep them straight

| Surface | Who sees it | How it gets there |
|---------|-------------|-------------------|
| Your Pi window | only you (and your local user) | your normal text output |
| The nats-chat bus | the operator + other agents | **only** what you send via `nats_send_*` |

If it isn't in a `nats_send_message` / `nats_send_direct` / `nats_send_ack` call, it didn't happen
as far as the bus is concerned.

## Getting on the bus

1. **Connect:** run `/nats-connect` (the extension loads dormant and does not connect on its own).
2. **Register:** `nats_register_agent` with a clear name (e.g. `build-seat-1`, `lead`). Other
   participants find and address you by this name.
3. **Join rooms:** `nats_join_room <room>`. Joining starts real-time delivery automatically — you
   do **not** poll. Messages arrive as turns when they're addressed to you.

(Headless/automated sessions may auto-connect via env vars instead — see the extension's config.)

## Recognizing what arrived

Incoming bus traffic is injected with a recognizable prefix:

- `[NATS room:<room> from <name>] <text>` — a room message. You only take a turn when it
  **@mentions you** or says **@all**; unaddressed room chatter is shown to you but does not require
  a reply.
- `[NATS DM from <name>] <text>` — a direct message to you. Always handle it.
- `[NATS ack from <name>: <status>] <regarding>` — a status acknowledgement from someone you
  messaged. Informational; usually no reply needed.

## Responding — channel discipline

- **Reply on the same channel you were addressed on.** Room mention → `nats_send_message` to that
  room. DM → `nats_send_direct` to that sender. Don't answer a room question via DM or vice versa.
- **Address the person back** by putting `@<their-name>` in your message so they get pinged:
  `nats_send_message` room=`ops` content=`@operator build is green ✅`.
- **Thread** when it helps: pass the message id you're answering as `reply_to`.
- **Don't echo unaddressed chatter.** If a room message didn't mention you, you generally don't
  reply — replying to everything is noise on a shared bus.

### Direct messages: acknowledge, then deliver

For a DM that kicks off real work, the operator wants to know you got it and how it's going:

1. `nats_send_ack` immediately with status `received` (or `investigating`) so the sender sees
   delivery within seconds, before you start.
2. Do the work. For longer tasks, send interim acks (`in_progress`, `blocked`) as the situation
   changes.
3. Deliver the result with `nats_send_direct` (and/or a final `nats_send_ack` `complete`).

Ack statuses: `received` · `investigating` · `dispatching` · `in_progress` · `blocked` ·
`complete`.

## Worked example — the mistake to avoid

You receive: `[NATS room:ops from operator] @you what's the build status?`

❌ **Wrong:** write "The build is green, all tests pass." as your turn's text and stop. The operator
sees nothing — from their chat console you never answered.

✅ **Right:** after determining the status, call
`nats_send_message` with room=`ops`, content=`@operator build is green ✅ — all 142 tests pass`.
*Then* you may also narrate locally if useful. The bus message is the actual reply.

## Etiquette & housekeeping

- Use **`@all`** only for genuine broadcasts (standups, shutdowns) — it pings everyone.
- `nats_list_agents` to see who's present and their rooms; `nats_get_history <room>` to catch up
  on a room you just joined.
- Keep messages concise and self-contained — the operator is reading a chat log, not your window.
- Stay registered for the session; presence refreshes automatically while connected.

## Tool quick reference

| Tool | Use for |
|------|---------|
| `nats_register_agent` | Claim your name on the bus (do this first) |
| `nats_join_room` / `nats_leave_room` | Enter/exit a room (starts/stops live delivery) |
| `nats_send_message` | **Reply to / post in a room** (your primary reply tool) |
| `nats_send_direct` | **Reply to / start a DM** with another agent |
| `nats_send_ack` | Acknowledge a DM with a status, before/while working |
| `nats_list_agents` / `nats_list_rooms` | See who/what is on the bus |
| `nats_get_history` | Read a room's recent backlog |
| `nats_check_messages` / `nats_check_direct` | Manual poll (rarely needed — delivery is automatic) |
| `nats_wait_for_message` | Block until traffic arrives (dispatch-and-wait flows only) |
