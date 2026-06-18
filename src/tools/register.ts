// Identity + status tools: nats_register_agent, nats_get_status
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  getIdentity,
  getRooms,
  isRegistered,
  register,
  syncPresence,
} from "../identity.js";
import { assertValidToken, ensureDirectConsumer } from "../stream-manager.js";
import { NATS_URL } from "../nats-client.js";
import { resetWaitReturn } from "../wakeups.js";
import { startDmSubscriber } from "../subscriber.js";

export function registerIdentityTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "nats_register_agent",
    label: "NATS Register Agent",
    description:
      "Register this Pi session as a named agent on the NATS chat bus. Other agents can find and message you after registration.",
    promptSnippet:
      "Register, re-register, or rename this session as a named NATS agent",
    promptGuidelines: [
      "Call nats_register_agent first, before any other nats_* tool — most nats_* tools require registration.",
      "You may call nats_register_agent again to change your name; it keeps your existing id and room memberships.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description:
          "Short agent name, e.g. 'build-seat-1' or 'lead'. Use letters, digits, '_' or '-' only.",
      }),
    }),
    async execute(_toolCallId, { name }, _signal, _onUpdate, _ctx) {
      assertValidToken("agent name", name);
      const identity = await register(name);
      // Clear any prior per-identity wait cooldown so a re-registering session
      // starts clean.
      resetWaitReturn(identity.id);
      // Create the DM consumer eagerly so a direct message sent right after
      // this agent registers isn't missed.
      await ensureDirectConsumer(identity.id);
      // Start background DM subscriber for non-blocking message delivery
      await startDmSubscriber();
      return {
        content: [
          {
            type: "text",
            text: `Registered as @${identity.name} (id: ${identity.id.slice(0, 12)}…)`,
          },
        ],
        details: { identity },
      };
    },
  });

  pi.registerTool({
    name: "nats_get_status",
    label: "NATS Get Status",
    description:
      "Return this session's agent identity, joined rooms, and connection status.",
    promptSnippet: "Inspect the current NATS identity and room membership",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      if (!isRegistered()) {
        return {
          content: [
            {
              type: "text",
              text: "Not registered. Call nats_register_agent to set this session's name.",
            },
          ],
        };
      }
      await syncPresence();
      const identity = getIdentity();
      const rooms = getRooms();
      return {
        content: [
          {
            type: "text",
            text: `@${identity.name} (id: ${identity.id.slice(0, 12)}…) — rooms: [${rooms.join(", ") || "none"}]`,
          },
        ],
      };
    },
  });
}
