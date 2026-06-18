/**
 * Quick smoke test: connect to NATS, register, join pi-test, send a greeting,
 * then verify presence and check room messages.  Keeps the connection alive
 * for a few seconds so presence is visible to other agents.
 *
 * Run: NATS_URL=nats://nats01.tkclabs.io:4222 npx tsx src/test-greet.ts
 */
import { connectNats, closeNats, NATS_URL } from "./nats-client.js";
import { ensureInfrastructure, ensureRoomConsumer, ensureDirectConsumer, publishRoomMessage, fetchRoomMessages, listPresence } from "./stream-manager.js";
import { register, addRoom, getIdentity, newMessage, syncPresence } from "./identity.js";

async function main() {
  console.log(`Connecting to ${NATS_URL}...`);
  await connectNats();
  console.log("Connected.");

  await ensureInfrastructure();
  console.log("Infrastructure ready.");

  // Register
  const identity = await register("pi-test-bot");
  console.log(`Registered as "${identity.name}" (id: ${identity.id})`);

  // Set up consumers
  await ensureDirectConsumer(identity.id);
  console.log("DM consumer ready.");

  // Join pi-test room — must sync presence AFTER adding the room
  addRoom("pi-test");
  await ensureRoomConsumer(identity.id, "pi-test");
  await syncPresence();  // refresh presence so the room shows up
  console.log('Joined room "pi-test" (presence updated).');

  // Verify presence is visible
  const agents = await listPresence();
  const self = agents.find((a) => a.id === identity.id);
  console.log("\n--- Presence check ---");
  console.log(`Total agents visible: ${agents.length}`);
  for (const a of agents) {
    console.log(`  ${a.name} (${a.id.slice(0, 12)}…) rooms: [${a.rooms.join(", ")}]`);
  }
  if (!self) {
    console.warn("⚠️  WARNING: Could not find ourselves in presence list!");
  }
  console.log("---");

  // Send greeting
  const msg = newMessage("Hello from pi-nats-chat! 👋 The Pi extension is alive and connected.", { room: "pi-test" });
  await publishRoomMessage("pi-test", msg);
  console.log(`\nSent to pi-test: "${msg.content}"`);

  // Check for any messages already in the room
  const msgs = await fetchRoomMessages(identity.id, "pi-test");
  if (msgs.length > 0) {
    console.log(`\nRoom messages (${msgs.length}):`);
    for (const m of msgs) {
      console.log(`  [${m.timestamp}] ${m.from}: ${m.content}`);
    }
  } else {
    console.log("\nNo other messages in room yet.");
  }

  // Keep alive briefly so presence is visible to other agents
  console.log("\nKeeping connection alive for 10 seconds (Ctrl+C to exit early)...");
  await new Promise((r) => setTimeout(r, 10_000));

  await closeNats();
  console.log("\nDone. Extension is ready for Pi.");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
