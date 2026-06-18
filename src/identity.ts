// In-process identity for the current Pi session. One Pi session owns
// exactly one agent; this module is the single source of truth for who that
// agent is and which rooms it has joined, mirrored to the presence KV.
import { randomUUID } from "node:crypto";
import type {
  AckMessage,
  AckStatus,
  AgentIdentity,
  AgentPresence,
  Message,
} from "./types.js";
import { putPresence } from "./stream-manager.js";

interface SessionState extends AgentIdentity {
  rooms: Set<string>;
}

let state: SessionState | null = null;

/**
 * Generate a subject/durable-safe agent id. NATS subject tokens and durable
 * consumer names can't contain "." (and shouldn't start with a digit), so we
 * strip the UUID's dashes and prefix a letter — leaving plain hex like
 * "a3f9...".
 */
function newAgentId(): string {
  return "a" + randomUUID().replaceAll("-", "");
}

export function isRegistered(): boolean {
  return state !== null;
}

/** Clear the in-process identity so each test starts unregistered. */
export function resetIdentityForTests(): void {
  state = null;
}

/** Register (or re-register) this session as a named agent. */
export async function register(name: string): Promise<AgentIdentity> {
  // Re-registering keeps the existing id and rooms, so register_agent is safe
  // to call twice (e.g. to change name) without orphaning the direct-message
  // consumer that was created under the original id.
  state = {
    id: state?.id ?? newAgentId(),
    name,
    rooms: state?.rooms ?? new Set<string>(),
  };
  await syncPresence();
  return getIdentity();
}

/** Throws a user-facing error if the session hasn't registered yet. */
export function requireState(): SessionState {
  if (!state) {
    throw new Error(
      "Not registered — call nats_register_agent first to set this session's name",
    );
  }
  return state;
}

export function getIdentity(): AgentIdentity {
  const s = requireState();
  return { id: s.id, name: s.name };
}

export function getRooms(): string[] {
  return [...requireState().rooms];
}

export function addRoom(room: string): void {
  requireState().rooms.add(room);
}

export function removeRoom(room: string): void {
  requireState().rooms.delete(room);
}

export function hasRoom(room: string): boolean {
  return requireState().rooms.has(room);
}

/** Snapshot of this session's presence for writing to the KV registry. */
export function presenceSnapshot(): AgentPresence {
  const s = requireState();
  return {
    id: s.id,
    name: s.name,
    rooms: [...s.rooms],
    last_seen: new Date().toISOString(),
  };
}

/**
 * Build an outgoing message stamped with this session's identity. `room` is
 * set for room broadcasts and left undefined for direct messages.
 */
export function newMessage(
  content: string,
  opts: { room?: string; reply_to?: string } = {},
): Message {
  const s = requireState();
  return {
    id: randomUUID(),
    from: s.name,
    from_id: s.id,
    room: opts.room,
    content,
    timestamp: new Date().toISOString(),
    reply_to: opts.reply_to,
  };
}

/**
 * Build an acknowledgment stamped with this session's identity.
 */
export function newAck(
  regarding: string,
  status: AckStatus,
  note?: string,
): AckMessage {
  const summary = note
    ? `[ack: ${status}] ${regarding} — ${note}`
    : `[ack: ${status}] ${regarding}`;
  const base = newMessage(summary);
  return note
    ? { ...base, type: "ack", regarding, status, note }
    : { ...base, type: "ack", regarding, status };
}

/**
 * Push current presence (identity + rooms + fresh last_seen) to the KV
 * registry. Call after any state change and on each tool invocation so an
 * active session keeps its TTL-backed presence alive.
 */
export async function syncPresence(): Promise<void> {
  if (!state) return;
  await putPresence(presenceSnapshot());
}
