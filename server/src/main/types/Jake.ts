// Types for the Jake SMS assistant inbound webhook + core path.

/**
 * A normalized inbound text (JAK-115). The resource layer accepts GHL's flexible
 * field names and hands the assistant a clean shape; the assistant then resolves
 * the texting customer (by `senderPhone`) and the text MODE (gateway vs
 * own_number), so it — not the resource — owns credential selection.
 */
export type JakeInboundMessage = {
  /** Contact id in whichever GHL sub-account the text came through. */
  contactId: string;
  /**
   * The SENDER's phone number (the person who texted in) — the tier-1 billing
   * identity, used in BOTH modes to resolve the customer + their credit account.
   */
  senderPhone: string;
  message: string;
  /**
   * The GHL location id the text arrived through, if the payload carried one.
   * Present when routed through a customer's OWN sub-account (own_number). Absent
   * for the shared gateway sub-account.
   */
  locationId?: string;
  /**
   * Candidate destination number(s) the text was received on (e.g. GHL `to`).
   * Used to resolve an own_number connection and to prove a safe reply-from
   * number. Never the sender's number.
   */
  candidateNumbers?: string[];
};

export type JakeTextMode = "gateway" | "own_number";

export type JakeInboundResult = {
  ok: boolean;
  /** Normalized address parsed from the inbound message, if any. */
  address: string | null;
  /** The reply text that was sent back over SMS. */
  reply: string;
  /** Which text mode handled this message. */
  mode: JakeTextMode;
  /** Credits charged to the customer for this message (0 when nothing billable). */
  charged: number;
  /** True when the customer had no credits and the lookup was skipped. */
  outOfCredits?: boolean;
};
