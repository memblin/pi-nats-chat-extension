// Persistent config for the NATS chat extension.
// Stored in ~/.pi/agent/nats-chat.json so it survives reloads and restarts.
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const CONFIG_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(CONFIG_DIR, "nats-chat.json");

export interface NatsChatConfig {
  agentName?: string;
  autoJoin?: string[]; // room names
}

/** Read persisted config. Returns {} if the file doesn't exist or is corrupt. */
export function loadConfig(): NatsChatConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const cfg: NatsChatConfig = {};
    if (typeof parsed.agentName === "string") cfg.agentName = parsed.agentName;
    if (Array.isArray(parsed.autoJoin)) {
      cfg.autoJoin = parsed.autoJoin.filter(
        (r: unknown): r is string => typeof r === "string",
      );
    }
    return cfg;
  } catch {
    return {};
  }
}

/** Persist config to disk. */
export function saveConfig(cfg: NatsChatConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

/** Return a human-readable summary of the current config. */
export function formatConfig(cfg: NatsChatConfig): string {
  const name = cfg.agentName ?? "(not set)";
  const rooms = cfg.autoJoin?.length
    ? cfg.autoJoin.map((r) => `#${r}`).join(", ")
    : "(not set)";
  return `agent name: ${name}\nauto-join rooms: ${rooms}\nconfig file: ${CONFIG_PATH}`;
}
