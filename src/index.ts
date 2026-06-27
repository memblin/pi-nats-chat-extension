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
import { connectNats, closeNats, isConnected, getConnection } from "./nats-client.js";
import { ensureInfrastructure, ensureRoomConsumer, ensureDirectConsumer, deletePresence, resetInfrastructureCache } from "./stream-manager.js";
import { register, addRoom, syncPresence, getIdentity, getRooms, isRegistered } from "./identity.js";
import { startHeartbeat } from "./heartbeat.js";
import {
  setPi,
  stopAllSubscribers,
  startAllSubscribers,
  startRoomSubscriber,
  startDmSubscriber,
  setMonitor,
  isMonitorEnabled,
} from "./subscriber.js";
import { loadConfig, loadScope, saveConfig, describeConfig, type ConfigScope } from "./config.js";
import { registerIdentityTools } from "./tools/register.js";
import { registerRoomTools } from "./tools/rooms.js";
import { registerMessagingTools } from "./tools/messaging.js";
import { registerDirectTools } from "./tools/direct.js";
import { registerAgentsTools } from "./tools/agents.js";
import { registerWaitTools } from "./tools/wait.js";

export default async function (pi: ExtensionAPI) {
  // Keep a handle on the heartbeat timer so reconnect can stop the old one.
  let stopHeartbeat: (() => void) | null = null;
  // Handle on the connection-status watcher, stopped/restarted on reconnect.
  let stopConnMonitor: (() => void) | null = null;
  // Last-known UI handle (captured from session_start / commands) so the
  // connection monitor can update a footer widget outside an event handler.
  // Typed loosely because setWidget may be absent on older Pi versions.
  let lastUi: { setWidget?: (key: string, lines: string[]) => void } | null =
    null;

  /** Reflect connection + monitor state in a footer widget when supported. */
  let connState = "offline";
  function renderNatsWidget(): void {
    try {
      lastUi?.setWidget?.("nats-chat", [
        `NATS: ${connState}${isMonitorEnabled() ? " · monitor on" : ""}`,
      ]);
    } catch {
      /* no UI / unsupported — ignore */
    }
  }
  function setNatsWidget(state: string): void {
    connState = state;
    renderNatsWidget();
  }

  /**
   * Watch NATS connection status events. On a real disconnect/reconnect we
   * update the widget and drop a non-interrupting line into the conversation,
   * and refresh presence on recovery. Returns a stop function.
   */
  function startConnectionMonitor(): () => void {
    let stopped = false;
    const conn = getConnection();
    void (async () => {
      try {
        for await (const s of conn.status()) {
          if (stopped) break;
          const type = (s as { type?: string }).type;
          if (type === "disconnect") {
            setNatsWidget("disconnected");
            pi.sendMessage({
              customType: "nats-chat",
              content: "connection lost — retrying…",
              display: true,
            });
          } else if (type === "reconnect") {
            setNatsWidget("connected");
            pi.sendMessage({
              customType: "nats-chat",
              content: "reconnected",
              display: true,
            });
            // Re-publish presence so peers see us again right away; the push
            // consumers self-heal on their own (see startPushConsumer).
            void syncPresence().catch(() => {});
          }
        }
      } catch {
        /* status iterator ended (connection closed) — nothing to do */
      }
    })();
    return () => {
      stopped = true;
    };
  }

  /**
   * Connect to NATS and start everything: infrastructure, heartbeat, the
   * connection-health monitor, and (if a name is configured) auto-registration
   * and auto-join. Idempotent — a no-op notify if already connected. Returns
   * whether the connection is up afterward.
   *
   * This is the single bring-up path, shared by /nats-connect and the optional
   * NATS_AUTOCONNECT startup hook. Nothing connects until it runs.
   */
  async function bringUp(ctx: {
    hasUI?: boolean;
    cwd?: string;
    ui?: { notify?: (m: string, t?: string) => void };
  }): Promise<boolean> {
    const notify = (m: string, t = "info") => {
      if (ctx?.hasUI) ctx.ui?.notify?.(m, t);
    };
    if (ctx?.hasUI && ctx.ui) lastUi = ctx.ui as typeof lastUi;

    if (isConnected()) {
      notify("NATS already connected.");
      return true;
    }

    try {
      await connectNats();
      await ensureInfrastructure();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setNatsWidget("offline");
      notify(`NATS unavailable (${detail}). Run /nats-connect to retry.`, "warn");
      return false;
    }

    setPi(pi);
    stopHeartbeat?.();
    stopHeartbeat = startHeartbeat();
    stopConnMonitor?.();
    stopConnMonitor = startConnectionMonitor();
    setNatsWidget("connected");

    // Auto-register + auto-join from env (highest), then project/global config.
    const cfg = loadConfig(ctx?.cwd);

    // Initialise the chat monitor: NATS_MONITOR env wins, else the persisted
    // config default, else off. /nats-monitor overrides it live for the session.
    const monEnv = process.env.NATS_MONITOR;
    setMonitor(
      monEnv !== undefined ? /^(1|true|on|yes)$/i.test(monEnv) : (cfg.monitor ?? false),
    );

    if (isRegistered()) {
      // Reconnecting an existing identity (e.g. after /nats-disconnect): re-ensure
      // our durable consumers, restart subscribers, and re-publish presence so we
      // come back as the same agent in the same rooms.
      const id = getIdentity();
      await ensureDirectConsumer(id.id);
      for (const room of getRooms()) await ensureRoomConsumer(id.id, room);
      await startAllSubscribers();
      await syncPresence();
      notify(`NATS connected (agent: "${id.name}", rooms: [${getRooms().join(", ")}])`);
      return true;
    }

    // Fresh connection: auto-register + auto-join from env (highest), then config.
    const agentName = process.env.NATS_AGENT_NAME || cfg.agentName;
    if (agentName) {
      const identity = await register(agentName);
      await ensureDirectConsumer(identity.id);
      await startDmSubscriber();
      notify(`NATS: registered as "${agentName}"`);

      const autoJoinRaw = process.env.NATS_AUTO_JOIN;
      const rooms = autoJoinRaw
        ? autoJoinRaw.split(",").map((r) => r.trim()).filter(Boolean)
        : (cfg.autoJoin ?? []);
      for (const room of rooms) {
        addRoom(room);
        await ensureRoomConsumer(identity.id, room);
        await syncPresence();
        await startRoomSubscriber(room);
        notify(`NATS: joined room "${room}"`);
      }
      notify(`NATS connected (agent: "${agentName}", rooms: [${getRooms().join(", ")}])`);
    } else {
      notify("NATS connected. Use nats_register_agent to claim a name.");
    }
    return true;
  }

  // ---- Lifecycle hooks ----

  pi.on("session_start", async (_event, ctx) => {
    lastUi = ctx.hasUI ? ctx.ui : null;
    setNatsWidget("offline");
    // Load DORMANT by default — do not open a NATS connection on session start.
    // Simple sessions shouldn't pay for a connection, heartbeat, and background
    // subscribers they never use. Connect on demand with /nats-connect.
    // Headless/automated sessions (which can't type a command) opt back into
    // auto-connect by setting NATS_AUTOCONNECT.
    if (process.env.NATS_AUTOCONNECT) {
      await bringUp(ctx);
    } else if (ctx.hasUI) {
      ctx.ui.notify("nats-chat loaded (offline). Run /nats-connect to join the bus.", "info");
    }
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    stopConnMonitor?.();
    stopConnMonitor = null;
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
      "View or edit NATS chat config (agent name, auto-join rooms) at project " +
      "(.pi/nats-chat.json) or global (~/.pi/agent/nats-chat.json) scope.",
    async handler(args, ctx) {
      lastUi = ctx.ui ?? lastUi;
      const cwd = ctx.cwd;

      // Display the effective config as a persistent, styled panel in the
      // conversation (the nats-chat renderer), rather than an editor modal.
      const showConfig = () =>
        pi.sendMessage({
          customType: "nats-chat",
          content: `config\n${describeConfig(cwd)}`,
          display: true,
        });

      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();

      // ---- Scriptable subcommands. Scope defaults to project; append "global"
      // (or "--global") to target the global file instead. ----
      if (sub === "set" || sub === "clear") {
        const rest = parts.slice(1);
        let scope: ConfigScope = "project";
        const gi = rest.findIndex(
          (p) => p.toLowerCase() === "global" || p.toLowerCase() === "--global",
        );
        if (gi !== -1) {
          scope = "global";
          rest.splice(gi, 1);
        }

        if (sub === "clear") {
          saveConfig({}, scope, cwd);
          ctx.ui.notify(`Cleared ${scope} NATS config. /reload to apply.`, "info");
          showConfig();
          return;
        }

        const key = rest[0]?.toLowerCase();
        const value = rest.slice(1).join(" ");
        if (!key || !value) {
          ctx.ui.notify(
            "Usage: /nats-config set name <agent-name> [global]\n" +
              "       /nats-config set rooms <room1,room2,…> [global]\n" +
              "       /nats-config set monitor <on|off> [global]",
            "error",
          );
          return;
        }
        const cfg = loadScope(scope, cwd);
        if (key === "name") {
          cfg.agentName = value;
        } else if (key === "rooms") {
          cfg.autoJoin = value.split(",").map((r) => r.trim()).filter(Boolean);
        } else if (key === "monitor") {
          cfg.monitor = /^(on|true|1|yes)$/i.test(value);
        } else {
          ctx.ui.notify(`Unknown key "${key}". Use "name", "rooms", or "monitor".`, "error");
          return;
        }
        saveConfig(cfg, scope, cwd);
        ctx.ui.notify(`Saved ${key} to ${scope} config. /reload to apply.`, "info");
        showConfig();
        return;
      }

      if (sub === "show") {
        showConfig();
        return;
      }

      // ---- Default: interactive panel when a UI is available. ----
      if (!ctx.hasUI) {
        showConfig();
        return;
      }

      while (true) {
        const eff = loadConfig(cwd);
        const summary = `name: ${eff.agentName ?? "(unset)"} · rooms: ${(eff.autoJoin ?? []).join(", ") || "(none)"} · monitor: ${eff.monitor ? "on" : "off"}`;
        const action = await ctx.ui.select(`NATS config — ${summary}`, [
          "Set agent name",
          "Set auto-join rooms",
          "Set monitor default",
          "Show details",
          "Clear config",
          "Done",
        ]);
        if (!action || action === "Done") break;
        if (action === "Show details") {
          showConfig();
          continue;
        }

        // Project is offered first so it's the natural default (Enter).
        const scopeChoice = await ctx.ui.select("Which scope?", [
          "Project — .pi/nats-chat.json (this repo)",
          "Global — ~/.pi/agent/nats-chat.json (all sessions)",
        ]);
        if (!scopeChoice) continue;
        const scope: ConfigScope = scopeChoice.startsWith("Global") ? "global" : "project";
        const cfg = loadScope(scope, cwd);

        if (action === "Set agent name") {
          const v = await ctx.ui.input("Agent name", cfg.agentName ?? eff.agentName);
          if (v && v.trim()) {
            cfg.agentName = v.trim();
            saveConfig(cfg, scope, cwd);
            ctx.ui.notify(`name → ${v.trim()} (${scope}). /reload to apply.`, "info");
          }
        } else if (action === "Set auto-join rooms") {
          // editor(title, prefill): the second arg is the PREFILLED content —
          // show the current rooms so the user edits rather than retypes.
          const current = (cfg.autoJoin ?? eff.autoJoin ?? []).join(", ");
          const v = await ctx.ui.editor("Auto-join rooms (comma-separated)", current);
          if (v !== undefined) {
            cfg.autoJoin = v.split(",").map((r) => r.trim()).filter(Boolean);
            saveConfig(cfg, scope, cwd);
            ctx.ui.notify(`rooms updated (${scope}). /reload to apply.`, "info");
          }
        } else if (action === "Set monitor default") {
          const choice = await ctx.ui.select(
            "Show unaddressed room chatter by default?",
            ["Off — only mentions/DMs", "On — monitor (show all chatter)"],
          );
          if (choice) {
            cfg.monitor = choice.startsWith("On");
            saveConfig(cfg, scope, cwd);
            ctx.ui.notify(
              `monitor default → ${cfg.monitor ? "on" : "off"} (${scope}). Use /nats-monitor to change it live.`,
              "info",
            );
          }
        } else if (action === "Clear config") {
          const ok = await ctx.ui.confirm(
            `Clear ${scope} config?`,
            "Resets agent name and rooms in that scope.",
          );
          if (ok) {
            saveConfig({}, scope, cwd);
            ctx.ui.notify(`Cleared ${scope} config.`, "info");
          }
        }
      }
      showConfig();
    },
  });

  // ---- Command: nats-connect ----

  pi.registerCommand("nats-connect", {
    description:
      "Connect to NATS and start background monitoring (auto-registers/joins from config or env). " +
      "The extension loads offline; run this to join the chat bus.",
    handler: async (_args, ctx) => {
      lastUi = ctx.hasUI ? ctx.ui : null;
      await bringUp(ctx);
    },
  });

  // ---- Command: nats-disconnect ----

  pi.registerCommand("nats-disconnect", {
    description:
      "Disconnect from NATS (stop monitoring, drop presence, free the connection) while keeping " +
      "the Pi session running. Reconnect as the same agent with /nats-connect.",
    handler: async (_args, ctx) => {
      lastUi = ctx.hasUI ? ctx.ui : lastUi;
      if (!isConnected()) {
        ctx.ui.notify("NATS is not connected.", "info");
        return;
      }
      // Remove our presence first (best-effort) so peers see us leave now,
      // rather than waiting up to the 5-min TTL — this needs the live connection.
      if (isRegistered()) {
        try {
          await deletePresence(getIdentity().id);
        } catch {
          /* best-effort */
        }
      }
      stopHeartbeat?.();
      stopHeartbeat = null;
      stopConnMonitor?.();
      stopConnMonitor = null;
      await stopAllSubscribers();
      await closeNats();
      resetInfrastructureCache();
      setNatsWidget("offline");
      // In-process identity and room memberships are kept, so /nats-connect
      // brings you back as the same agent in the same rooms. Durable consumers
      // persist server-side; only presence was dropped.
      ctx.ui.notify(
        "Disconnected from NATS. Session continues — /nats-connect to rejoin.",
        "info",
      );
    },
  });

  // ---- Command: nats-monitor ----

  pi.registerCommand("nats-monitor", {
    description:
      "Toggle showing unaddressed NATS room chatter in this session (default off). " +
      "Mentions, DMs, and acks always show; the monitor adds everything else, with no agent turn.",
    handler: async (args, ctx) => {
      lastUi = ctx.hasUI ? ctx.ui : lastUi;
      const a = args.trim().toLowerCase();
      let on: boolean;
      if (["on", "enable", "true", "1", "yes"].includes(a)) on = true;
      else if (["off", "disable", "false", "0", "no"].includes(a)) on = false;
      else if (a === "" || a === "toggle") on = !isMonitorEnabled();
      else if (a === "status") {
        ctx.ui.notify(`NATS monitor is ${isMonitorEnabled() ? "ON" : "OFF"}.`, "info");
        return;
      } else {
        ctx.ui.notify("Usage: /nats-monitor [on|off|toggle|status]", "error");
        return;
      }
      setMonitor(on);
      renderNatsWidget();
      ctx.ui.notify(
        on
          ? "NATS monitor ON — showing all room chatter in this session (no agent turns)."
          : "NATS monitor OFF — only mentions, DMs, and acks are shown.",
        "info",
      );
    },
  });

  // ---- Command: nats-reconnect ----

  pi.registerCommand("nats-reconnect", {
    description: "Reconnect to NATS and restart background monitoring (after a server restart)",
    handler: async (_args, ctx) => {
      lastUi = ctx.hasUI ? ctx.ui : null;
      // Stop old heartbeat + status monitor before draining the connection —
      // otherwise they fire against a dead NATS client and throw.
      stopHeartbeat?.();
      stopHeartbeat = null;
      stopConnMonitor?.();
      stopConnMonitor = null;
      await stopAllSubscribers();
      await closeNats();
      resetInfrastructureCache();
      try {
        await connectNats();
        await ensureInfrastructure();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        setNatsWidget("offline");
        ctx.ui.notify(`NATS reconnect failed: ${detail}`, "error");
        return;
      }
      setPi(pi);
      stopHeartbeat = startHeartbeat();
      stopConnMonitor = startConnectionMonitor();
      setNatsWidget("connected");
      await startAllSubscribers();
      // Immediately push presence so other agents see us in rooms right away,
      // rather than waiting for the next heartbeat tick (up to 60 s).
      await syncPresence();
      ctx.ui.notify("NATS reconnected and monitoring restarted", "info");
    },
  });
}
