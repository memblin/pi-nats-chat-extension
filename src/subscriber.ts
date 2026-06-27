// Background push subscribers that watch NATS rooms and direct messages
// WITHOUT blocking the agent's main thread. When a message arrives, it is
// injected into the conversation via pi.sendUserMessage() so the LLM sees it
// as a new user message and responds naturally.
//
// This is the Pi-native alternative to wait_for_message. The agent can work
// on tasks and get interrupted only when chat traffic actually arrives.
//
// Lifecycle:
//   session_start → no-op (no subscribers until register + join)
//   register_agent  → starts DM subscriber (if not already running)
//   join_room      → starts room subscriber for that room
//   leave_room     → stops room subscriber
//   session_shutdown → stops all subscribers + closes NATS

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ROOM_STREAM,
  DIRECT_STREAM,
  roomConsumerName,
  directConsumerName,
  startPushConsumer,
  type BackgroundConsumer,
} from "./stream-manager.js";
import { getIdentity, getRooms, isRegistered, syncPresence } from "./identity.js";
import { resetEmptyWakeups } from "./wakeups.js";
import { isMentioned } from "./mentions.js";
import type { Message } from "./types.js";

/** Active background consumers, keyed by their NATS durable name. */
const consumers = new Map<string, BackgroundConsumer>();

/** Reference to pi, set on session_start. */
let pi: ExtensionAPI | null = null;

export function setPi(p: ExtensionAPI): void {
  pi = p;
}

/**
 * Whether the "chat monitor" is on. When OFF (the default), unaddressed room
 * chatter is suppressed entirely — only messages addressed to this agent
 * (mentions / DMs / @all) and acks reach the session. When ON, unaddressed
 * chatter is also printed to the session for a human to read (chat-console
 * style), still WITHOUT triggering an agent turn or any token processing.
 */
let monitorEnabled = false;

export function setMonitor(on: boolean): void {
  monitorEnabled = on;
}

export function isMonitorEnabled(): boolean {
  return monitorEnabled;
}

/**
 * Format a NATS message for injection into the Pi conversation.
 * Direct messages get a prominent header; room messages include the room name.
 */
function formatMessageForInjection(msg: Message): string {
  if (msg.type === "ack") {
    const extra = msg.note ? ` — ${msg.note}` : "";
    return `[NATS ack from ${msg.from}: ${msg.status}] ${msg.regarding}${extra}`;
  }
  if (msg.room) {
    return `[NATS room:${msg.room} from ${msg.from}] ${msg.content}`;
  }
  return `[NATS DM from ${msg.from}] ${msg.content}`;
}

/**
 * Whether a message is addressed to this agent. A message is "addressed" if:
 * - It contains "@agentName" (the registered display name), or
 * - It is a direct message (no room set).
 *
 * Unaddressed room chatter is displayed silently without triggering a turn,
 * so the agent isn't distracted by background conversation.
 */
function isAddressedToAgent(msg: Message): boolean {
  if (!isRegistered()) return true; // not registered yet, accept all
  const identity = getIdentity();
  if (!msg.room) return true; // direct messages are always addressed
  // Specific @<name> mention or @all broadcast, token-aware (see mentions.ts).
  return isMentioned(msg.content, identity.name);
}

/**
 * Callback invoked by push consumers when a message arrives. Injects it into
 * the Pi conversation as a user message so the agent responds.
 */
function onMessage(msg: Message): void {
  if (!pi) return;

  const text = formatMessageForInjection(msg);

  // Side effects worth doing only for messages we actually surface/process:
  // refresh presence and reset the wait_for_message empty-wakeup streak.
  const surface = () => {
    const identity = isRegistered() ? getIdentity() : null;
    if (identity) resetEmptyWakeups(identity.id);
    void syncPresence().catch(() => {});
  };

  if (msg.type === "ack") {
    // Acks ride your DM subject (directed at you) — always shown, never a turn.
    surface();
    pi.sendMessage({ customType: "nats-chat", content: text, display: true, details: { msg } });
    return;
  }

  if (isAddressedToAgent(msg)) {
    // Mentions / DMs / @all — inject as a user message so the agent responds.
    surface();
    pi.sendUserMessage(text, { deliverAs: "steer" });
    return;
  }

  // Unaddressed room chatter. Default: suppress entirely (no display, no token
  // processing — the message is already acked on NATS by the consumer). With
  // the monitor on, print it for a human to read, still without a turn.
  if (monitorEnabled) {
    surface();
    pi.sendMessage({ customType: "nats-chat", content: text, display: true, details: { msg } });
  }
}

function onError(err: unknown): void {
  // Surface to the conversation so a struggling subscriber isn't silent. The
  // push consumer auto-restarts (see startPushConsumer); this is visibility,
  // not recovery. Displayed without triggering a turn.
  if (!pi) return;
  const detail = err instanceof Error ? err.message : String(err);
  pi.sendMessage({
    customType: "nats-chat",
    content: `subscriber error (retrying): ${detail}`,
    display: true,
  });
}

// ---- DM subscriber ----

export async function startDmSubscriber(): Promise<void> {
  if (!pi) return;
  const identity = getIdentity();
  const name = directConsumerName(identity.id);

  if (consumers.has(name)) return; // already running

  const c = startPushConsumer(
    DIRECT_STREAM,
    name,
    identity.id,
    onMessage,
    onError,
  );
  consumers.set(name, c);
}

// ---- Room subscriber ----

export async function startRoomSubscriber(room: string): Promise<void> {
  if (!pi) return;
  const identity = getIdentity();
  const name = roomConsumerName(identity.id, room);

  if (consumers.has(name)) return; // already running

  const c = startPushConsumer(
    ROOM_STREAM,
    name,
    identity.id,
    onMessage,
    onError,
  );
  consumers.set(name, c);
}

export async function stopRoomSubscriber(room: string): Promise<void> {
  const identity = getIdentity();
  const name = roomConsumerName(identity.id, room);
  const c = consumers.get(name);
  if (c) {
    await c.stop();
    consumers.delete(name);
  }
}

// ---- Full teardown ----

export async function stopAllSubscribers(): Promise<void> {
  const stops = [...consumers.values()].map((c) => c.stop());
  consumers.clear();
  await Promise.allSettled(stops);
}

/**
 * Start subscribers for all currently-joined rooms + DMs.
 * Called after session_start when the agent is already registered.
 */
export async function startAllSubscribers(): Promise<void> {
  if (!isRegistered() || !pi) return;
  await startDmSubscriber();
  for (const room of getRooms()) {
    await startRoomSubscriber(room);
  }
}
