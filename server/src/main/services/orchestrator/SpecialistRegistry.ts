import { injectable } from "tsyringe";

/**
 * One specialist the orchestrator knows about, keyed by name (JAK-135).
 *
 * A descriptor is the REGISTRATION SEAM for the epic: JAK-135 seeds the three
 * capabilities it knows the router will classify — `report` (built, available),
 * `skip_trace` (JAK-136), `comps` (JAK-137) — and the later tickets flip their
 * entry to `available: true` (and wire the executor) via {@link
 * SpecialistRegistry.register} WITHOUT rewriting the router. Until then an
 * unavailable descriptor tells the router to reply "coming soon" and spend
 * nothing.
 */
export interface SpecialistDescriptor {
  /** Registry key the plan references. */
  name: string;
  /** True when running this specialist spends credits (→ confirm-before-spend). */
  needsConfirmation: boolean;
  /** Credits this specialist is expected to cost (informational until it runs). */
  estimatedCredits: number;
  /** False = not built yet (coming soon); the router recognizes it but won't spend. */
  available: boolean;
}

/**
 * The specialist registry (JAK-135) — a name→descriptor map the orchestrator
 * reads to build a dispatch plan and to decide whether a requested capability is
 * runnable or still "coming soon".
 *
 * It is deliberately tiny and pure: it holds NO execution logic and makes NO
 * I/O. JAK-136/137 register their specialist descriptor here (or override the
 * seeded one) so the router picks them up with no code change of its own. The
 * seeded credit estimates mirror the JAK-109 default costs (1 per report / text
 * lookup, +2 for a skip-trace) and are placeholders 136/137 will confirm.
 */
@injectable()
export class SpecialistRegistry {
  static readonly REPORT = "report";
  static readonly SKIP_TRACE = "skip_trace";
  static readonly COMPS = "comps";

  private readonly specialists = new Map<string, SpecialistDescriptor>();

  constructor() {
    // Report: BUILT (JAK-130/134). Runs on a resolved address; keeps its
    // base-credit behavior, so it never needs a confirmation gate.
    this.register({
      name: SpecialistRegistry.REPORT,
      needsConfirmation: false,
      estimatedCredits: 1,
      available: true,
    });
    // Skip-trace (JAK-136) + comps (JAK-137): recognized but NOT built yet.
    // Confirm-before-spend when they land; for now the router replies "coming
    // soon" and spends nothing. Estimates are placeholders 136/137 will confirm.
    this.register({
      name: SpecialistRegistry.SKIP_TRACE,
      needsConfirmation: true,
      estimatedCredits: 2,
      available: false,
    });
    this.register({
      name: SpecialistRegistry.COMPS,
      needsConfirmation: true,
      estimatedCredits: 2,
      available: false,
    });
  }

  /** Register (or override) a specialist descriptor by name. */
  register(descriptor: SpecialistDescriptor): void {
    this.specialists.set(descriptor.name, descriptor);
  }

  /** The descriptor for a name, or null when nothing is registered under it. */
  get(name: string): SpecialistDescriptor | null {
    return this.specialists.get(name) ?? null;
  }

  /** True when a specialist is registered AND built (runnable, not coming-soon). */
  isAvailable(name: string): boolean {
    return this.get(name)?.available ?? false;
  }
}
