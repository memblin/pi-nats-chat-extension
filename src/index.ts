// Pi NATS Chat Extension
//
// Connects Pi sessions to a NATS JetStream backend for inter-agent
// communication: room-based messaging, direct agent-to-agent messages,
// presence tracking, and message history.
//
// Key innovation over the MCP version: background push subscribers that
// inject messages into the conversation WITHOUT blocking the agent thread.
// The agent works normally and only gets interrupted when chat traffic
// actually arrives.
//
// Two modes of operation:
//  1. Background monitoring (default, non-blocking) — automatic after
//     nats_register_agent + nats_join_room. Messages arrive as user
//     messages, triggering a turn naturally.
//  2. Blocking wait (nats_wait_for_message tool) — for explicit
//     dispatch-and-wait workflows.
//
// Setup:
//   npm install   # installs the 'nats' dependency
//   Then place in ~/.pi/agent/extensions/ or load with pi -e

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { connectNats, closeNats, isConnected } from "./nats-client.js";
import { ensureInfrastructure, ensureRoomConsumer, ensureDirectConsumer } from "./stream-manager.js";
import { register, addRoom, syncPresence, getIdentity, isRegistered } from "./identity.js";
import { startHeartbeat } from "./heartbeat.js";
import {
  setPi,
  stopAllSubscribers,
  startAllSubscribers,
  startRoomSubscriber,
  startDmSubscriber,
} from "./subscriber.js";
import { registerIdentityTools } from "./tools/register.js";
import { registerRoomTools } from "./tools/rooms.js";
import { registerMessagingTools } from "./tools/messaging.js";
import { registerDirectTools } from "./tools/direct.js";
import { registerAgentsTools } from "./tools/agents.js";
import { registerWaitTools } from "./tools/wait.js";

export default async function (pi: ExtensionAPI) {
  // ---- Lifecycle hooks ----

  pi.on("session_start", async (_event, ctx) => {
    // Defer NATS connection until a session is actually running.
    if (!isConnected()) {
      await connectNats();
      await ensureInfrastructure();
    }
    // Wire pi instance so background subscribers can inject messages
    setPi(pi);
    // Start presence heartbeat (no-ops until register_agent is called)
    startHeartbeat();

    // ---- Auto-register and auto-join from environment variables ----
    const agentName = process.env.NATS_AGENT_NAME;
    if (agentName && !isRegistered()) {
      const identity = await register(agentName);
      await ensureDirectConsumer(identity.id);
      await startDmSubscriber();
      if (ctx.hasUI) {
        ctx.ui.notify(`NATS: registered as "${agentName}"`, "info");
      }

      const autoJoin = process.env.NATS_AUTO_JOIN;
      if (autoJoin) {
        const rooms = autoJoin.split(",").map((r) => r.trim()).filter(Boolean);
        for (const room of rooms) {
          addRoom(room);
          await ensureRoomConsumer(identity.id, room);
          await syncPresence();
          await startRoomSubscriber(room);
          if (ctx.hasUI) {
            ctx.ui.notify(`NATS: joined room "${room}"`, "info");
          }
        }
      }
      if (ctx.hasUI) {
        const joined = getIdentity().rooms;
        ctx.ui.notify(
          `NATS chat extension ready (agent: "${agentName}", rooms: [${[...joined].join(", ")}])`,
          "info",
        );
      }
    } else if (!agentName && ctx.hasUI) {
      ctx.ui.notify("NATS chat extension ready", "info");
    }
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    await stopAllSubscribers();
  });

  // ---- Custom message renderer ----

  pi.registerMessageRenderer("nats-chat", (message, options, theme) => {
    const { expanded } = options;
    let text = theme.fg("accent", theme.bold("[NATS] "));
    text += message.content;

    if (expanded && message.details?.msg) {
      const msg = message.details.msg as Record<string, unknown>;
      text +=
        "\n" +
        theme.fg("dim", JSON.stringify(msg, null, 2));
    }

    return new Text(text, 0, 0);
  });

  // ---- Tools ----

  registerIdentityTools(pi);
  registerRoomTools(pi);
  registerMessagingTools(pi);
  registerDirectTools(pi);
  registerAgentsTools(pi);
  registerWaitTools(pi);

  // ---- Command: nats-reconnect ----

  pi.registerCommand("nats-reconnect", {
    description: "Reconnect to NATS and restart background monitoring",
    handler: async (_args, ctx) => {
      await stopAllSubscribers();
      await closeNats();
      await connectNats();
      await ensureInfrastructure();
      setPi(pi);
      startHeartbeat();
      await startAllSubscribers();
      ctx.ui.notify("NATS reconnected and monitoring restarted", "info");
    },
  });
}
