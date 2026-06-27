// NATS connection lifecycle. Holds the single shared connection plus its
// JetStream client and manager for the lifetime of the extension session.
import { readFileSync } from "node:fs";
import { connect } from "@nats-io/transport-node";
import type { ConnectionOptions, NatsConnection } from "@nats-io/nats-core";
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";

export const NATS_URL = process.env.NATS_URL ?? "nats://localhost:4222";

let nc: NatsConnection | null = null;
let js: JetStreamClient | null = null;
let jsm: JetStreamManager | null = null;
let activeUrl = NATS_URL;

/**
 * Establish the shared NATS connection. Idempotent.
 * @param servers - optional override (used by integration tests to point at a
 *   throwaway broker); defaults to the NATS_URL env var.
 */
export async function connectNats(servers: string = NATS_URL): Promise<void> {
  if (nc) return;
  activeUrl = servers;

  const opts: ConnectionOptions = {
    servers,
    name: "pi-nats-chat",
    // A coding session routinely outlives a transient broker restart. The
    // library default (maxReconnectAttempts: 10) gives up after ~20s and
    // closes for good; keep retrying indefinitely so chat recovers on its own
    // once the broker returns.
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2000,
    reconnectJitter: 1000,
  };

  // Optional auth/TLS for non-localhost brokers, all opt-in via env vars.
  if (process.env.NATS_TOKEN) opts.token = process.env.NATS_TOKEN;
  if (process.env.NATS_USER) opts.user = process.env.NATS_USER;
  if (process.env.NATS_PASS) opts.pass = process.env.NATS_PASS;
  if (process.env.NATS_TLS === "1") opts.tls = {};
  if (process.env.NATS_CREDS) {
    // Imported lazily so the authenticator symbol is only required when creds
    // auth is actually configured.
    const { credsAuthenticator } = await import("@nats-io/nats-core");
    opts.authenticator = credsAuthenticator(
      readFileSync(process.env.NATS_CREDS),
    );
  }

  nc = await connect(opts);
  js = jetstream(nc);
  jsm = await jetstreamManager(nc);
}

/** The URL of the currently active connection (the configured default until connected). */
export function getActiveUrl(): string {
  return activeUrl;
}

export function getConnection(): NatsConnection {
  if (!nc) throw new Error("NATS is not connected. Run /nats-connect first.");
  return nc;
}

export function getJetStream(): JetStreamClient {
  if (!js) throw new Error("NATS is not connected. Run /nats-connect first.");
  return js;
}

export function getManager(): JetStreamManager {
  if (!jsm) throw new Error("NATS is not connected. Run /nats-connect first.");
  return jsm;
}

/** Whether connected to NATS. False once the connection has closed for good,
 * even though we still hold the handle, so callers can detect a dead link and
 * trigger a reconnect. */
export function isConnected(): boolean {
  return nc !== null && !nc.isClosed();
}

/** Drain and tear down the connection (used on session shutdown). */
export async function closeNats(): Promise<void> {
  if (!nc) return;
  try {
    await nc.drain();
  } catch {
    // Drain fails if the connection is already dead — that's fine,
    // we still want to clear our handle so reconnect can start fresh.
  }
  nc = null;
  js = null;
  jsm = null;
}
