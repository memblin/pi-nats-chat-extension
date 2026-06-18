// NATS connection lifecycle. Holds the single shared connection plus its
// JetStream client and manager for the lifetime of the extension session.
import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
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
  nc = await connect({ servers, name: "pi-nats-chat" });
  js = jetstream(nc);
  jsm = await jetstreamManager(nc);
}

/** The URL of the currently active connection (the configured default until connected). */
export function getActiveUrl(): string {
  return activeUrl;
}

export function getConnection(): NatsConnection {
  if (!nc) throw new Error("NATS is not connected — call connectNats() first");
  return nc;
}

export function getJetStream(): JetStreamClient {
  if (!js) throw new Error("NATS is not connected — call connectNats() first");
  return js;
}

export function getManager(): JetStreamManager {
  if (!jsm) throw new Error("NATS is not connected — call connectNats() first");
  return jsm;
}

/** Whether connected to NATS. */
export function isConnected(): boolean {
  return nc !== null;
}

/** Drain and tear down the connection (used on session shutdown). */
export async function closeNats(): Promise<void> {
  if (!nc) return;
  await nc.drain();
  nc = null;
  js = null;
  jsm = null;
}
