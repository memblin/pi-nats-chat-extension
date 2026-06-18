// JetStream infrastructure + every NATS read/write the tools rely on.
// Tools call these typed helpers and never touch the NATS client directly.
import { nanos } from "@nats-io/transport-node";
import {
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  type Consumer,
  type ConsumerMessages,
} from "@nats-io/jetstream";
import { Bucket, type KV } from "@nats-io/kv";
import { getJetStream, getManager } from "./nats-client.js";
import type { AgentPresence, Message } from "./types.js";

// ---------------------------------------------------------------------------
// Names & subjects
// ---------------------------------------------------------------------------

export const ROOM_STREAM = "CLAUDE_CHAT_ROOMS";
export const DIRECT_STREAM = "CLAUDE_CHAT_DIRECT";
export const PRESENCE_KV = "claude_chat_agents";

// Retain a day of room/direct traffic, capped per subject so a busy room
// can't grow without bound. Consumers expire a week after going idle.
const MESSAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MESSAGE_MAX_PER_SUBJECT = 1000;
const CONSUMER_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
// Linger window for presence: the server expires a record this long after its
// last write, so a crashed/abandoned session clears on its own. Kept short
// because every live participant refreshes well inside it — a registered agent
// heartbeats every 60s for the life of its session, so 5 min is several missed
// heartbeats.
const PRESENCE_TTL_MS = 5 * 60 * 1000;

// After the first message wakes a blocking wait, keep gathering for this brief
// window so a burst of messages arriving a few-score ms apart all land in the
// same response rather than being split across two calls.
const WAIT_SETTLE_MS = 200;

export const roomSubject = (room: string) => `chat.room.${room}.msg`;
export const directSubject = (agentId: string) => `chat.direct.${agentId}.msg`;
export const roomConsumerName = (agentId: string, room: string) =>
  `room_${agentId}_${room}`;
export const directConsumerName = (agentId: string) => `direct_${agentId}`;

/**
 * Names used in NATS subject tokens and durable consumer names must avoid
 * `.`, `*`, `>` and whitespace. We allow a conservative slug character set.
 * Throws a user-facing error when the value is unusable.
 */
export function assertValidToken(kind: string, value: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new Error(
      `Invalid ${kind} "${value}": use 1-64 chars of letters, digits, "_" or "-" only`,
    );
  }
}

const te = new TextEncoder();
const td = new TextDecoder();
const messageCodec = {
  encode(v: Message): Uint8Array { return te.encode(JSON.stringify(v)); },
  decode(a: Uint8Array): Message { return JSON.parse(td.decode(a)); },
};
const presenceCodec = {
  encode(v: AgentPresence): Uint8Array { return te.encode(JSON.stringify(v)); },
  decode(a: Uint8Array): AgentPresence { return JSON.parse(td.decode(a)); },
};

// ---------------------------------------------------------------------------
// Infrastructure bootstrap
// ---------------------------------------------------------------------------

let presenceKv: KV | null = null;

/** Create the streams and presence bucket if they don't already exist. */
export async function ensureInfrastructure(): Promise<void> {
  await ensureStream(ROOM_STREAM, ["chat.room.>"]);
  await ensureStream(DIRECT_STREAM, ["chat.direct.>"]);
  await getPresenceKv();
}

async function ensureStream(name: string, subjects: string[]): Promise<void> {
  const jsm = getManager();
  try {
    await jsm.streams.info(name);
  } catch {
    await jsm.streams.add({
      name,
      subjects,
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      discard: DiscardPolicy.Old,
      max_age: nanos(MESSAGE_MAX_AGE_MS),
      max_msgs_per_subject: MESSAGE_MAX_PER_SUBJECT,
    });
  }
}

async function getPresenceKv(): Promise<KV> {
  if (presenceKv) return presenceKv;
  presenceKv = await Bucket.create(getJetStream(), PRESENCE_KV, {
    history: 1,
    ttl: PRESENCE_TTL_MS,
  });
  return presenceKv;
}

/** Drop the cached KV handle so it can't outlive a closed connection (tests). */
export function resetStreamManagerForTests(): void {
  presenceKv = null;
}

// ---------------------------------------------------------------------------
// Presence registry (KV)
// ---------------------------------------------------------------------------

