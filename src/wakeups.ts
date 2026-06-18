// Per-identity tally of consecutive empty wakeups, kept in process memory (no
// persistence). An "empty wakeup" is a wait_for_message that timed out with no
// messages. ANY active receive resets the streak.
//
// Also handles per-identity cooldown and single-flight coalescing for
// wait_for_message — see the MCP server's docs/tools.md for rationale.

const emptyWakeups = new Map<string, number>();

export interface WaitReturnPayload {
  timed_out: boolean;
  [key: string]: unknown;
}

const lastWait = new Map<
  string,
  { at: number; payload: WaitReturnPayload }
>();

const inFlightWaits = new Map<string, Promise<WaitReturnPayload>>();

export const WAIT_COOLDOWN_MS = 5000;

export interface WaitCooldownError {
  error: "too_soon";
  message: string;
  retry_after_ms: number;
  consecutive_empty_wakeups: number;
}

export type WaitCooldownDecision =
  | { action: "proceed" }
  | { action: "replay"; payload: WaitReturnPayload }
  | { action: "reject"; payload: WaitCooldownError };

export function decideWaitCooldown(
  id: string,
  now: number = Date.now(),
): WaitCooldownDecision {
  const last = lastWait.get(id);
  if (!last) return { action: "proceed" };
  const elapsed = now - last.at;
  if (elapsed >= WAIT_COOLDOWN_MS) return { action: "proceed" };

  if (last.payload.timed_out) {
    return {
      action: "replay",
      payload: { ...last.payload, replayed_from_cache: true },
    };
  }

  return {
    action: "reject",
    payload: {
      error: "too_soon",
      message:
        `nats_wait_for_message was called ${elapsed}ms after its previous ` +
        `return for this identity, which delivered messages. Process those ` +
        `messages before waiting again — each wait must be in a separate ` +
        `agent turn. The turn-by-turn cycle is the loop; do not call ` +
        `nats_wait_for_message more than once per turn.`,
      retry_after_ms: WAIT_COOLDOWN_MS - elapsed,
      consecutive_empty_wakeups: emptyWakeups.get(id) ?? 0,
    },
  };
}

export function recordWaitReturn(
  id: string,
  payload: WaitReturnPayload,
  now: number = Date.now(),
): void {
  lastWait.set(id, { at: now, payload });
}

export function resetWaitReturn(id: string): void {
  lastWait.delete(id);
}

export async function coalesceWait(
  id: string,
  start: () => Promise<WaitReturnPayload>,
): Promise<{ leader: boolean; result: WaitReturnPayload }> {
  const existing = inFlightWaits.get(id);
  if (existing) {
    return { leader: false, result: await existing };
  }
  const promise = start();
  inFlightWaits.set(id, promise);
  try {
    return { leader: true, result: await promise };
  } finally {
    inFlightWaits.delete(id);
  }
}

export function recordWaitResult(id: string, timedOut: boolean): number {
  const next = timedOut ? (emptyWakeups.get(id) ?? 0) + 1 : 0;
  emptyWakeups.set(id, next);
  return next;
}

export function resetEmptyWakeups(id: string): void {
  emptyWakeups.set(id, 0);
}

export function emptyWakeupCount(id: string): number {
  return emptyWakeups.get(id) ?? 0;
}

// Test-only helpers
export function resetEmptyWakeupsForTests(): void {
  emptyWakeups.clear();
}

export function resetWaitReturnForTests(): void {
  lastWait.clear();
  inFlightWaits.clear();
}
