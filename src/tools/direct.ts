// Direct messaging tools: nats_send_direct, nats_send_ack, nats_check_direct
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  getIdentity,
  newAck,
  newMessage,
  syncPresence,
} from "../identity.js";
import {
  publishDirectMessage,
  fetchDirectMessages,
  listPresence,
} from "../stream-manager.js";
import { resetEmptyWakeups } from "../wakeups.js";
import type { AckStatus, AgentPresence, AckMessage } from "../types.js";

const ACK_STATUSES: readonly [AckStatus, ...AckStatus[]] = [
  "received",
  "investigating",
  "dispatching",
  "in_progress",
  "blocked",
  "complete",
];

/** Shape of an agent id: "a" + a UUID with its dashes stripped (see identity.ts). */
const AGENT_ID_RE = /^a[0-9a-f]{32}$/;

/**
 * Resolve a `to` argument (a name or an id) to a single registered agent.
 */
async function resolveTarget(to: string): Promise<AgentPresence> {
  const agents = await listPresence();
  const matches = agents.filter((a) => a.id === to || a.name === to);

  if (matches.length === 0) {
    // Presence lives on a 5-min TTL, but the recipient's durable DM consumer
    // persists for days — so an exact agent id still addresses a target whose
    // presence has merely lapsed (mid-long-task, briefly idle). The DM lands on
    // chat.direct.<id>.msg and waits for them.
    if (AGENT_ID_RE.test(to)) {
      return { id: to, name: to, rooms: [], last_seen: "" };
    }
    throw new Error(
      `No registered agent matches "${to}". Use nats_list_agents to see available agents.`,
    );
  }
  if (matches.length > 1 && !matches.some((a) => a.id === to)) {
    const ids = matches.map((a) => a.id).join(", ");
    throw new Error(
      `Ambiguous agent name "${to}" — multiple agents share this name. Use one of these exact ids: ${ids}`,
    );
  }
  return matches.find((a) => a.id === to) ?? matches[0];
}

export function registerDirectTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "nats_send_direct",
    label: "NATS Send Direct",
    description:
      "Send a direct message to another agent. The recipient will receive it via their background monitor or next wait_for_message.",
    promptSnippet: "Send a point-to-point direct message to another agent",
    promptGuidelines: [
      "Use nats_send_direct for point-to-point communication. The target can be an agent name or id.",
      "You can optionally reply_to a previous message id.",
    ],
    parameters: Type.Object({
      to: Type.String({
        description: "The target agent's name or id",
      }),
      content: Type.String({
        description: "The message content to send",
      }),
      reply_to: Type.Optional(
        Type.String({
          description: "Optional message id this is a reply to",
        }),
      ),
    }),
    async execute(_toolCallId, { to, content, reply_to }, _signal, _onUpdate, _ctx) {
      const target = await resolveTarget(to);

      const message = newMessage(content, { reply_to });
      await publishDirectMessage(target.id, message);
      await syncPresence();

      return {
        content: [
          {
            type: "text",
            text: `DM → @${target.name}: ${content}`,
          },
        ],
        details: { message, target },
      };
    },
  });

  pi.registerTool({
    name: "nats_send_ack",
    label: "NATS Send Acknowledgment",
    description:
      "Acknowledge a message you received and are acting on — a lightweight status ping to the sender, not a full reply. Call it immediately on receiving a direct message, before doing work.",
    promptSnippet: "Acknowledge a direct message with a status (received, investigating, etc.)",
    promptGuidelines: [
      "Call nats_send_ack immediately after receiving a direct message — before processing it. This gives the sender delivery confirmation within seconds.",
      "Statuses: received | investigating | dispatching | in_progress | blocked | complete",
      "The 'regarding' field should briefly label what you're acknowledging.",
    ],
    parameters: Type.Object({
      to: Type.String({
        description: "The target agent's name or id",
      }),
      regarding: Type.String({
        description:
          "Brief label for what is being acknowledged, e.g. 'rc13 publish handoff'",
      }),
      status: StringEnum(ACK_STATUSES, {
        description:
          "Current handling status: received | investigating | dispatching | in_progress | blocked | complete",
      }),
      note: Type.Optional(
        Type.String({
          description: "Optional human-readable detail (max 200 chars)",
        }),
      ),
    }),
    async execute(_toolCallId, { to, regarding, status, note }, _signal, _onUpdate, _ctx) {
      const target = await resolveTarget(to);

      const ack = newAck(regarding, status, note);
      await publishDirectMessage(target.id, ack);
      await syncPresence();

      return {
        content: [
          {
            type: "text",
            text: `ack → @${target.name}: ${status} re: ${regarding}`,
          },
        ],
        details: { ack, target },
      };
    },
  });

  pi.registerTool({
    name: "nats_check_direct",
    label: "NATS Check Direct",
    description:
      "Check for direct messages. Note: background monitoring (started automatically on register_agent) delivers DMs in real time — use this only for manual checks.",
    promptSnippet: "Manually poll for direct messages (background monitoring is preferred)",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const messages = await fetchDirectMessages(getIdentity().id);
      if (messages.length > 0) resetEmptyWakeups(getIdentity().id);
      await syncPresence();

      const lines = messages.length === 0
        ? ["No new direct messages."]
        : [`${messages.length} DM${messages.length === 1 ? "" : "s"}:`, ...messages.map((m) => `  @${m.from}: ${m.content}`)];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  });
}
