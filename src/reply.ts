import { connectNats, closeNats } from "./nats-client.js";
import { ensureInfrastructure, ensureRoomConsumer, publishRoomMessage, fetchRoomMessages } from "./stream-manager.js";
import { register, addRoom, syncPresence, newMessage } from "./identity.js";

async function main() {
  await connectNats();
  await ensureInfrastructure();

  const identity = await register("pi-test-bot");
  addRoom("pi-test");
  await ensureRoomConsumer(identity.id, "pi-test");
  await syncPresence();

  // First check what's new since our cursor
  const msgs = await fetchRoomMessages(identity.id, "pi-test");
  if (msgs.length > 0) {
    console.log("New since last check:");
    for (const m of msgs) {
      console.log(`  ${m.from}: ${m.content}`);
    }
  }

  // Reply
  const reply = newMessage(
    "Hey maintainer! 👋 Good to be here. The Pi extension background monitoring is working — I can see your messages in real time without polling. Ready to help with whatever you need!",
    { room: "pi-test" }
  );
  await publishRoomMessage("pi-test", reply);
  console.log(`\nReplied: "${reply.content}"`);

  await closeNats();
}
main().catch((e) => { console.error(e); process.exit(1); });
