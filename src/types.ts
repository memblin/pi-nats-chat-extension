// Shared data shapes that flow through the system: agent identities, the
// presence records stored in the KV registry, and the messages published to
// NATS subjects. Every JSON payload on the wire conforms to one of these.

export interface AgentIdentity {
  id: string;
  name: string;
}

export interface AgentPresence extends AgentIdentity {
  rooms: string[];
  last_seen: string;
}

export interface Message {
  id: string;
  from: string;
  from_id: string;
  room?: string;
  content: string;
  timestamp: string;
  reply_to?: string;
}

/** Handling states a send_ack can report back to a message's sender. */
export type AckStatus =
  | "received"
  | "investigating"
  | "dispatching"
  | "in_progress"
  | "blocked"
  | "complete";

/**
 * A lightweight acknowledgment. It rides the same direct-message subject as a
 * normal Message (so existing consumers and the console read it without change)
 * but carries `type: "ack"` plus the ack fields, letting recipients render it as
 * a status badge rather than a chat turn.
 */
export interface AckMessage extends Message {
  type: "ack";
  regarding: string;
  status: AckStatus;
  note?: string;
}
