/**
 * Pure text helpers for the first-text welcome + delayed onboarding capture
 * (JAK-first-text-welcome). No I/O, no DI — just string in/out — so the wording,
 * the no-emoji rule, and the reply parsing are all exhaustively unit-testable.
 *
 * The GoTextJake.com footer is NOT added here: like the out-of-credits copy, the
 * SENDER appends the canonical footer at send time, so it can never be edited or
 * built away. Every string these builders return is deliberately emoji-free and
 * TTS-friendly.
 */

/** The three new-customer opening grants announced in the welcome. */
export interface WelcomeGrants {
  report: number;
  skiptrace: number;
  comps: number;
}

/** The profile fields we can pull out of a follow-up reply. */
export interface CapturedProfile {
  firstName?: string;
  lastName?: string;
  email?: string;
}

/** "50 report credits" / "1 report credit" — pluralized for clean TTS. */
function creditPhrase(n: number, label: string): string {
  return `${n} ${label} credit${n === 1 ? "" : "s"}`;
}

/**
 * The one-time WELCOME sent on a NEW number's first-ever text
 * (JAK-first-text-welcome): announce the seeded credits and invite an address.
 * Deliberately does NOT ask for name/email — that ask is DELAYED to after the 3rd
 * report. Emoji-free, TTS-friendly; the sender appends the footer.
 */
export function buildWelcomeMessage(grants: WelcomeGrants): string {
  return [
    `Welcome to Jake. You've got ${creditPhrase(grants.report, "report")}, ` +
      `${creditPhrase(grants.skiptrace, "skip trace")}, and ` +
      `${creditPhrase(grants.comps, "comps")} to start.`,
    "Text me a full property address any time and I'll pull you a report.",
  ].join("\n\n");
}

/**
 * A short, warm acknowledgment after we capture a texter's profile info
 * (JAK-first-text-welcome). Greets them by first name when we got one. Emoji-free;
 * the sender appends the footer.
 */
export function buildProfileAck(captured: CapturedProfile): string {
  const greeting = captured.firstName ? `Thanks, ${captured.firstName}.` : "Thanks.";
  return `${greeting} I've saved your info and I'll keep it with your account.`;
}

const EMAIL_RE = /[^\s,;:<>()"']+@[^\s,;:<>()"']+\.[^\s,;:<>()"']+/;

// Leading conversational cues a texter may wrap their name in ("my name is Sara",
// "I'm Sara", "this is Sara"). Matching one is ALSO the signal that a reply with
// no email is nonetheless a profile answer.
const NAME_CUE_RE = /\b(?:my name is|name is|name'?s|i am|i'?m|this is|it'?s|call me)\b/i;

// Filler tokens to drop when pulling the actual name out of the remaining words.
const FILLER = new Set([
  "my", "name", "names", "is", "im", "i", "am", "the", "a", "an", "and",
  "email", "mail", "e", "this", "its", "it", "call", "me", "here", "you", "go", "by",
]);

/**
 * Parse a follow-up reply for profile info (JAK-first-text-welcome). Returns the
 * fields found, or null when the message isn't a profile answer at all — so the
 * caller only intercepts genuine name/email replies and never hijacks an address
 * or a command.
 *
 * A message counts as a profile answer when it contains an EMAIL, or an explicit
 * NAME CUE ("my name is ...", "I'm ..."). In both cases we also pull the name: the
 * remaining alphabetic tokens (minus filler + the email) become first/last, first
 * token first. Never fabricates a value; partial info (name only, or email only)
 * is fine.
 */
export function parseProfileReply(message: string): CapturedProfile | null {
  const text = String(message ?? "").trim();
  if (!text) return null;

  const emailMatch = text.match(EMAIL_RE);
  const email = emailMatch ? emailMatch[0].replace(/[.,;:]+$/, "") : undefined;
  const hasCue = NAME_CUE_RE.test(text);

  // Not a profile answer unless it carries an email or an explicit name cue.
  if (!email && !hasCue) return null;

  // Strip the email + any leading cue, then read the leftover name tokens.
  let nameSource = email ? text.replace(email, " ") : text;
  const cue = nameSource.match(NAME_CUE_RE);
  if (cue && cue.index != null) {
    nameSource = nameSource.slice(cue.index + cue[0].length);
  }
  const tokens = (nameSource.match(/[A-Za-z][A-Za-z'-]*/g) ?? [])
    .filter((t) => !FILLER.has(t.toLowerCase()))
    .slice(0, 3);

  const captured: CapturedProfile = {};
  if (tokens.length >= 1) captured.firstName = tokens[0];
  if (tokens.length >= 2) captured.lastName = tokens.slice(1).join(" ");
  if (email) captured.email = email;

  return captured.firstName || captured.lastName || captured.email ? captured : null;
}
