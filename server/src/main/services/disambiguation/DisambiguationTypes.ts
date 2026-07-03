// JAK-138 — Pending disambiguation types: the ONE outstanding "which address did
// you mean?" question per phone, so a following bare number/ordinal can select an
// address and run the intent that was waiting on it.

import { JakeIntent } from "../orchestrator/OrchestratorTypes";
import { CompParamOverrides } from "../comps/CompsTypes";

/**
 * Raw persistence row for `text_jake_pending_disambiguation` (JAK-138) — the ONE
 * outstanding address-clarification question per phone (upserted). When Jake asks
 * "which address did you mean?" and lists them, this remembers WHICH intent was
 * pending so a following bare number/ordinal resolves the address (re-derived from
 * the stable per-phone resolved-address list) and runs that intent. The address is
 * intentionally NOT stored — only the intent (and, for a comps question, the
 * texter's parameter overrides).
 */
export interface DisambiguationPendingRow {
  phone: string;
  customer_id: string;
  /** The address-based intent waiting on a pick: property_report | skip_trace | comps. */
  intent: JakeIntent;
  /** The texter's comp parameter overrides, for a pending comps question; else null. */
  comp_params: CompParamOverrides | null;
  created_at: Date;
}
