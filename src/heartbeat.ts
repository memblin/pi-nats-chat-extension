// Background presence heartbeat. A registered agent otherwise only refreshes
// its presence when it calls a chat tool, so a session doing a long stretch of
// work that touches no nats-chat tool would lapse out of the registry. This
// refreshes presence on a fixed interval for the whole life of the session.
import { syncPresence, isRegistered } from "./identity.js";

const PRESENCE_HEARTBEAT_MS = 60_000; // 1 min — well under the 5-min presence TTL

/**
 * Start refreshing presence every intervalMs until the returned stop function is
 * called. Safe to start before register_agent — no-ops until registered.
 */
export function startHeartbeat(
  intervalMs: number = PRESENCE_HEARTBEAT_MS,
): () => void {
  const timer = setInterval(() => {
    if (!isRegistered()) return;
    void syncPresence().catch(() => {
      /* transient — the next tick retries */
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
