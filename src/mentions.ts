// Shared @mention detection for room messages. Used by the background
// subscriber (to decide whether a room message interrupts the agent) and by
// the polling tools (to filter room chatter down to messages aimed at us).
//
// Matching is token-aware rather than a raw substring test: "@all" must not
// fire on "@allison", and "@bob" must not fire on "@bobby" or an email like
// "x@bob.dev". A mention is an "@" that is NOT part of a longer handle or
// email — not preceded by a word char, "@", "." or "-" — followed by exactly
// the target token and a non-handle boundary.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenMention(token: string): RegExp {
  // (?<![\w@./-])  — not mid-word, mid-handle, or mid-email
  // (?![\w-])      — token ends here (so "@bob" ≠ "@bobby"/"@bob-2")
  return new RegExp(`(?<![\\w@./-])@${escapeRegExp(token)}(?![\\w-])`);
}

const ALL = tokenMention("all");

/**
 * Whether `content` addresses the agent named `agentName` — either an explicit
 * `@<agentName>` mention or an `@all` broadcast. Case-sensitive on the name to
 * match the registered identity exactly.
 */
export function isMentioned(content: string, agentName: string): boolean {
  if (ALL.test(content)) return true;
  return tokenMention(agentName).test(content);
}
