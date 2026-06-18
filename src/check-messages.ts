import { connectNats, closeNats } from "./nats-client.js";
import { ensureInfrastructure, ensureRoomConsumer, fetchRoomMessages, getRoomHistory } from "./stream-manager.js";
import { register, addRoom, syncPresence } from "./identity.js";

async function main() {
  await connectNats();
  await ensureInfrastructure();

  const identity = await register("pi-test-bot");
  addRoom("pi-test");
  await ensureRoomConsumer(identity.id, "pi-test");
  await syncPresence();

  // Fetch new messages since our last consumer cursor
  const msgs = await fetchRoomMessages(identity.id, "pi-test");
  if (msgs.length > 0) {
    console.log(`New messages (${msgs.length}):`);
    for (const m of msgs) {
      console.log(`  [${m.timestamp}] ${m.from}: ${m.content}`);
    }
  } else {
    const history = await getRoomHistory("pi-test", 10);
    console.log(`Last ${history.length} messages:`);
    for (const m of history) {
      console.log(`  [${m.timestamp}] ${m.from}: ${m.content}`);
    }
  }

  await closeNats();
}
main().catch((e) => { console.error(e); process.exit(1); });
