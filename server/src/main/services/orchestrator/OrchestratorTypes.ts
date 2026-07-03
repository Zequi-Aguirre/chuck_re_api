// JAK-135 — Orchestrator / router AI types.
//
// The router turns text-Jake from a single-path address lookup into a
// conversational, multi-capability assistant. It reads EVERY inbound message
// plus the JAK-134 conversation memory (recent window + the ordered per-phone
// resolved-address list), classifies intent, resolves references, and emits a
// typed DISPATCH PLAN the assistant executes. The specialist names in the plan
// are keyed against the {@link import("./SpecialistRegistry").SpecialistRegistry}
// so JAK-136 (skip-trace) / JAK-137 (comps) plug in without rewriting the router.

import { CompParamOverrides } from "../comps/CompsTypes";

/**
 * The intents the router classifies every inbound message into.
 *
 *   property_report - a report for an address, whether typed directly ("123 Main
 *                     St, ...") or resolved from a reference ("the 2nd address I
 *                     sent", "the last one"). Runs the Report specialist.
 *   report_refresh  - a bare affirmative ("OK"/"YES") that confirms a fresh PAID
 *                     copy of the last address (the JAK-134 confirm-before-spend
 *                     reply). Runs the Report specialist on the last address.
 *   skip_trace      - owner contact lookup (JAK-136). Runs the skip-trace specialist.
 *   comps           - comparables / CMA (JAK-137). Runs the comps specialist, which
 *                     may carry texter-supplied parameter overrides (see compParams).
 *   chitchat        - greeting / unrecognized → an emoji-free guidance reply.
 */
export type JakeIntent =
  | "property_report"
  | "report_refresh"
  | "skip_trace"
  | "comps"
  | "chitchat";

/** Every intent the router may emit — the single source of truth for validation. */
export const JAKE_INTENTS: readonly JakeIntent[] = [
  "property_report",
  "report_refresh",
  "skip_trace",
  "comps",
  "chitchat",
] as const;

/**
 * One specialist the plan asks to run, with its confirm-before-spend metadata.
 * `needsConfirmation` + `estimatedCredits` mirror JAK-134's shipped pattern:
 * anything that will spend credits tells the user the cost and waits for an
 * OK/YES first. Report-on-an-address keeps its base-credit behavior
 * (needsConfirmation = false), while skip-trace / comps require confirmation.
 */
export interface SpecialistPlan {
  /** Registry key: "report" | "skip_trace" | "comps". */
  name: string;
  /** True when running this specialist will spend credits and must be confirmed. */
  needsConfirmation: boolean;
  /** Credits this specialist is expected to cost (informational until it runs). */
  estimatedCredits: number;
}

/**
 * The structured dispatch plan the router produces for one inbound message. The
 * assistant executes it: which specialist(s) to run, and on which resolved
 * entity.
 */
export interface DispatchPlan {
  intent: JakeIntent;
  /**
   * The resolved entity the plan acts on — a normalized address (or, later, an
   * owner reference) — or null when the intent needs no entity (chitchat) or a
   * reference could not be resolved (→ the assistant asks for clarification).
   */
  targetEntity: string | null;
  /** The specialist(s) to run, in order. Empty for chitchat. */
  specialists: SpecialistPlan[];
  /** The model's short, human-readable note about what it's doing (telemetry). */
  userFacingNote: string;
  /**
   * Texter-supplied comp parameter overrides pulled from the message ("comps within
   * 1 mile, last 6 months, 3 similar homes"), for the comps intent only (JAK-137).
   * Null/absent when the texter didn't specify any — the comps specialist then uses
   * the admin defaults. Only the fields the texter named are set; all are clamped
   * downstream.
   */
  compParams?: CompParamOverrides | null;
}

/** What the assistant hands the orchestrator for one inbound message. */
export interface OrchestratorInput {
  /** The texting customer's phone — the memory + resolved-address list key. */
  phone: string;
  /** The raw inbound message text. */
  message: string;
  /** The address parsed deterministically from the message, or null. */
  parsedAddress: string | null;
  /** Whether the message is a bare affirmative ("OK"/"yes") — a spend confirmation. */
  isAffirmative: boolean;
}
