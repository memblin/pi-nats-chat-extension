// Messaging tools: nats_send_message, nats_check_messages, nats_get_history
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Message } from "../types.js";
import {
  getIdentity,
  getRooms,
  hasRoom,
  newMessage,
  syncPresence,
} from "../identity.js";
import {
  assertValidToken,
  publishRoomMessage,
  fetchRoomMessages,
  getRoomHistory,
} from "../stream-manager.js";
import { resetEmptyWakeups } from "../wakeups.js";
import { isMentioned } from "../mentions.js";

/** Format a single message as a clean one-liner. */
function fmtMsg(m: Message): string {
  const ts = m.timestamp.slice(11, 19); // HH:MM:SS
  const reply = m.reply_to ? ` (↳ ${m.reply_to.slice(0, 8)})` : "";
  return `[${ts}] @${m.from}: ${m.content}${reply}`;
}

/** Keep only messages that mention the agent by name, mention @all, or are DMs. */
function filterMentions(messages: Message[], agentName: string): Message[] {
  return messages.filter((m) => !m.room || isMentioned(m.content, agentName));
}

export function registerMessagingTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "nats_send_message",
    label: "NATS Send Message",
    description: "Broadcast a message to a room",
    promptSnippet: "Send a message to a NATS room",
    promptGuidelines: [
      "Use nats_send_message to broadcast to a room you've joined. Other agents (and background-monitored sessions) will receive it.",
      "You can optionally reply to a previous message by passing its id as reply_to.",
    ],
    parameters: Type.Object({
      room: Type.String({ description: "The room to send the message to" }),
      content: Type.String({
        description: "The message content to broadcast",
      }),
      reply_to: Type.Optional(
        Type.String({
          description: "Optional message ID this is a reply to",
        }),
      ),
    }),
    async execute(_toolCallId, { room, content, reply_to }, _signal, _onUpdate, _ctx) {
      assertValidToken("room name", room);
      if (!hasRoom(room)) {
        throw new Error(
          `You are not a member of room "${room}". Use nats_join_room first.`,
        );
      }
      const message = newMessage(content, { room, reply_to });
      await publishRoomMessage(room, message);
      await syncPresence();
      return {
        content: [
          {
            type: "text",
            text: `Sent to #${room}: ${content}`,
          },
        ],
        details: { message },
      };
    },
  });

  pi.registerTool({
    name: "nats_check_messages",
    label: "NATS Check Messages",
    description:
      "Poll for new messages in joined rooms. Note: background monitoring (started automatically on join_room) delivers messages in real time without polling — use this only when you need a manual check.",
    promptSnippet: "Manually poll for new room messages (background monitoring is preferred)",
    promptGuidelines: [
      "nats_check_messages is for manual polling. Messages are normally delivered automatically via background monitoring after nats_join_room.",
      "If you specify a room, only that room is checked. Omit to check all joined rooms.",
    ],
    parameters: Type.Object({
      room: Type.Optional(
        Type.String({
          description:
            "Specific room to check; omit to check all joined rooms",
        }),
      ),
    }),
    async execute(_toolCallId, { room }, _signal, _onUpdate, _ctx) {
      const identity = getIdentity();

      if (room !== undefined) {
        if (!hasRoom(room)) {
          throw new Error(
            `You are not a member of room "${room}". Use nats_join_room first.`,
          );
        }
        const raw = await fetchRoomMessages(identity.id, room);
        const messages = filterMentions(raw, identity.name);
        if (messages.length > 0) resetEmptyWakeups(identity.id);
        await syncPresence();
        const lines = messages.length === 0
          ? [`No new messages in #${room}.`]
          : [`#${room} (${messages.length} message${messages.length === 1 ? "" : "s"}):`, ...messages.map(fmtMsg)];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }

      const rooms = getRooms();
      if (rooms.length === 0) {
        await syncPresence();
        return {
          content: [
            {
              type: "text",
              text: "No rooms joined. Use nats_join_room to join a room first.",
            },
          ],
        };
      }

      const allRaw = [];
      for (const r of rooms) {
        const msgs = await fetchRoomMessages(identity.id, r);
        allRaw.push(...msgs);
      }
      const messages = filterMentions(allRaw, identity.name);
      if (messages.length > 0) resetEmptyWakeups(identity.id);

      await syncPresence();
      const lines = messages.length === 0
        ? ["No new messages across joined rooms."]
        : [`${messages.length} message${messages.length === 1 ? "" : "s"}:`, ...messages.map(fmtMsg)];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  });

  pi.registerTool({
    name: "nats_get_history",
    label: "NATS Get History",
    description: "Retrieve message history for a room",
    promptSnippet: "Get recent message history from a NATS room",
    parameters: Type.Object({
      room: Type.String({
        description: "The room to retrieve history for",
      }),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum number of messages to return (default: 50)",
        }),
      ),
    }),
    async execute(_toolCallId, { room, limit }, _signal, _onUpdate, _ctx) {
      assertValidToken("room name", room);
      const messages = await getRoomHistory(room, limit ?? 50);
      const lines = messages.length === 0
        ? [`No history in #${room}.`]
        : [`#${room} last ${messages.length} message${messages.length === 1 ? "" : "s"}:`, ...messages.map(fmtMsg)];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  });
}
