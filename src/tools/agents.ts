// Agent discovery: nats_list_agents
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getIdentity, isRegistered, syncPresence } from "../identity.js";
import { listPresence } from "../stream-manager.js";

export function registerAgentsTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "nats_list_agents",
    label: "NATS List Agents",
    description: "List all registered agents and their presence",
    promptSnippet: "List all agents on the NATS bus and their room memberships",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      if (isRegistered()) await syncPresence();

      const agents = await listPresence();
      const selfId = isRegistered() ? getIdentity().id : null;

      const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));

      const mapped = sorted.map((agent) => ({
        id: agent.id,
        name: agent.name,
        rooms: agent.rooms,
        last_seen: agent.last_seen,
        is_self: agent.id === selfId,
      }));

      const lines = mapped.length === 0
        ? ["No agents registered."]
        : mapped.map((a) => {
            const self = a.is_self ? " (you)" : "";
            const rooms = a.rooms.length > 0 ? a.rooms.map((r) => `#${r}`).join(", ") : "no rooms";
            const seen = a.last_seen.slice(11, 19);
            return `@${a.name}${self} [${seen}] ${rooms}`;
          });
      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  });
}
