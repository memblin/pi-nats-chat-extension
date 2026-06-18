// Wait tool: nats_wait_for_message
//
// This is the BLOCKING variant. It blocks the agent turn until a message
// arrives or the timeout fires. Use this when the agent has dispatched work
// and wants to block until responses come in.
//
// For NON-BLOCKING operation, background monitoring (started automatically on
// join_room and register_agent) injects messages into the conversation without
// any polling or blocking — the agent works normally and gets interrupted only
// when chat traffic arrives.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Message } from "../types.js";
import {
  getIdentity,
  getRooms,
  isRegistered,
  syncPresence,
} from "../identity.js";
import { waitForMessages } from "../stream-manager.js";
import {
  coalesceWait,
  decideWaitCooldown,
  recordWaitResult,
  recordWaitReturn,
} from "../wakeups.js";

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 1800000; // 30 minutes

export function registerWaitTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "nats_wait_for_message",
    label: "NATS Wait For Message",
    description:
      "BLOCKING — block until a message arrives on any joined room or your direct inbox, then return everything received during the wait. Wakes the instant a message is delivered. On timeout it returns an empty result. Prefer background monitoring (automatic on join_room) for non-blocking operation.",
    promptSnippet:
      "Block waiting for NATS messages (prefer background monitoring for non-blocking)",
    promptGuidelines: [
      "nats_wait_for_message BLOCKS the agent turn. Only use it when you have dispatched work and want to wait for responses. For normal operation, rely on background monitoring (automatic after nats_join_room).",
      "Call nats_wait_for_message at most ONCE per turn. Multiple calls per turn is a bug.",
      "Use consecutive_empty_wakeups to drive adaptive backoff: tighten timeout when busy, relax when quiet.",
    ],
    parameters: Type.Object({
      timeout_ms: Type.Optional(
        Type.Number({
          description:
            "How long to block before returning an empty result (default 30000, max 1800000 = 30 minutes).",
        }),
      ),
    }),
    async execute(_toolCallId, { timeout_ms }, _signal, _onUpdate, _ctx) {
      if (!isRegistered()) {
        throw new Error(
          "Not registered — call nats_register_agent (and nats_join_room to listen on a room) before waiting for messages.",
        );
      }

      const identity = getIdentity();

      // Per-identity cooldown gate
      const decision = decideWaitCooldown(identity.id);
      if (decision.action === "replay" || decision.action === "reject") {
        // decision.payload is already a plain object; format it briefly
        const p = decision.payload as Record<string, unknown>;
        const lines = [
          decision.action === "replay" ? "[cooldown — replaying previous result]" : "[cooldown — wait rejected]",
          `elapsed_ms=${p.elapsed_ms}, empty_wakeups=${p.consecutive_empty_wakeups}`,
        ];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }

      const rooms = getRooms();
      const timeout = timeout_ms ?? DEFAULT_TIMEOUT_MS;

      const { leader, result } = await coalesceWait(
        identity.id,
        async () => {
          await syncPresence();

          const start = Date.now();
          const { roomMessages, directMessages } = await waitForMessages(
            identity.id,
            rooms,
            timeout,
          );
          const elapsed_ms = Date.now() - start;

          const timed_out =
            roomMessages.length === 0 && directMessages.length === 0;
          const consecutive_empty_wakeups = recordWaitResult(
            identity.id,
            timed_out,
          );

          const payload = {
            timed_out,
            elapsed_ms,
            consecutive_empty_wakeups,
            room_messages: roomMessages,
            direct_messages: directMessages,
          };

          recordWaitReturn(identity.id, payload);
          return payload;
        },
      );

      const roomLines = result.room_messages.length > 0
        ? ["", "Room messages:", ...result.room_messages.map((m: Message) => `  [#${m.room}] @${m.from}: ${m.content}`)]
        : [];
      const dmLines = result.direct_messages.length > 0
        ? ["", "Direct messages:", ...result.direct_messages.map((m: Message) => `  @${m.from}: ${m.content}`)]
        : [];
      const status = result.timed_out
        ? `Timed out after ${result.elapsed_ms}ms (${result.consecutive_empty_wakeups} empty wakeups)`
        : `Woke after ${result.elapsed_ms}ms`;
      const coalesced = leader ? "" : " [coalesced]";
      const lines = [`${status}${coalesced}`, ...roomLines, ...dmLines];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  });
}
