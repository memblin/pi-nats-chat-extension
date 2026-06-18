// Room tools: nats_join_room, nats_leave_room, nats_list_rooms
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  getIdentity,
  getRooms,
  addRoom,
  removeRoom,
  syncPresence,
} from "../identity.js";
import {
  assertValidToken,
  ensureRoomConsumer,
  deleteRoomConsumer,
  listPresence,
} from "../stream-manager.js";
import { startRoomSubscriber, stopRoomSubscriber } from "../subscriber.js";

export function registerRoomTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "nats_join_room",
    label: "NATS Join Room",
    description:
      "Join a named room for multi-agent coordination. When you join, background monitoring starts automatically — you'll receive messages from this room in real time without blocking.",
    promptSnippet: "Join a named chat room (starts background monitoring automatically)",
    promptGuidelines: [
      "Call nats_join_room to join a room after nats_register_agent. Background monitoring starts automatically — you don't need to poll.",
      "Room names use letters, digits, '_' or '-' only, e.g. 'team-sync' or 'release_coordination'.",
    ],
    parameters: Type.Object({
      room: Type.String({ description: "Room name to join" }),
    }),
    async execute(_toolCallId, { room }, _signal, _onUpdate, _ctx) {
      assertValidToken("room name", room);
      addRoom(room);
      await ensureRoomConsumer(getIdentity().id, room);
      await syncPresence();
      // Start background subscriber so messages from this room are injected
      // into the conversation automatically (non-blocking).
      await startRoomSubscriber(room);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { joined: true, room, rooms: getRooms() },
              null,
              2,
            ),
          },
        ],
        details: { room },
      };
    },
  });

  pi.registerTool({
    name: "nats_leave_room",
    label: "NATS Leave Room",
    description: "Leave a room. Background monitoring for this room stops.",
    promptSnippet: "Leave a chat room and stop monitoring it",
    parameters: Type.Object({
      room: Type.String({ description: "Room name to leave" }),
    }),
    async execute(_toolCallId, { room }, _signal, _onUpdate, _ctx) {
      removeRoom(room);
      await deleteRoomConsumer(getIdentity().id, room);
      await syncPresence();
      // Stop background subscriber for this room
      await stopRoomSubscriber(room);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { left: true, room, rooms: getRooms() },
              null,
              2,
            ),
          },
        ],
        details: { room },
      };
    },
  });

  pi.registerTool({
    name: "nats_list_rooms",
    label: "NATS List Rooms",
    description: "List all active rooms and their members",
    promptSnippet: "List all NATS rooms and who is in each",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const agents = await listPresence();

      const roomMap = new Map<
        string,
        Array<{ id: string; name: string }>
      >();
      for (const agent of agents) {
        for (const room of agent.rooms) {
          if (!roomMap.has(room)) roomMap.set(room, []);
          roomMap.get(room)!.push({ id: agent.id, name: agent.name });
        }
      }

      const rooms = Array.from(roomMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([room, members]) => ({
          room,
          members,
          member_count: members.length,
        }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ rooms }, null, 2),
          },
        ],
      };
    },
  });
}
