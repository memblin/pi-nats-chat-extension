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
import type { Message } from "./types.js";

/** Active background consumers, keyed by their NATS durable name. */
const consumers = new Map<string, BackgroundConsumer>();

/** Reference to pi, set on session_start. */
let pi: ExtensionAPI | null = null;

export function setPi(p: ExtensionAPI): void {
  pi = p;
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
  const mention = `@${identity.name}`;
  return msg.content.includes(mention);
}

/**
 * Callback invoked by push consumers when a message arrives. Injects it into
 * the Pi conversation as a user message so the agent responds.
 */
function onMessage(msg: Message): void {
  if (!pi) return;

  // Reset the empty-wakeup streak so wait_for_message sees activity too
  const identity = isRegistered() ? getIdentity() : null;
  if (identity) resetEmptyWakeups(identity.id);

  // Keep presence fresh on receive
  void syncPresence().catch(() => {});

  const text = formatMessageForInjection(msg);

  if (msg.type === "ack") {
    // Acks are informational — send as custom message, don't interrupt
    pi.sendMessage({
      customType: "nats-chat",
      content: text,
      display: true,
      details: { msg },
    });
  } else if (isAddressedToAgent(msg)) {
    // Addressed messages trigger a turn so the agent responds
    pi.sendUserMessage(text, { deliverAs: "steer" });
  } else {
    // Unaddressed room chatter — display silently, no turn triggered
    pi.sendMessage({
      customType: "nats-chat",
      content: text,
      display: true,
      details: { msg },
    });
  }
}

function onError(err: unknown): void {
  if (pi?.events) {
    pi.events.emit("nats:error", { error: err });
  }
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
