// Persistent config for the NATS chat extension.
//
// Two scopes, mirroring how Pi itself layers settings:
//   - global  : ~/.pi/agent/nats-chat.json        (applies to every session)
//   - project : <cwd>/.pi/nats-chat.json          (this project; overrides global)
// Project values win over global on a per-key basis, and environment variables
// (NATS_AGENT_NAME / NATS_AUTO_JOIN) still win over both at read time in index.ts.
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "node:fs";

export interface NatsChatConfig {
  agentName?: string;
  autoJoin?: string[]; // room names
  monitor?: boolean; // show unaddressed room chatter in the session (default off)
}

export type ConfigScope = "global" | "project";

const GLOBAL_DIR = join(homedir(), ".pi", "agent");
const GLOBAL_PATH = join(GLOBAL_DIR, "nats-chat.json");

/** Absolute paths for both scopes. `cwd` defaults to the process cwd. */
export function configPaths(cwd: string = process.cwd()): Record<ConfigScope, string> {
  return {
    global: GLOBAL_PATH,
    project: join(cwd, ".pi", "nats-chat.json"),
  };
}

/** Parse + validate a raw JSON blob into a config (tolerant: returns {} on junk). */
function parse(raw: string): NatsChatConfig {
  try {
    const parsed = JSON.parse(raw);
    const cfg: NatsChatConfig = {};
    if (typeof parsed.agentName === "string") cfg.agentName = parsed.agentName;
    if (Array.isArray(parsed.autoJoin)) {
      cfg.autoJoin = parsed.autoJoin.filter(
        (r: unknown): r is string => typeof r === "string",
      );
    }
    if (typeof parsed.monitor === "boolean") cfg.monitor = parsed.monitor;
    return cfg;
  } catch {
    return {};
  }
}

/** Read one scope's config. Returns {} when the file is absent or corrupt. */
export function loadScope(scope: ConfigScope, cwd?: string): NatsChatConfig {
  const path = configPaths(cwd)[scope];
  try {
    if (!existsSync(path)) return {};
    return parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Effective config = global overlaid by project (project wins per key). Pass the
 * session cwd so the project file is resolved relative to the right directory.
 */
export function loadConfig(cwd?: string): NatsChatConfig {
  const global = loadScope("global", cwd);
  const project = loadScope("project", cwd);
  return {
    agentName: project.agentName ?? global.agentName,
    autoJoin: project.autoJoin ?? global.autoJoin,
    monitor: project.monitor ?? global.monitor,
  };
}

/** Persist config to a specific scope, atomically (temp + rename). */
export function saveConfig(
  cfg: NatsChatConfig,
  scope: ConfigScope = "global",
  cwd?: string,
): void {
  const path = configPaths(cwd)[scope];
  const dir = path.slice(0, path.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf-8");
  renameSync(tmp, path);
}

/** Which scope, if any, currently provides each field — for display. */
export function describeConfig(cwd?: string): string {
  const global = loadScope("global", cwd);
  const project = loadScope("project", cwd);
  const eff = loadConfig(cwd);
  const paths = configPaths(cwd);

  const source = (key: keyof NatsChatConfig): string =>
    project[key] !== undefined ? "project" : global[key] !== undefined ? "global" : "—";

  const rooms = eff.autoJoin?.length ? eff.autoJoin.map((r) => `#${r}`).join(", ") : "(none)";
  return [
    `agent name : ${eff.agentName ?? "(not set)"}   [${source("agentName")}]`,
    `auto-join  : ${rooms}   [${source("autoJoin")}]`,
    `monitor    : ${eff.monitor ? "on" : "off"} (default)   [${source("monitor")}]`,
    ``,
    `project file: ${paths.project}`,
    `global file : ${paths.global}`,
    `(project overrides global; env vars override both)`,
  ].join("\n");
}
