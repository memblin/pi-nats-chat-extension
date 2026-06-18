import { connectNats, closeNats } from "./nats-client.js";
import { ensureInfrastructure, ensureRoomConsumer, ensureDirectConsumer, listPresence } from "./stream-manager.js";
import { register, addRoom, syncPresence, getIdentity } from "./identity.js";

async function main() {
  await connectNats();
  await ensureInfrastructure();

  const name = process.env.NATS_AGENT_NAME || "pi-bot";
  const identity = await register(name);
  await ensureDirectConsumer(identity.id);
  console.log("registered:", identity.name);

  const rooms = (process.env.NATS_AUTO_JOIN || "").split(",").map(r => r.trim()).filter(Boolean);
  for (const room of rooms) {
    addRoom(room);
    await ensureRoomConsumer(identity.id, room);
    await syncPresence();
    console.log("joined:", room);
  }

  const agents = await listPresence();
  const self = agents.find(a => a.id === identity.id);
  console.log("rooms:", self?.rooms);
  console.log("all agents:", agents.map(a => a.name + " [" + a.rooms.join(",") + "]").join(", "));

  await closeNats();
}
main().catch(e => { console.error(e); process.exit(1); });
