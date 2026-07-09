import { injectable, inject } from "tsyringe";
import { PropertyReportWriter } from "../PropertyReportWriter";
import { FooterStore } from "./FooterStore";
import { CreateFooterInput, Footer, FooterRow, UpdateFooterInput } from "./FooterTypes";

/**
 * Business surface for the admin-managed rotating reply footers (JAK-188).
 *
 * Two responsibilities:
 *   1. {@link getRandomActiveFooter} — the SENDER's per-outbound-message pick: a
 *      uniformly-random ACTIVE footer's text. When there are ZERO active footers
 *      it returns the EXISTING hardcoded default footer constant
 *      ({@link PropertyReportWriter.FOOTER}) — kept as the fallback so a reply is
 *      never sent footer-less, exactly like day-1 (JAK-157/158).
 *   2. Admin CRUD ({@link list}/{@link create}/{@link update}/{@link remove}) over
 *      the pool, used by the AdminResource "Footers" section.
 *
 * Footers are GLOBAL — no per-location scope.
 */
@injectable()
export class FooterService {
  /**
   * The fallback footer when no active footer exists — the EXISTING hardcoded
   * default (JAK-157/158). Reused (not re-declared) so the fallback, the writers'
   * enforced footer, and the migration seed can never drift apart.
   */
  static readonly DEFAULT_FOOTER = PropertyReportWriter.FOOTER;

  constructor(@inject(FooterStore) private readonly store: FooterStore) {}

  /**
   * The text of a uniformly-random ACTIVE footer, or the hardcoded default when
   * none are active. Called once per outbound message so the footer rotates.
   */
  async getRandomActiveFooter(): Promise<string> {
    const active = await this.store.listActive();
    if (active.length === 0) return FooterService.DEFAULT_FOOTER;
    const pick = active[Math.floor(Math.random() * active.length)];
    // Guard against a NaN/out-of-range index (defensive): fall back to first.
    return (pick ?? active[0]).text;
  }

  /** Every footer, newest first — the admin list. */
  async list(): Promise<Footer[]> {
    const rows = await this.store.listAll();
    return rows.map(toFooter);
  }

  /** Add a footer to the pool. Active by default. */
  async create(input: CreateFooterInput): Promise<Footer> {
    const row = await this.store.insert(input.text, input.active ?? true);
    return toFooter(row);
  }

  /** Edit a footer's text and/or active flag. Null if the id is unknown. */
  async update(id: string, patch: UpdateFooterInput): Promise<Footer | null> {
    const row = await this.store.update(id, { text: patch.text, active: patch.active });
    return row ? toFooter(row) : null;
  }

  /** Remove a footer from the pool. True if one was deleted. */
  async remove(id: string): Promise<boolean> {
    return this.store.delete(id);
  }
}

/** Map a persistence row to the camelCase domain/API shape. */
function toFooter(row: FooterRow): Footer {
  return {
    id: row.id,
    text: row.text,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
