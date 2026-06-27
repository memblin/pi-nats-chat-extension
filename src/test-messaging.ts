/**
 * Messaging integration test against a real NATS server. Exercises the parts
 * the reliability/usage hardening touched:
 *   - token-aware @mention filtering on real round-tripped wire data
 *   - getRoomHistory's ring-buffer tail (returns the last N, in order)
 *   - direct-message delivery to an agent id that has no presence record
 *     (the "DM by id even when presence has lapsed" path)
 *
 * Run: NATS_URL=nats://localhost:4222 npx tsx src/test-messaging.ts
 */
import { randomUUID } from "node:crypto";
import { connectNats, closeNats, NATS_URL } from "./nats-client.js";
import {
  ensureInfrastructure,
  ensureRoomConsumer,
  ensureDirectConsumer,
  publishRoomMessage,
  publishDirectMessage,
  fetchRoomMessages,
  fetchDirectMessages,
  getRoomHistory,
} from "./stream-manager.js";
import { register, addRoom, getIdentity, syncPresence } from "./identity.js";
import { isMentioned } from "./mentions.js";
import type { Message } from "./types.js";

let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

/** A synthetic "remote" agent id in the real id format ("a" + 32 hex). */
function remoteId(): string {
  return "a" + randomUUID().replaceAll("-", "");
}

function remoteMsg(from: string, fromId: string, room: string, content: string): Message {
  return {
    id: randomUUID(),
    from,
    from_id: fromId,
    room,
    content,
    timestamp: new Date().toISOString(),
  };
}

async function main() {
  console.log(`Connecting to ${NATS_URL}...`);
  await connectNats();
  await ensureInfrastructure();

  const me = await register("alice");
  const myId = getIdentity().id;
  const bobId = remoteId();

  // ---- Mention filtering on real wire data ----
  const team = `mt-${Date.now().toString(36)}`;
  addRoom(team);
  await ensureRoomConsumer(myId, team); // DeliverPolicy.New — created before publishes
  await syncPresence();

  const cases: Array<[string, boolean]> = [
    ["hey @alice can you look", true], // explicit mention
    ["just some chatter, no ping", false], // unaddressed
    ["@all standup in 5", true], // broadcast
    ["cc @alicia not me", false], // substring must NOT match
  ];
  for (const [content] of cases) {
    await publishRoomMessage(team, remoteMsg("bob", bobId, team, content));
  }

  const got = await fetchRoomMessages(myId, team, 50);
  check("fetched all 4 remote room messages", got.length === 4);
  check("own id is filtered from fetch (none from me)", got.every((m) => m.from_id !== myId));
  for (const [content, expected] of cases) {
    const m = got.find((x) => x.content === content);
    check(`mention(${JSON.stringify(content)})=${expected}`, !!m && isMentioned(m.content, me.name) === expected);
  }

  // ---- History ring-buffer tail ----
  const hist = `mh-${Date.now().toString(36)}`;
  for (let i = 0; i < 5; i++) {
    await publishRoomMessage(hist, remoteMsg("bob", bobId, hist, `h${i}`));
  }
  const tail = await getRoomHistory(hist, 3);
  check("history returns exactly the limit (3)", tail.length === 3);
  check(
    "history returns the most-recent 3 in order (h2,h3,h4)",
    tail.map((m) => m.content).join(",") === "h2,h3,h4",
  );

  // ---- DM to an id with no presence record ----
  await ensureDirectConsumer(bobId);
  await publishDirectMessage(bobId, remoteMsg("alice", myId, "", "ping with no presence record"));
  const dms = await fetchDirectMessages(bobId, 50);
  check("DM delivered to a presence-less id", dms.length === 1 && dms[0].content.includes("ping"));

  await closeNats();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