export async function putPresence(presence: AgentPresence): Promise<void> {
  const kv = await getPresenceKv();
  await kv.put(presence.id, presenceCodec.encode(presence));
}

export async function getPresence(
  agentId: string,
): Promise<AgentPresence | null> {
  const kv = await getPresenceKv();
  const entry = await kv.get(agentId);
  if (entry?.operation !== "PUT") return null;
  try {
    return entry.json<AgentPresence>();
  } catch {
    return null;
  }
}

export async function deletePresence(agentId: string): Promise<void> {
  const kv = await getPresenceKv();
  await kv.delete(agentId);
}

export async function listPresence(): Promise<AgentPresence[]> {
  const kv = await getPresenceKv();
  const out: AgentPresence[] = [];
  // Drain the key iterator FULLY before fetching any value (see nats-chat-mcp
  // for rationale: interleaving keys() and get() opens conflicting consumers).
  const keys: string[] = [];
  for await (const key of await kv.keys()) keys.push(key);
  for (const key of keys) {
    const entry = await kv.get(key);
    if (entry?.operation !== "PUT") continue;
    try {
      out.push(entry.json<AgentPresence>());
    } catch {
      /* skip malformed entry */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

export async function publishRoomMessage(
  room: string,
  message: Message,
): Promise<void> {
  await getJetStream().publish(roomSubject(room), messageCodec.encode(message));
}

export async function publishDirectMessage(
  toAgentId: string,
  message: Message,
): Promise<void> {
  await getJetStream().publish(
    directSubject(toAgentId),
    messageCodec.encode(message),
  );
}

// ---------------------------------------------------------------------------
// Durable consumers — one per (agent, room) and one per agent for DMs.
// ---------------------------------------------------------------------------

export async function ensureRoomConsumer(
  agentId: string,
  room: string,
): Promise<void> {
  await ensureConsumer(
    ROOM_STREAM,
    roomConsumerName(agentId, room),
    roomSubject(room),
  );
}

export async function deleteRoomConsumer(
  agentId: string,
  room: string,
): Promise<void> {
  try {
    await getManager().consumers.delete(
      ROOM_STREAM,
      roomConsumerName(agentId, room),
    );
  } catch {
    /* already gone */
  }
}

export async function ensureDirectConsumer(agentId: string): Promise<void> {
  await ensureConsumer(
    DIRECT_STREAM,
    directConsumerName(agentId),
    directSubject(agentId),
  );
}

async function ensureConsumer(
  stream: string,
  durable: string,
  filterSubject: string,
): Promise<void> {
  const jsm = getManager();
  try {
    await jsm.consumers.info(stream, durable);
    return;
  } catch {
    /* needs creating */
  }
  await jsm.consumers.add(stream, {
    durable_name: durable,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.New,
    filter_subject: filterSubject,
    inactive_threshold: nanos(CONSUMER_IDLE_MS),
  });
}

// ---------------------------------------------------------------------------
// Fetch (poll)
// ---------------------------------------------------------------------------

export async function fetchRoomMessages(
  agentId: string,
  room: string,
  max = 50,
): Promise<Message[]> {
  const consumer = await getJetStream().consumers.get(
    ROOM_STREAM,
    roomConsumerName(agentId, room),
  );
  return drainConsumer(consumer, max, agentId);
}

export async function fetchDirectMessages(
  agentId: string,
  max = 50,
): Promise<Message[]> {
  const consumer = await getJetStream().consumers.get(
    DIRECT_STREAM,
    directConsumerName(agentId),
  );
  return drainConsumer(consumer, max, agentId);
}

async function drainConsumer(
  consumer: Consumer,
  max: number,
  selfId: string,
): Promise<Message[]> {
  const out: Message[] = [];
  const batch = await consumer.fetch({ max_messages: max, expires: 1000 });
  for await (const msg of batch) {
    let parsed: Message | undefined;
    try {
      parsed = msg.json<Message>();
    } catch {
      /* skip malformed payload */
    }
    msg.ack();
    if (parsed && parsed.from_id !== selfId) out.push(parsed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Blocking wait — wake on first delivery across all of an agent's subjects.
// ---------------------------------------------------------------------------

export interface WaitResult {
  roomMessages: Message[];
  directMessages: Message[];
}

export async function waitForMessages(
  agentId: string,
  rooms: string[],
  timeoutMs: number,
): Promise<WaitResult> {
  const js = getJetStream();
  const roomMessages: Message[] = [];
  const directMessages: Message[] = [];

  let wake: () => void = () => {};
  const firstMessage = new Promise<void>((resolve) => {
    wake = resolve;
  });

  const subscriptions: ConsumerMessages[] = [];

  const pump = async (consumer: Consumer, bucket: Message[]): Promise<void> => {
    const iter = await consumer.consume({ max_messages: 100 });
    subscriptions.push(iter);
    try {
      for await (const msg of iter) {
        let parsed: Message | undefined;
        try {
          parsed = msg.json<Message>();
        } catch {
          /* skip malformed payload */
        }
        msg.ack();
        if (parsed && parsed.from_id !== agentId) {
          bucket.push(parsed);
          wake();
        }
      }
    } catch {
      /* iterator stopped or consumer went away */
    }
  };

  const roomConsumers = await Promise.all(
    rooms.map((room) =>
      js.consumers.get(ROOM_STREAM, roomConsumerName(agentId, room)),
    ),
  );
  const directConsumer = await js.consumers.get(
    DIRECT_STREAM,
    directConsumerName(agentId),
  );

  const pumps = [
    ...roomConsumers.map((c) => pump(c, roomMessages)),
    pump(directConsumer, directMessages),
  ];

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });

  await Promise.race([firstMessage, timeout]);

  // Woken by a delivery? Linger briefly to sweep up a closely-following burst.
  if (roomMessages.length > 0 || directMessages.length > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, WAIT_SETTLE_MS));
  }

  if (timer) clearTimeout(timer);
  for (const iter of subscriptions) iter.stop();
  await Promise.allSettled(pumps);

  return { roomMessages, directMessages };
}

// ---------------------------------------------------------------------------
// History — read-only replay over a room's retained messages.
// ---------------------------------------------------------------------------

export async function getRoomHistory(
  room: string,
  limit = 50,
): Promise<Message[]> {
  const consumer = await getJetStream().consumers.get(ROOM_STREAM, {
    filterSubjects: roomSubject(room),
  });
  const out: Message[] = [];
  const batch = await consumer.fetch({
    max_messages: MESSAGE_MAX_PER_SUBJECT,
    expires: 1500,
  });
  for await (const msg of batch) {
    try {
      out.push(msg.json<Message>());
    } catch {
      /* skip malformed payload */
    }
  }
  return out.slice(-limit);
}

// ---------------------------------------------------------------------------
// Push consumer — for background subscriber (non-blocking, fires callback)
// ---------------------------------------------------------------------------

export interface BackgroundConsumer {
  /** Stop the background consumer gracefully. */
  stop(): Promise<void>;
}

/**
 * Open a continuous read on a durable consumer, calling `onMessage` for each
 * delivery. The callback receives the parsed Message plus the raw ack function
 * (the subscriber acks after the callback succeeds).
 *
 * A self-authored message (from_id === agentId) is still acked but NOT passed
 * to the callback — otherwise the agent would see its own posts as incoming.
 */
export function startPushConsumer(
  stream: string,
  durableName: string,
  agentId: string,
  onMessage: (msg: Message) => void | Promise<void>,
  onError?: (err: unknown) => void,
): BackgroundConsumer {
  let stopped = false;
  let sub: ConsumerMessages | null = null;

  const run = (async () => {
    if (stopped) return;
    const consumer = await getJetStream().consumers.get(stream, durableName);
    if (stopped) return;

    sub = await consumer.consume({ max_messages: 100 });
    try {
      for await (const msg of sub) {
        if (stopped) break;
        let parsed: Message | undefined;
        try {
          parsed = msg.json<Message>();
        } catch {
          msg.ack();
          continue;
        }
        msg.ack();
        if (parsed && parsed.from_id !== agentId) {
          try {
            await onMessage(parsed);
          } catch (err) {
            onError?.(err);
          }
        }
      }
    } catch (err) {
      if (!stopped) onError?.(err);
    }
  })();

  return {
    async stop() {
      stopped = true;
      sub?.stop();
      await run.catch(() => {});
    },
  };
}
