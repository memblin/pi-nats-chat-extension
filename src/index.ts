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
import { register, addRoom, syncPresence, getIdentity, getRooms, isRegistered } from "./identity.js";
import { startHeartbeat } from "./heartbeat.js";
import {
  setPi,
  stopAllSubscribers,
  startAllSubscribers,
  startRoomSubscriber,
  startDmSubscriber,
} from "./subscriber.js";
import { loadConfig, saveConfig, formatConfig } from "./config.js";
import { registerIdentityTools } from "./tools/register.js";
import { registerRoomTools } from "./tools/rooms.js";
import { registerMessagingTools } from "./tools/messaging.js";
import { registerDirectTools } from "./tools/direct.js";
import { registerAgentsTools } from "./tools/agents.js";
import { registerWaitTools } from "./tools/wait.js";

export default async function (pi: ExtensionAPI) {
  // Keep a handle on the heartbeat timer so reconnect can stop the old one.
  let stopHeartbeat: (() => void) | null = null;

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
    stopHeartbeat = startHeartbeat();

    // ---- Auto-register and auto-join from config + environment variables ----
    // Env vars take precedence; config file (~/.pi/agent/nats-chat.json) is the fallback.
    const cfg = loadConfig();
    const agentName = process.env.NATS_AGENT_NAME || cfg.agentName;
    if (agentName && !isRegistered()) {
      const identity = await register(agentName);
      await ensureDirectConsumer(identity.id);
      await startDmSubscriber();
      if (ctx.hasUI) {
        ctx.ui.notify(`NATS: registered as "${agentName}"`, "info");
      }

      const autoJoinRaw = process.env.NATS_AUTO_JOIN;
      const rooms = autoJoinRaw
        ? autoJoinRaw.split(",").map((r) => r.trim()).filter(Boolean)
        : (cfg.autoJoin ?? []);
      for (const room of rooms) {
        addRoom(room);
        await ensureRoomConsumer(identity.id, room);
        await syncPresence();
        await startRoomSubscriber(room);
        if (ctx.hasUI) {
          ctx.ui.notify(`NATS: joined room "${room}"`, "info");
        }
      }
      if (ctx.hasUI) {
        const joined = getRooms();
        ctx.ui.notify(
          `NATS chat extension ready (agent: "${agentName}", rooms: [${joined.join(", ")}])`,
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

  // ---- Command: nats-config ----

  pi.registerCommand("nats-config", {
    description:
      "Show or update NATS chat config (agent name, auto-join rooms). " +
      "Stored in ~/.pi/agent/nats-chat.json.",
    async handler(args, ctx) {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase();

      if (!sub || sub === "show") {
        const cfg = loadConfig();
        const label = cfg.agentName
          ? `NATS Config — agent: ${cfg.agentName}`
          : "NATS Config";
        ctx.ui.editor(label, formatConfig(cfg));
        return;
      }

      if (sub === "set") {
        const key = parts[1]?.toLowerCase();
        const value = parts.slice(2).join(" ");

        if (!key || !value) {
          ctx.ui.notify(
            "Usage: /nats-config set name <agent-name>\n" +
              "       /nats-config set rooms <room1,room2,…>",
            "error",
          );
          return;
        }

        const cfg = loadConfig();

        if (key === "name") {
          cfg.agentName = value;
          saveConfig(cfg);
          ctx.ui.editor(
            `NATS Config — agent name set`,
            `Agent name set to "${value}".\nRestart or /reload to auto-register.\n\n${formatConfig(cfg)}`,
          );
        } else if (key === "rooms") {
          cfg.autoJoin = value
            .split(",")
            .map((r) => r.trim())
            .filter(Boolean);
          saveConfig(cfg);
          ctx.ui.editor(
            `NATS Config — rooms updated`,
            `Auto-join rooms set to [${cfg.autoJoin.join(", ")}].\nRestart or /reload to apply.\n\n${formatConfig(cfg)}`,
          );
        } else {
          ctx.ui.notify(
            `Unknown key "${key}". Use "name" or "rooms".`,
            "error",
          );
        }
        return;
      }

      if (sub === "clear") {
        saveConfig({});
        ctx.ui.editor(
          "NATS Config — cleared",
          "NATS chat config cleared. Restart or /reload to apply.",
        );
        return;
      }

      ctx.ui.notify(
        `Unknown subcommand "${sub}". Use: show, set, clear.`,
        "error",
      );
    },
  });

  // ---- Command: nats-reconnect ----

  pi.registerCommand("nats-reconnect", {
    description: "Reconnect to NATS and restart background monitoring",
    handler: async (_args, ctx) => {
      // Stop old heartbeat before draining the connection — otherwise it fires
      // against a dead NATS client and throws "closed connection".
      stopHeartbeat?.();
      stopHeartbeat = null;
      await stopAllSubscribers();
      await closeNats();
      await connectNats();
      await ensureInfrastructure();
      setPi(pi);
      stopHeartbeat = startHeartbeat();
      await startAllSubscribers();
      // Immediately push presence so other agents see us in rooms right away,
      // rather than waiting for the next heartbeat tick (up to 60 s).
      await syncPresence();
      ctx.ui.notify("NATS reconnected and monitoring restarted", "info");
    },
  });
}
